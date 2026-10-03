<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>
            <span :class="row.abnormal > 0 ? 'error-text' : ''">{{ row.abnormal }}</span>
          </td>
        </tr>
      </tbody>
    </table>

    <section class="abnormal-panel">
      <h3>异常面板</h3>
      <p v-if="!abnormalEvents.length" class="page-desc">当前没有异常记录。</p>
      <table v-else class="data-table">
        <thead>
          <tr><th>业务模块</th><th>编号</th><th>当前状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="event in abnormalEvents" :key="`${event.module}-${event.id}`">
            <td>{{ event.module }}</td>
            <td>{{ event.id }}</td>
            <td class="error-text">{{ event.status }}</td>
          </tr>
        </tbody>
      </table>
    </section>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview, listAbnormalEvents } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const abnormalEvents = ref<ReturnType<typeof listAbnormalEvents>>([])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  abnormalEvents.value = listAbnormalEvents()
}

onMounted(refresh)
</script>
