/**
 * dsh-session-ops —— 宿主半边（Host side）。
 *
 * 给侧栏会话行菜单补三个原生没有的操作：
 *   · 打开工作区位置（openSessionLocation，在宿主桌面的文件管理器里打开会话的工作目录）
 *   · 移动会话到工作区（moveSession）
 *   · 删除会话（deleteSession，进回收站而不是抹掉）
 *
 * ── 为什么需要宿主半边 ───────────────────────────────────────────────────
 * DSH 的会话归属由两条事实共同决定（@deepseek-ai/dsh-workspace/src/entity.ts）：
 *   1. 工作区记录里的 sessionIds 顺序（所有权账本）；
 *   2. 该会话**日志头部记录的 cwd**，realpath 规范化后必须逐字等于工作区 path。
 * 读取时 sessionIds 会被 `host.sessionPath(id) === record.path` 过滤，attachSession
 * 也会用同一条规则校验并抛错。官方没有任何 Remote/UI 命令能改这两条事实，所以
 * 浏览器半边只能寄信给宿主，由宿主直接动注册表与会话日志。
 *
 * ── 移动的两种情形 ───────────────────────────────────────────────────────
 * ① cwd 已等于目标工作区路径（会话本来就在那个目录跑，只是没登记）
 *    → 纯 attachSession，零风险、字节不动。
 * ② cwd 与目标工作区不同（真正的跨目录搬家）
 *    → 改写会话日志**第一行头部**的 cwd，并把日志文件搬到
 *      `sessions\--<目标 cwd 编码>--\<id>\session.v4.jsonl.zstd`，
 *      刷新注册表的头部索引后重新登记。
 *    安全性：事件行逐字节不动，只换头部一行；zstd 帧按后端自己的
 *    CHECKSUM_OPTIONS（ZSTD_c_checksumFlag=1）重压；原文件先复制进回收站，
 *    写完后用后端自己的 `stat()` 复验头部可解析且 cwd 正确，失败即回滚。
 *    仍拒绝正在运行/被打开的会话（除非 force 且没有任何在跑的工作）。
 *
 * ── 删除 ─────────────────────────────────────────────────────────────────
 * 会话日志目录整棵搬进回收站（`<DSH_HOME>\session-trash\<时间戳>-<id>\`），
 * 同时从注册表摘掉账目（detach / unpin / unarchive），并写一份 restore.json
 * 记录原始绝对路径，因此可以 `restore` 回去。绝不永久删除。
 *
 * 本文件刻意不 import 任何 @deepseek-ai/* 包：插件目录被 profile 以 link: 方式
 * 引用，Node 按 realpath 解析依赖，插件自己目录里没有 DSH 的 node_modules。
 * 只用 node: 内置模块，因此没有可解析性风险。
 */

import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat as fsStat, writeFile } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

/** Loader 中的插件标识。 */
export const name = "dsh-session-ops"

/** 浏览器半边调用的同源端点（Host 注册的 prefix 路由）。 */
const ROUTE_PREFIX = "/session-ops/api"

/** zstd 帧魔数（小端读出的值），用来判断日志是否压缩存储。 */
const ZSTD_MAGIC = 0xfd2fb528

