/** 单用户 Executor 的 DSH 宿主适配；无宿主能力时显式失败，不回退当前会话。 */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { redact } from '../redact.js'

export function workerSessionId(ticketId) {
  const id = String(ticketId || '').trim()
  if (!id) throw new TypeError('ticketId is required')
  return `worker-${id}`
}

function unwrap(result, sessionId) {
  if (result && result.agent) return result.agent
  const error = result && result.error
  const wrapped = new Error(error && error.message || `session not available: ${sessionId}`)
  wrapped.code = error && error.code || 'SESSION_UNAVAILABLE'
  throw wrapped
}

export function createDshExecutor(ctx = {}) {
  /**
   * 读宿主能力服务。
   *
   * 必须与 `lib/index.js` 的 `optionalService()` 用**同一套读取语义**，否则会出现
   * 「登记阶段取到了、投递阶段取不到」：`recordRuntimeDelivery` 用宽容的 `ctx.get()`
   * 落盘成一个 `worker-* / status: assigned` 的 assignment，而这里用 `ctx[name]`
   * 直接属性读取 —— cordis 对**未 inject** 的属性读取**直接抛**
   * `cannot get property "x" without inject`，于是投递时抛错，状态里留下一个
   * 永远 assigned、从未被执行的 worker assignment（`workerActive` 仍为真，
   * 投影的 paused/health 与实际情况错位）。
   *
   * 这里只做「取不到就报缺失」的判定，不吞错 —— 调用方要的是明确的
   * `DSH host capability missing: <name>`，而不是一个含义模糊的 undefined。
   */
  function requireHost(name) {
    let service
    try {
      if (typeof ctx.get === 'function') service = ctx.get(name)
    } catch { /* 服务正在释放 / fiber 不活跃：按缺失处理 */ }
    if (service === undefined || service === null) {
      try {
        service = ctx[name]
      } catch { /* 未 inject 的直接读取会抛：按缺失处理 */ }
    }
    if (!service) throw new TypeError(`DSH host capability missing: ${name}`)
    return service
  }
  async function resolve(sessionId) {
    const controller = requireHost('sessionController')
    if (typeof controller.resolveAgent !== 'function') throw new TypeError('DSH host capability missing: sessionController.resolveAgent')
    return unwrap(await controller.resolveAgent(sessionId), sessionId)
  }
  return Object.freeze({
    async start({ ticket, assignment } = {}) {
      const workdir = String(assignment && assignment.workdir || ticket && ticket.workdir || '')
      if (!isAbsolute(workdir)) throw new TypeError('executor workdir must be absolute')
      const sessionId = workerSessionId(ticket && ticket.id)
      const controller = requireHost('sessionController')
      let result = await controller.resolveAgent(sessionId)
      if (result && result.error && result.error.code === 'session/not-found') {
        const registry = requireHost('workspaceRegistry')
        if (typeof registry.create !== 'function') throw new TypeError('DSH host capability missing: workspaceRegistry.create')
        const workspace = await registry.create(workdir)
        if (typeof controller.create !== 'function') throw new TypeError('DSH host capability missing: sessionController.create')
        await controller.create({ sessionId, workspaceId: workspace.id, agentPreset: 'standard' })
        result = await controller.resolveAgent(sessionId)
      }
      const agent = unwrap(result, sessionId)
      return { ok: true, sessionId: agent.id || sessionId, workdir }
    },
    async prompt({ ticket, prompt, messageId } = {}) {
      const sessionId = workerSessionId(ticket && ticket.id)
      const agent = await resolve(sessionId)
      if (agent.status && agent.status !== 'idle') return { ok: false, busy: true, error: `worker busy: ${agent.status}`, sessionId }
      const message = {
        id: messageId || randomUUID(), role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: redact(String(prompt || '')) }],
      }
      if (typeof agent.followup === 'function') { await agent.followup(message); return { ok: true, via: 'followup', sessionId } }
      if (typeof agent.steer === 'function') { await agent.steer(message); return { ok: true, via: 'steer', sessionId } }
      const inbox = agent.inbox || agent.session && agent.session.inbox
      if (inbox && typeof inbox.append === 'function') {
        await inbox.append('next-turn', message)
        return { ok: true, via: 'inbox.append', sessionId }
      }
      throw new TypeError('worker session has no followup/steer/inbox delivery port')
    },
    async status({ ticket } = {}) {
      const sessionId = workerSessionId(ticket && ticket.id)
      const agent = await resolve(sessionId)
      const hostStatus = String(agent.status || '')
      const status = hostStatus === 'running' ? 'assigned' : hostStatus === 'idle' ? 'waiting' : hostStatus === 'ended' ? 'ended' : null
      if (!status) throw new TypeError(`unknown worker status: ${hostStatus || 'missing'}`)
      return { sessionId, status, hostStatus }
    },
    async stop({ ticket, reason = '' } = {}) {
      const sessionId = workerSessionId(ticket && ticket.id)
      const agent = await resolve(sessionId)
      if (typeof agent.cancel !== 'function') throw new TypeError('worker session has no cancel port')
      await agent.cancel({ kind: 'user', reason: String(reason) }, { keepInbox: true })
      return { ok: true, sessionId }
    },
  })
}
