<template>
  <div class="stats-grid basic-stats">
    <card-numeric title="当前消息频率" icon="paper-plane">{{ currentRate }} / min</card-numeric>
    <card-numeric title="近期消息频率" icon="history">{{ recentRate }} / d</card-numeric>
    <card-numeric title="命名插件数量" icon="plug">{{ registry.pluginCount }}</card-numeric>
    <card-numeric title="数据库体积" icon="database">{{ (profile.storageSize / 1048576).toFixed(1) }} MB</card-numeric>
    <card-numeric title="活跃用户数量" icon="heart">{{ profile.activeUsers }}</card-numeric>
    <card-numeric title="活跃群数量" icon="users">{{ profile.activeGroups }}</card-numeric>
  </div>
  <load-chart/>
  <div class="stats-grid chart-stats">
    <history-chart/>
    <hour-chart/>
    <group-chart/>
    <word-cloud/>
  </div>
</template>

<script setup lang="ts">

import { computed } from 'vue'
import { stats, profile, registry } from '~/client'
import CardNumeric from './card-numeric.vue'
import GroupChart from './group-chart.vue'
import HistoryChart from './history-chart.vue'
import HourChart from './hour-chart.vue'
import LoadChart from './load-chart.vue'
import WordCloud from './word-cloud.vue'

const currentRate = computed(() => {
  return profile.value.bots.reduce((sum, bot) => sum + bot.currentRate[0], 0)
})

const recentRate = computed(() => {
  return Object.values(stats.value.botSend).reduce((sum, value) => sum + value, 0).toFixed(1)
})

</script>

<style lang="scss">

.stats-grid .k-card {
  margin: 0;
}

.basic-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(2, 1fr);
  grid-gap: 2rem;
  margin-bottom: 2rem;
}

.chart-stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, auto);
  grid-gap: 2rem;
  margin: 2rem 0 4rem;

  .echarts {
    max-width: 100%;
    margin: 0 auto -3rem;
  }

  @media (min-width: 1400px) {
    grid-template-columns: repeat(2, 1fr);
    grid-template-rows: repeat(2, auto);

    @media (min-width: 1600px) {
      .echarts {
        width: 600px;
        height: 400px;
        max-width: 100%;
        margin: 0 auto -3rem;
      }
    }

    @media (max-width: 1600px) {
      .echarts {
        width: 480px;
        height: 360px;
      }
    }
  }

  @media (max-width: 1440px) {
    grid-template-columns: 1fr;
    grid-template-rows: repeat(4, auto);

    @media (min-width: 1200px) {
      .echarts {
        width: 800px;
        height: 400px;
      }
    }

    @media (max-width: 1200px) {
      .echarts {
        width: 720px;
        height: 400px;
      }
    }
  }
}

</style>