/** 默认配置；profile patch 里的 config 会逐项覆盖。 */
const DEFAULTS = {
  enabled: true,
  /** 是否允许「跨目录搬家」（改写头部 cwd）。关掉后只剩 cwd 匹配时的纯登记。 */
  allowRelocate: true,
  /** 回收站根目录；空串 = `<DSH_HOME>\session-trash`。 */
  trashDir: "",
  /** 转发到宿主控制台的诊断日志。 */
  debug: false,
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

/** 从宿主上下文里安静地取一个服务（没有就返回 undefined，绝不抛）。 */
function serviceOf(ctx, key) {
  try {
    return ctx.get?.(key)
  } catch {
    return undefined
  }
}

/** 会话持久化后端（jsonl 后端，提供 root / locate / stat / list / open）。 */
function persistenceOf(ctx) {
  return serviceOf(ctx, "sessionPersistence")
}

/** 工作区注册表（ctx.workspaceRegistry）。 */
function registryOf(ctx) {
  return serviceOf(ctx, "workspaceRegistry")
}

/** 会话注册表：只包含当前进程真正持有的会话。 */
function liveSessionOf(ctx, sessionId) {
  const sessions = serviceOf(ctx, "sessions")
  try {
    return sessions?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/** DSH 主目录。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : join(homedir(), ".dsh")
}

/**
 * 诊断日志：追加到 `<DSH_HOME>\session-ops.log`。
 *
 * 宿主侧的 logger 输出沉在 Electron 里取不到，而「插件到底加载了没」「处理器
 * 为什么失败」这两件事只能在现场查，所以留一个可读的落盘痕迹。永不抛。
 * @param message - 一行诊断文本。
 */
function note(message) {
  try {
    appendFileSync(join(dshHome(), "session-ops.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8")
  } catch {
    /* 写不进去就算了，不影响功能 */
  }
}

/** `yyyyMMdd-HHmmss` 形式的时间戳，用于回收站目录名。 */
function stamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** realpath 规范化；路径不存在时退回 resolve() 的结果，绝不抛。 */
async function canonicalPath(raw) {
  if (typeof raw !== "string" || raw === "") return undefined
  try {
    return await realpath(raw)
  } catch {
    try {
      return resolve(raw)
    } catch {
      return raw
    }
  }
}

/** 该会话还有哪些工作在跑（与「归档」用的是同一条瀑布）。 */
async function activityOf(ctx, sessionId) {
  try {
    const items = await ctx.waterfall?.("workspace/session-activity", { sessionId }, () => Promise.resolve([]))
    return Array.isArray(items) ? items : []
  } catch {
    // 查询失败时按「有活动」处理，宁可多问一句也不误伤。
    return [{ kind: "unknown", name: "活动探测失败" }]
  }
}

/** 读取某个会话的存储头部（先持久化、再回落到内存会话）。 */
async function headerOf(ctx, sessionId) {
  const persistence = persistenceOf(ctx)
  if (persistence !== undefined) {
    try {
      const snapshot = await persistence.stat(sessionId)
      if (snapshot?.header !== undefined) return snapshot.header
    } catch {
      /* 落到内存会话 */
    }
  }
  const live = liveSessionOf(ctx, sessionId)
  return live?.header
}

/**
 * 会话日志的绝对路径。
 *
 * 优先用后端自己的 `locate(meta)`——它内部就是 projectKey(cwd) + encodeSegment(id)
 * 的权威实现，我不复制这套编码规则（复制就会漂移）。
 * @param persistence - 持久化后端。
 * @param header - 会话头部（含 id 与 cwd）。
 * @returns 绝对路径，或 undefined。
 */
function logPathOf(persistence, header) {
  if (typeof persistence?.locate !== "function") return undefined
  try {
    const located = persistence.locate({ id: header.id, cwd: header.cwd })
    return typeof located?.path === "string" ? located.path : undefined
  } catch {
    return undefined
  }
}

/**
 * 兜底：在持久化根目录里按 `<任意项目目录>\<id>\session*.jsonl*` 找日志文件。
 * 只在后端不提供 locate() 时使用。
 * @param persistence - 持久化后端。
 * @param sessionId - 会话 id。
 * @returns 绝对路径，或 undefined。
 */
async function findLogFile(persistence, sessionId) {
  const root = persistence?.root
  if (typeof root !== "string" || root === "") return undefined
  let projectDirs
  try {
    projectDirs = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const sessionDir = join(root, projectDir.name, sessionId)
    let files
    try {
      files = await readdir(sessionDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile()) continue
      if (/^session(\.[v0-9]+)?\.jsonl(\.zstd)?$/u.test(file.name)) return join(sessionDir, file.name)
    }
  }
  return undefined
}

/**
 * 把日志第一行的 cwd 换成目标路径，重新打成 zstd 帧。
 *
 * 事件行逐字节保留（解压出来是同一段文本，只有第一行被替换），
 * 压缩参数与后端一致（带内容校验和）。
 * @param source - 原始容器字节。
 * @param targetCwd - 新的 cwd 绝对路径。
 * @returns 新的容器字节。
 */
function rewriteHeaderCwd(source, targetCwd) {
  const compressed = source.length >= 4 && source.readUInt32LE(0) === ZSTD_MAGIC
  const text = compressed ? zstdDecompressSync(source).toString("utf8") : source.toString("utf8")
  const newline = text.indexOf("\n")
  if (newline < 0) throw new Error("会话日志缺少头部行，已放弃改写")
  const headerLine = text.slice(0, newline)
  let header
  try {
    header = JSON.parse(headerLine)
  } catch (error) {
    throw new Error(`会话日志头部不是合法 JSON：${String(error)}`)
  }
  if (header?.type !== "session") throw new Error("会话日志第一行不是 session 头部，已放弃改写")
  const patched = `${JSON.stringify({ ...header, cwd: targetCwd })}${text.slice(newline)}`
  const bytes = Buffer.from(patched, "utf8")
  return compressed
    ? zstdCompressSync(bytes, { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } })
    : bytes
}

/** 递归列出目录下所有文件（相对路径），用于回收站清单。 */
async function listFiles(root, prefix = "") {
  const found = []
  let entries
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : join(prefix, entry.name)
    if (entry.isDirectory()) found.push(...(await listFiles(root, rel)))
    else found.push(rel)
  }
  return found
}

/* ───────────────────────── 打开工作区位置 ───────────────────────── */

/**
 * 打开一个会话的工作区位置：在宿主桌面的文件管理器里打开它的工作目录。
 *
 * 不自己拼平台命令，而是转发给宿主自己的
 * `sessionController.openWorkspacePath()`——DSH 自带的「在资源管理器中打开/显示」
 * 走的就是这条实现，因此路径校验（必须能通过组合文件系统解析回同一个宿主路径）、
 * 平台分派（Explorer / Finder / xdg-open）与 WSL 路径转换都与宿主保持一致。
 *
 * 冷会话也能用：只读持久化头部，不激活 Agent。
 * @param ctx - 宿主上下文。
 * @param params - `{ sessionId }`。
 * @param log - 诊断输出。
 * @returns `{ sessionId, path }`；路径不存在或宿主没有桌面时抛错。
 */
async function openSessionLocation(ctx, params, log) {
  const sessionId = requireString(params?.sessionId, "sessionId")
  const header = await headerOf(ctx, sessionId)
  if (header === undefined || header === null) throw new Error(`找不到会话 ${sessionId} 的存储记录`)

  const recorded = typeof header.cwd === "string" ? header.cwd.trim() : ""
  if (recorded === "") throw new Error("这个会话没有记录工作目录，无法定位工作区位置")

  // 用 realpath 规范化：宿主打开前会把路径解析回自身做逐字比较，大小写/短名对不上就会被拒。
  const target = (await canonicalPath(recorded)) ?? recorded
  let info
  try {
    info = await fsStat(target)
  } catch (error) {
    throw new Error(`工作区目录不存在或打不开：${target}（${String(error)}）`)
  }
  if (!info.isDirectory()) throw new Error(`会话记录的工作目录不是一个文件夹：${target}`)

  const controller = serviceOf(ctx, "sessionController")
  if (typeof controller?.openWorkspacePath !== "function") {
    throw new Error("宿主未挂载 sessionController，本插件在此部署下无法打开文件管理器")
  }
  if (typeof controller.canOpenWorkspacePath === "function" && controller.canOpenWorkspacePath() !== true) {
    throw new Error("这个宿主没有可用的桌面文件管理器（例如无图形界面的 Web 部署），无法打开工作区位置")
  }

  try {
    await controller.openWorkspacePath({ path: target }, new AbortController().signal)
  } catch (error) {
    // 宿主把失败包成 RemoteError("gateway/internal", "path open failed")，真正的原因在 cause 里。
    const cause = error?.cause
    const detail = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`宿主拒绝打开 ${target}：${reason}${detail === "" ? "" : `（${detail}）`}`)
  }
  log(`已打开工作区位置：${target}`)
  return { sessionId, path: target }
}

/* ───────────────────────── 会话操作实现 ───────────────────────── */

/**
 * 收集一次操作的上下文：头部、规范 cwd、日志路径、所属工作区、子会话。
 * @param ctx - 宿主上下文。
 * @param sessionId - 目标会话。
 * @returns 操作上下文；会话不存在时抛错。
 */
async function describe(ctx, sessionId) {
  const registry = registryOf(ctx)
  const persistence = persistenceOf(ctx)
  if (registry === undefined) throw new Error("宿主未挂载 workspaceRegistry，本插件在此部署下不可用")
  if (persistence === undefined) throw new Error("宿主未挂载 sessionPersistence，本插件在此部署下不可用")

  const header = await headerOf(ctx, sessionId)
  if (header === undefined || header === null) throw new Error(`找不到会话 ${sessionId} 的存储记录`)

  const cwd = typeof header.cwd === "string" ? header.cwd : undefined
  const canonical = await canonicalPath(cwd)
  const file = logPathOf(persistence, header) ?? (await findLogFile(persistence, sessionId))
  let sizeBytes
  if (file !== undefined) {
    try {
      sizeBytes = (await fsStat(file)).size
    } catch {
      sizeBytes = undefined
    }
  }

  const workspaces = registry.list().map((workspace) => ({
    id: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    accounted: workspace.sessionIds.includes(sessionId),
    matchesCwd: canonical !== undefined && workspace.path === canonical,
  }))

  const snapshots = await persistence.list()
  const children = snapshots
    .map((snapshot) => snapshot.header)
    .filter((candidate) => candidate?.parentSession === sessionId)
    .map((candidate) => ({ id: candidate.id, cwd: candidate.cwd }))

  const activity = await activityOf(ctx, sessionId)
  const live = liveSessionOf(ctx, sessionId) !== undefined

  return {
    header,
    cwd,
    canonical,
    file,
    sizeBytes,
    workspaces,
    children,
    activity,
    live,
    registry,
    persistence,
  }
}

/**
 * 把一个会话日志从旧位置搬到新位置（跨项目目录搬迁）。
 *
 * 顺序刻意如此，避免「同一个 id 在两个项目目录下同时存在」的中间态——
 * 后端的 findLog() 是扫描式的，重复文件会让它选到旧的那份：
 *   ① 原件复制进回收站 → ② 改写后的副本先落到目标目录的临时名（发现逻辑不认识它）
 *   → ③ 摘掉旧文件与旧目录 → ④ 临时名转正 → ⑤ 用后端自己的 stat() 复验头部
 * @param context - describe() 的结果。
 * @param targetPath - 目标工作区路径（规范形式）。
 * @param trashRoot - 回收站根目录。
 * @param log - 诊断输出。
 * @returns `{ source, destination, trash, bytes }`。
 */
async function relocateLog(context, targetPath, trashRoot, log) {
  const { persistence, header } = context
  const source = context.file ?? (await findLogFile(persistence, header.id))
  if (source === undefined) throw new Error(`找不到会话 ${header.id} 的日志文件，无法搬迁`)

  const destination = logPathOf(persistence, { id: header.id, cwd: targetPath })
  if (destination === undefined) {
    throw new Error("此版本的会话持久化后端不提供 locate()，无法安全推导目标路径")
  }
  if (resolve(destination) === resolve(source)) {
    return { source, destination, trash: undefined, bytes: undefined }
  }

  // ① 原件先复制进回收站（写坏也能原样拿回来）。
  const trashDir = join(trashRoot, `${stamp()}-${header.id}`)
  const trashFile = join(trashDir, "session.log")
  await mkdir(trashDir, { recursive: true })
  await copyFile(source, trashFile)
  await writeFile(
    join(trashDir, "restore.json"),
    JSON.stringify(
      {
        sessionId: header.id,
        reason: "relocate-backup",
        cwdBefore: header.cwd,
        sourcePath: source,
        destinationPath: destination,
        trashedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  )

  // ② 改写头部 cwd，副本先以临时名落到目标目录。
  const bytes = rewriteHeaderCwd(await readFile(source), targetPath)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp-${randomUUID()}`
  await writeFile(temporary, bytes)

  // ③ 摘掉旧文件与旧目录，保证同一时刻只剩一份。
  await rm(source, { force: true })
  await rm(dirname(source), { recursive: true, force: true })

  // ④ 转正。
  await rename(temporary, destination)

  // ⑤ 复验：后端读到的头部必须已经是目标 cwd。
  const verified = await persistence.stat(header.id)
  if (verified?.header?.cwd !== targetPath) {
    await rm(destination, { force: true })
    await mkdir(dirname(source), { recursive: true }).catch(() => {})
    await copyFile(trashFile, source).catch(() => {})
    throw new Error(`搬迁后校验失败（头部 cwd = ${String(verified?.header?.cwd)}），已回滚原件`)
  }

  log(`已搬迁 ${header.id}：${source} → ${destination}`)
  return { source, destination, trash: trashFile, bytes: bytes.length }
}

/**
 * 让注册表的头部索引重新读取磁盘上的会话头部。
 *
 * 注册表对头部有内存缓存（`headers` Map），改写 cwd 之后必须刷新，
 * 否则 attachSession 会拿旧 cwd 校验并拒绝。
 * @param registry - 工作区注册表。
 */
async function refreshHeaderIndex(registry) {
  if (typeof registry.replaceHeaderIndex !== "function" || typeof registry.listStoredHeaders !== "function") return
  await registry.replaceHeaderIndex(await registry.listStoredHeaders())
}

/**
 * 移动一个会话到目标工作区。
 * @param ctx - 宿主上下文。
 * @param params - `{ sessionId, workspaceId, force }`。
 * @param options - 生效配置。
 * @param log - 诊断输出。
 * @returns 结果。
 */
async function moveSession(ctx, params, options, log) {
  const sessionId = requireString(params?.sessionId, "sessionId")
  const workspaceId = requireString(params?.workspaceId, "workspaceId")
  const context = await describe(ctx, sessionId)
  const { registry, header, canonical } = context

  const target = registry.get(workspaceId)
  if (target === undefined) throw new Error(`找不到工作区 ${workspaceId}`)

  const targetPath = target.path
  const alreadyThere = canonical === targetPath && target.sessionIds.includes(sessionId)
  if (alreadyThere) return { mode: "noop", workspace: viewOf(target), sessionId }

  // ① cwd 已匹配 → 纯登记，字节不动。
  if (canonical === targetPath) {
    await target.attachSession(sessionId)
    await refreshHeaderIndexIfNeeded(registry)
    return { mode: "attach", workspace: viewOf(target), sessionId, file: context.file }
  }

  if (options.allowRelocate !== true) {
    throw new Error("本插件配置为禁止跨目录搬家（allowRelocate: false），只能在 cwd 匹配时登记")
  }

  // ② 跨目录搬家。
  if (context.activity.length > 0) {
    throw new Error(`这个会话还有工作在跑（${context.activity.length} 项），先停止再移动`)
  }
  if (context.live && params?.force !== true) {
    throw new Error("这个会话正在运行或已被打开，先切换到别的会话再移动（或勾选强制）")
  }
  try {
    const targetStat = await fsStat(targetPath)
    if (!targetStat.isDirectory()) throw new Error("not a directory")
  } catch (error) {
    throw new Error(`目标工作区目录不可用：${targetPath}（${String(error)}）`)
  }

  const trashRoot = trashRootOf(options)
  const previousWorkspaces = registry
    .list()
    .filter((workspace) => String(workspace.id) !== workspaceId && workspace.sessionIds.includes(sessionId))

  let relocation
  try {
    relocation = await relocateLog(context, targetPath, trashRoot, log)
    await refreshHeaderIndex(registry)
    for (const workspace of previousWorkspaces) await workspace.detachSession(sessionId)
    await target.attachSession(sessionId)
  } catch (error) {
    // 回滚：relocateLog 在自校验失败时已把原件放回；
    // 这里只把注册表的头部索引清回真实状态，绝不掩盖原始错误。
    try {
      await refreshHeaderIndex(registry)
    } catch {
      /* 尽力而为 */
    }
    throw error
  }

  return {
    mode: "relocate",
    sessionId,
    workspace: viewOf(target),
    from: relocation.source,
    to: relocation.destination,
    backup: relocation.trash,
  }
}

/** 注册表存在时刷新一次头部索引（纯登记路径用，失败不致命）。 */
async function refreshHeaderIndexIfNeeded(registry) {
  try {
    await refreshHeaderIndex(registry)
  } catch {
    /* 索引刷新失败不影响已经登记的成员关系 */
  }
}

/** 工作区的对外视图。 */
function viewOf(workspace) {
  return { id: String(workspace.id), title: workspace.title, path: workspace.path }
}

/** 校验字符串参数。 */
function requireString(value, field) {
  if (typeof value !== "string" || value === "") throw new Error(`缺少参数 ${field}`)
  return value
}

/** 回收站根目录。 */
function trashRootOf(options) {
  const configured = typeof options.trashDir === "string" ? options.trashDir.trim() : ""
  return configured !== "" ? configured : join(dshHome(), "session-trash")
}

/**
 * 删除一个会话：删它自己，以及（可选）它的 subagent 子会话。
 *
 * 全部走「整棵目录搬进回收站」，绝不永久删除。
 * @param ctx - 宿主上下文。
 * @param params - `{ sessionId, includeChildren, force }`。
 * @param options - 生效配置。
 * @param log - 诊断输出。
 * @returns 结果。
 */
async function deleteSession(ctx, params, options, log) {
  const sessionId = requireString(params?.sessionId, "sessionId")
  const context = await describe(ctx, sessionId)
  const { registry, persistence } = context

  // 有工作在跑一律拒绝；只是被打开着则要显式 force（界面会提示先切换）。
  if (context.activity.length > 0) {
    throw new Error(`这个会话还有工作在跑（${context.activity.length} 项），先停止再删除`)
  }
  if (context.live && params?.force !== true) {
    throw new Error("这个会话正在运行或已被打开，先切换到别的会话再删除（或勾选强制）")
  }

  const targets = [{ id: sessionId, context }]
  if (params?.includeChildren !== false) {
    for (const child of context.children) {
      if (liveSessionOf(ctx, child.id) !== undefined) continue
      try {
        targets.push({ id: child.id, context: await describe(ctx, child.id) })
      } catch {
        /* 子会话读不出来就跳过 */
      }
    }
  }

  const trashRoot = join(trashRootOf(options), `${stamp()}-${sessionId}`)
  await mkdir(trashRoot, { recursive: true })
  const trashed = []
  const skipped = []

  for (const target of targets) {
    const file = target.context.file ?? (await findLogFile(persistence, target.id))
    if (file === undefined) {
      skipped.push({ id: target.id, reason: "没有找到日志文件" })
      continue
    }
    const sessionDir = dirname(file)
    const destination = join(trashRoot, target.id)
    try {
      await mkdir(destination, { recursive: true })
      for (const relative of await listFiles(sessionDir)) {
        await rename(join(sessionDir, relative), join(destination, basename(relative))).catch(async () => {
          await copyFile(join(sessionDir, relative), join(destination, basename(relative)))
          await rm(join(sessionDir, relative), { force: true })
        })
      }
      await writeFile(
        join(destination, "restore.json"),
        JSON.stringify(
          {
            sessionId: target.id,
            reason: "delete",
            cwd: target.context.header.cwd,
            originalPath: file,
            originalSessionDir: sessionDir,
            trashedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      )
      await rm(sessionDir, { recursive: true, force: true })
      trashed.push({ id: target.id, from: sessionDir, to: destination })
      log(`已删除会话 ${target.id} → ${destination}`)
    } catch (error) {
      skipped.push({ id: target.id, reason: String(error) })
    }
  }

  // 注册表收尾：摘账目、取消防置顶/归档标记，再刷新头部索引让侧栏掉行。
  for (const target of targets) {
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(target.id)) continue
      await workspace.detachSession(target.id).catch(() => {})
    }
    await registry.unpinSession?.(target.id).catch(() => {})
    await registry.unarchiveSession?.(target.id).catch(() => {})
  }
  await refreshHeaderIndexIfNeeded(registry)

  return { sessionId, trashRoot, trashed, skipped, count: trashed.length }
}

/**
 * 把回收站里的一个条目放回去。
 * @param ctx - 宿主上下文。
 * @param params - `{ trashPath }`：回收站条目目录（含 restore.json 的那一层）。
 * @returns 结果。
 */
async function restoreSession(ctx, params) {
  const trashPath = requireString(params?.trashPath, "trashPath")
  const manifestPath = join(trashPath, "restore.json")
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    throw new Error(`回收站条目缺少 restore.json：${String(error)}`)
  }
  const originalDir = manifest.originalSessionDir ?? (manifest.originalPath !== undefined ? dirname(manifest.originalPath) : undefined)
  if (typeof originalDir !== "string" || originalDir === "") throw new Error("restore.json 没有记录原始目录")

  await mkdir(originalDir, { recursive: true })
  const files = (await listFiles(trashPath)).filter((relative) => relative !== "restore.json")
  if (files.length === 0) throw new Error("回收站条目里没有日志文件")
  for (const relative of files) {
    await copyFile(join(trashPath, relative), join(originalDir, basename(relative)))
  }

  const registry = registryOf(ctx)
  if (registry !== undefined) {
    await refreshHeaderIndexIfNeeded(registry)
    const target = registry.list().find((workspace) => workspace.path === manifest.cwd)
    if (target !== undefined) await target.attachSession(manifest.sessionId).catch(() => {})
  }
  return { sessionId: manifest.sessionId, restoredTo: originalDir }
}

/** 列出回收站条目（最近在前）。 */
async function listTrash(ctx, params, options) {
  const root = trashRootOf(options)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { root, entries: [] }
  }
  const listed = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(root, entry.name, "restore.json"), "utf8"))
    } catch {
      manifest = undefined
    }
    listed.push({ name: entry.name, path: join(root, entry.name), manifest })
  }
  listed.sort((left, right) => right.name.localeCompare(left.name))
  return { root, entries: listed }
}

/* ───────────────────────────── HTTP 半边 ───────────────────────────── */

/** 允许调度的操作（白名单，杜绝任意反射调用）。 */
const OPERATIONS = new Map([
  ["prepare", (ctx, params, options, log) => prepareSession(ctx, params, options, log)],
  ["openLocation", (ctx, params, _options, log) => openSessionLocation(ctx, params, log)],
  ["move", (ctx, params, options, log) => moveSession(ctx, params, options, log)],
  ["delete", (ctx, params, options, log) => deleteSession(ctx, params, options, log)],
  ["restore", (ctx, params) => restoreSession(ctx, params)],
  ["listTrash", (ctx, params, options) => listTrash(ctx, params, options)],
])

/**
 * prepare：给界面提供一次操作所需的全部事实（工作区清单、当前归属、风险提示）。
 * @param ctx - 宿主上下文。
 * @param params - `{ sessionId }`。
 * @param options - 生效配置。
 * @returns 界面所需数据。
 */
async function prepareSession(ctx, params, options) {
  const sessionId = requireString(params?.sessionId, "sessionId")
  const context = await describe(ctx, sessionId)
  return {
    session: {
      id: sessionId,
      cwd: context.cwd,
      canonicalCwd: context.canonical,
      origin: context.header.origin ?? "user",
      sizeBytes: context.sizeBytes,
      live: context.live,
      activityCount: context.activity.length,
      activity: context.activity.map((item) => ({ kind: item?.kind, name: item?.name })),
      workspaceId: context.workspaces.find((workspace) => workspace.accounted)?.id ?? null,
    },
    workspaces: context.workspaces,
    children: context.children,
    trashRoot: trashRootOf(options),
    allowRelocate: options.allowRelocate === true,
  }
}

/** 浏览器信任 fence：Host 必须是回环或可信域，且请求非跨站、Origin 与 Host 同源。 */
function isTrustedRequest(request, trustedHosts) {
  const headers = request.headers ?? {}
  const host = headers.host
  if (typeof host !== "string" || host === "") return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const loopback =
    hostUrl.hostname === "localhost" ||
    hostUrl.hostname === "127.0.0.1" ||
    hostUrl.hostname === "::1" ||
    hostUrl.hostname === "[::1]" ||
    hostUrl.hostname === "0:0:0:0:0:0:0:1" ||
    hostUrl.hostname.endsWith(".localhost")
  const trusted = Array.isArray(trustedHosts)
    ? trustedHosts.some((raw) => {
        try {
          return new URL(`http://${raw}`).host === hostUrl.host
        } catch {
          return false
        }
      })
    : false
  if (!loopback && !trusted) return false
  if (headers["sec-fetch-site"] === "cross-site") return false
  const origin = headers.origin
  if (typeof origin !== "string" || origin === "") return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读一个 JSON 请求体（最大 1 MiB）。 */
async function readJsonBody(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > 1024 * 1024) throw new Error("请求体不能超过 1 MiB")
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (text.trim() === "") return {}
  return JSON.parse(text)
}

