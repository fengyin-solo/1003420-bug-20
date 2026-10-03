import { SEED_ROWS } from './seed'
import type { EntryRow, LedgerEntry } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
const LEGACY_LEDGER_KEY = 'forest-fire-patrol:ledger'
const LEGACY_VERSION_KEY = 'forest-fire-patrol:version'

// 单键原子提交：业务数据、处置台账、版本号打包在一个 blob 里一次 setItem 落库，
// localStorage 的单次写入是原子的，不会出现「台账已写、业务数据没写」的半成品。
type Database = {
  version: number
  entries: Record<string, EntryRow[]>
  ledger: LedgerEntry[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 抽出存储适配器：页面走 localStorage，单测可以注入会失败的假存储。
export interface StorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

let adapter: StorageAdapter | null | undefined

function storage(): StorageAdapter | null {
  if (adapter === undefined) {
    adapter =
      typeof window === 'undefined' || !window.localStorage ? null : window.localStorage
  }
  return adapter
}

// 仅供测试替换存储实现。
export function _setStorageAdapter(custom: StorageAdapter | null): void {
  adapter = custom
  invalidateCache()
}

function seedDatabase(): Database {
  return { version: 1, entries: clone(SEED_ROWS), ledger: [] }
}

function readJSON<T>(raw: string | null, fallback: () => T): T {
  if (!raw) {
    return fallback()
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback()
  }
}

// 兼容旧版本拆键存储：读到老格式时合并成新的单 blob。
function migrateLegacy(backend: StorageAdapter): Database | null {
  const rawEntries = backend.getItem(STORAGE_KEY)
  if (!rawEntries) {
    return null
  }
  const entries = readJSON<Record<string, EntryRow[]> | null>(rawEntries, () => null)
  if (!entries) {
    return null
  }
  const ledger = readJSON<LedgerEntry[]>(backend.getItem(LEGACY_LEDGER_KEY), () => [])
  const version = Number(backend.getItem(LEGACY_VERSION_KEY)) || 1
  return { version, entries: { ...clone(SEED_ROWS), ...entries }, ledger }
}

function isDatabase(value: unknown): value is Database {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.version === 'number' &&
    typeof candidate.entries === 'object' &&
    Array.isArray(candidate.ledger)
  )
}

function readDatabase(): Database {
  const backend = storage()
  if (!backend) {
    return seedDatabase()
  }
  const raw = backend.getItem(STORAGE_KEY)
  const parsed = readJSON<unknown>(raw, () => null)
  const valid = isDatabase(parsed)
  const db = valid
    ? parsed
    : // 旧版本拆键存储（或损坏数据）：迁移老格式，迁不了就播种。
      migrateLegacy(backend) ?? seedDatabase()
  if (!valid) {
    // 首次打开或旧格式：重写成单键格式，落库版本以迁移值为准。
    backend.setItem(STORAGE_KEY, JSON.stringify(db))
  }
  // 以落库值为准，但补齐示例数据里后来新增的模块。
  db.entries = { ...clone(SEED_ROWS), ...db.entries }
  return db
}

// 内存缓存：带版本号，读取前向 localStorage 校验，版本落后就作废重读。
let cache: Database | null = null

export function invalidateCache(): void {
  cache = null
}

// 缓存校验点：把缓存与最新落库值对齐，返回当前数据。
export function syncFromStorage(): Database {
  if (cache === null) {
    cache = readDatabase()
  } else {
    const persisted = readVersion()
    if (persisted !== cache.version) {
      cache = readDatabase()
    }
  }
  return cache
}

function readVersion(): number {
  const backend = storage()
  if (!backend) {
    return cache?.version ?? 0
  }
  const db = readJSON<Database | null>(backend.getItem(STORAGE_KEY), () => null)
  const version = typeof db?.version === 'number' ? db.version : 0
  return version
}

export function allRows(): Record<string, EntryRow[]> {
  return syncFromStorage().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export interface CommitUnit {
  key: string
  rows: EntryRow[]
  ledger: LedgerEntry[]
}

// 把一批模块改动原子落库：单次 setItem，失败整体不生效（缓存不变，由调用方从校验点重试）。
export function persistUnits(units: CommitUnit[]): void {
  const current = syncFromStorage()
  const entries = { ...current.entries }
  const ledger = [...current.ledger]
  for (const unit of units) {
    entries[unit.key] = unit.rows
    ledger.push(...unit.ledger)
  }
  const next: Database = { version: current.version + 1, entries, ledger }
  const serialized = JSON.stringify(next)

  const backend = storage()
  if (!backend) {
    // 没有可写存储（SSR / 测试环境）：只推进内存版本，保证语义一致。
    cache = next
    return
  }
  // 一次原子写入：写成功才推进缓存版本，写失败缓存原样保留，天然支持回滚。
  backend.setItem(STORAGE_KEY, serialized)
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  persistUnits([{ key, rows, ledger: [] }])
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ---- 处置台账 -------------------------------------------------------------

// 台账同样走版本校验，始终读到最新落库的那份。
export function listLedger(): LedgerEntry[] {
  return syncFromStorage().ledger
}

// ---- 跨标签页：别处落库后，本机缓存立即作废，下次读取重新校验 --------------

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      invalidateCache()
    }
  })
}
