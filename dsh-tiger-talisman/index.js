/**
 * dsh-tiger-talisman —— 宿主半边（虎符咒）。
 *
 * 虎符咒的作用是**平衡**：它能平衡其余十一个符咒，集齐十二个才让圣主复活。
 * 这个插件干的是同一件事——DSH 里同时住着十几个插件、几十个 Skill，谁都往
 * 侧栏、往 `<head>`、往 z-index 里伸手；虎符咒给它们**划领地并仲裁争用**。
 *
 * 宿主这半边只做**只读体检**：profile 里装了哪些插件、哪些进了 bundle 层、
 * 谁带浏览器半边、有哪些 Skill（含可能互相抢活的触发词）。这些只有宿主能看见；
 * 插槽、样式表、层级那些则要浏览器半边才能看见，两边在面板里合成一张表。
 *
 * 全程**不改任何上游文件**，也不改任何配置——只读、只报告。
 */

import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Loader 中的插件标识。 */
export const name = "dsh-tiger-talisman"

/** DSH 主目录。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : join(homedir(), ".dsh")
}

/** 诊断日志：追加到 `<DSH_HOME>\tiger-talisman.log`。永不抛。 */
function note(message) {
  try {
    appendFileSync(join(dshHome(), "tiger-talisman.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8")
  } catch {
    /* 写不进去就算了，不影响功能 */
  }
}

/**
 * 读一个 JSON 文件，失败给兜底值（体检不该因为某个文件坏掉就整体失败）。
 * @param path - 文件路径。
 * @param fallback - 读不到时返回的值。
 * @returns 解析结果或兜底值。
 */
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

/**
 * 解析 `SKILL.md` 开头那段 `---` frontmatter 里的少量字段。
 *
 * 刻意不引 YAML 依赖：只需要 name / description / whenToUse 三个标量，而且
 * 解析失败也必须给出可读结果，不能让一个格式古怪的 skill 把体检带崩。
 * @param text - SKILL.md 全文。
 * @returns 解析出的字段（缺省为空串）。
 */
export function parseFrontmatter(text) {
  const fields = { name: "", description: "", whenToUse: "" }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return fields
  const body = match[1]
  const pick = (key) => {
    const line = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(body)
    if (line === null) return ""
    return line[1].trim().replace(/^["']|["']$/g, "")
  }
  fields.name = pick("name")
  fields.description = pick("description")
  fields.whenToUse = pick("whenToUse")
  return fields
}

/**
 * 解析 `link:` / 普通依赖对应的包目录。
 * @param profileDir - profile 目录。
 * @param dep - 依赖名。
 * @param spec - package.json 里的版本/规格串。
 * @returns 包目录绝对路径，无法判断时为 null。
 */
function resolvePackageDir(profileDir, dep, spec) {
  if (typeof spec === "string" && spec.startsWith("link:")) {
    return resolve(spec.slice("link:".length))
  }
  const candidate = join(profileDir, "node_modules", dep)
  return existsSync(candidate) ? candidate : null
}

/**
 * 扫描 profile 里装了哪些插件（只读）。
 *
 * 判定「这是不是一个 DSH 插件」的口径：它的 package.json 带 `dsh` 字段，
 * 或者它是本机自研的 `link:` 依赖。普通第三方依赖（cytoscape、rxjs 这种）
 * 会被跳过，否则体检报告里会混进一堆无关包。
 * @param home - DSH 主目录。
 * @returns `{ profileDir, bundles, plugins }`。
 */
export function collectPlugins(home) {
  const profileDir = join(home, "profiles", "desktop")
  const pkg = readJson(join(profileDir, "package.json"), null) ?? {}
  const bundlesRaw = pkg?.dsh?.profile?.bundles
  const bundles = Array.isArray(bundlesRaw) ? bundlesRaw.filter((value) => typeof value === "string") : []
  const deps = pkg?.dependencies !== null && typeof pkg?.dependencies === "object" ? pkg.dependencies : {}
  const plugins = []
  for (const [dep, specRaw] of Object.entries(deps)) {
    const spec = String(specRaw)
    const dir = resolvePackageDir(profileDir, dep, spec)
    const meta = dir === null ? null : readJson(join(dir, "package.json"), null)
    const dsh = meta?.dsh
    const isLocal = spec.startsWith("link:")
    if (dsh === void 0 && !isLocal) continue
    plugins.push({
      name: dep,
      version: typeof meta?.version === "string" ? meta.version : null,
      spec,
      local: isLocal,
      /** 只有进了 `dsh.profile.bundles` 才会被 compose 进宿主树。 */
      inBundles: bundles.includes(dep),
      hasClient: dsh !== null && dsh !== void 0 && dsh.client !== null && dsh.client !== void 0,
      clientPlatform: typeof dsh?.client?.platform === "string" ? dsh.client.platform : null,
      description: typeof meta?.description === "string" ? meta.description : "",
      path: dir,
    })
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))
  return { profileDir, bundles, plugins }
}

/**
 * 扫描用户技能目录（只读）。
 * @param home - DSH 主目录。
 * @returns 每个技能一条：目录名 + frontmatter 字段 + 描述长度。
 */
export function collectSkills(home) {
  const dir = join(home, "skills")
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillPath = join(dir, entry.name, "SKILL.md")
    if (!existsSync(skillPath)) continue
    let text = ""
    try {
      text = readFileSync(skillPath, "utf8")
    } catch {
      continue
    }
    const fields = parseFrontmatter(text)
    out.push({
      dir: entry.name,
      name: fields.name === "" ? entry.name : fields.name,
      description: fields.description,
      whenToUse: fields.whenToUse,
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * 合成宿主侧体检结果。
 * @param home - DSH 主目录（缺省取 `DSH_HOME`）。
 * @returns 可 JSON 序列化的体检对象。
 */
export function buildInventory(home = dshHome()) {
  const { profileDir, bundles, plugins } = collectPlugins(home)
  return {
    scannedAt: new Date().toISOString(),
    home,
    profileDir,
    bundles,
    plugins,
    skills: collectSkills(home),
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
    },
  }
}

/**
 * 安装插件：挂一条只读体检路由，并写一行日志。
 *
 * 路由是 same-origin 的 `GET /tiger-talisman/api/inventory`，浏览器半边打开
 * 面板时拉一次；任何写操作都不提供（虎符咒第一版只体检、不仲裁）。
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
  try {
    ctx.inject(["webServer"], (wctx) => {
      wctx.webServer.register({
        kind: "prefix",
        path: "/tiger-talisman/api",
        handler: (req, res) => {
          const method = req.method ?? "GET"
          if (method !== "GET" && method !== "HEAD") {
            res.writeHead(405, { "content-type": "text/plain; charset=utf-8" })
            res.end("method not allowed\n")
            return
          }
          const url = new URL(req.url ?? "/", "http://localhost")
          if (!url.pathname.endsWith("/inventory")) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
            res.end("not found\n")
            return
          }
          let body = ""
          try {
            body = JSON.stringify(buildInventory(), null, 2)
          } catch (error) {
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
            res.end(`inventory failed: ${String(error)}\n`)
            return
          }
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          })
          res.end(method === "HEAD" ? void 0 : body)
        },
      })
      log("已加载：体检路由 GET /tiger-talisman/api/inventory")
    })
  } catch (error) {
    log(`未挂载体检路由（webServer 不可用）：${String(error)}`)
  }
  note(`apply: ${name} 已加载（node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ""}）`)
}
