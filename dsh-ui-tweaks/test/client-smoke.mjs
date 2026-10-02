/**
 * dsh-ui-tweaks 浏览器半边冒烟测试。
 *
 * 不需要浏览器：用一个最小的 document 替身（querySelector / createElement / head.append /
 * addEventListener / documentElement）跑一遍 apply，检查
 *   · 只注入一张样式表，且重复 apply 不会插第二张；
 *   · 样式与监听分属两个 effect，各自的清理函数真的把对应产物摘掉；
 *   · 七段微调各自的选择器都在；
 *   · mask 用的数据 URI 能解码回一段合法、几何正确的 SVG（不是被 # 或引号截断的半截）；
 *   · 🧩 确实被 font-size: 0 收掉（否则图标会变成 emoji + 线性图标叠在一起）；
 *   · ⑦ 只在 dsh-cron 确实打开、且点的是侧栏面板行时才派发它自己的激活事件。
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

/* ── 仿制 document ── */

/** 最小元素：够 ⑧ 的收起态菜单用（属性、子节点、contains、closest、remove）。 */
function makeElement(tagName) {
  const node = {
    tagName,
    dataset: {},
    textContent: "",
    innerHTML: "",
    children: [],
    parent: null,
    attrs: new Map(),
    handlers: new Map(),
    setAttribute(name, value) {
      node.attrs.set(name, String(value))
    },
    getAttribute(name) {
      return node.attrs.has(name) ? node.attrs.get(name) : null
    },
    hasAttribute(name) {
      return node.attrs.has(name)
    },
    append(child) {
      child.parent = node
      node.children.push(child)
    },
    remove() {
      const parent = node.parent
      if (parent === null) return
      const at = parent.children.indexOf(node)
      if (at >= 0) parent.children.splice(at, 1)
      node.parent = null
    },
    contains(other) {
      return other === node || node.children.includes(other)
    },
    closest() {
      return null
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    style: {
      props: new Map(),
      setProperty(name, value, priority) {
        node.style.props.set(name, `${value}|${priority ?? ""}`)
      },
      getPropertyValue(name) {
        return node.style.props.get(name) ?? ""
      },
      removeProperty(name) {
        node.style.props.delete(name)
      },
    },
    addEventListener(type, fn) {
      const list = node.handlers.get(type) ?? []
      list.push(fn)
      node.handlers.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = node.handlers.get(type) ?? []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    click() {
      node.clicked = (node.clicked ?? 0) + 1
      for (const fn of node.handlers.get("click") ?? []) fn({ target: node, preventDefault() {}, stopPropagation() {} })
    },
  }
  return node
}

const head = makeElement("head")

/** 面板行：一个 outlet 里包着一个带 aria-label 的按钮，模拟 sidebar.panellist 结构。 */
function makePanelRow(label, clicked = {}) {
  const row = makeElement("button")
  row.setAttribute("aria-label", label)
  row.click = () => {
    clicked.count = (clicked.count ?? 0) + 1
  }
  const outlet = makeElement("span")
  outlet.closest = (selector) => (selector === "button" ? row : null)
  return { outlet, row, clicked }
}

const rowPlugins = makePanelRow("插件")
const rowMcp = makePanelRow("MCP连接器")
const panelOutlets = [rowPlugins.outlet, rowMcp.outlet]

const newSessionRow = makeElement("button")
newSessionRow.setAttribute("aria-label", "新建会话")
// 收起态的真实结构：宿主不渲染 newSessionLabel 的文字，[class*="newSessionLabel"]
// 命中的是包着它的 newSessionLabelMask，textContent 为空——采集时必须跳过它。
newSessionRow.querySelectorAll = (selector) => (selector === '[class*="newSessionLabel"]' ? [{ textContent: "   " }] : [])

const cronEntryRow = makeElement("button")
cronEntryRow.setAttribute("aria-label", "定时任务")

/** ⑧ 采集入口时、⑨ 找那一行时，都要能找到这些按钮。 */
const railQueryTargets = new Map([
  ['button[class*="newSession"]:not([data-dsh-cron-entry])', newSessionRow],
  ["[data-dsh-cron-entry]", cronEntryRow],
])

const listeners = new Map()
function addListener(type, fn) {
  const list = listeners.get(type) ?? []
  list.push(fn)
  listeners.set(type, list)
}
function removeListener(type, fn) {
  const list = listeners.get(type) ?? []
  const at = list.indexOf(fn)
  if (at >= 0) list.splice(at, 1)
}
function fire(type, event) {
  for (const fn of listeners.get(type) ?? []) fn(event)
}

const documentElement = {
  attrs: new Set(),
  setAttribute(name) {
    documentElement.attrs.add(name)
  },
  removeAttribute(name) {
    documentElement.attrs.delete(name)
  },
  hasAttribute(name) {
    return documentElement.attrs.has(name)
  },
}

const dispatched = []
const document = {
  head,
  documentElement,
  addEventListener: addListener,
  removeEventListener: removeListener,
  dispatchEvent(event) {
    dispatched.push(event)
  },
  querySelector(selector) {
    const match = /^style\[data-plugin="(.+)"\]$/.exec(selector)
    if (match !== null) {
      const found = head.children.find((node) => node.tagName === "style" && node.dataset.plugin === match[1])
      return found ?? null
    }
    // ⑧ 采集侧栏入口时用到的那两个选择器
    if (railQueryTargets.has(selector)) return railQueryTargets.get(selector)
    return null
  },
  createElement(tagName) {
    return makeElement(tagName)
  },
  querySelectorAll(selector) {
    return selector === '[data-slot="sidebar.panellist"]' ? panelOutlets : []
  },
  body: makeElement("body"),
}

/* ── 仿制 MutationObserver（⑨ 用它盯 data-dsh-cron-active） ── */

const observers = []
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = []
    observers.push(this)
  }
  observe(target, options) {
    this.targets.push({ target, options })
  }
  disconnect() {
    this.targets = []
  }
  trigger() {
    this.callback([], this)
  }
}
globalThis.MutationObserver = FakeMutationObserver

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
new Function("window", "document", source)(browserWindow, document)

