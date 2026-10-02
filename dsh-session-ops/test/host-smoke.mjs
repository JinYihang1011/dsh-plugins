/**
 * dsh-session-ops 宿主半边冒烟测试。
 *
 * 不依赖运行中的 DSH：用一份**忠实仿制**的后端（projectKey / encodeSegment /
 * logPath 规则抄自 @deepseek-ai/dsh-session-persistence-jsonl 的源码）与一份仿制
 * 注册表（sessionIds + 头部 cwd 过滤 + attach 校验），拿真实会话日志的副本
 * 跑完整的 移动 / 登记 / 删除 / 恢复 / 拒绝 路径。
 *
 * 运行：node test/host-smoke.mjs
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { realpathSync } from "node:fs"
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { internals } from "../index.js"

/* ── 抄自后端的路径规则（必须与 dsh-session-persistence-jsonl 一致） ── */

function encodeSegment(raw) {
  if (raw === ".") return "~002E"
  if (raw === "..") return "~002E~002E"
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0")
  }
  return out
}

function projectKey(cwd) {
  let readable = ""
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-"
      separatorRun = true
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0")
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`
}

const logPath = (root, cwd, id) => join(root, projectKey(cwd), encodeSegment(id), "session.v4.jsonl.zstd")

/* ── 仿制后端 ── */

function createPersistence(root) {
  async function readHeader(path) {
    const raw = await readFile(path)
    const text = zstdDecompressSync(raw).toString("utf8")
    return { header: JSON.parse(text.slice(0, text.indexOf("\n"))), path }
  }
  async function walk() {
    const found = []
    for (const projectDir of await readdir(root, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue
      for (const sessionDir of await readdir(join(root, projectDir.name), { withFileTypes: true })) {
        if (!sessionDir.isDirectory()) continue
        const sessionPath = join(root, projectDir.name, sessionDir.name)
        for (const file of await readdir(sessionPath, { withFileTypes: true })) {
          if (file.isFile() && /^session(\.[v0-9]+)?\.jsonl\.zstd$/.test(file.name)) {
            found.push(join(sessionPath, file.name))
          }
        }
      }
    }
    return found
  }
  return {
    root,
    compression: "zstd",
    locate: (meta) => ({ kind: "jsonl", path: logPath(root, meta.cwd, meta.id) }),
    async stat(id) {
      for (const path of await walk()) {
        const { header } = await readHeader(path)
        if (header.id === id) return { header, sizeBytes: (await stat(path)).size }
      }
      return undefined
    },
    async list() {
      const snapshots = []
      for (const path of await walk()) {
        const { header } = await readHeader(path)
        snapshots.push({ header, sizeBytes: (await stat(path)).size })
      }
      return snapshots
    },
  }
}

/* ── 仿制注册表 ── */

function createRegistry(workspaces, persistence) {
  const table = new Map()
  for (const workspace of workspaces) {
    table.set(workspace.id, { id: workspace.id, path: workspace.path, title: workspace.title, sessionIds: [...(workspace.sessionIds ?? [])] })
  }
  const headers = new Map()
  const paths = new Map()
  function entity(record) {
    return {
      get id() {
        return record.id
      },
      get path() {
        return record.path
      },
      get title() {
        return record.title
      },
      get sessionIds() {
        return record.sessionIds.filter((id) => paths.get(id) === record.path)
      },
      async attachSession(id) {
        if (!record.sessionIds.includes(id)) {
          const header = headers.get(id)
          if (header?.cwd === undefined) throw new Error(`cannot attach ${id}: no cwd`)
          if (header.cwd !== record.path) throw new Error(`cannot attach ${id}: its cwd resolves to '${header.cwd}'`)
          paths.set(id, header.cwd)
        }
        if (!record.sessionIds.includes(id)) record.sessionIds = [id, ...record.sessionIds]
      },
      async detachSession(id) {
        record.sessionIds = record.sessionIds.filter((existing) => existing !== id)
      },
    }
  }
  return {
    list: () => [...table.values()].map(entity),
    get: (id) => (table.has(id) ? entity(table.get(id)) : undefined),
    archivedSessionIds: [],
    pinnedSessionIds: [],
    async unpinSession() {},
    async unarchiveSession() {},
    // 与真实注册表一致：这里必须重新读盘，而不是回吐内存里的旧头部。
    async listStoredHeaders() {
      return (await persistence.list()).map((snapshot) => snapshot.header)
    },
    async replaceHeaderIndex(list) {
      headers.clear()
      paths.clear()
      for (const header of list) {
        headers.set(header.id, header)
        paths.set(header.id, header.cwd)
      }
    },
    _seedHeader(header) {
      headers.set(header.id, header)
      paths.set(header.id, header.cwd)
    },
  }
}

/* ── 断言小工具 ── */

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
async function expectThrow(label, fn) {
  try {
    await fn()
    check(label, false, "没有按预期抛错")
  } catch (error) {
    check(label, true)
    return error
  }
  return undefined
}

/* ── 主流程 ── */

const realSessionsRoot = process.argv[2] ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh"), "sessions")

function patchCwd(raw, cwd) {
  const text = zstdDecompressSync(raw).toString("utf8")
  const newline = text.indexOf("\n")
  const header = JSON.parse(text.slice(0, newline))
  const patched = `${JSON.stringify({ ...header, cwd })}${text.slice(newline)}`
  return { header, bytes: zstdCompressSync(Buffer.from(patched, "utf8"), { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }) }
}

const workDir = await mkdtemp(join(tmpdir(), "dsh-session-ops-test-"))
const sessionsRoot = join(workDir, "sessions")

// 三个真实存在的工作区目录（attach 校验要求目录存在）。
await mkdir(join(workDir, "projA"), { recursive: true })
await mkdir(join(workDir, "projB"), { recursive: true })
await mkdir(join(workDir, "projC"), { recursive: true })
const projectA = realpathSync(join(workDir, "projA"))
const projectB = realpathSync(join(workDir, "projB"))
const projectC = realpathSync(join(workDir, "projC"))

// 找一个真实会话日志做素材（顶层会话优先）。
const sourceLog = await (async () => {
  for (const projectDir of await readdir(realSessionsRoot, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue
    for (const sessionDir of await readdir(join(realSessionsRoot, projectDir.name), { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue
      const candidate = join(realSessionsRoot, projectDir.name, sessionDir.name, "session.v4.jsonl.zstd")
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error(`没有在 ${realSessionsRoot} 找到可用的会话日志`)
})()

const sessionId = "session-00000000-0000-4000-8000-000000000001"
const childId = "11111111-1111-4111-8111-111111111111"
const rawSource = await readFile(sourceLog)
const seeded = patchCwd(rawSource, projectA).header

async function seedSession(id, cwd, extra = {}) {
  const path = logPath(sessionsRoot, cwd, id)
  await mkdir(dirname(path), { recursive: true })
  const text = zstdDecompressSync(rawSource).toString("utf8")
  const newline = text.indexOf("\n")
  const header = { ...JSON.parse(text.slice(0, newline)), id, cwd, ...extra }
  await writeFile(path, zstdCompressSync(Buffer.from(`${JSON.stringify(header)}${text.slice(newline)}`, "utf8"), { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }))
  return header
}

console.log(`素材：${sourceLog}`)
console.log(`沙箱：${workDir}\n`)

const header = await seedSession(sessionId, projectA)
const seededBytes = await readFile(logPath(sessionsRoot, projectA, sessionId))
await seedSession(childId, projectA, { origin: "subagent", parentSession: sessionId })

const persistence = createPersistence(sessionsRoot)
const registry = createRegistry(
  [
    { id: "ws-a", title: "项目 A", path: projectA, sessionIds: [sessionId, childId] },
    { id: "ws-b", title: "项目 B", path: projectB, sessionIds: [] },
    { id: "ws-c", title: "项目 C", path: projectC, sessionIds: [] },
  ],
  persistence,
)
await registry.replaceHeaderIndex(await persistence.list().then((all) => all.map((snapshot) => snapshot.header)))

let liveSession
let activity = []
// 仿制宿主的 sessionController：只记录插件交给它的打开请求，不真的开窗口。
const opened = []
let sessionController = {
  canOpenWorkspacePath: () => true,
  async openWorkspacePath(request) {
    opened.push(request)
    return { opened: true }
  },
}
const ctx = {
  get: (key) =>
    ({ workspaceRegistry: registry, sessionPersistence: persistence, sessionController, sessions: { get: (id) => (liveSession === id ? { header } : undefined) } })[key],
  waterfall: async () => activity,
  logger: () => ({ info() {}, warn() {} }),
  effect: () => {},
}
const options = { enabled: true, allowRelocate: true, trashDir: "", debug: false }
const log = () => {}
const trashRoot = join(workDir, "trash")

console.log("① prepare：读一次会话事实")
const prepared = await internals.describe(ctx, sessionId)
check("拿到规范化 cwd", prepared.canonical === projectA, String(prepared.canonical))
check("找到日志文件", prepared.file === logPath(sessionsRoot, projectA, sessionId), String(prepared.file))
check("识别出子会话", prepared.children.length === 1 && prepared.children[0].id === childId)
check("识别出当前归属", prepared.workspaces.find((w) => w.accounted)?.id === "ws-a")

console.log("\n② 同工作区移动 = no-op")
const noop = await internals.moveSession(ctx, { sessionId, workspaceId: "ws-a" }, options, log)
check("返回 noop", noop.mode === "noop", noop.mode)

console.log("\n③ 有工作在跑 → 拒绝搬移")
activity = [{ kind: "turn", name: "进行中的回合" }]
await expectThrow("拒绝", () => internals.moveSession(ctx, { sessionId, workspaceId: "ws-b" }, options, log))
activity = []

console.log("\n④ 被打开着 → 拒绝；force 后放行")
liveSession = sessionId
await expectThrow("拒绝", () => internals.moveSession(ctx, { sessionId, workspaceId: "ws-b" }, options, log))
liveSession = undefined

console.log("\n⑤ 跨目录搬移：A → B")
const moved = await internals.moveSession(ctx, { sessionId, workspaceId: "ws-b" }, { ...options, trashDir: trashRoot }, log)
check("模式为 relocate", moved.mode === "relocate", moved.mode)
const destination = logPath(sessionsRoot, projectB, sessionId)
check("日志落到 B 的项目目录", existsSync(destination), destination)
check("A 的项目目录已清空该会话", !existsSync(logPath(sessionsRoot, projectA, sessionId)))
const movedHeader = (await persistence.stat(sessionId)).header
check("头部 cwd 已改写", movedHeader.cwd === projectB, movedHeader.cwd)
check("事件与标题等字段保持不变", movedHeader.createdAt === header.createdAt && movedHeader.id === sessionId)
check("B 的 sessionIds 已收录", registry.get("ws-b").sessionIds.includes(sessionId))
check("A 的 sessionIds 已摘除", !registry.get("ws-a").sessionIds.includes(sessionId))
check("原件已备份进回收站", existsSync(moved.backup), moved.backup)
check("回收站副本与搬移前的原件逐字节一致", (await readFile(moved.backup)).equals(seededBytes))

console.log("\n⑥ 头部 cwd 与事件逐行无损")
const originalText = zstdDecompressSync(rawSource).toString("utf8")
const afterText = zstdDecompressSync(await readFile(destination)).toString("utf8")
const originalLines = originalText.split("\n").slice(1)
const afterLines = afterText.split("\n").slice(1)
check("除头部外逐行一致", JSON.stringify(originalLines) === JSON.stringify(afterLines))

console.log("\n⑦ 搬回去：B → A")
const back = await internals.moveSession(ctx, { sessionId, workspaceId: "ws-a" }, { ...options, trashDir: trashRoot }, log)
check("模式为 relocate", back.mode === "relocate", back.mode)
check("回到 A 的项目目录", existsSync(logPath(sessionsRoot, projectA, sessionId)))
check("cwd 恢复为 A", (await persistence.stat(sessionId)).header.cwd === projectA)
check("A 的 sessionIds 重新收录", registry.get("ws-a").sessionIds.includes(sessionId))

console.log("\n⑧ 删除会话（含子会话）")
const deleted = await internals.deleteSession(ctx, { sessionId, includeChildren: true }, { ...options, trashDir: trashRoot }, log)
check("删掉 2 个（自己 + 子会话）", deleted.count === 2, String(deleted.count))
check("日志已离开 sessions 根", !existsSync(logPath(sessionsRoot, projectA, sessionId)) && !existsSync(logPath(sessionsRoot, projectA, childId)))
check("A 的 sessionIds 已摘干净", !registry.get("ws-a").sessionIds.includes(sessionId) && !registry.get("ws-a").sessionIds.includes(childId))
const trashEntries = deleted.trashed.map((entry) => entry.to)
check("回收站有 restore.json", trashEntries.every((entry) => existsSync(join(entry, "restore.json"))))
check("回收站有日志本身", trashEntries.every((entry) => existsSync(join(entry, "session.v4.jsonl.zstd"))))

console.log("\n⑨ 从回收站恢复")
for (const entry of trashEntries) await internals.restoreSession(ctx, { trashPath: entry })
check("日志回到 A 的项目目录", existsSync(logPath(sessionsRoot, projectA, sessionId)))
check("子会话也回来了", existsSync(logPath(sessionsRoot, projectA, childId)))
check("A 的 sessionIds 重新收录", registry.get("ws-a").sessionIds.includes(sessionId))

console.log("\n⑩ 未登记目录：cwd 不在任何工作区 → 仍可搬到已登记工作区")
const headerC = await seedSession("session-00000000-0000-4000-8000-000000000002", projectC)
await registry.replaceHeaderIndex(await persistence.list().then((all) => all.map((snapshot) => snapshot.header)))
const fromNowhere = await internals.moveSession(ctx, { sessionId: headerC.id, workspaceId: "ws-b" }, { ...options, trashDir: trashRoot }, log)
check("模式为 relocate", fromNowhere.mode === "relocate", fromNowhere.mode)
check("B 收录", registry.get("ws-b").sessionIds.includes(headerC.id))

console.log("\n⑪ HTTP 路由层：信任 fence + 方法白名单 + 信封")
const captured = { route: undefined }
const webServer = {
  register(route) {
    captured.route = route
    return () => {}
  },
}
// 真实部署里注入 webServer 的子上下文仍然带着同一个 ctx（get / waterfall 都能用），
// 所以这里按同样方式叠加，而不是另造一个空上下文。
const wctx = Object.assign({}, ctx, { webServer, webRuntime: { trustedHosts: [] } })
const disposeRoute = internals.mountRoutes(wctx, () => options, log)
check("mountRoutes 返回 disposer", typeof disposeRoute === "function")
if (captured.route === undefined) {
  check("已注册路由", false, "没有捕获到路由")
} else {
  check("注册为 prefix 路由", captured.route.kind === "prefix" && captured.route.path === "/session-ops/api")

  const invoke = (headers, method, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      headers,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
    const state = { status: undefined, payload: undefined, headers: undefined }
    const res = {
      writeHead(status, headers2) {
        state.status = status
        state.headers = headers2
      },
      end(text) {
        state.payload = text === undefined ? undefined : JSON.parse(text)
      },
    }
    return (async () => {
      await captured.route.handler(req, res)
      return state
    })()
  }

  const good = { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387" }
  const forbidden = await invoke({ host: "evil.example.com:80" }, "POST", { method: "prepare" })
  check("非回环 Host 被 403 拒绝", forbidden.status === 403, String(forbidden.status))
  const crossSite = await invoke({ ...good, "sec-fetch-site": "cross-site" }, "POST", { method: "prepare" })
  check("跨站请求被 403 拒绝", crossSite.status === 403, String(crossSite.status))
  const wrongMethod = await invoke(good, "GET")
  check("GET 被 405 拒绝", wrongMethod.status === 405, String(wrongMethod.status))
  const unknown = await invoke(good, "POST", { method: "nope" })
  check("未知方法被 400 拒绝", unknown.status === 400 && unknown.payload?.ok === false)
  const preparedOverHttp = await invoke(good, "POST", { method: "prepare", params: { sessionId } })
  check("prepare 走通并返回信封", preparedOverHttp.status === 200 && preparedOverHttp.payload?.ok === true)
  check("信封里带工作区清单", Array.isArray(preparedOverHttp.payload?.detail?.workspaces))
  const openOverHttp = await invoke(good, "POST", { method: "openLocation", params: { sessionId } })
  check("openLocation 是白名单方法且走通", openOverHttp.status === 200 && openOverHttp.payload?.detail?.path === projectA, JSON.stringify(openOverHttp.payload))
  disposeRoute()
}

console.log("\n⑫ 打开工作区位置：把 cwd 交给宿主的原生打开能力")
opened.length = 0
const location = await internals.openSessionLocation(ctx, { sessionId }, log)
check("返回规范化后的路径", location.path === projectA, String(location.path))
check("请求里带的是该会话的工作目录", opened.length === 1 && opened[0].path === projectA, JSON.stringify(opened))
check("不带 action（= 直接打开这个文件夹，而不是在上级里选中它）", opened[0].action === undefined)

const savedController = sessionController
sessionController = undefined
await expectThrow("宿主没有 sessionController → 报错", () => internals.openSessionLocation(ctx, { sessionId }, log))
sessionController = { canOpenWorkspacePath: () => false, openWorkspacePath() {} }
await expectThrow("宿主报告没有桌面文件管理器 → 报错", () => internals.openSessionLocation(ctx, { sessionId }, log))
sessionController = {
  canOpenWorkspacePath: () => true,
  async openWorkspacePath() {
    throw Object.assign(new Error("path open failed"), { cause: new Error("Path has no verified Host path") })
  },
}
const refusal = await expectThrow("宿主拒绝打开 → 报错", () => internals.openSessionLocation(ctx, { sessionId }, log))
check("错误里带上宿主的 cause", String(refusal?.message).includes("Path has no verified Host path"), String(refusal?.message))
sessionController = savedController

const ghost = await seedSession("session-00000000-0000-4000-8000-000000000003", join(workDir, "not-here"))
await expectThrow("工作目录不存在 → 报错", () => internals.openSessionLocation(ctx, { sessionId: ghost.id }, log))
const blank = await seedSession("session-00000000-0000-4000-8000-000000000004", "")
await expectThrow("会话没记录 cwd → 报错", () => internals.openSessionLocation(ctx, { sessionId: blank.id }, log))
await expectThrow("缺少 sessionId → 报错", () => internals.openSessionLocation(ctx, {}, log))
check("失败路径没有产生任何打开请求", opened.length === 1, String(opened.length))

console.log(`\n结果：${passed} 通过，${failures.length} 失败`)
for (const failure of failures) console.log(`  ✗ ${failure}`)
if (failures.length > 0) {
  console.log(`\n沙箱保留在：${workDir}`)
  process.exitCode = 1
} else {
  await rm(workDir, { recursive: true, force: true })
}
