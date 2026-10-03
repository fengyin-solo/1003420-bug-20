import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  invalidateCache,
  listLedger,
  listRows,
  persistUnits,
  resetRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  LedgerEntry,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 目标状态落在异常语义上时同样标记异常，避免「中止任务 / 标记异常」这类动作丢失异常事件。
const ABNORMAL_STATUS_HINTS = ['取消', '中止', '异常', '荒废', '误报', '驳回', '报废', '过期', '故障', '关闭']

// localStorage 偶发写入失败时的重试：回到缓存校验点重读最新落库值后再试。
const COMMIT_RETRY_LIMIT = 2

let ledgerSeq = 0

function nextLedgerId(): number {
  ledgerSeq += 1
  return Date.now() * 1000 + ledgerSeq
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function isAbnormalFlow(action: string, target: string): boolean {
  return (
    NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) ||
    ABNORMAL_STATUS_HINTS.some((hint) => target.includes(hint))
  )
}

interface PlannedAction {
  meta: ModuleMeta
  rowId: number
  target: string
  updated: EntryRow
  nextRows: EntryRow[]
  ledger: LedgerEntry
}

// 动作计划：只基于缓存校验点之后的最新数据做变更，不提前改动共享缓存。
function planAction(
  key: string,
  id: number,
  action: string,
  operator: string,
): { result: ActionResult; plan?: PlannedAction } {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { result: { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` } }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { result: { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` } }
  }
  const previous = rows[index]
  const current = String(previous.status)
  if (current === target) {
    return { result: { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` } }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const abnormal = isAbnormalFlow(action, target)
  const updated: EntryRow = {
    ...previous,
    status: target,
    pending: target !== lastStatus,
    abnormal,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  const ledger: LedgerEntry = {
    id: nextLedgerId(),
    module: meta.key,
    entity: meta.entity,
    rowId: id,
    action,
    fromStatus: current,
    toStatus: target,
    abnormal,
    operator,
    at: new Date().toISOString(),
  }
  return { result: { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }, plan: { meta, rowId: id, target, updated, nextRows, ledger } }
}

// 落库并在中断后重试：失败就作废缓存，从缓存校验点重读最新落库值，再把变更套上去重写。
function commitWithRetry(plan: PlannedAction): ActionResult {
  let lastError: unknown
  for (let attempt = 0; attempt <= COMMIT_RETRY_LIMIT; attempt += 1) {
    try {
      persistUnits([{ key: plan.meta.key, rows: plan.nextRows, ledger: [plan.ledger] }])
      return { ok: true, message: '' }
    } catch (error) {
      lastError = error
      invalidateCache()
      // 回到校验点重读最新数据，按行编号把同一条变更重新套用后再试。
      const rows = listRows(plan.meta.key)
      const index = rows.findIndex((row) => Number(row.id) === plan.rowId)
      if (index < 0) {
        return { ok: false, message: `没有找到编号为 ${plan.rowId} 的${plan.meta.entity}` }
      }
      if (String(rows[index].status) === plan.target) {
        // 之前的写入其实已落库，只是后续步骤中断：无需重复写入。
        return { ok: true, message: '' }
      }
      const replayed = [...rows]
      // 以最新落库行为底（别人可能改过其他字段），强制套用本次动作推导出的状态字段。
      replayed[index] = {
        ...rows[index],
        status: plan.target,
        pending: plan.updated.pending,
        abnormal: plan.ledger.abnormal,
      }
      plan.nextRows = replayed
    }
  }
  return {
    ok: false,
    message: `操作未能落库，已重试${COMMIT_RETRY_LIMIT}次：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  operator = '值班管理员',
): ActionResult {
  const { result, plan } = planAction(key, id, action, operator)
  if (!plan) {
    return result
  }
  const committed = commitWithRetry(plan)
  return committed.ok ? { ok: true, message: result.message } : committed
}

// 并发完成两条业务记录：各自独立事务，任一失败只回滚它自己那一条，互不牵连。
export function runActionBatch(
  jobs: Array<{ key: string; id: number; action: string }>,
  operator = '值班管理员',
): ActionResult[] {
  return jobs.map((job) => {
    try {
      return runAction(job.key, job.id, job.action, operator)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '动作执行失败，已回滚该条记录',
      }
    }
  })
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 处置台账：另一个入口直接读同一份落库台账，动作在模块页执行后这里跟着多一份。
export function loadLedger(): LedgerEntry[] {
  return listLedger().sort((a, b) => (a.id < b.id ? 1 : -1))
}

// 异常面板：汇总各模块最新落库值里仍处于异常态的记录，异常事件不再只藏在某一列计数里。
export function listAbnormalEvents(): Array<{ module: string; id: number; status: string }> {
  const rows = allRows()
  const events: Array<{ module: string; id: number; status: string }> = []
  for (const meta of MODULE_BY_KEY.values()) {
    for (const row of rows[meta.key] ?? []) {
      if (row.abnormal) {
        events.push({ module: meta.name, id: Number(row.id), status: String(row.status) })
      }
    }
  }
  return events
}

export function loadOverview(): OverviewResult {
  // 取数前先过缓存校验点，卡片永远对着最新落库值统计，不再用旧快照。
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
