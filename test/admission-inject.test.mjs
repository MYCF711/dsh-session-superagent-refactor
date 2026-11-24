import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { __test } from '../lib/index.js'

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

/** 造一个真实的、带 fiber 的插件 context，让未 inject 的访问真的抛。 */
async function withPluginContext(fn) {
  const cordis = await loadCordis()
  if (!cordis) return { skipped: true }
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

test('filterAdmissionBatch：未 inject gate 时走 accept 兜底，整批放行（真机回归）', async (t) => {
  const out = await withPluginContext(async (ctx) => {
    const items = [{ number: 153 }, { number: 154 }]
    return {
      accepted: await filterAdmissionBatch(ctx, items, {}),
      acceptedNoDeps: await filterAdmissionBatch(ctx, items),
    }
  })
  if (out.skipped) return t.skip('本机没有可用的 cordis')
  // 修复前：这里抛 `cannot get property "admissionGate" without inject`，一条也放行不了
  assert.deepEqual(out.value.accepted.map((i) => i.number), [153, 154], '未注入门禁时必须回退放行，而不是抛错')
  assert.deepEqual(out.value.acceptedNoDeps.map((i) => i.number), [153, 154], 'deps 省略时同样不能抛')
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
