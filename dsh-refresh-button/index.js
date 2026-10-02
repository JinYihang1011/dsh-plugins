/**
 * dsh-refresh-button —— 宿主半边。
 *
 * 客户端半边只负责画菜单（刷新 / 重启 / 关闭）；重启与关闭必须由宿主进程执行，
 * 所以这里用 Web 路由把能力暴露给同源页面（与 dsh-builtin-browser 设置面板同一手法）：
 *
 *   POST /dsh-refresh-button/action   body: {"action":"restart"|"quit"}
 *     → 先回 200（让页面拿到回执），再启动一个脱离宿主进程的 PowerShell：
 *       restart：等 ~0.9s → 结束所有 "DeepSeek Harness" 进程 → 等 2s → 重新拉起 exe
 *       quit   ：等 ~0.9s → 结束所有 "DeepSeek Harness" 进程（不重启）
 *
 * 按用户要求：两项都**不做二次确认**，点击即执行。
 * spawn 用 detached + unref：脚本不随宿主进程一起被杀掉。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-refresh-button'

const ACTION_ROUTE = '/dsh-refresh-button/action'
const DSH_EXE = 'D:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe'
const MAX_BODY = 4096

/** 同源守卫：只允许本页发起（跨站页面不得触发重启/关闭）。 */
function sameOrigin(request) {
  const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return false
  const origin = String(request.headers.origin ?? '').trim()
  if (origin === 'null') return false
  if (origin === '') return true
  try {
    return new URL(origin).host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase()
  } catch {
    return false
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > MAX_BODY) {
        request.destroy()
        finish('')
      }
    })
    request.on('end', () => finish(data))
    request.on('error', () => finish(''))
  })
}

/** 宿主侧也写日志，和 restart.ps1 用同一个文件，便于对照。
 *  路径固定成 <DSH_HOME>\logs\ —— 不能依赖 TEMP：DSH 的文件沙箱会按会话给不同的 TEMP，
 *  宿主进程与 agent shell 看到的 TEMP 并不是同一个目录（实测踩过）。 */
function logPath() {
  const dir = join(homedir(), '.dsh', 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 目录建不出来就让 appendFileSync 自己失败
  }
  return join(dir, 'dsh-refresh-button.log')
}

function logLine(message) {
  try {
    appendFileSync(logPath(), `${new Date().toISOString()} [host] ${message}\n`)
  } catch {
    // 日志写不了不影响主流程
  }
}

/** powershell.exe 走绝对路径：桌面端宿主的 PATH 可能不含 System32。 */
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const candidates = [
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/** 动作脚本的位置：与本文件同目录（link 安装后即 ~/.dsh/local-plugins/dsh-refresh-button/restart.ps1）。 */
function scriptPath() {
  try {
    return fileURLToPath(new URL('./restart.ps1', import.meta.url))
  } catch {
    return ''
  }
}

/**
 * 启动脱离宿主进程的动作脚本。
 *
 * 脚本外置成 restart.ps1（而不是嵌在这里）有两个好处：
 *   1. 每次动作都重新读文件 —— 改脚本不需要重启 DSH（宿主只会在启动时加载本文件）；
 *   2. 脚本内部逐步写日志到 %TEMP%\dsh-refresh-button.log，失败时能直接看到卡在哪一步。
 */
export function scheduleHostAction(action) {
  const file = scriptPath()
  const ps = powershellPath()
  logLine(`action=${action} script=${file} powershell=${ps}`)
  if (!file || !existsSync(file)) {
    logLine('restart.ps1 不存在，放弃')
    throw new Error('restart.ps1 not found: ' + file)
  }
  // 这里**刻意不用 detached: true**。
  // Windows 下 detached 会用 DETACHED_PROCESS 起进程，PowerShell 5.1 在没有控制台的
  // 这种环境下会立刻退出（exit 0，约 120ms），脚本一行都不执行。实测二分：
  //   detached + -File -> 不执行；不 detached + -File -> 正常执行。
  // 子进程不会随宿主一起死：restart.ps1 用 Stop-Process（不带 /T）只结束目标进程，不杀进程树。
  const child = spawn(
    ps,
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', file, '-Action', action],
    { stdio: 'ignore', windowsHide: true }
  )
  child.on('error', (err) => logLine('spawn error: ' + String(err && err.message ? err.message : err)))
  child.on('exit', (code, signal) => logLine(`child exited code=${code} signal=${signal}`))
  child.unref()
  logLine('spawned pid=' + String(child.pid))
  return file
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

export function apply(ctx) {
  const inject = ctx.inject
  if (typeof inject !== 'function') return
  try {
    inject(['webServer'], (host) => {
      host.effect(() =>
        host.webServer.register(
          {
            kind: 'exact',
            path: ACTION_ROUTE,
            handler: async (request, response) => {
              if (!sameOrigin(request)) return json(response, 403, { ok: false, error: 'cross-origin refused' })
              if (String(request.method ?? '').toUpperCase() !== 'POST') {
                return json(response, 405, { ok: false, error: 'POST required' })
              }
              let action = ''
              try {
                action = String(JSON.parse((await readBody(request)) || '{}').action ?? '')
              } catch {
                return json(response, 400, { ok: false, error: 'invalid JSON body' })
              }
              if (action !== 'restart' && action !== 'quit') {
                return json(response, 400, { ok: false, error: 'action must be restart or quit' })
              }
              if (!existsSync(DSH_EXE)) {
                return json(response, 500, { ok: false, error: 'DSH executable not found: ' + DSH_EXE })
              }
              // 先给页面回执，再动手
              json(response, 200, { ok: true, action })
              try {
                scheduleHostAction(action)
              } catch (err) {
                ctx.logger?.warn?.('dsh-refresh-button: %s failed: %s', action, String(err))
              }
            },
          },
          'dsh-refresh-button: host action'
        )
      )
    })
  } catch {
    // 没有 webServer 的宿主（headless / CLI）：菜单里的重启/关闭不可用，但不影响插件加载
  }
}
