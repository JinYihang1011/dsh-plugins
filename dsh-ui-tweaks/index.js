/**
 * dsh-ui-tweaks —— 宿主半边。
 *
 * 本插件是**纯样式**的：真正的工作全在浏览器半边（client.js 注入一张样式表）。
 * 宿主这半边只用来说明「本插件已加载」，并给未来的宿主侧微调留一个落点。
 *
 * 为什么值得单独做成一个插件，而不是直接改上游文件：
 *   之前把 dsh-mcp-connector 的 lib/client.js 改了，结果插件一升级就整份被覆盖，
 *   改动无声消失。这里的做法是**不碰任何上游文件**，只用一张优先级更高的
 *   样式表从外面覆盖。上游升级不会清除它；万一上游改了类名，最坏情况也只是
 *   这条样式不再命中，而不会报错或破坏界面。
 */

import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Loader 中的插件标识。 */
export const name = "dsh-ui-tweaks"

/** DSH 主目录。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : join(homedir(), ".dsh")
}

/** 诊断日志：追加到 `<DSH_HOME>\ui-tweaks.log`。永不抛。 */
function note(message) {
  try {
    appendFileSync(join(dshHome(), "ui-tweaks.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8")
  } catch {
    /* 写不进去就算了，不影响功能 */
  }
}

/**
 * 安装插件：本半边没有要做的事，只在日志里留一行，方便确认它真的被 compose 进来了。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
  const log = (message) => {
    try {
      ctx.logger(name).info(String(message))
    } catch {
      console.log(`[${name}] ${String(message)}`)
    }
  }
  log("已加载（样式由浏览器半边注入）")
  note(`apply: ${name} 已加载（node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ""}）`)
}
