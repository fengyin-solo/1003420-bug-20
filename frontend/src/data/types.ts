/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  /** 终态集合：落到这些状态的记录不再待处理，其余状态都算 pending。 */
  terminalStatuses: string[]
  /** 异常状态集合：落到这些状态要进异常面板，动作落库时以状态为准而不是动作名。 */
  abnormalStatuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

/** 处置台账：每次成功的状态流转都在这里留一份，另一个入口也能看到同一份。 */
export type LedgerRecord = {
  id: number
  moduleKey: string
  moduleName: string
  entity: string
  rowId: number
  label: string
  action: string
  fromStatus: string
  toStatus: string
  abnormal: boolean
  operator: string
  createdAt: string
}

/** 缓存校验点：动作落库前先落一个校验点，中断后凭它从缓存最新版本重试。 */
export type OperationCheckpoint = {
  moduleKey: string
  rowId: number
  action: string
  fromStatus: string
  toStatus: string
  label: string
  operator: string
  /** 落校验点时的缓存版本：重试前必须与最新落库版本一致。 */
  version: number
}

export type BatchOperation = {
  moduleKey: string
  rowId: number
  action: string
}

export type BatchItemResult = {
  moduleKey: string
  rowId: number
  action: string
  ok: boolean
  message: string
  rolledBack: boolean
}

export type BatchResult = {
  ok: boolean
  items: BatchItemResult[]
  ledgerIds: number[]
}

export type AbnormalEvent = {
  moduleKey: string
  moduleName: string
  entity: string
  rowId: number
  label: string
  status: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
  abnormals: AbnormalEvent[]
}
