/**
 * dsh-win-notify —— 宿主半边（Host side）。
 *
 * 目标：DSH 出现「审批请求」或「用户问询」时，弹一条 Windows 通知，
 * 让窗口在后台 / 最小化时也不会漏掉需要人回答的事情。
 *
 * ── 挂载点 ────────────────────────────────────────────────────────────────
 * 两个都是 agent 作用域的 cordis 事件瀑布（宿主侧由 dsh-api-remotes 转发给浏览器 UI）：
 *   · approval/request        —— ctx.approval.request() 派发；策略为 ask 时才走到这里
 *   · user-questions/request  —— ctx.userQuestions.ask() 派发（ask_user_question 工具）
 *
 * ── 为什么要 prepend ─────────────────────────────────────────────────────
 * cordis 的监听表（EventsService._hooks）是**全应用一张按注册顺序排列的数组**，
 * 瀑布链就是按这个顺序串起来的。本插件作为 bundle 排在 dsh-web-app 之后加载，
 * 若不 prepend 就排在链尾：要等人答完（或请求失败）才会轮到本监听器，通知毫无意义。
 * 加上 { prepend: true } 后排到链首，通知完立即调用 next() 放行，
 * 不干预、不改变任何审批结果与问询答案。
 *
 * 事件作用域过滤（dsh-scope.scopeTarget）对未打作用域标签的监听器一律放行，
 * 所以在本插件自己的 ctx 上注册即可收到每个 agent 的请求。
 *
 * ── 通知怎么发出去 ───────────────────────────────────────────────────────
 * 交给同目录的 notify.ps1，用 **Windows PowerShell 5.1**（不是 pwsh：PS7 没有
 * WinRT 投影）调用 Windows.UI.Notifications。两点必须同时满足：
 *   1. 进程完整性级别 ≥ Medium —— 宿主进程是 Medium，子进程继承之；Low 完整性
 *      （DSH 文件沙箱里的 pwsh）调用会报 0x80073D54 "no package identity"。
 *   2. AUMID 必须是已注册了开始菜单快捷方式的那个 —— 桌面端安装时注册的是
 *      com.deepseek.dsh，所以通知显示为「DeepSeek Harness」并带其图标。
 * 载荷走 base64(UTF-8 JSON) 参数传递，彻底绕开 PowerShell 的引号/编码坑。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 * 安装后即生效，无需配置。可用 profile 的 patch 覆盖配置，例如：
 *   - id: dsh-win-notify
 *     name: dsh-win-notify
 *     config:
 *       sound: false
 *       appId: com.deepseek.dsh
 *
 * 本文件刻意不 import 任何 @deepseek-ai/* 包：插件目录被 profile 以 link: 方式
 * 引用，Node 按 realpath 解析依赖，插件自己目录里没有 DSH 的 node_modules。
 * 只用 node: 内置模块，因此没有可解析性风险。
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** 本插件目录（notify.ps1 与 index.js 同级）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 真正发通知的 PowerShell 脚本。 */
const TOAST_SCRIPT = join(HERE, "notify.ps1")

/** Windows PowerShell 5.1 的绝对路径（WinRT 投影只在这里可用）。 */
const WINDOWS_POWERSHELL = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)

