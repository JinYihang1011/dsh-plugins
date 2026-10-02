/**
 * dsh-tiger-talisman 浏览器半边自测。
 *
 * 不需要浏览器：用最小 document 替身 + 一个假的 slots 服务跑一遍，验证
 *   · 领地表把插槽分成 列表 / 独占 / 键控 三类；
 *   · **独占型被多人占用才判冲突**，列表型多人占用不判（这是体检口径的地基）；
 *   · 样式领地按插件聚合，重复挂载（同一插件多张样式表）能被看出来；
 *   · 报告渲染不抛错，且把冲突写进正文；
 *   · 入口注册进 sidebar.panellist + main，样式表幂等且可清理。
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

/* ── 最小 DOM ── */

function makeEl(tag) {
  const node = {
    tagName: tag,
    className: "",
    dataset: {},
    style: {},
    children: [],
    parent: null,
    textContent: "",
    append(...kids) {
      for (const kid of kids) {
        kid.parent = node
        node.children.push(kid)
      }
    },
    replaceChildren(...kids) {
      node.children = []
      node.append(...kids)
    },
    remove() {
      const parent = node.parent
      if (parent === null) return
      const at = parent.children.indexOf(node)
      if (at >= 0) parent.children.splice(at, 1)
      node.parent = null
    },
    setAttribute() {},
    addEventListener() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
  }
  return node
}

/** head：只认 `style[data-plugin…]` 这两种选择器，够本插件用。 */
const head = makeEl("head")
head.querySelector = (selector) => {
  const match = /^style\[data-plugin="(.+)"\]$/.exec(selector)
  if (match === null) return null
  return head.children.find((node) => node.tagName === "style" && node.dataset.plugin === match[1]) ?? null
}
head.querySelectorAll = (selector) => (selector === "style[data-plugin]" ? head.children.filter((node) => node.tagName === "style") : [])

const document = {
  head,
  createElement: (tag) => makeEl(tag),
  querySelector: (selector) => head.querySelector(selector),
  querySelectorAll: () => [],
}

/* 预置两张别人的样式表：mnemon 只有一张；某个插件两张（重复挂载痕迹） */
function seedStyle(plugin, text) {
  const node = makeEl("style")
  node.dataset.plugin = plugin
  node.textContent = text
  head.append(node)
  return node
}
seedStyle("dsh-mnemon", ".a{color:red}.b{z-index:1300}")
seedStyle("dsh-ui-tweaks", ".c{background:transparent !important;z-index:2100}")
seedStyle("dsh-ui-tweaks", ".d{background:transparent !important}")

/* ── Module Loader 与 require 替身 ── */

const source = await readFile(new URL("../client.js", import.meta.url), "utf8")
let definition
const browserWindow = { __ModuleLoader__: { load: (value) => (definition = value) } }
new Function("window", "document", source)(browserWindow, document)

check("提交了一个 Module Loader 定义", definition?.id === "dsh-tiger-talisman", String(definition?.id))

const moduleExports = definition.factory((name) => {
  if (name === "react") return { useRef: () => ({ current: null }), useState: () => [null, () => {}], useEffect: () => {} }
  if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null }
  if (name === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("宿主没提供 primitives —— 走内联 SVG 兜底")
  throw new Error(`不该 require ${name}`)
})

const internals = moduleExports.internals

/* ── ① 领地表 ── */

const kinds = new Set(Object.values(internals.TERRITORIES).map((row) => row.kind))
check("领地表覆盖 列表 / 独占 / 键控 三类", kinds.has("list") && kinds.has("exclusive") && kinds.has("keyed"), [...kinds].join(","))
check("shell.overlay 被标为独占（全屏弹层同刻只该有一个）", internals.TERRITORIES["shell.overlay"]?.kind === "exclusive")
check("sidebar.panellist 被标为列表（入口本来就该并列）", internals.TERRITORIES["sidebar.panellist"]?.kind === "list")

/* ── ② 插槽采集与冲突口径 ── */

const entries = {
  "shell.overlay": [{ options: { id: "a" } }, { options: { id: "b" } }],
  "sidebar.panellist": [{ options: { id: "plugins" } }, { options: { id: "mnemon" } }],
  main: [{ options: { key: "plugins" } }],
}
const fakeSlots = { entriesOfSlot: (slot) => entries[slot] ?? [] }

const slotRows = internals.collectSlots(fakeSlots)
const overlay = slotRows.find((row) => row.slot === "shell.overlay")
const panellist = slotRows.find((row) => row.slot === "sidebar.panellist")
const mainRow = slotRows.find((row) => row.slot === "main")
check("独占型插槽被多人占用 → 判冲突", overlay?.conflict === true, JSON.stringify(overlay))
check("列表型插槽被多人占用 → 不判冲突", panellist?.conflict === false, JSON.stringify(panellist))
check("键控插槽即使多人注册也不算冲突（宿主按 key 只渲染一个）", mainRow?.conflict === false, JSON.stringify(mainRow))
check("占用者 id 采集正确", overlay?.owners.map((owner) => owner.id).join(",") === "a,b", JSON.stringify(overlay?.owners))
check("冲突行排在前面（报告先给要紧的）", slotRows[0]?.conflict === true, JSON.stringify(slotRows.slice(0, 2)))
check("slots 服务缺失时不抛错（面板显示空表而不是崩）", internals.collectSlots(undefined).every((row) => row.owners.length === 0))

/* ── ③ 样式领地 ── */

