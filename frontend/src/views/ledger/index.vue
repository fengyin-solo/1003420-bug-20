<template>
  <section class="page" data-module="ledger">
    <header class="page-head">
      <div>
        <h2>处置台账</h2>
        <p class="page-desc">
          每次状态流转落库都在这里多留一份；另一个入口处置后，本页重新统计即可看到同一份台账。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">处置记录</span>
        <strong class="stat-value">{{ records.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">异常处置</span>
        <strong class="stat-value">{{ abnormalCount }}</strong>
      </article>
    </div>

    <header class="page-head">
      <div>
        <h3>并发处置（各自回滚）</h3>
        <p class="page-desc">
          并发完成两条业务记录：两条各自独立提交，失败的一条只回滚自己，不连坐另一条。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="runConcurrent">
          并发完成：巡护#1 确认完成 + 巡护#2 确认完成
        </button>
      </div>
    </header>
    <table v-if="batchItems.length" class="data-table">
      <thead>
        <tr><th>业务记录</th><th>动作</th><th>结果</th><th>是否回滚</th></tr>
      </thead>
      <tbody>
        <tr v-for="(item, index) in batchItems" :key="index">
          <td>{{ item.moduleKey }} #{{ item.rowId }}</td>
          <td>{{ item.action }}</td>
          <td>{{ item.message }}</td>
          <td>{{ item.rolledBack ? '已回滚该条' : '正常完成' }}</td>
        </tr>
      </tbody>
    </table>

    <header class="page-head">
      <div>
        <h3>中断重试（缓存校验点）</h3>
        <p class="page-desc">
          动作在「校验点已落库、状态未提交」处中断后，从校验点按最新缓存版本继续。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="stageInterrupt">制造一次中断（巡护#1 开始巡护）</button>
        <button class="btn primary" type="button" @click="retryCheckpoint">从校验点重试</button>
      </div>
    </header>

    <table class="data-table">
      <thead>
        <tr>
          <th>时间</th><th>业务模块</th><th>业务对象</th><th>编号</th>
          <th>动作</th><th>流转</th><th>异常</th><th>操作人</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in records" :key="record.id">
          <td>{{ formatTime(record.createdAt) }}</td>
          <td>{{ record.moduleName }}</td>
          <td>{{ record.entity }}</td>
          <td>{{ record.label }}</td>
          <td>{{ record.action }}</td>
          <td>{{ record.fromStatus }} → {{ record.toStatus }}</td>
          <td :class="{ 'error-text': record.abnormal }">{{ record.abnormal ? '异常' : '—' }}</td>
          <td>{{ record.operator }}</td>
        </tr>
        <tr v-if="!records.length">
          <td colspan="8" class="empty-state">暂无处置记录，先到业务模块里执行一次动作</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>台账与业务数据一同持久化在本机浏览器，版本随每次落库递增</span>
      <span v-if="notice" class="error-text">{{ notice }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  loadLedger,
  recoverInterruptedAction,
  runActionBatch,
  stageInterruptedAction,
} from '@/api/local-service'
import { storageKey } from '@/data/local-store'
import type { BatchItemResult, LedgerRecord } from '@/data/types'

const records = ref<LedgerRecord[]>([])
const batchItems = ref<BatchItemResult[]>([])
const notice = ref('')

const abnormalCount = computed(() => records.value.filter((record) => record.abnormal).length)

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function reload() {
  records.value = loadLedger()
}

function runConcurrent() {
  // 两条业务记录并发完成；#2 在种子数据里是「执行中」，#1 是「待执行」，
  // 若某条已处于目标状态，该条单独回滚并给出原因，另一条照常落库。
  const result = runActionBatch([
    { moduleKey: 'patrol', rowId: 1, action: '确认完成' },
    { moduleKey: 'patrol', rowId: 2, action: '确认完成' },
  ])
  batchItems.value = result.items
  notice.value = result.ok
    ? `两条记录均已完成，台账新增 ${result.ledgerIds.length} 份`
    : '部分记录未完成，已按条回滚，仅成功的进入台账'
  reload()
}

function stageInterrupt() {
  const result = stageInterruptedAction('patrol', 1, '开始巡护')
  notice.value = result.message
  reload()
}

function retryCheckpoint() {
  const result = recoverInterruptedAction()
  notice.value = result ? result.message : '当前没有待重试的校验点'
  reload()
}

function handleStorage(event: StorageEvent) {
  if (event.key === storageKey()) {
    reload()
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', handleStorage)
})
onUnmounted(() => {
  window.removeEventListener('storage', handleStorage)
})
</script>
