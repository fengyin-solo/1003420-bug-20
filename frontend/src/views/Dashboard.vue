<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
        <RouterLink class="btn" to="/ledger">处置台账</RouterLink>
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
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <header class="page-head">
      <div>
        <h3>异常事件</h3>
        <p class="page-desc">按最新落库状态实时汇总，状态解除后事件自动消失。</p>
      </div>
    </header>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>业务对象</th><th>编号</th><th>当前状态</th></tr>
      </thead>
      <tbody>
        <tr v-for="event in abnormalEvents" :key="`${event.moduleKey}-${event.rowId}`">
          <td>{{ event.moduleName }}</td>
          <td>{{ event.entity }}</td>
          <td>{{ event.label }}</td>
          <td class="error-text">{{ event.status }}</td>
        </tr>
        <tr v-if="!abnormalEvents.length">
          <td colspan="4" class="empty-state">当前没有异常事件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import type { AbnormalEvent, OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const abnormalEvents = ref<AbnormalEvent[]>([])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  abnormalEvents.value = payload.abnormals
}

// 另一个入口落库（storage 事件）后本页统计与异常面板立刻刷新，不展示旧快照。
function handleStorage(event: StorageEvent) {
  if (event.key === 'forest-fire-patrol:entries') {
    refresh()
  }
}

onMounted(() => {
  refresh()
  window.addEventListener('storage', handleStorage)
})
onUnmounted(() => {
  window.removeEventListener('storage', handleStorage)
})
</script>
