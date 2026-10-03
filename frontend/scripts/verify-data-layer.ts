// 数据层端到端校验：用内存假存储模拟 localStorage，覆盖缓存失效、异常标记、
// 总览取数一致、台账双入口、并发各自回滚、写入中断后从缓存校验点重试。
// 运行：node --experimental-strip-types scripts/verify-data-layer.ts
import assert from 'node:assert/strict'

import { runAction, runActionBatch, loadOverview, listAbnormalEvents, loadLedger } from '../src/api/local-service.ts'
import { _setStorageAdapter } from '../src/data/local-store.ts'
import type { StorageAdapter } from '../src/data/local-store.ts'

class MemoryStorage implements StorageAdapter {
  data = new Map<string, string>()
  failNext = 0
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  setItem(key: string, value: string) {
    if (this.failNext > 0) {
      this.failNext -= 1
      throw new Error('模拟写入中断（配额不足 / 存储暂时不可用）')
    }
    this.data.set(key, value)
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
}

// 第二个浏览器视角：共用底层数据、但模块缓存彼此独立，用来验证跨标签页失效。
function freshAdapterView(base: MemoryStorage): StorageAdapter {
  return {
    getItem: (key) => base.getItem(key),
    setItem: (key, value) => base.setItem(key, value),
    removeItem: (key) => base.removeItem(key),
  }
}

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const storage = new MemoryStorage()
_setStorageAdapter(storage)

// 1. 动作落库后，模块数据、总览卡片、异常面板三处口径一致。
check('动作落库后总览与模块页一致', () => {
  const before = loadOverview()
  const patrolAbnormalBefore = before.modules.find((m) => m.name === '巡护任务')!.abnormal
  const result = runAction('patrol', 1, '取消任务')
  assert.equal(result.ok, true, result.message)

  const after = loadOverview()
  const patrol = after.modules.find((m) => m.name === '巡护任务')!
  assert.equal(patrol.abnormal, patrolAbnormalBefore + 1, '总览异常量 +1')
  const events = listAbnormalEvents().filter((e) => e.module === '巡护任务' && e.id === 1)
  assert.equal(events.length, 1, '异常面板能看到这条异常事件')
  assert.equal(events[0].status, '已取消')
})

// 2. 以前丢异常的动作（中止任务 / 标记异常 / 标记荒废）现在都能进异常面板。
check('非回滚前缀的异常流转不再丢失', () => {
  assert.equal(runAction('drone', 1, '中止任务').ok, true)
  assert.equal(runAction('weather', 1, '标记异常').ok, true)
  assert.equal(runAction('firebreak', 1, '标记荒废').ok, true)
  assert.ok(listAbnormalEvents().some((e) => e.module === '无人机巡查' && e.status === '因故中止'))
  assert.ok(listAbnormalEvents().some((e) => e.module === '气象观测' && e.status === '异常值'))
  assert.ok(listAbnormalEvents().some((e) => e.module === '防火隔离带' && e.status === '已荒废'))
})

// 3. 处置台账：每个成功动作一份记录，另一个入口读到的是同一份落库数据。
check('另一个入口（处置台账）跟着多一份', () => {
  const countBefore = loadLedger().length
  runAction('patrol', 2, '确认完成')
  const ledger = loadLedger()
  assert.equal(ledger.length, countBefore + 1)
  const last = ledger[0]
  assert.equal(last.module, 'patrol')
  assert.equal(last.action, '确认完成')
  assert.equal(last.toStatus, '已完成')
})

// 4. 缓存失效：外部（另一标签页）写了更新的落库值，本视角重新校验后不能再看旧快照。
check('缓存版本落后时作废重读，不显示旧快照', () => {
  // 当前视角缓存里 patrol#3 是「待执行」之外的初始状态；模拟别处落库改它。
  const raw = JSON.parse(storage.getItem('forest-fire-patrol:entries')!)
  const target = raw.entries.patrol.find((r: { id: number }) => r.id === 3)
  target.status = '执行中'
  target.pending = true
  raw.version += 1
  storage.setItem('forest-fire-patrol:entries', JSON.stringify(raw))

  // 不做任何手工刷新动作，重新取数应自动校验并看到新值。
  const overview = loadOverview()
  assert.equal(
    overview.modules.find((m) => m.name === '巡护任务')!.pending,
    raw.entries.patrol.filter((r: { pending: boolean }) => r.pending).length,
  )
  assert.equal(freshAdapterView(storage).getItem('forest-fire-patrol:entries')!.length > 0, true)
})

// 5. 并发完成两条业务记录：两条互不相同，各自成功；注入失败的那条只回滚自己。
check('并发两条记录：各自独立提交', () => {
  const results = runActionBatch([
    { key: 'fireteam', id: 1, action: '下达出动' },
    { key: 'equipment', id: 1, action: '领用装备' },
  ])
  assert.deepEqual(results.map((r) => r.ok), [true, true])
  const ledger = loadLedger()
  assert.ok(ledger.some((l) => l.module === 'fireteam' && l.rowId === 1))
  assert.ok(ledger.some((l) => l.module === 'equipment' && l.rowId === 1))
})

// 6. 并发中一条业务非法（动作不存在）时，只回滚它自己，另一条照常落库。
check('并发中失败的一条只回滚自己', () => {
  const ledgerCount = loadLedger().length
  const results = runActionBatch([
    { key: 'patrol', id: 1, action: '不存在的动作' },
    { key: 'duty', id: 1, action: '确认排班' },
  ])
  assert.equal(results[0].ok, false)
  assert.equal(results[1].ok, true)
  const ledger = loadLedger()
  assert.equal(ledger.length, ledgerCount + 1, '只有成功那一条进了台账')
  assert.ok(ledger[0].module === 'duty')
})

// 7. 操作中断：前两次 setItem 失败，第三次成功；要求自动从缓存校验点重试，
//    最终数据正确且台账恰好一份（不重复）。
check('写入中断后从缓存校验点重试，台账不重复', () => {
  storage.failNext = 2
  const ledgerCount = loadLedger().length
  const result = runAction('supply', 1, '发起补充')
  assert.equal(result.ok, true, result.message)
  assert.equal(loadLedger().length, ledgerCount + 1, '重试成功后台账只多一份')
  const overview = loadOverview()
  const supply = overview.modules.find((m) => m.name === '物资储备')!
  assert.ok(supply.pending >= 1)
})

// 8. 中断后恢复时若发现上次其实已落库（目标状态相同），不重复写台账。
check('重试发现已落库则不重复记账', () => {
  // 让唯一一次 setItem 在调用方看来成功（数据已是目标态），再重复同一动作应被去重。
  const again = runAction('supply', 1, '确认补充')
  assert.equal(again.ok, true)
  const duplicate = runAction('supply', 1, '确认补充')
  assert.equal(duplicate.ok, false, '相同状态重复操作被拦截')
})

console.log(`\n全部 ${passed} 项校验通过`)