check("提交了一个 Module Loader 定义", definition?.id === "dsh-ui-tweaks", String(definition?.id))

const moduleExports = definition.factory(() => {
  throw new Error("本插件的 factory 不该 require 任何模块（纯 CSS + 一个 DOM 监听）")
})

check("不声明任何注入的服务", JSON.stringify(moduleExports.inject) === "[]", JSON.stringify(moduleExports.inject))
check("apply 是函数", typeof moduleExports.apply === "function")

/* ── 注入 ── */

const effects = []
/** ⑦ 清面板走的是 ctx.get("layout").selectPanel(null)，这里记录调用。 */
const panelSelections = []
const ctx = {
  effect(factory, label) {
    effects.push({ dispose: factory(), label })
  },
  get(name) {
    return name === "layout" ? { selectPanel: (id) => panelSelections.push(id) } : undefined
  },
}

moduleExports.apply(ctx)
check("注入了一张样式表", head.children.length === 1, String(head.children.length))
const style = head.children[0]
check("样式表带 data-plugin 标识（幂等与排查都靠它）", style?.dataset.plugin === "dsh-ui-tweaks", String(style?.dataset.plugin))

const css = style?.textContent ?? ""

/* ── ① MCP 连接器图标 ── */

check("① 命中的是 dsh-mcp-connector 的图标容器", css.includes(".mcpConnectorLauncherIcon"))
check("① 用 font-size: 0 收掉 emoji 字形", /\.mcpConnectorLauncherIcon\s*\{[^}]*font-size:\s*0\s*!important/.test(css))
check("① 图标颜色跟随 currentColor（亮暗主题自动适配）", /\.mcpConnectorLauncherIcon\s*\{[^}]*background-color:\s*currentColor/.test(css))
check("① 同时写了 -webkit- 与标准 mask（Chromium 两边都认）", css.includes("-webkit-mask-image:") && /\n\tmask-image:/.test(css))
// 图标盒子 20px → 16px：插件原本给 20px 盒子装 16px 字形，视觉居中但会把
// 右边的文字整体推远 3px（截图实测：46 → 49）。
check("① 图标盒子收到 16px（宿主 PanelRow 的尺寸），文字才会对齐", /\.mcpConnectorLauncherIcon\s*\{[^}]*flex:\s*0 0 16px\s*!important[^}]*width:\s*16px\s*!important/s.test(css))
check(
  "① 折叠态图标用宿主折叠时的 18px",
  /\.mcpConnectorLauncher\[data-wide="false"\]\s+\.mcpConnectorLauncherIcon\s*\{[^}]*mask-size:\s*18px 18px/s.test(css),
)

