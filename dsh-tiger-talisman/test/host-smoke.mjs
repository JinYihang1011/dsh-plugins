/**
 * dsh-tiger-talisman 宿主半边自测。
 *
 * 用**临时 fixture 的 DSH_HOME** 跑，不碰真实配置：验证插件清单、技能清单与
 * frontmatter 解析的口径（这是体检报告里「插件 N 个 / 技能 N 个」的来源）。
 *
 * 运行：node test/host-smoke.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildInventory, collectPlugins, collectSkills, parseFrontmatter } from "../index.js"

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

/* ── frontmatter ── */

check("解析 name/description/whenToUse", (() => {
  const fields = parseFrontmatter("---\nname: demo\ndescription: 一句话说明\nwhenToUse: 当……时\n---\n# 正文\n")
  return fields.name === "demo" && fields.description === "一句话说明" && fields.whenToUse === "当……时"
})())
check("没有 frontmatter 时给空字段而不是抛错", (() => {
  const fields = parseFrontmatter("# 只有正文\n")
  return fields.name === "" && fields.description === ""
})())
check("frontmatter 里的值带引号也能剥掉", parseFrontmatter('---\nname: "quoted"\n---\n').name === "quoted")

/* ── fixture DSH_HOME ── */

const home = mkdtempSync(join(tmpdir(), "tiger-host-"))
const profileDir = join(home, "profiles", "desktop")
mkdirSync(join(profileDir, "node_modules", "pkg-plain"), { recursive: true })
mkdirSync(join(profileDir, "node_modules", "pkg-dsh"), { recursive: true })
const localPluginDir = join(home, "local-plugins", "my-local-plugin")
mkdirSync(localPluginDir, { recursive: true })
mkdirSync(join(home, "skills", "demo-skill"), { recursive: true })
mkdirSync(join(home, "skills", "no-frontmatter"), { recursive: true })

writeFileSync(join(profileDir, "package.json"), JSON.stringify({
  dependencies: {
    "pkg-plain": "^1.0.0",
    "pkg-dsh": "^2.0.0",
    // 与真实 profile 一致：link: 后面跟一个绝对路径（正斜杠写法）
    "my-local-plugin": `link:${localPluginDir.replace(/\\/g, "/")}`,
  },
  dsh: { profile: { bundles: ["pkg-dsh", "my-local-plugin"] } },
}, null, 2), "utf8")

writeFileSync(join(profileDir, "node_modules", "pkg-plain", "package.json"), JSON.stringify({ name: "pkg-plain", version: "1.0.0" }), "utf8")
writeFileSync(join(profileDir, "node_modules", "pkg-dsh", "package.json"), JSON.stringify({
  name: "pkg-dsh", version: "2.0.0", description: "带 dsh 元数据的插件",
  dsh: { client: { platform: "web" } },
}), "utf8")
writeFileSync(join(home, "local-plugins", "my-local-plugin", "package.json"), JSON.stringify({
  name: "my-local-plugin", version: "0.1.0",
  dsh: { bundle: { patch: "./cordis.patch.yml" } },
}), "utf8")
writeFileSync(join(home, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 演示用\n---\n正文\n", "utf8")
writeFileSync(join(home, "skills", "no-frontmatter", "SKILL.md"), "# 没有 frontmatter\n", "utf8")
writeFileSync(join(home, "skills", "not-a-skill.txt"), "忽略我\n", "utf8")

const { bundles, plugins } = collectPlugins(home)
check("bundles 列表读到了", bundles.length === 2 && bundles.includes("pkg-dsh"), JSON.stringify(bundles))
check("普通第三方依赖被跳过（不带 dsh 元数据、也不是 link）", plugins.every((row) => row.name !== "pkg-plain"), plugins.map((row) => row.name).join(","))
check("带 dsh 元数据的依赖被收录", plugins.some((row) => row.name === "pkg-dsh"))
const local = plugins.find((row) => row.name === "my-local-plugin")
check("link: 依赖被识别为本机插件", local?.local === true, String(local?.local))
check("link: 依赖的包目录被解析到真实路径", local?.path === join(home, "local-plugins", "my-local-plugin"), String(local?.path))
check("inBundles 只对 bundle 列表里的插件为真", plugins.find((row) => row.name === "pkg-dsh")?.inBundles === true)
check("没有 client 声明的插件 hasClient=false", local?.hasClient === false, String(local?.hasClient))

const skills = collectSkills(home)
check("技能只收带 SKILL.md 的目录", skills.length === 2, JSON.stringify(skills.map((row) => row.dir)))
check("技能名优先取 frontmatter.name", skills.some((row) => row.name === "demo-skill"))
check("没有 frontmatter 时回落到目录名", skills.some((row) => row.name === "no-frontmatter"))

const inventory = buildInventory(home)
check("buildInventory 给出可序列化结果", typeof JSON.stringify(inventory) === "string")
check("buildInventory 带 scannedAt / runtime", typeof inventory.scannedAt === "string" && typeof inventory.runtime.node === "string")

rmSync(home, { recursive: true, force: true })

console.log(`\n结果：${passed} 通过，${failures.length} 失败`)
for (const failure of failures) console.log(`  ✗ ${failure}`)
if (failures.length > 0) process.exitCode = 1
