/* eslint-disable camelcase */
/* eslint-disable quote-props */

import { createHmac } from 'crypto'
import { encode } from 'querystring'
import { Context, camelize, Time, Random, sanitize, Logger } from 'koishi-core'
import { CommonPayload, addListeners, defaultEvents, EventConfig } from './events'
import { Config, GitHub, ReplyHandler, ReplySession, EventData } from './server'
import axios from 'axios'

export * from './server'

const logger = new Logger('github')

const defaultOptions: Config = {
  path: '/github',
  messagePrefix: '[GitHub] ',
  replyTimeout: Time.hour,
}

export const name = 'github'

export function apply(ctx: Context, config: Config = {}) {
  config = { ...defaultOptions, ...config }
  config.path = sanitize(config.path)

  const { app, database } = ctx
  const { appId, redirect } = config
  const subscriptions: Record<string, Record<string, EventConfig>> = {}
  const github = app.github = new GitHub(app, config)

  ctx.command('github', 'GitHub 相关功能').alias('gh')
    .action(({ session }) => session.execute('help github', true))

  ctx.command('github.recent', '查看最近的通知')
    .action(async () => {
      const output = Object.entries(history).slice(0, 10).map(([messageId, [message]]) => {
        const [brief] = message.split('\n', 1)
        return `${messageId}. ${brief}`
      })
      if (!output.length) return '最近没有 GitHub 通知。'
      return output.join('\n')
    })

  const tokens: Record<string, string> = {}

  ctx.router.get(config.path + '/authorize', async (ctx) => {
    const token = ctx.query.state
    if (!token || Array.isArray(token)) return ctx.status = 400
    const id = tokens[token]
    if (!id) return ctx.status = 403
    delete tokens[token]
    const { code, state } = ctx.query
    const data = await app.github.getTokens({ code, state, redirect_uri: redirect })
    await database.setUser('id', id, {
      ghAccessToken: data.access_token,
      ghRefreshToken: data.refresh_token,
    })
    return ctx.status = 200
  })

  ctx.command('github.authorize <user>', 'GitHub 授权')
    .alias('github.auth')
    .userFields(['id'])
    .action(async ({ session }, user) => {
      if (!user) return '请输入用户名。'
      const token = Random.uuid()
      tokens[token] = session.user.id
      const url = 'https://github.com/login/oauth/authorize?' + encode({
        client_id: appId,
        state: token,
        redirect_uri: redirect,
        scope: 'admin:repo_hook,repo',
        login: user,
      })
      return '请点击下面的链接继续操作：\n' + url
    })

  ctx.command('github.repos [name]', 'GitHub 仓库')
    .userFields(['ghAccessToken', 'ghRefreshToken'])
    .option('add', '-a  监听一个新的仓库')
    .option('delete', '-d  移除已监听的仓库')
    .option('subscribe', '-s  添加完成后更新到订阅', { hidden: true })
    .action(async ({ session, options }, name) => {
      if (options.add || options.delete) {
        if (!name) return '请输入仓库名。'
        if (!/^[\w-]+\/[\w-]+$/.test(name)) return '请输入正确的仓库名。'
        if (!session.user.ghAccessToken) {
          return ctx.app.github.authorize(session, '要使用此功能，请对机器人进行授权。输入你的 GitHub 用户名。')
        }

        name = name.toLowerCase()
        const url = `https://api.github.com/repos/${name}/hooks`
        const [repo] = await ctx.database.get('github', [name])
        if (options.add) {
          if (repo) return `已经添加过仓库 ${name}。`
          const secret = Random.uuid()
          let data: any
          try {
            data = await ctx.app.github.request('POST', url, session, {
              events: ['*'],
              config: {
                secret,
                url: app.options.selfUrl + config.path + '/webhook',
              },
            })
          } catch (err) {
            if (!axios.isAxiosError(err)) throw err
            if (err.response?.status === 404) {
              return '仓库不存在或您无权访问。'
            } else if (err.response?.status === 403) {
              return '第三方访问受限，请尝试授权此应用。\nhttps://docs.github.com/articles/restricting-access-to-your-organization-s-data/'
            } else {
              logger.warn(err)
              return '由于未知原因添加仓库失败。'
            }
          }
          await ctx.database.create('github', { name, id: data.id, secret })
          if (!options.subscribe) return '添加仓库成功！'
          return session.execute({
            name: 'github',
            args: [name],
            options: { add: true },
          }, true)
        } else {
          if (!repo) return `尚未添加过仓库 ${name}。`
          try {
            await ctx.app.github.request('DELETE', `${url}/${repo.id}`, session)
          } catch (err) {
            if (!axios.isAxiosError(err)) throw err
            logger.warn(err)
            return '移除仓库失败。'
          }
          await ctx.database.remove('github', [name])
          return '移除仓库成功！'
        }
      }

      const repos = await ctx.database.get('github', {})
      if (!repos.length) return '当前没有监听的仓库。'
      return repos.map(repo => repo.name).join('\n')
    })

  function subscribe(repo: string, id: string, meta: EventConfig) {
    (subscriptions[repo] ||= {})[id] = meta
  }

  function unsubscribe(repo: string, id: string) {
    delete subscriptions[repo][id]
    if (!Object.keys(subscriptions[repo]).length) {
      delete subscriptions[repo]
    }
  }

  ctx.command('github [name]')
    .channelFields(['githubWebhooks'])
    .option('list', '-l  查看当前频道订阅的仓库列表')
    .option('add', '-a  为当前频道添加仓库订阅')
    .option('delete', '-d  从当前频道移除仓库订阅')
    .action(async ({ session, options }, name) => {
      if (options.list) {
        if (!session.channel) return '当前不是群聊上下文。'
        const names = Object.keys(session.channel.githubWebhooks)
        if (!names.length) return '当前没有订阅的仓库。'
        return names.join('\n')
      }

      if (options.add || options.delete) {
        if (!session.channel) return '当前不是群聊上下文。'
        if (!name) return '请输入仓库名。'
        if (!/^[\w-]+\/[\w-]+$/.test(name)) return '请输入正确的仓库名。'

        name = name.toLowerCase()
        const webhooks = session.channel.githubWebhooks
        if (options.add) {
          if (webhooks[name]) return `已经在当前频道订阅过仓库 ${name}。`
          const [repo] = await ctx.database.get('github', [name])
          if (!repo) {
            const dispose = session.middleware(({ content }, next) => {
              dispose()
              content = content.trim()
              if (content && content !== '.' && content !== '。') return next()
              return session.execute({
                name: 'github.repos',
                args: [name],
                options: { add: true, subscribe: true },
              })
            })
            return `尚未添加过仓库 ${name}。发送空行或句号以立即添加并订阅该仓库。`
          }
          webhooks[name] = {}
          await session.channel._update()
          subscribe(name, session.cid, {})
          return '添加订阅成功！'
        } else if (options.delete) {
          if (!webhooks[name]) return `尚未在当前频道订阅过仓库 ${name}。`
          delete webhooks[name]
          await session.channel._update()
          unsubscribe(name, session.cid)
          return '移除订阅成功！'
        }
      }
    })

  ctx.on('connect', async () => {
    const channels = await ctx.database.getAssignedChannels(['id', 'githubWebhooks'])
    for (const { id, githubWebhooks } of channels) {
      for (const repo in githubWebhooks) {
        subscribe(repo, id, githubWebhooks[repo])
      }
    }
  })

  const reactions = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes']

  const history: Record<string, EventData> = {}

  function safeParse(source: string) {
    try {
      return JSON.parse(source)
    } catch {}
  }

  ctx.router.post(config.path + '/webhook', async (ctx) => {
    const event = ctx.headers['x-github-event']
    const signature = ctx.headers['x-hub-signature-256']
    const id = ctx.headers['x-github-delivery']
    const payload = safeParse(ctx.request.body.payload)
    if (!payload) return ctx.status = 400
    const fullEvent = payload.action ? `${event}/${payload.action}` : event
    logger.debug('received %s (%s)', fullEvent, id)
    const [data] = await database.get('github', [payload.repository.full_name.toLowerCase()])
    // 202：服务器已接受请求，但尚未处理
    // 在 github.repos -a 时确保获得一个 2xx 的状态码
    if (!data) return ctx.status = 202
    if (signature !== `sha256=${createHmac('sha256', data.secret).update(ctx.request.rawBody).digest('hex')}`) {
      return ctx.status = 403
    }
    ctx.status = 200
    if (payload.action) {
      app.emit(`github/${fullEvent}` as any, payload)
    }
    app.emit(`github/${event}` as any, payload)
  })

  ctx.before('attach-user', (session, fields) => {
    if (!session.quote) return
    if (history[session.quote.messageId.slice(0, 6)]) {
      fields.add('ghAccessToken')
      fields.add('ghRefreshToken')
    }
  })

  ctx.middleware((session: ReplySession, next) => {
    if (!session.quote) return next()
    const body = session.parsed.content.trim()
    const payloads = history[session.quote.messageId.slice(0, 6)]
    if (!body || !payloads) return next()

    let name: string, message: string
    if (session.parsed.prefix !== null || session.parsed.appel) {
      name = body.split(' ', 1)[0]
      message = body.slice(name.length).trim()
    } else {
      name = reactions.includes(body) ? 'react' : 'reply'
      message = body
    }

    const payload = payloads[1][name]
    if (!payload) return next()
    const handler = new ReplyHandler(github, session, message)
    return handler[name](...payload)
  })

  addListeners((event, handler) => {
    const base = camelize(event.split('/', 1)[0])
    ctx.on(`github/${event}` as any, async (payload: CommonPayload) => {
      // step 1: filter event
      const repoConfig = subscriptions[payload.repository.full_name.toLowerCase()] || {}
      const targets = Object.keys(repoConfig).filter((id) => {
        const baseConfig = repoConfig[id][base] || {}
        if (baseConfig === false) return
        const action = camelize(payload.action)
        if (action && baseConfig !== true) {
          const actionConfig = baseConfig[action]
          if (actionConfig === false) return
          if (actionConfig !== true && !(defaultEvents[base] || {})[action]) return
        }
        return true
      })
      if (!targets.length) return

      // step 2: handle event
      const result = handler(payload as any)
      if (!result) return

      // step 3: broadcast message
      logger.debug('broadcast', result[0].split('\n', 1)[0])
      const messageIds = await ctx.broadcast(targets, config.messagePrefix + result[0])
      const hexIds = messageIds.map(id => id.slice(0, 6))

      // step 4: save message ids for interactions
      for (const id of hexIds) {
        history[id] = result
      }

      setTimeout(() => {
        for (const id of hexIds) {
          delete history[id]
        }
      }, config.replyTimeout)
    })
  })
}