const maskMatch = /-webkit-mask-image:\s*url\("data:image\/svg\+xml,([^"]+)"\)/.exec(css)
check("① mask 是一个 data URI", maskMatch !== null)
if (maskMatch !== null) {
  const svg = decodeURIComponent(maskMatch[1])
  check("① 解码后是完整的 <svg>…</svg>（没有被 # 或引号截断）", svg.startsWith("<svg ") && svg.endsWith("</svg>"), svg.slice(0, 40))
  check("① 几何与宿主 IconLinkOutlineRegular 一致（viewBox 0 0 16 16）", svg.includes('viewBox="0 0 16 16"'), svg.slice(0, 120))
  check("① 描边宽度 1（regular 版）", svg.includes('stroke-width="1"'), svg.slice(0, 160))
  check("① 两条路径都在（链接图标的两个环）", (svg.match(/<path /g) ?? []).length === 2, String((svg.match(/<path /g) ?? []).length))
  check("① 不填充、只描边（否则会变成实心块）", svg.includes('fill="none"'))
  const expected = moduleExports.internals.LINK_ICON_SVG
  check("① 解码结果与源码里的 SVG 逐字一致", svg === expected)
}

/* ── ② 行度量 ── */

const rowRule = /\.mcpConnectorLauncher\[data-wide="true"\]\s*\{([^}]*)\}/.exec(css)
check("② 只覆盖展开态（折叠态的 36×36 圆形样式不动）", rowRule !== null)
if (rowRule !== null) {
  const body = rowRule[1]
  check("② min-height 36 对齐 panelRow", /min-height:\s*36px\s*!important/.test(body), body.trim())
  check("② padding 7px 8px 对齐 panelRow", /padding:\s*7px 8px\s*!important/.test(body))
  check("② gap 8 与图标列宽一致", /gap:\s*8px\s*!important/.test(body))
  check("② 圆角用主题变量 --dsw-radius-md", body.includes("var(--dsw-radius-md"))
  check("② height 改成 auto（否则 42px 会压过 min-height）", /height:\s*auto\s*!important/.test(body))
  check("② margin 0 2px 对齐 panelRow", /margin:\s*0 2px\s*!important/.test(body), body.trim())
}
check("② hover 用主题变量而不是写死色值", css.includes("var(--dsw-alias-interactive-bg-hover"))
check("② hover 规则只作用于展开态", css.includes('.mcpConnectorLauncher[data-wide="true"]:hover'))

/* ── ③ 行距：把这一行拉回上面那组 ── */

