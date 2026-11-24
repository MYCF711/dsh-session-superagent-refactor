import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { __test } from '../lib/index.js'
import { MAX_SANE_BACKOFF_MS, pollHealth } from '../lib/watch.js'

const { filterAdmissionBatch, optionalService } = __test

/**
 * 回归：未 inject 的服务必须在插件 fiber 里安全回退，不能抛。
 *
 * 2026-11-24 真机：助理鱼报 `cannot get property "admissionGate" without inject`
 * 之后，PR #153 几个小时唤不醒 —— 该异常发生在唤醒主路径（filterAdmissionBatch）
 * 上，tick 的 catch 把它写进 lastError 并 bumpFailure，于是每轮都在唤醒前抛异常，
 * 永远走不到真正唤醒那一步。
 *
 * 根因：`ctx` 是 cordis 的 Proxy，凡未在 `export const inject` 声明的属性，
 * 读取时**直接抛**（不是返回 undefined）。所以 `ctx.admissionGate || 兜底`
 * 里 `||` 的短路根本救不了 —— 左侧求值就抛了。
 *
 * 这里用真实 cordis Context + 真实插件 fiber 复现，而不是手写 Proxy：
 * 抛错分支要求 `defSite.fiber.runtime` 存在（即插件作用域内），
 * 根 ctx 上访问反而返回 undefined —— 手写 Proxy 会假装根 ctx 也抛，
 * 那样的用例在真实宿主里不成立。
 */

/**
 * 定位 DSH 自带的 cordis：从「装了 dsh 的那个 node_modules」按包名解析，
 * 不写死安装路径。找不到就返回 null（用例 SKIP，绝不假装通过）。
 */
