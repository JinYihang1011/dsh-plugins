/**
 * dsh-session-ops 浏览器半边冒烟测试。
 *
 * 不依赖浏览器与 React：用一个最小的 react 替身（`createElement` 只记结构、
 * `useSyncExternalStore` 直接把当前快照交出来）与仿制的 slots 服务，跑通
 * 「注册了几项 / 落在哪个 order / 点下去发的是什么请求 / 结果与失败各弹什么 Toast」。
 *
 * 它测不到真实渲染（那要真 React），但能挡住所有接线错误：
 * slot id 与 order、菜单文案、宿主方法的参数、Toast 的 tone/icon、错误透传。
 *
 * 运行：node test/client-smoke.mjs
 */

import { readFile } from "node:fs/promises"

let passed = 0
const failures = []
function check(label, condition, extra) {
  if (condition) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${extra === undefined ? "" : ` — ${extra}`}`)
    console.log(`  FAIL ${label}${extra === undefined ? "" : ` — ${extra}`}`)
  }
}

/* ── 仿制 window.__ModuleLoader__ ── */

const source = await readFile(new URL("../client.js", import.meta.url), "utf8")
let definition
const browserWindow = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
}
// client.js 是 Module Loader 的包体脚本（只依赖 window），按它的方式执行一次。
new Function("window", source)(browserWindow)

check("提交了一个 Module Loader 定义", definition?.id === "dsh-session-ops", String(definition?.id))
check("定义了 factory", typeof definition?.factory === "function")

/* ── 仿制 react 与 ui-primitives ── */

let snapshot
const react = {
  Fragment: Symbol("react.fragment"),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    snapshot = getSnapshot()
    return snapshot
  },
}

const primitives = {
  MenuItemButton: "MenuItemButton",
  Modal: "Modal",
  Toast: "Toast",
  IconFolderOpenOutlineRegular: "IconFolderOpenOutlineRegular",
  IconTrashOutlineRegular: "IconTrashOutlineRegular",
  IconWarningOutlineRegular: "IconWarningOutlineRegular",
  IconWorkspaceTreeOutlineRegular: "IconWorkspaceTreeOutlineRegular",
}

const exports = definition.factory((id) => {
  if (id === "react") return react
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives
  throw new Error(`Unexpected require: ${id}`)
})

check("客户端注入声明只有 slots", JSON.stringify(exports.inject) === '["slots"]', JSON.stringify(exports.inject))

/* ── 仿制 slots 服务 ── */

const registrations = new Map()
const ctx = {
  slots: {
    inject(_name, register) {
      register()
    },
    register(entry, component) {
      registrations.set(entry.id, { entry, component })
    },
  },
}
exports.apply(ctx)

const menuIds = [...registrations.entries()]
  .filter(([, value]) => value.entry.name === "sidebar.workspaces.session.menu.item")
  .map(([id, value]) => [id, value.entry.order])
check("会话行菜单注册了 3 项", menuIds.length === 3, JSON.stringify(menuIds))
check(
  "order 依次为 450 / 500 / 600",
  JSON.stringify(menuIds.map(([, order]) => order)) === "[450,500,600]",
  JSON.stringify(menuIds),
)
check("三项的 id 是插件命名空间内的", menuIds.every(([id]) => id.startsWith("session-ops.")), JSON.stringify(menuIds))
check("Overlay 宿主已注册", registrations.has("session-ops.dialogs"))

/* ── 菜单项本身 ── */

const item = registrations.get("session-ops.openLocation")
check("「打开工作区位置」已注册", item !== undefined)
check("用的宿主 MenuItemButton（保证风格一致）", item?.component({ sessionId: "s", displayTitle: "t", useMenuOpenState: () => [true, () => {}] }).type === "MenuItemButton")
check(
  "带文件夹图标",
  item?.component({ sessionId: "s", displayTitle: "t", useMenuOpenState: () => [true, () => {}] }).props.icon?.type ===
    "IconFolderOpenOutlineRegular",
)

let menuOpen = true
const menuNode = item.component({
  sessionId: "session-example",
  displayTitle: "示例会话",
  useMenuOpenState: () => [menuOpen, (next) => (menuOpen = next)],
})
check("文案为「打开工作区位置」", menuNode.children[0] === "打开工作区位置", String(menuNode.children[0]))

/* ── 点击：发什么请求、弹什么 Toast ── */

function stubFetch(responder) {
  const calls = []
  browserWindow.fetch = async (url, init) => {
    calls.push({ url, init })
    return responder()
  }
  return calls
}

function jsonResponse(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload }
}

// ① 成功
let calls = stubFetch(() => jsonResponse({ ok: true, detail: { sessionId: "session-example", path: "D:\\proj" } }))
menuOpen = true
menuNode.props.onSelect()
await new Promise((resolve) => setTimeout(resolve, 0))

check("点击后先关掉菜单", menuOpen === false)
check("请求打到插件自己的同源端点", calls[0]?.url === "/session-ops/api", String(calls[0]?.url))
check("请求带 same-origin 凭据", calls[0]?.init?.credentials === "same-origin", String(calls[0]?.init?.credentials))
const body = JSON.parse(calls[0]?.init?.body ?? "{}")
check("方法是 openLocation", body.method === "openLocation", JSON.stringify(body))
check("参数只有 sessionId", JSON.stringify(body.params) === '{"sessionId":"session-example"}', JSON.stringify(body.params))

registrations.get("session-ops.dialogs").component()
check("成功时弹出确认 Toast", typeof snapshot?.toast?.text === "string" && snapshot.toast.text.includes("已在文件管理器中打开"), JSON.stringify(snapshot?.toast))
check("Toast 文案带上了宿主返回的路径", snapshot?.toast?.text.includes("D:\\proj"), String(snapshot?.toast?.text))

// ② 失败：宿主返回 ok:false
calls = stubFetch(() => jsonResponse({ ok: false, message: "工作区目录不存在或打不开：D:\\gone" }, false, 400))
menuOpen = true
menuNode.props.onSelect()
await new Promise((resolve) => setTimeout(resolve, 0))

registrations.get("session-ops.dialogs").component()
const failureToast = snapshot?.toast
check("失败时弹出说明 Toast", typeof failureToast?.text === "string" && failureToast.text.includes("打不开工作区位置"), JSON.stringify(failureToast))
check("失败 Toast 透传宿主给的原因", failureToast?.text.includes("D:\\gone"), String(failureToast?.text))
check(
  "失败 Toast 用警告图标（tone 只有 success 有专属样式）",
  failureToast?.icon?.type === "IconWarningOutlineRegular",
  String(failureToast?.icon?.type),
)
check("失败 Toast 停得更久，读得完", failureToast?.holdMs === 10000, String(failureToast?.holdMs))

// ③ HTTP 层整个挂掉（网络错误）
stubFetch(() => {
  throw new Error("Failed to fetch")
})
menuNode.props.onSelect()
await new Promise((resolve) => setTimeout(resolve, 0))
registrations.get("session-ops.dialogs").component()
check("网络错误也变成 Toast 而不是静默", String(snapshot?.toast?.text).includes("Failed to fetch"), String(snapshot?.toast?.text))

console.log(`\n结果：${passed} 通过，${failures.length} 失败`)
for (const failure of failures) console.log(`  ✗ ${failure}`)
if (failures.length > 0) process.exitCode = 1