/**
 * 挂载 `/session-ops/api`（POST JSON：`{ method, params }`）。
 * @param wctx - 已注入 webServer / webRuntime 的子上下文。
 * @param getOptions - 读取生效配置。
 * @param log - 诊断输出。
 * @returns disposer。
 */
function mountRoutes(wctx, getOptions, log) {
  return wctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      // 处理器里任何抛出都会被 webserver 折成**没有响应体的裸 400**，现场就丢了，
      // 所以整个函数体自带兜底：永远自己写出 JSON，并把栈留在诊断日志里。
      try {
        // 注意：cordis 里 `ctx.webRuntime` 对未注入的服务会直接抛错，
        // 必须走 ctx.get() 取可选服务。
        const trustedHosts = serviceOf(wctx, "webRuntime")?.trustedHosts
        if (!isTrustedRequest(req, trustedHosts)) {
          writeJson(res, 403, { ok: false, message: "forbidden" })
          return
        }
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST" })
          res.end()
          return
        }
        const body = await readJsonBody(req)
        const operation = OPERATIONS.get(body?.method)
        if (operation === undefined) {
          writeJson(res, 400, {
            ok: false,
            message: `未知方法 "${String(body?.method ?? "")}"（可用：${[...OPERATIONS.keys()].join("、")}）`,
          })
          return
        }
        const options = getOptions()
        const result = await operation(wctx, body?.params ?? {}, options, log)
        writeJson(res, 200, { ok: true, detail: result })
      } catch (error) {
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
        log(`api 失败：${message}`)
        note(`api 失败：${message}`)
        try {
          writeJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
        } catch {
          /* 响应已经发出去或 socket 已销毁 */
        }
      }
    },
  })
}

