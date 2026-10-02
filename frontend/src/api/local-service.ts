import { MODULE_BY_KEY } from '@/data/modules'
import {
  commit,
  currentVersion,
  listLedger,
  listRows,
  readCheckpoint,
  resetRows,
} from '@/data/local-store'
import type {
  AbnormalEvent,
  ActionResult,
  BatchItemResult,
  BatchOperation,
  BatchResult,
  EntryRow,
  LedgerRecord,
  ModuleMeta,
  OperationCheckpoint,
  OverviewResult,
  PageResult,
} from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// pending / abnormal 一律按「最新落库状态」推导，动作名不再参与判断：
// 旧实现按动作名前缀猜异常，「取消任务」「标记异常」等动作全部漏掉，异常事件会丢。
export function isPendingStatus(meta: ModuleMeta, status: string): boolean {
  return !meta.terminalStatuses.includes(status)
}

export function isAbnormalStatus(meta: ModuleMeta, status: string): boolean {
  return meta.abnormalStatuses.includes(status)
}

function rowLabel(meta: ModuleMeta, row: EntryRow): string {
  const labelField = meta.fields[0]
  return labelField ? String(row[labelField] ?? row.id) : String(row.id)
}

function withStatusFlags(meta: ModuleMeta, row: EntryRow): EntryRow {
  return {
    ...row,
    pending: isPendingStatus(meta, String(row.status)),
    abnormal: isAbnormalStatus(meta, String(row.status)),
  }
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
  recoverInterruptedAction()
  const meta = moduleMeta(key)
  // 总览/列表取数都以最新落库状态重算标志位，不使用行上可能过期的旧快照。
  const rows = listRows(key).map((row) => withStatusFlags(meta, row))
  const matched = filterRows(rows, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function pushLedger(
  ledger: LedgerRecord[],
  draft: {
    moduleKey: string
    rowId: number
    action: string
    fromStatus: string
    toStatus: string
    label: string
    operator: string
  },
): number {
  const meta = moduleMeta(draft.moduleKey)
  const id = ledger.reduce((max, item) => Math.max(max, item.id), 0) + 1
  ledger.push({
    id,
    moduleKey: draft.moduleKey,
    moduleName: meta.name,
    entity: meta.entity,
    rowId: draft.rowId,
    label: draft.label,
    action: draft.action,
    fromStatus: draft.fromStatus,
    toStatus: draft.toStatus,
    abnormal: isAbnormalStatus(meta, draft.toStatus),
    operator: draft.operator,
    createdAt: new Date().toISOString(),
  })
  return id
}

type ApplyDraft = {
  meta: ModuleMeta
  rowId: number
  action: string
  toStatus: string
  operator: string
  label: string
  fromStatus: string
}

// 在一次 commit 草稿里完成「更新记录 + 追加处置台账」：两条要么一起生效要么都不生效。
function applyToDraft(
  draft: { entries: Record<string, EntryRow[]>; ledger: LedgerRecord[] },
  change: ApplyDraft,
): number {
  const { meta, rowId, action, toStatus, operator, label, fromStatus } = change
  const rows = (draft.entries[meta.key] ?? []).map((row) =>
    Number(row.id) === rowId
      ? {
          ...row,
          status: toStatus,
          pending: isPendingStatus(meta, toStatus),
          abnormal: isAbnormalStatus(meta, toStatus),
        }
      : row,
  )
  draft.entries[meta.key] = rows
  return pushLedger(draft.ledger, {
    moduleKey: meta.key,
    rowId,
    action,
    fromStatus,
    toStatus,
    label,
    operator,
  })
}

export function runAction(
  key: string,
  id: number,
  action: string,
  operator = '值班管理员',
): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const target = meta.actionTargets[action]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const fromStatus = String(rows[index].status)
  if (fromStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 先把校验点落库，校验点版本取「本次落库之后的缓存版本」：
  // 之后只要最新落库版本仍等于它，就说明中断之后没有任何动作再落库。
  const label = rowLabel(meta, rows[index])
  const checkpointVersion = currentVersion() + 1
  const checkpoint: OperationCheckpoint = {
    moduleKey: key,
    rowId: id,
    action,
    fromStatus,
    toStatus: target,
    label,
    operator,
    version: checkpointVersion,
  }
  commit((draft) => {
    draft.checkpoint = checkpoint
  })

  try {
    commit((draft) => {
      applyToDraft(draft, {
        meta,
        rowId: id,
        action,
        toStatus: target,
        operator,
        label,
        fromStatus,
      })
      draft.checkpoint = null
    })
  } catch (error) {
    // 提交失败：校验点保留，交给 recoverInterruptedAction 重试，这里不丢动作。
    return {
      ok: false,
      message:
        error instanceof Error
          ? `动作已中断（${error.message}），已保留校验点，将在下次取数时重试`
          : '动作已中断，已保留校验点，将在下次取数时重试',
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 模拟「动作落库前操作中断」：只写缓存校验点、不提交状态变更，
 * 供台账入口演示从校验点重试；正常动作链路由 runAction 自己在提交前落校验点。
 */
export function stageInterruptedAction(
  key: string,
  id: number,
  action: string,
  operator = '值班管理员',
): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const target = meta.actionTargets[action]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const fromStatus = String(rows[index].status)
  if (fromStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，无法再中断「${action}」` }
  }
  const checkpoint: OperationCheckpoint = {
    moduleKey: key,
    rowId: id,
    action,
    fromStatus,
    toStatus: target,
    label: rowLabel(meta, rows[index]),
    operator,
    version: currentVersion() + 1,
  }
  commit((draft) => {
    draft.checkpoint = checkpoint
  })
  return { ok: true, message: `已制造中断：${meta.entity}「${action}」停在缓存校验点，等待重试` }
}

/**
 * 从缓存校验点重试被中断的动作：
 * - 校验点版本与最新落库版本一致（没人改过）→ 继续提交；
 * - 记录状态已变成目标状态（别处已完成）→ 校验点作废，不重复落库；
 * - 记录已离开起始状态 → 原动作前提失效，丢弃校验点。
 */
export function recoverInterruptedAction(operator = '值班管理员'): ActionResult | null {
  const checkpoint = readCheckpoint()
  if (!checkpoint) {
    return null
  }
  const meta = MODULE_BY_KEY.get(checkpoint.moduleKey)
  if (!meta || checkpoint.version !== currentVersion()) {
    commit((draft) => {
      draft.checkpoint = null
    })
    return null
  }
  const rows = listRows(meta.key)
  const row = rows.find((item) => Number(item.id) === checkpoint.rowId)
  if (!row) {
    commit((draft) => {
      draft.checkpoint = null
    })
    return null
  }
  const current = String(row.status)
  if (current === checkpoint.toStatus) {
    commit((draft) => {
      draft.checkpoint = null
    })
    return null
  }
  if (current !== checkpoint.fromStatus) {
    commit((draft) => {
      draft.checkpoint = null
    })
    return {
      ok: false,
      message: `${meta.entity}状态已变为「${current}」，中断动作「${checkpoint.action}」不再重试`,
    }
  }
  try {
    commit((draft) => {
      applyToDraft(draft, {
        meta,
        rowId: checkpoint.rowId,
        action: checkpoint.action,
        toStatus: checkpoint.toStatus,
        operator: checkpoint.operator || operator,
        label: checkpoint.label,
        fromStatus: checkpoint.fromStatus,
      })
      draft.checkpoint = null
    })
  } catch {
    // 提交仍然失败：校验点保留，下次取数继续重试。
    return { ok: false, message: `中断动作「${checkpoint.action}」重试失败，已保留校验点` }
  }
  return {
    ok: true,
    message: `已从校验点继续：${meta.entity}「${checkpoint.action}」，当前状态「${checkpoint.toStatus}」`,
  }
}

/**
 * 并发完成一批业务记录：每条独立校验、独立写校验点、独立提交。
 * 某条失败只回滚该条（不落状态、不写台账），其余条照常完成，互不连坐。
 */
export function runActionBatch(
  operations: BatchOperation[],
  operator = '值班管理员',
): BatchResult {
  const items: BatchItemResult[] = []
  const ledgerIds: number[] = []
  let allOk = true

  for (const op of operations) {
    const meta = MODULE_BY_KEY.get(op.moduleKey)
    if (!meta) {
      allOk = false
      items.push({
        moduleKey: op.moduleKey,
        rowId: op.rowId,
        action: op.action,
        ok: false,
        message: `没有登记名为 ${op.moduleKey} 的业务模块`,
        rolledBack: true,
      })
      continue
    }
    const result = runAction(op.moduleKey, op.rowId, op.action, operator)
    if (!result.ok) {
      allOk = false
      items.push({
        moduleKey: op.moduleKey,
        rowId: op.rowId,
        action: op.action,
        ok: false,
        message: result.message,
        // 该条未进入落库即保持原样，等价于只回滚自己这一条。
        rolledBack: true,
      })
      continue
    }
    // runAction 成功后台账最后一条就是本次写入，取回它的编号。
    const latest = listLedger()[0]
    if (latest) {
      ledgerIds.push(latest.id)
    }
    items.push({
      moduleKey: op.moduleKey,
      rowId: op.rowId,
      action: op.action,
      ok: true,
      message: result.message,
      rolledBack: false,
    })
  }

  return { ok: allOk, items, ledgerIds }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key).map((item) => withStatusFlags(meta, item))) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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

export function loadOverview(): OverviewResult {
  recoverInterruptedAction()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    // 总览取数以最新落库状态为准，逐行重算 pending/abnormal，杜绝旧快照。
    const entries = (listRows(meta.key) ?? []).map((row) => withStatusFlags(meta, row))
    return {
      key: meta.key,
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
  // 异常面板事件同样按最新落库状态汇总，不再依赖动作落库时写下的旧标志。
  const abnormals: AbnormalEvent[] = []
  for (const meta of MODULE_BY_KEY.values()) {
    for (const row of listRows(meta.key) ?? []) {
      if (!isAbnormalStatus(meta, String(row.status))) {
        continue
      }
      abnormals.push({
        moduleKey: meta.key,
        moduleName: meta.name,
        entity: meta.entity,
        rowId: Number(row.id),
        label: rowLabel(meta, row),
        status: String(row.status),
      })
    }
  }
  const moduleStats = modules.map(({ name, created, pending, abnormal }) => ({
    name,
    created,
    pending,
    abnormal,
  }))
  return { cards, modules: moduleStats, abnormals }
}

export function loadLedger(): LedgerRecord[] {
  recoverInterruptedAction()
  // 台账按时间倒序展示，最新的处置在最上面。
  return [...listLedger()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}
