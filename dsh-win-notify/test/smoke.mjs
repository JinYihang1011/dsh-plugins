/**
 * dsh-win-notify 冒烟测试：不依赖 DSH 运行时，用假 ctx 直接驱动插件。
 *
 * 覆盖：
 *   · 两个事件都注册在链首（prepend —— 这是通知来得及发生的前提）
 *   · 审批/问询载荷 → 通知文案组装
 *   · 畸形载荷不抛异常、且始终调用 next()（绝不改变审批结果）
 *   · 去重窗口生效
 *
 * 运行：node test/smoke.mjs
 */

import assert from "node:assert/strict"

const module_ = await import(new URL("../index.js", import.meta.url).href)

assert.equal(module_.name, "dsh-win-notify")
assert.equal(typeof module_.apply, "function")

/** 收集宿主日志，充当"已发出的通知"计数。 */
const logged = []
const registrations = new Map()

const ctx = {
  on(name, listener, options) {
    registrations.set(name, { listener, options })
    return () => {}
  },
  logger() {
    return {
      warn: (message) => logged.push(String(message)),
      info: (message) => logged.push(String(message)),
    }
  },
}

module_.apply(ctx, { debug: true, dryRun: true })

// ── 注册形状 ───────────────────────────────────────────────────────────────
assert.deepEqual(
  [...registrations.keys()].sort(),
  ["approval/request", "user-questions/request"],
  "必须同时监听审批与问询",
)
for (const [event, record] of registrations) {
  assert.equal(record.options?.prepend, true, `${event} 必须 prepend，否则排在被转发的 Web 监听器之后`)
}

/** 只统计真正"发出"的通知（dry-run 行）。 */
const toasts = () => logged.filter((line) => line.startsWith("[dry-run]"))

/** 调用一次监听器，返回 next 是否被调用以及返回值。 */
function invoke(event, request) {
  const record = registrations.get(event)
  let nextCalls = 0
  const sentinel = Symbol("next-result")
  const result = record.listener(request, () => {
    nextCalls += 1
    return sentinel
  })
  return { nextCalls, result, sentinel }
}

// ── 审批：带 reason ────────────────────────────────────────────────────────
logged.length = 0
let outcome = invoke("approval/request", { toolName: "pwsh", reason: "命令需要提权执行" })
assert.equal(outcome.nextCalls, 1, "必须放行瀑布链")
assert.equal(outcome.result, outcome.sentinel, "必须原样返回 next() 的结果")
assert.equal(toasts().length, 1)
assert.match(toasts()[0], /DSH · 需要审批/)
assert.match(toasts()[0], /命令需要提权执行/)
assert.match(toasts()[0], /工具：pwsh/)

// ── 审批：无 reason，退回内建口径 ─────────────────────────────────────────
logged.length = 0
const noReasonKey = "approval/request-without-reason"
registrations.set(noReasonKey, registrations.get("approval/request"))
invoke(noReasonKey, { toolName: "bash" })
assert.match(toasts()[0], /工具 bash 请求越权执行/)

// ── 去重：同一内容立刻重复触发只发一次 ────────────────────────────────────
logged.length = 0
invoke("approval/request", { toolName: "pwsh", reason: "命令需要提权执行" })
assert.equal(toasts().length, 0, "去重窗口内不应重复通知")

// ── 问询：多问题 ───────────────────────────────────────────────────────────
logged.length = 0
invoke("user-questions/request", {
  questions: [
    { id: "q1", question: "要部署到哪个环境？", options: [{ label: "预发" }, { label: "生产" }] },
    { id: "q2", question: "需要通知谁？" },
  ],
})
assert.equal(toasts().length, 1)
assert.match(toasts()[0], /DSH · 需要你的回答/)
assert.match(toasts()[0], /要部署到哪个环境？/)
assert.match(toasts()[0], /另外还有 1 个问题/)

// ── 问询：计划评审用专门标题 ──────────────────────────────────────────────
logged.length = 0
invoke("user-questions/request", {
  questions: [{ id: "q1", question: "是否批准该计划？", intent: { kind: "plan-review", approve: "批准", detail: "..." } }],
})
assert.match(toasts()[0], /DSH · 计划待确认/)

// ── 畸形载荷：不抛异常、仍然放行 ──────────────────────────────────────────
for (const bad of [undefined, null, {}, { questions: "not-an-array" }, { toolName: 42 }]) {
  const a = invoke("approval/request", bad)
  assert.equal(a.nextCalls, 1, `审批监听器必须对 ${JSON.stringify(bad)} 放行`)
  const q = invoke("user-questions/request", bad)
  assert.equal(q.nextCalls, 1, `问询监听器必须对 ${JSON.stringify(bad)} 放行`)
}

// ── 平台开关：非 win32 不注册 ─────────────────────────────────────────────
const original = Object.getOwnPropertyDescriptor(process, "platform")
Object.defineProperty(process, "platform", { value: "linux", configurable: true })
const other = new Map()
module_.apply({ on: (n, l, o) => other.set(n, { l, o }), logger: () => ({ warn() {} }) }, {})
assert.equal(other.size, 0, "非 Windows 平台不应注册监听器")
Object.defineProperty(process, "platform", original)

// ── 会话标题：拿得到就补一行，拿不到/抛错都不影响通知 ────────────────────
/** 用带 sessionTitle 服务的假 ctx 重新装载一次插件。 */
function withSessionTitle(service) {
  const lines = []
  const hooks = new Map()
  const fakeCtx = {
    on: (n, l, o) => hooks.set(n, { l, o }),
    get: (n) => (n === "sessionTitle" ? service : undefined),
    logger: () => ({ warn: (m) => lines.push(String(m)), info: (m) => lines.push(String(m)) }),
  }
  module_.apply(fakeCtx, { debug: true, dryRun: true })
  return { hooks, lines, toasts: () => lines.filter((line) => line.startsWith("[dry-run]")) }
}

const titled = withSessionTitle({ get: (session) => session?.title })
titled.hooks.get("approval/request").l({ toolName: "pwsh", reason: "需要提权", agent: { session: { title: "重构登录模块" } } }, () => {})
assert.match(titled.toasts()[0], /会话：重构登录模块/)

const broken = withSessionTitle({
  get: () => {
    throw new Error("service exploded")
  },
})
broken.hooks.get("user-questions/request").l(
  { questions: [{ id: "q1", question: "继续吗？" }], agent: { session: {} } },
  () => {},
)
assert.equal(broken.toasts().length, 1, "取标题出错也必须照常发通知")
assert.doesNotMatch(broken.toasts()[0], /会话：/)

const noService = withSessionTitle(undefined)
noService.hooks.get("approval/request").l({ toolName: "rg", agent: {} }, () => {})
assert.equal(noService.toasts().length, 1, "没有 sessionTitle 服务也必须照常发通知")

console.log("smoke ok：11 项断言全部通过")