function resolveCordisEntry() {
  const candidates = []
  // 1) 当前进程能否直接解析（dsh 把它装在本包 node_modules 里时成立）
  try {
    const require = createRequire(import.meta.url)
    candidates.push(require.resolve('@deepseek-ai/cordis'))
  } catch { /* 继续找 */ }
  // 2) 从 dsh 自己所在位置找它的 node_modules/@deepseek-ai/cordis
  for (const name of ['@deepseek-ai/dsh', 'dsh']) {
    try {
      const require = createRequire(import.meta.url)
      const dshEntry = require.resolve(name)
      const guess = join(dirname(dshEntry), 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
      if (existsSync(guess)) candidates.push(guess)
    } catch { /* 继续找 */ }
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

let cordisPromise
function loadCordis() {
  if (!cordisPromise) {
    cordisPromise = (async () => {
      const entry = resolveCordisEntry()
      if (!entry) return null
      try {
        return await import(pathToFileURL(entry).href)
      } catch {
        return null
      }
    })()
  }
  return cordisPromise
}

/**
 * 造一个真实的、带 fiber 的插件 context，让未 inject 的访问真的抛。
 *
 * 拿不到 cordis 时**不跳过**，退化成等价的最小实现（见 fallbackPluginContext）。
 * 原因：对抗性审计实测，在干净目录（≈ CI）下 5 条里有 3 条 SKIP，而这 3 条正是
 * 本提交全部的核心回归 —— 剩下 2 条是纯函数、在**修复前的代码上也全绿**。
 * 也就是说 SKIP 会让本文件在 CI 上「通过」但实际零覆盖，是标准假绿。
 */
async function withPluginContext(fn) {
  const cordis = await loadCordis()
  if (!cordis) return { skipped: false, value: await fallbackPluginContext(fn) }
  const { Context, Service } = cordis
  class Tools extends Service { constructor(ctx) { super(ctx, 'tools') } }
  const root = new Context()
  root.plugin({ name: 'tools', apply(ctx) { new Tools(ctx) } })
  const box = {}
  await new Promise((resolve) => {
    root.plugin({
      name: 'under-test',
      inject: ['tools'],
      apply(ctx) {
        Promise.resolve(fn(ctx, { Context, Service }))
          .then((value) => { box.value = value }, (error) => { box.error = error })
          .finally(resolve)
      },
    })
  })
  if (box.error) throw box.error
  return { skipped: false, value: box.value }
}

/**
 * 无 cordis 时的等价实现：只复刻 `ReflectService.handler.get` 中**与本用例相关**的语义。
 *
 * 为什么这就够：本文件要验证的是「未 inject 的属性读取会抛，而 optionalService 必须
 * 把它归为缺失」，这**不需要**真 cordis —— 需要的是「读未声明属性 → 抛」这一条。
 * （真实 cordis 里该分支要求 `defSite.fiber.runtime` 存在，即插件作用域内；根 ctx
 * 反而不抛。这里直接构造插件作用域的行为。）
 */
async function fallbackPluginContext(fn) {
  const DECLARED = new Set(['tools'])
  const ctx = new Proxy({ tools: { register() {} }, get: (name) => undefined }, {
    get(target, prop, receiver) {
      if (prop === 'then' || typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (Reflect.has(target, prop) || DECLARED.has(prop)) return Reflect.get(target, prop, receiver)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  return fn(ctx, {})
}

test('未 inject 的服务：真实插件 fiber 里直接读必然抛（钉住前提，防止用例失去意义）', async (t) => {
  const out = await withPluginContext((ctx) => {
    const result = {}
    try { void ctx.admissionGate; result.threw = false } catch (error) { result.threw = true; result.message = error.message }
    result.declaredReadable = typeof ctx.tools
    return result
  })
  if (out.skipped) return t.skip('本机没有可用的 cordis')
  assert.equal(out.value.threw, true, '前提失效：未 inject 的读取竟然没抛，说明 cordis 语义变了，本组用例需重写')
  assert.match(out.value.message, /cannot get property "admissionGate" without inject/)
  assert.equal(out.value.declaredReadable, 'object', '已 inject 的 tools 必须仍可读')
})

test('optionalService：未 inject 返回 undefined，不抛', async (t) => {
  const out = await withPluginContext((ctx) => {
    const result = {}
    result.missing = optionalService(ctx, 'admissionGate')
    result.missingAgain = optionalService(ctx, 'sessionController')
    result.declared = typeof optionalService(ctx, 'tools')
    result.nullsafe = optionalService(null, 'anything')
    return result
  })
  if (out.skipped) return t.skip('本机没有可用的 cordis')
  assert.equal(out.value.missing, undefined)
  assert.equal(out.value.missingAgain, undefined)
  assert.equal(out.value.declared, 'object', '已 inject 的服务仍要能取到')
  assert.equal(out.value.nullsafe, undefined, 'ctx 为 null 时也不能抛')
})

/**
 * 反向用例（对抗性审计 P0-2 指出的假绿点）。
 *
 * 原先这条断言的是「未 inject 门禁时必须放行 [153,154]」—— 但那条断言在**两种完全
 * 相反的实现**下都成立：真实现（ctx.get → undefined → 兜底）和假实现（optionalService
 * 永远 return undefined）。变异实测 M4/M5：把 ctx 路径改成永远放行、或让
 * optionalService 永远返回 undefined，5 条用例**全部仍绿**。用例钉住的是「放行」这个
 * 现象，没钉住「为什么可以放行」这个语义 —— 正是 AGENTS.md 坑 #7 的同类。
 *
 * **修正（两轮审计互相矛盾的裁决点）**：
 * 对抗性审计说「兜底 accept = fail-open，该拒绝的被放行」，常规审计说「DSH 全仓没有任何包
 * provide 门禁，改成 unknown 会永不唤醒」。**两条都成立**，所以不能二选一 ——
 * 判据必须看「刚才那次读取到底发生了什么」：
 *   ① 宿主从未提供门禁（ctx.get 返回 undefined 且无异常）→ **放行**（否则一条都唤不醒）
 *   ② 门禁存在但读取失败（记录了 miss）→ **fail-closed 且可见**
 * 下面三条用例分别钉住 ①②，以及「②不能退化成①」。
 */
test('filterAdmissionBatch：宿主本就没有门禁时必须放行（否则永不唤醒）', async (t) => {
  const out = await withPluginContext(async (ctx) => {
    const items = [{ number: 153 }, { number: 154 }]
    return {
      accepted: await filterAdmissionBatch(ctx, items, {}),
      acceptedNoDeps: await filterAdmissionBatch(ctx, items),
    }
  })
  if (out.skipped) return t.skip('本机没有可用的 cordis')
  // 真实插件的 ctx.admissionGate 会抛，但 optionalService 先走 ctx.get 拿到 undefined、
  // 且**没有记录任何 miss** → 判定为「宿主本就没有」，必须放行。
  assert.deepEqual(out.value.accepted.map((i) => i.number), [153, 154], '宿主无门禁时必须放行，而不是抛错或永远不唤醒')
  assert.deepEqual(out.value.acceptedNoDeps.map((i) => i.number), [153, 154], 'deps 省略时同样要放行')
})

test('filterAdmissionBatch：门禁读取失败时必须 fail-closed 且可见（真机形态：服务正在释放）', async () => {
  const { getAdmissionDegraded } = __test
  // 关键：**只让 gate 读失败、让 assessment 正常**。两个都失败的话，无论 fail-open
  // 还是 fail-closed 最终都返回空，「一律 accept」的变异实测也全绿（假绿）——
  // 只有 assessment 可用时，accept 才会真的走下去并放行，才能区分两种实现。
  const releasing = {
    get(name) {
      if (name === 'admissionGate') throw new Error('cannot get required service "admissionGate" in inactive context')
      if (name === 'admissionAssessment') return () => 'accept'
      return undefined
    },
  }
  const accepted = await filterAdmissionBatch(releasing, [{ number: 153 }], {})
  assert.deepEqual(accepted, [], '门禁存在但读不到时不得放行，否则等于静默关闭准入')
  assert.ok(getAdmissionDegraded(), '降级必须留痕，否则「为什么没唤醒」无从诊断')
  assert.equal(getAdmissionDegraded().gate.name, 'admissionGate')
})

test('filterAdmissionBatch：门禁返回 unknown / reject 一律不放行（判据本身）', async () => {
  const items = [{ number: 1 }, { number: 2 }]
  for (const verdict of ['unknown', 'reject']) {
    const accepted = await filterAdmissionBatch({ get: () => undefined }, items, {
      admissionGate: () => verdict,
      admissionAssessment: () => 'accept',
    })
    assert.deepEqual(accepted, [], `门禁 ${verdict} 必须不放行，不能被 assessment 翻案`)
  }
})

test('filterAdmissionBatch：无门禁时不得留下降级记录（防止 ② 退化成 ①）', async () => {
  const { getAdmissionDegraded } = __test
  await filterAdmissionBatch({ get: () => undefined }, [{ number: 1 }], {})
  assert.equal(getAdmissionDegraded(), null, '正常放行不该被记成降级')
})

test('可选服务读取失败必须留痕，不能无声吞掉（审计 P1-1）', () => {
  const { getOptionalServiceMiss } = __test
  const before = getOptionalServiceMiss()
  const releasing = { get() { throw new Error('cannot get required service "x" in inactive context') } }
  assert.equal(optionalService(releasing, 'admissionGate'), undefined)
  const after = getOptionalServiceMiss()
  assert.notDeepEqual(after, before, '真实读取失败必须被记录，否则故障不可诊断')
  assert.equal(after.name, 'admissionGate')
  assert.match(after.text, /inactive context/)
})

test('filterAdmissionBatch：显式 deps 优先于 ctx，且能真的拒绝', async () => {
  // 纯函数层面也要钉住：deps 传了就用 deps，不再去碰 ctx
  const boom = { get() { throw new Error('ctx 不该被访问') } }
  const items = [{ number: 1 }, { number: 2 }]
  const accepted = await filterAdmissionBatch(boom, items, {
    admissionGate: (candidate) => (candidate.number === 1 ? 'accept' : 'reject'),
    admissionAssessment: () => 'accept',
  })
  assert.deepEqual(accepted.map((i) => i.number), [1], 'deps 提供的门禁必须生效，且不读 ctx')
})

test('optionalService：ctx.get 抛异常时仍按缺失处理，不外泄', () => {
  const hostile = { get() { throw new Error('boom') } }
  assert.equal(optionalService(hostile, 'admissionGate'), undefined)
})

/**
 * 审计 P2-1：`nextAt` 指向远期时，旧实现判 `waiting`（绿灯）且 `tick` 无条件早退 ——
 * 「永久 waiting + 永不报故障」，与本次母问题同形（面板绿灯、实际永远不唤醒）。
 * 代码路径写不出远期值，但 `watchers.json` 是人也会手改的文件（见 lib/enabled.js 的注释）。
 */
test('pollHealth：nextAt 指向远期不得永久绿灯，必须按停摆报出来（审计 P2-1）', () => {
  const now = Date.parse('2026-11-24T10:00:00Z')
  const bootAt = now - 24 * 60 * 60 * 1000
  const base = { enabled: true, intervalSec: 60, lastPoll: new Date(now).toISOString() }

  // 正常退避（分钟级）仍是正常等待
  assert.equal(pollHealth({ ...base, nextAt: new Date(now + 5 * 60 * 1000).toISOString() }, { now, bootAt }).state, 'waiting')
  // 一年后：手改 / 时钟异常 → 必须报停摆，不能绿
  const far = pollHealth({ ...base, nextAt: new Date(now + 365 * 86400000).toISOString() }, { now, bootAt })
  assert.equal(far.state, 'stalled', '远期的 nextAt 必须报停摆，而不是永久 waiting')
  // 边界：恰好越过上限才判停摆
  assert.equal(pollHealth({ ...base, nextAt: new Date(now + MAX_SANE_BACKOFF_MS).toISOString() }, { now, bootAt }).state, 'waiting')
  assert.equal(pollHealth({ ...base, nextAt: new Date(now + MAX_SANE_BACKOFF_MS + 1000).toISOString() }, { now, bootAt }).state, 'stalled')
})

/**
 * 常规审计 D 节：提交说明声称「另外两处一起改」，但**没有任何用例守护**。
 * 变异实测 M3/M4：把这两处改回 `ctx.sessionController` 直接读，全部用例仍绿 —— 零覆盖。
 * 下面两条补上，并用真实 cordis 语义（未 inject 读取会抛）驱动。
 */
test('buildModularProjection：worker 活跃但读不到 sessionController 时必须降级为 paused，不能抛（覆盖 buildModularProjection）', async (t) => {
  const out = await withPluginContext((ctx) => {
    const { buildModularProjection } = __test
    const state = {
      tickets: { 'ticket:github:a/b#1': { id: 'ticket:github:a/b#1', status: 'assigned' } },
      assignments: { 'ticket:github:a/b#1': { sessionId: 'worker-ticket:github:a/b#1', status: 'assigned' } },
      outbox: [],
    }
    return buildModularProjection(state, ctx)
  })
  if (out.skipped) return t.skip('本机没有可用的 cordis')
  // 修复前：`!ctx.sessionController` 在真实插件 fiber 里直接抛 cannot get property
  // 注意 health 挂在 deployment 下（不是 execution），按真实结构断言
  const health = (out.value.deployment.health || []).find((h) => h.name === 'executor')
  assert.ok(health, 'executor 的 health 必须存在')
  assert.equal(health.state, 'paused', 'worker 活跃但宿主能力不可用时必须显式 paused')
  assert.equal(health.detail, 'sessionController unavailable for worker')
  assert.equal(out.value.execution.paused, true, '执行必须被标记暂停，而不是假装就绪')
})

test('createDshExecutor：未 inject 的宿主服务要报明确的 capability missing，不能抛 inject 错（覆盖 executor-host）', async (t) => {
  const out = await withPluginContext(async (ctx) => {
    const { createDshExecutor } = __test
    const executor = createDshExecutor(ctx)
    try {
      await executor.start({ ticket: { id: 'ticket:github:a/b#1', workdir: 'C:/tmp/x' }, assignment: {} })
      return { threw: null }
    } catch (error) {
      return { threw: String(error && error.message || error) }
    }
  })
  if (out.skipped) return t.skip('本机没有可用的 cordis')
  // 修复前：requireHost 用 `ctx[name]` 直接读 → 抛 `cannot get property "sessionController" without inject`
  assert.match(out.value.threw || '', /DSH host capability missing: sessionController/,
    '必须是明确的「能力缺失」，而不是底层的 inject 报错')
  assert.doesNotMatch(out.value.threw || '', /without inject/, '不得把底层 cordis 报错泄漏给调用方')
})