/* ───────────────────────────── 插件入口 ───────────────────────────── */

/**
 * 安装插件：注册 HTTP 路由（浏览器半边据此读写会话归属）。
 * @param ctx - 宿主上下文。
 * @param config - profile patch 传入的配置（可选）。
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const debug = options.debug === true
  const log = (message) => {
    try {
      ctx.logger(name).info(String(message))
    } catch {
      console.log(`[${name}] ${String(message)}`)
    }
    if (debug) console.log(`[${name}] ${String(message)}`)
  }
  note(`apply: ${name} 已加载（node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ""}）`)
  if (options.enabled === false) {
    log("已按配置停用（enabled: false）")
    note("apply: 已按配置停用")
    return
  }

  let dispose = undefined
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["webServer"], (wctx) => {
        dispose = mountRoutes(wctx, () => options, log)
        log(`已挂载 ${ROUTE_PREFIX}`)
        note(`apply: 已挂载 ${ROUTE_PREFIX}`)
      })
    } catch (error) {
      log(`未挂载 web 路由（webServer 不可用）：${String(error)}`)
      note(`apply: 未挂载（${String(error)}）`)
    }
  } else {
    note("apply: 上下文没有 inject()，未挂载 web 路由")
  }
  ctx.effect?.(() => () => {
    try {
      dispose?.()
    } catch {
      /* 已经卸载 */
    }
  }, "dsh-session-ops: web routes")
}

/** 供测试与诊断使用：不经过 HTTP 直接调用内部操作。 */
export const internals = {
  describe,
  openSessionLocation,
  moveSession,
  deleteSession,
  restoreSession,
  listTrash,
  mountRoutes,
  rewriteHeaderCwd,
  logPathOf,
  findLogFile,
  trashRootOf,
  refreshHeaderIndex,
}