const styleRows = internals.collectStyles()
const uiTweaks = styleRows.find((row) => row.plugin === "dsh-ui-tweaks")
check("按插件聚合样式表，并数出张数", uiTweaks?.sheets === 2, JSON.stringify(uiTweaks))
check("数出 !important 数量", uiTweaks?.importants === 2, JSON.stringify(uiTweaks))
check("抽出 z-index 并去重排序", uiTweaks?.zIndexes.join(",") === "2100", JSON.stringify(uiTweaks?.zIndexes))
check("重复挂载（同一插件多张样式表）能被识别", styleRows.filter((row) => row.sheets > 1).map((row) => row.plugin).join(",") === "dsh-ui-tweaks")
check("没有 z-index 的插件给空数组而不是 undefined", styleRows.find((row) => row.plugin === "dsh-mnemon")?.zIndexes.join(",") === "1300")

/* ── ④ 层级命名 ── */

check("z-index 30 归到轨道/图标栏", internals.layerName(30) === "轨道/图标栏", internals.layerName(30))
check("z-index 1300 归到覆盖层/弹窗", internals.layerName(1300) === "覆盖层 / 弹窗", internals.layerName(1300))
check("z-index 9999 归到系统层", internals.layerName(9999) === "系统层（宿主设置、模态）", internals.layerName(9999))

/* ── ⑤ 报告渲染 ── */

const host = makeEl("div")
internals.renderReport(host, {
  phase: "ready",
  client: { slots: slotRows, styles: styleRows },
  host: {
    plugins: [{ name: "dsh-ui-tweaks", version: "1.0.0", local: true, inBundles: true, hasClient: true, clientPlatform: "web" }],
    skills: [{ name: "demo-skill", dir: "demo-skill", description: "演示" }],
  },
})
function textOf(node) {
  return (node.textContent ?? "") + node.children.map(textOf).join("")
}
const report = textOf(host)
check("报告渲染不抛错且有内容", report.length > 0)
check("报告把冲突写进正文", report.includes("独占型插槽被多人占用") && report.includes("shell.overlay"))
check("报告列出重复挂载痕迹", report.includes("重复挂载痕迹"))
check("报告包含 插件 / 技能 数量", report.includes("插件 1 个") && report.includes("技能 1 个"))
check("报告分四段", report.includes("① 插槽领地") && report.includes("② 样式领地") && report.includes("③ 插件") && report.includes("④ 技能"))

const emptyHost = makeEl("div")
internals.renderReport(emptyHost, { phase: "ready", client: { slots: [], styles: [] }, host: { plugins: [], skills: [] } })
check("空体检也能渲染（不抛错，且明确说未发现冲突）", textOf(emptyHost).includes("未发现独占型插槽被多人占用"))

const errorHost = makeEl("div")
internals.renderReport(errorHost, { phase: "error", error: "boom" })
check("体检失败时报告里说明原因", textOf(errorHost).includes("体检失败：boom"))

/* ── ⑥ 安装：注册入口与样式表 ── */

const effects = []
const injectCalls = []
const registrations = []
const ctx = {
  effect(factory, label) {
    effects.push({ dispose: factory(), label })
  },
  inject(deps, callback) {
    injectCalls.push({ deps, callback })
    return () => {}
  },
}
const scopedSlots = {
  inject(name, callback) {
    return callback()
  },
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
  entriesOfSlot: () => [],
}
moduleExports.apply(ctx)
check("样式表挂上了", head.children.some((node) => node.dataset.plugin === "dsh-tiger-talisman"))
check("用 ctx.inject(['slots']) 取服务（拿不到也不影响其它段）", injectCalls.length === 1 && injectCalls[0].deps.join(",") === "slots", JSON.stringify(injectCalls.map((call) => call.deps)))

const before = registrations.length
injectCalls[0].callback({ slots: scopedSlots })
const added = registrations.slice(before)
const panelEntry = added.find((row) => row.options.name === "sidebar.panellist")
const mainEntry = added.find((row) => row.options.name === "main")
check("注册了 sidebar.panellist 入口", panelEntry !== undefined && panelEntry.options.id === "tiger-talisman", JSON.stringify(added.map((row) => row.options.name)))
check("入口标签是「虎符咒」", panelEntry?.options.label?.() === "虎符咒", String(panelEntry?.options.label?.()))
check("注册了 main 主面板，key 与入口 id 同名", mainEntry?.options.key === "tiger-talisman", String(mainEntry?.options.key))
check("入口 order 在 MCP连接器(40) 之后", panelEntry?.options.order === 50, String(panelEntry?.options.order))

moduleExports.apply(ctx)
check("重复 apply 不会插第二张样式表", head.children.filter((node) => node.dataset.plugin === "dsh-tiger-talisman").length === 1)

effects[0].dispose()
check("样式 effect 清理后摘掉自己的样式表", head.children.every((node) => node.dataset.plugin !== "dsh-tiger-talisman"))

let threw = false
try {
  new Function("window", "document", source)(browserWindow, undefined)
  definition.factory(() => ({})).apply({ effect() {} })
} catch (error) {
  threw = true
  console.log(`   （缺 document 时抛错：${error}）`)
}
check("没有 document 时不抛错（安静跳过）", threw === false)

console.log(`\n结果：${passed} 通过，${failures.length} 失败`)
for (const failure of failures) console.log(`  ✗ ${failure}`)
if (failures.length > 0) process.exitCode = 1
