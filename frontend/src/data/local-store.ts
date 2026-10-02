import { SEED_ROWS } from './seed'
import type { EntryRow, LedgerRecord, OperationCheckpoint } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// v2 结构：版本号 + 处置台账 + 动作校验点；v1 只有纯 entries，读到旧结构时自动迁移。
type PersistedState = {
  version: number
  entries: Record<string, EntryRow[]>
  ledger: LedgerRecord[]
  checkpoint: OperationCheckpoint | null
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedState(): PersistedState {
  return { version: 0, entries: clone(SEED_ROWS), ledger: [], checkpoint: null }
}

function readPersisted(): PersistedState {
  const fallback = seedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as PersistedState | Record<string, EntryRow[]>
    // v1 旧结构：直接就是 entries 表，迁移成带版本的新结构。
    if (!parsed || typeof parsed !== 'object' || !('entries' in parsed)) {
      const migrated: PersistedState = {
        version: 1,
        entries: { ...clone(SEED_ROWS), ...(parsed as Record<string, EntryRow[]>) },
        ledger: [],
        checkpoint: null,
      }
      return migrated
    }
    const state = parsed as PersistedState
    return {
      version: typeof state.version === 'number' ? state.version : 1,
      entries: { ...clone(SEED_ROWS), ...(state.entries ?? {}) },
      ledger: Array.isArray(state.ledger) ? state.ledger : [],
      checkpoint: state.checkpoint ?? null,
    }
  } catch {
    persist(fallback)
    return fallback
  }
}

function persist(state: PersistedState): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

// 内存缓存带上版本号：版本以最新落库值为准，缓存落后就整体丢弃重读。
let cache: PersistedState | null = null

function syncCache(): PersistedState {
  if (cache === null) {
    cache = readPersisted()
    return cache
  }
  // 另一个入口（标签页/窗口）可能已经落库：以最新落库版本为准校验缓存。
  const fresh = readPersisted()
  if (fresh.version !== cache.version) {
    cache = fresh
  }
  return cache
}

// 同机另一个入口写入时立刻作废本入口缓存，避免详情重复显示旧快照。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

/** 提交一次写入：版本号 +1 后整体落库，缓存版本随之更新。 */
function commit(mutate: (draft: PersistedState) => void): PersistedState {
  const state = clone(syncCache())
  mutate(state)
  state.version += 1
  persist(state)
  cache = state
  return state
}

export function currentVersion(): number {
  return syncCache().version
}

export function allRows(): Record<string, EntryRow[]> {
  return syncCache().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit((draft) => {
    draft.entries[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function listLedger(): LedgerRecord[] {
  return clone(syncCache().ledger)
}

export function readCheckpoint(): OperationCheckpoint | null {
  const checkpoint = syncCache().checkpoint
  return checkpoint ? clone(checkpoint) : null
}

export function storageKey(): string {
  return STORAGE_KEY
}

export { commit }