/** 默认配置；profile patch 里的 config 会逐项覆盖。 */
const DEFAULTS = {
  /** 通知的 AppUserModelID。DSH 桌面端注册的就是这个，改错会导致通知不显示。 */
  appId: "com.deepseek.dsh",
  /** 是否播放通知提示音。 */
  sound: true,
  /**
   * 点击通知（或动作按钮）时激活的 URI。
   * DSH 桌面端注册了 `dsh` 协议（app.setAsDefaultProtocolClient("dsh")），
   * 且只在 `dsh://open` 上聚焦主窗口，所以点击能把 DSH 拉回前台。
   * 置空字符串可关掉点击行为。
   */
  launchUri: "dsh://open",
  /** 动作按钮文案；置空则只保留整条通知的点击激活。 */
  actionLabel: "打开 DeepSeek Harness",
  /**
   * toast scenario，空串=普通通知（约 6 秒后自动消失）。
   * 设为 `"reminder"` 则通知一直停留在屏幕上，直到用户点击或手动关闭——
   * 想要"绝不错过"的体验就开它（代价是它会更碍眼）。
   */
  scenario: "",
  /** 通知标题。 */
  approvalTitle: "DSH · 需要审批",
  questionTitle: "DSH · 需要你的回答",
  planReviewTitle: "DSH · 计划待确认",
  /** 正文单行最大字符数，超出截断（Windows 通知正文过长会被系统裁掉）。 */
  textMaxChars: 160,
  /** 在正文里附一行会话标题，便于判断该切回哪段对话。 */
  includeSessionTitle: true,
  /** 相同标题+正文在该毫秒窗口内只发一次，防止重试/重复派发刷屏。 */
  dedupeWindowMs: 2000,
  /** 单次 powershell.exe 的最长存活时间（毫秒），超时直接杀掉，避免僵尸进程。 */
  timeoutMs: 15000,
  /** 只做内容组装与日志、不真的弹通知（自测用）。 */
  dryRun: false,
  /** 转发到宿主控制台的诊断日志（排查用）。 */
  debug: false,
}

/** 已发出的通知指纹 → 时间戳，用于去重。 */
const recent = new Map()

/**
 * 截断单行文本，避免超长正文被 Windows 截断得莫名其妙。
 * @param value - 任意文本。
 * @param max - 最大字符数。
 * @returns 单行、已截断的文本；无效输入返回空串。
 */
function oneLine(value, max) {
  if (typeof value !== "string") return ""
  const flat = value.replace(/\s+/gu, " ").trim()
  if (flat === "") return ""
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * 读取请求所属会话的标题（`ctx.sessionTitle.get(session)`）。
 *
 * 只用于让通知说明"哪段对话在等你"，拿不到就安静地省略这一行：
 * 服务缺失、会话尚未生成标题、内部结构变动，都不该影响通知本身。
 * @param ctx - 插件上下文。
 * @param agent - 事件请求携带的 agent（可能不存在）。
 * @returns 会话标题，或空串。
 */
function sessionTitleOf(ctx, agent) {
  try {
    const service = ctx.get?.("sessionTitle")
    const session = agent?.session
    if (service === undefined || service === null || session === undefined) return ""
    const title = service.get(session)
    return typeof title === "string" ? title : ""
  } catch {
    return ""
  }
}

/**
 * 审批请求 → 通知内容。
 * @param request - approval/request 的事件载荷（toolName / reason / displayReason / callId）。
 * @param options - 生效配置。
 * @param sessionTitle - 会话标题，可为空。
 * @returns 标题与正文各行。
 */
function approvalContent(request, options, sessionTitle) {
  const toolName = oneLine(request?.toolName, 80) || "未知工具"
  const reason = oneLine(request?.reason, options.textMaxChars)
  const texts = [reason || `工具 ${toolName} 请求越权执行`]
  // 自定义 reason 未必提到工具名，补一行让人一眼看清是谁在申请。
  if (reason !== "") texts.push(`工具：${toolName}`)
  if (sessionTitle !== "") texts.push(`会话：${sessionTitle}`)
  return { title: options.approvalTitle, texts }
}

/**
 * 问询请求 → 通知内容。
 * @param request - user-questions/request 的事件载荷（questions 数组）。
 * @param options - 生效配置。
 * @param sessionTitle - 会话标题，可为空。
 * @returns 标题与正文各行。
 */
function questionContent(request, options, sessionTitle) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const first = questions[0] ?? {}
  const isPlanReview = first?.intent?.kind === "plan-review"
  const headline =
    oneLine(first?.question, options.textMaxChars) ||
    oneLine(first?.header, options.textMaxChars) ||
    "有一个问题需要你回答"
  const texts = [headline]
  if (questions.length > 1) texts.push(`另外还有 ${questions.length - 1} 个问题`)
  else if (!isPlanReview && oneLine(first?.header, 60) !== "" && oneLine(first?.header, 60) !== headline)
    texts.push(oneLine(first?.header, 60))
  if (sessionTitle !== "") texts.push(`会话：${sessionTitle}`)
  return { title: isPlanReview ? options.planReviewTitle : options.questionTitle, texts }
}

