<template>
  <section class="page" data-module="ledger">
    <header class="page-head">
      <div>
        <h2>处置台账</h2>
        <p class="page-desc">汇总各业务模块每一次状态流转，模块页面完成动作后这里同步多一份留痕。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">处置记录</span>
        <strong class="stat-value">{{ rows.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">异常处置</span>
        <strong class="stat-value">{{ abnormalCount }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>模块</span>
        <input v-model="moduleFilter" placeholder="按业务模块检索" />
      </label>
      <label class="filter-item">
        <span>动作</span>
        <input v-model="actionFilter" placeholder="按处置动作检索" />
      </label>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>时间</th><th>业务模块</th><th>对象</th><th>编号</th>
          <th>处置动作</th><th>流转前</th><th>流转后</th><th>是否异常</th><th>操作人</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)">
          <td>{{ formatTime(row.at) }}</td>
          <td>{{ moduleName(row.module) }}</td>
          <td>{{ row.entity }}</td>
          <td>{{ row.rowId }}</td>
          <td>{{ row.action }}</td>
          <td>{{ row.fromStatus }}</td>
          <td>{{ row.toStatus }}</td>
          <td>
            <span :class="row.abnormal ? 'error-text' : ''">{{ row.abnormal ? '异常' : '正常' }}</span>
          </td>
          <td>{{ row.operator }}</td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="9" class="empty-state">暂无处置记录，先到各业务模块执行一次动作</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>台账与业务数据在同一笔落库事务里写入，动作成功必有一份记录</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadLedger, moduleMeta } from '@/api/local-service'
import type { LedgerEntry } from '@/data/types'

const rows = ref<LedgerEntry[]>([])
const moduleFilter = ref('')
const actionFilter = ref('')

const abnormalCount = computed(() => rows.value.filter((row) => row.abnormal).length)

const filteredRows = computed(() =>
  rows.value.filter((row) => {
    const moduleText = moduleName(row.module)
    const matchModule =
      moduleFilter.value.trim() === '' || moduleText.includes(moduleFilter.value.trim())
    const matchAction =
      actionFilter.value.trim() === '' || row.action.includes(actionFilter.value.trim())
    return matchModule && matchAction
  }),
)

function moduleName(key: string): string {
  try {
    return moduleMeta(key).name
  } catch {
    return key
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function resetFilters() {
  moduleFilter.value = ''
  actionFilter.value = ''
}

function reload() {
  rows.value = loadLedger()
}

onMounted(reload)
</script>