check(
  "③ 把 .panelList 的 margin-bottom 压到 4px（展开/折叠两种算法都落在 4）",
  /body:has\(\[data-mcp-connector-top-mount="true"\]\)\s+nav:has\(\[data-slot="sidebar\.panellist"\]\)\s*\{\s*margin-bottom:\s*4px\s*!important/.test(css),
)
// .regionArea 是 overflow:hidden，负上边距会被裁掉（hover 药丸会被切平），
// 所以这个方案里不能出现任何 margin-top 负值。
check("③ 不用负边距（父级 overflow:hidden 会裁掉 hover 药丸）", !/margin(-top)?:\s*-\d/.test(css), (css.match(/margin(-top)?:\s*-\d[^;]*/g) ?? []).join(" / "))
check("③ 只在连接器确实挂出来时才改间距", css.includes('body:has([data-mcp-connector-top-mount="true"])'))

/* ── ④ 运行中任务 ── */

check("④ 命中 dsh-cron 的 sidebar-jobs 块", /\[data-dsh-part="sidebar-jobs"\]\s*\{\s*display:\s*none\s*!important/.test(css))
check("④ 没有被误写成卸载（只隐藏，不动上游逻辑）", !css.includes("sidebar-jobs-list"))

/* ── ⑤ 收起侧栏时隐藏「定时任务」克隆按钮 ── */

check(
  "⑤ 桌面端收起态隐藏 dsh-cron 的克隆入口（否则和「新会话」图标重叠钉在标题栏）",
  /html\[data-windows-titlebar\]:has\(\[data-sidebar-collapsed="true"\]\)\s+\[data-dsh-cron-entry\]\s*\{\s*display:\s*none\s*!important/.test(css),
)
check("⑤ 只在桌面端标题栏模式下动手（网页版收起态仍留图标栏）", css.includes("html[data-windows-titlebar]"))

/* ── ⑥ 六个入口统一成一行 ── */

const expanded = moduleExports.internals.EXPANDED
const escapedExpanded = expanded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
check("⑥ 用「展开态」限定，收起态不动宿主自己的 36×36 图标", expanded === 'body:not(:has([data-sidebar-collapsed="true"]))', expanded)
check(
  "⑥ 宿主「新会话」大按钮被压成 panelRow 行",
  new RegExp(`${escapedExpanded} button\\[class\\*="newSession"\\]:not\\(\\[data-dsh-cron-entry\\]\\)\\s*\\{[^}]*min-height:\\s*36px\\s*!important[^}]*padding:\\s*7px 8px\\s*!important`, "s").test(css),
)
check(
  "⑥ dsh-cron 的「定时任务」克隆同样是 panelRow 行",
  new RegExp(`${escapedExpanded} \\[data-dsh-cron-entry\\]\\s*\\{[^}]*min-height:\\s*36px\\s*!important`, "s").test(css),
)
check("⑥ 行外边距 4px，与 panelList 的 gap 对齐", css.includes("margin: 4px 2px 0 !important"))
check("⑥ 面板列表补 4px 上边距，六行等距", /nav:has\(\[data-slot="sidebar\.panellist"\]\)\s*\{\s*margin-top:\s*4px\s*!important/.test(css))
check("⑥ 大按钮里的内容是左对齐（宿主原本居中）", /\[class\*="newSessionContent"\]\s*\{[^}]*justify-content:\s*flex-start\s*!important/s.test(css))
check("⑥ 大按钮里的图标统一到 16px", /\[class\*="newSession"\] svg\s*\{\s*width:\s*16px\s*!important/s.test(css))
check("⑥ 行高亮仍走主题变量", css.includes("var(--dsw-alias-interactive-bg-hover"))

/* ── ⑦ 让「定时任务」让位给面板行 ── */

// ⑦（面板让位）与 ⑧（收起态菜单）各注册一个 document 点击监听。
check("⑦⑧ 共注册 2 个 document 点击监听", (listeners.get("click") ?? []).length === 2, String((listeners.get("click") ?? []).length))

const rowTarget = { closest: (selector) => (selector === "button" ? { closest: (inner) => (inner === "nav" ? {} : null) } : null) }
const plainTarget = { closest: (selector) => (selector === "button" ? { closest: () => null } : null) }

fire("click", { target: rowTarget })
check("⑦ 定时任务没打开时不派发事件（不干扰其它插件）", dispatched.length === 0, String(dispatched.length))

documentElement.setAttribute("data-dsh-cron-active")
fire("click", { target: rowTarget })
check("⑦ 打开时点面板行 → 派发 dsh-cron 自己的激活事件", dispatched.length === 1 && dispatched[0]?.type === "dsh-panel-activate", String(dispatched.length))
check("⑦ detail 不是 'cron'（它据此把自己关掉）", dispatched[0]?.detail === "ui-tweaks:panel-row", String(dispatched[0]?.detail))

fire("click", { target: plainTarget })
check("⑦ 点不在 nav 里的按钮（例如「定时任务」自己）不派发", dispatched.length === 1, String(dispatched.length))

documentElement.removeAttribute("data-dsh-cron-active")
fire("click", { target: rowTarget })
check("⑦ 关闭后不再派发", dispatched.length === 1, String(dispatched.length))

/* ⑦ 的第二条：点「新会话 / 定时任务」这类铺满对话列的入口要先清掉已选中的面板，
   否则 cron 会浮在那块面板之上，而它的「返回对话」只会露出上一个面板。 */
const newSessionTarget = { closest: (selector) => (selector === "button" ? { closest: () => null, matches: (sel) => sel.includes("newSession") } : null) }
const cronEntryTarget = { closest: (selector) => (selector === "button" ? { closest: () => null, matches: (sel) => sel.includes("data-dsh-cron-entry") } : null) }

check("⑦ 点面板行不清面板（那是宿主的活，清了两边就打架）", panelSelections.length === 0, JSON.stringify(panelSelections))
fire("click", { target: newSessionTarget })
check("⑦ 点「新会话」先清掉已选中的面板", panelSelections.length === 1 && panelSelections[0] === null, JSON.stringify(panelSelections))
fire("click", { target: cronEntryTarget })
check("⑦ 点「定时任务」也先清掉面板（这样 cron 底下是对话，不是上一个面板）", panelSelections.length === 2 && panelSelections[1] === null, JSON.stringify(panelSelections))
fire("click", { target: plainTarget })
check("⑦ 点其它按钮（不在 nav、也不是那两个入口）不动面板", panelSelections.length === 2, JSON.stringify(panelSelections))

/* ── ⑧ 「操作」菜单（收起 / 展开都常驻） ── */

const RAIL_TRIGGER_CLASS = moduleExports.internals.RAIL_TRIGGER_CLASS
const RAIL_MENU_CLASS = moduleExports.internals.RAIL_MENU_CLASS

check(
  "⑧ 收起态隐藏宿主的「新会话」图标（由「操作」按钮接管那个位置）",
  /html\[data-windows-titlebar\]:has\(\[data-sidebar-collapsed="true"\]\)\s+button\[class\*="newSession"\]\s*\{\s*display:\s*none\s*!important/.test(css),
)
check(
  "⑧ 触发按钮与「应用 / 编辑」同款文字样式（fixed / left:48px / 28 高 / 0 10px / 6px 圆角 / 14px）",
  /\.dshRailTrigger\s*\{[^}]*position:\s*fixed[^}]*left:\s*48px[^}]*height:\s*28px[^}]*padding:\s*0 10px[^}]*border-radius:\s*6px[^}]*font-size:\s*14px/s.test(css),
)
check(
  "⑧ 两种状态都把 Desktop 菜单的起点让开（否则「操作」会盖住「应用」）",
  /html\[data-windows-titlebar\]\s*\{\s*--dsh-windows-menu-start:\s*100px\s*!important/.test(css),
)
check(
  "⑧ 展开 / 收起都常驻（显示规则不带 data-sidebar-collapsed 限定）",
  /html\[data-windows-titlebar\]\s+\.dshRailTrigger\s*\{\s*display:\s*inline-flex/.test(css) &&
    !/data-sidebar-collapsed[^{}]*\]\s*\.dshRailTrigger\s*\{\s*display:\s*inline-flex/.test(css),
)
check("⑧ 菜单项沿用 panelRow 度量（7px 10px / 圆角 / 主题 hover）", /\.dshRailMenuItem\s*\{[^}]*padding:\s*7px 10px/s.test(css))
check("⑧ 菜单项高亮走主题变量", /\.dshRailMenuItem:hover/.test(css) && css.includes("var(--dsw-alias-interactive-bg-hover"))

const trigger = document.body.children.find((node) => node.className === RAIL_TRIGGER_CLASS)
check("⑧ 触发按钮已挂到 body", trigger !== undefined)
check("⑧ 触发按钮是文字「操作」而不是图标", trigger?.textContent === "操作" && trigger?.innerHTML === "", `${trigger?.textContent} / ${trigger?.innerHTML}`)
check("⑧ 触发按钮的无障碍名是「操作」", trigger?.getAttribute("aria-label") === "操作", String(trigger?.getAttribute("aria-label")))
check("⑧ 初始 aria-expanded=false", trigger?.getAttribute("aria-expanded") === "false", String(trigger?.getAttribute("aria-expanded")))

trigger?.click()
const menu = document.body.children.find((node) => node.className === RAIL_MENU_CLASS)
check("⑧ 点开生成菜单", menu !== undefined)
const labels = (menu?.children ?? []).map((item) => item.textContent)
check("⑧ 菜单里必须有「新对话」（收起态读不到标签时用这个措辞）", labels[0] === "新对话", labels.join(" | "))
check("⑧ 菜单列出侧栏当前全部入口（面板行自动进来）", labels.join("|") === "新对话|定时任务|插件|MCP连接器", labels.join(" | "))
check("⑧ 菜单项只有文字（没有图标 / innerHTML）", (menu?.children ?? []).every((item) => item.textContent !== "" && item.innerHTML === ""))
check("⑧ 打开后 aria-expanded=true", trigger?.getAttribute("aria-expanded") === "true", String(trigger?.getAttribute("aria-expanded")))

menu?.children?.[0]?.click()
check("⑧ 点菜单项把点击委托给原按钮", newSessionRow.clicked === 1, String(newSessionRow.clicked))
check("⑧ 点完自动收起菜单", document.body.children.includes(menu) === false)

trigger?.click()
check("⑧ 再点一次能重新打开", document.body.children.some((node) => node.className === RAIL_MENU_CLASS))
fire("keydown", { key: "Escape" })
check("⑧ Esc 关闭菜单", document.body.children.some((node) => node.className === RAIL_MENU_CLASS) === false)

check("⑨ 「定时任务」打开时自己那行也有选中底色（和面板行的 panelActive 一致）", /html\[data-dsh-cron-active\]\s+body\s+\[data-dsh-cron-entry\]\s*\{\s*background:\s*var\(--dsw-alias-interactive-bg-hover/.test(css))
check(
  "⑥ 的「新会话」行度量段排除 cron 克隆按钮（否则会以更高特异度压掉 ⑨ 的底色）",
  /button\[class\*="newSession"\]:not\(\[data-dsh-cron-entry\]\)\s*\{[^}]*min-height:\s*36px\s*!important/s.test(css),
)

// ⑨ 的 JS 兜底：不依赖 CSS 级联，直接写内联（带 important）。
const applyCronActiveSkin = moduleExports.internals.applyCronActiveSkin
documentElement.setAttribute("data-dsh-cron-active")
applyCronActiveSkin()
check("⑨ 兜底：打开时给那一行写内联底色（带 important）", /important$/.test(cronEntryRow.style.getPropertyValue("background")), cronEntryRow.style.getPropertyValue("background"))
documentElement.removeAttribute("data-dsh-cron-active")
applyCronActiveSkin()
check("⑨ 兜底：关闭后摘掉内联底色", cronEntryRow.style.getPropertyValue("background") === "", cronEntryRow.style.getPropertyValue("background"))

// 互斥的**第二条保险**：由 cron 自己的激活状态驱动，而不是拦点击。
const cronAttrObserver = observers.find((o) => o.targets.some((t) => t.options?.attributeFilter?.includes("data-dsh-cron-active")))
check("⑨ 装了盯 data-dsh-cron-active 的观察器", cronAttrObserver !== undefined, String(observers.length))
documentElement.setAttribute("data-dsh-cron-active")
const beforeToggle = panelSelections.length
cronAttrObserver?.trigger()
check(
  "⑨ cron 一打开就清掉宿主的主面板（不依赖抢到那次点击）",
  panelSelections.length === beforeToggle + 1 && panelSelections.at(-1) === null,
  JSON.stringify(panelSelections),
)
documentElement.removeAttribute("data-dsh-cron-active")

check(
  "⑩ cron 打开时收起宿主「当前会话」的灰底（宿主只在没有面板激活时才给它上色），hover 保留",
  /html\[data-dsh-cron-active\]\s+\[class\*="sessionRow"\]\[class\*="selected"\]:not\(:hover\)[^{]*\{\s*background:\s*transparent\s*!important/.test(css),
)

/* ── 幂等与清理 ── */

check("一次 apply 登记四个 effect（样式 + 三个补丁，互不连累）", effects.length === 4, String(effects.length))
moduleExports.apply(ctx)
check("第二个实例插自己那一张样式表（刻意不去重）", head.children.length === 2, String(head.children.length))
check("第二次 apply 再登记四个 effect", effects.length === 8, String(effects.length))

// 关键回归：插件可能被挂载两次（profile bundles + 市场 shim），旧实例的清理
// **不能**把新实例的样式表一起带走——那正是「刷新后样式整体消失、但 JS 补丁还在」
// 的成因（表现为「运行中任务」冒出来、六个入口退回大按钮）。
effects[0].dispose()
check("实例 1 清理后，实例 2 的样式表仍在（不再整体消失）", head.children.length === 1, String(head.children.length))
check("样式 effect 不碰监听（两次 apply 的共 4 个）", (listeners.get("click") ?? []).length === 4, String((listeners.get("click") ?? []).length))

effects[1].dispose()
check("⑧ 的监听不受 ⑦ 清理影响（4 → 3）", (listeners.get("click") ?? []).length === 3, String((listeners.get("click") ?? []).length))
// 剩下的那套属于第二次 apply，仍然生效——各 effect 各管各的。
documentElement.setAttribute("data-dsh-cron-active")
fire("click", { target: rowTarget })
documentElement.removeAttribute("data-dsh-cron-active")
check("另一个 apply 的监听仍然生效（互不连累）", dispatched.length === 2, String(dispatched.length))

effects[2].dispose()
check(
  "实例 1 的「操作」按钮被摘掉，实例 2 的留下",
  document.body.children.filter((node) => node.className === RAIL_TRIGGER_CLASS).length === 1,
  String(document.body.children.length),
)

effects[3].dispose()
effects[4].dispose()
check("实例 2 的样式表只在它自己被清理时移除", head.children.length === 0, String(head.children.length))
effects[5].dispose()
check("实例 2 的 ⑦ 也清了（还剩 ⑧ 的 1 个）", (listeners.get("click") ?? []).length === 1, String((listeners.get("click") ?? []).length))
effects[6].dispose()
check("实例 2 的 ⑧ 清理后监听归零", (listeners.get("click") ?? []).length === 0, String((listeners.get("click") ?? []).length))
effects[7].dispose()

moduleExports.apply(ctx)
check("清理后重新 apply 能再装上", head.children.length === 1, String(head.children.length))
effects[8].dispose()
effects[9].dispose()
effects[10].dispose()
effects[11].dispose()
check(
  "再次清理后 head 干净、无残留监听、无残留按钮",
  head.children.length === 0 && (listeners.get("click") ?? []).length === 0 && document.body.children.length === 0,
  `${head.children.length} / ${(listeners.get("click") ?? []).length} / ${document.body.children.length}`,
)

/* ── 缺 document 时静默跳过（非 web 部署） ── */

let threw = false
try {
  new Function("window", "document", source)(browserWindow, undefined)
  definition.factory(() => {}).apply({ effect() {} })
} catch (error) {
  threw = true
  console.log(`   （缺 document 时抛错：${error}）`)
}
check("没有 document 时不抛错（安静跳过）", threw === false)

console.log(`\n结果：${passed} 通过，${failures.length} 失败`)
for (const failure of failures) console.log(`  ✗ ${failure}`)
if (failures.length > 0) process.exitCode = 1