/**
 * 用 Windows PowerShell 5.1 弹一条通知。
 *
 * 任何失败都只记日志、绝不抛出：本函数在审批瀑布链首执行，
 * 抛错会把一次正常审批变成 unavailable（fail closed），那是不可接受的副作用。
 * @param content - 标题与正文各行。
 * @param options - 生效配置。
 * @param log - 诊断输出函数。
 */
function showToast(content, options, log) {
  if (options.dryRun === true) {
    log(`[dry-run] ${content.title} :: ${content.texts.join(" | ")}`)
    return
  }
  if (!existsSync(TOAST_SCRIPT)) {
    log(`找不到通知脚本：${TOAST_SCRIPT}`)
    return
  }
  const powershell = existsSync(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : "powershell.exe"
  const payload = {
    appId: options.appId,
    title: content.title,
    texts: content.texts,
    sound: options.sound !== false,
  }
  // 总是显式下发 launch（哪怕是空串）：空串表示"不要点击行为"，
  // notify.ps1 只有在载荷完全没有该字段时才使用它自己的缺省值。
  payload.launch = typeof options.launchUri === "string" ? options.launchUri.trim() : ""
  if (payload.launch !== "" && typeof options.actionLabel === "string" && options.actionLabel.trim() !== "") {
    payload.actionLabel = options.actionLabel.trim()
  }
  if (typeof options.scenario === "string" && options.scenario.trim() !== "") {
    payload.scenario = options.scenario.trim()
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
  let child
  try {
    child = spawn(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        TOAST_SCRIPT,
        "-PayloadBase64",
        encoded,
      ],
      { windowsHide: true, stdio: "ignore" },
    )
  } catch (error) {
    log(`启动 powershell 失败：${String(error)}`)
    return
  }
  child.on("error", (error) => log(`powershell 进程错误：${String(error)}`))
  const timer = setTimeout(() => {
    try {
      child.kill()
    } catch {
      /* 已经退出 */
    }
  }, options.timeoutMs)
  timer.unref?.()
  child.on("exit", () => clearTimeout(timer))
}

/**
 * 组装并投递一条通知（带去重）。
 * @param kind - 事件种类，参与去重指纹。
 * @param content - 标题与正文。
 * @param options - 生效配置。
 * @param log - 诊断输出函数。
 */
function notify(kind, content, options, log) {
  if (content === undefined || content === null) return
  const fingerprint = `${kind}\u0000${content.title}\u0000${content.texts.join("\u0001")}`
  const now = Date.now()
  const previous = recent.get(fingerprint)
  if (previous !== undefined && now - previous < options.dedupeWindowMs) return
  recent.set(fingerprint, now)
  // 只保留最近的指纹，长期运行不涨内存。
  if (recent.size > 64) {
    for (const [key, at] of recent) if (now - at > options.dedupeWindowMs) recent.delete(key)
  }
  if (options.debug) log(`通知：${content.title} / ${content.texts.join(" / ")}`)
  showToast(content, options, log)
}

/** Loader 中的插件标识。 */
export const name = "dsh-win-notify"

/**
 * 安装两个 prepend 瀑布监听器。
 * @param ctx - 插件上下文。
 * @param config - profile patch 传入的配置（可选）。
 */
export function apply(ctx, config) {
  if (process.platform !== "win32") return
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const log = (message) => {
    if (!options.debug && !String(message).startsWith("找不到")) return
    try {
      ctx.logger(name).warn(String(message))
    } catch {
      console.warn(`[${name}] ${String(message)}`)
    }
  }

  ctx.on(
    "approval/request",
    (request, next) => {
      try {
        const sessionTitle = options.includeSessionTitle === false ? "" : sessionTitleOf(ctx, request?.agent)
        notify("approval", approvalContent(request, options, sessionTitle), options, log)
      } catch (error) {
        log(`审批通知失败：${String(error)}`)
      }
      return next()
    },
    { prepend: true },
  )

  ctx.on(
    "user-questions/request",
    (request, next) => {
      try {
        const sessionTitle = options.includeSessionTitle === false ? "" : sessionTitleOf(ctx, request?.agent)
        notify("question", questionContent(request, options, sessionTitle), options, log)
      } catch (error) {
        log(`问询通知失败：${String(error)}`)
      }
      return next()
    },
    { prepend: true },
  )
}
