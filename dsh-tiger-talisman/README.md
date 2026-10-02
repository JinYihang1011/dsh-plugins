# dsh-tiger-talisman（虎符咒）

**虎符咒的作用是平衡**：它能平衡其余十一个符咒，集齐十二个才让圣主复活。
这个插件干的是同一件事——DSH 里同时住着十几个插件、几十个 Skill，谁都往侧栏、
往 `<head>`、往 z-index 里伸手，**虎符咒给它们划领地、把争用摆到明面上**。

> 第一版是**只读体检**：只报告，不改任何东西、不仲裁任何一方。等看清楚了再开仲裁。

## 一、它体检什么

面板（侧栏「虎符咒」）分四段：

| 段 | 内容 |
| --- | --- |
| ① 插槽领地 | 谁占了哪个插槽；插槽分**列表 / 独占 / 键控**三类，**独占型被多人占用 = 真冲突** |
| ② 样式领地 | 每个插件往 `<head>` 放了几张样式表、多少规则、多少 `!important`、用了哪些 z-index；**同一插件多张样式表 = 重复挂载痕迹** |
| ③ 插件 | 宿主只读扫描：版本、来源（npm / 本机 link）、**是否真的进了 bundle 层**、有没有浏览器半边 |
| ④ 技能 | `SKILL.md` 的 name / 目录 / 描述（触发词重叠是 Skill 侧的主要争用） |

领地表是**声明式**的（`client.js` 里的 `TERRITORIES`），例如：

```js
"shell.overlay":            { kind: "exclusive", note: "全屏弹层：同刻只该有一个活跃" }
"sidebar.panellist":        { kind: "list",      note: "侧栏面板入口列表" }
"main":                     { kind: "keyed",     note: "按 activePanelId 选中，同刻只渲染一个" }
```

## 二、为什么这三类口径是对的

- **列表型**多人占用是设计如此（`sidebar.panellist` 就该并列），报成冲突只会制造噪音；
- **独占型**多人占用才是问题：`shell.overlay` 四个占用者、`conversation.composer.dock` 两个——
  宿主默认布局会把它们挤在一起或互相盖住，需要仲裁；
- **键控型**（`main`）由宿主按键选中，同刻只渲染一个，天然安全。

## 三、它顺手就能发现的真问题（本机实测）

装上后第一次打开面板，就报了这几条：

- `shell.overlay` 被 4 个插件占用：`dsh-session-ops` / `dsh-chat-import` / `dsh-mcp-connector` / `dshmarket`；
- `conversation.composer.dock` 被 2 个占用：`dsh-refresh-button` / `dsh-cost-meter`；
- z-index 从 `12` 一路铺到 `9999`，全屏覆盖层（`inset:0`）有 7 个插件在用——**没有统一秩序**；
- `dsh-ui-tweaks` 往 `<head>` 放了 46 个 `!important`，`dsh-better-sidebar` 7 个、`dsh-mnemon` 6 个；
- **装了但没进 bundle 层**：`dsh-cost-meter`、`@nonamelego/dsh-catppuccin`。

## 四、安装

```powershell
pwsh -File install.ps1              # 同步 → 备份配置 → dsh plugin add link: → 登记 bundles
pwsh -File install.ps1 -WhatIfOnly  # 只看它要做什么
```

装好后**重启一次 DeepSeek Harness**（profile 的 composition 要重新组装，宿主才会把
浏览器半边交给 Module Loader）。

## 五、验证与诊断

```powershell
node test/host-smoke.mjs     # 宿主侧：插件/技能清单口径（15 项）
node test/client-smoke.mjs   # 浏览器侧：领地表、冲突口径、报告渲染（34 项）
Get-Content "$env:DSH_HOME\tiger-talisman.log" -Tail 5
curl.exe -s http://127.0.0.1:<端口>/tiger-talisman/api/inventory   # 只读体检 JSON
```

## 六、已知限制

- **只读**：不仲裁、不互斥、不改任何插件的行为。要真的"平衡"，下一步是把
  `TERRITORIES` 升级成可执行的仲裁规则（谁打开谁让位），沿用 `dsh-ui-tweaks` 里
  验证过的两招：**从外面覆盖**（不改上游）+ **转发上游自己的事件**。
- 插槽是**探测式**采集：只探 `TERRITORIES` 里列出的那些，宿主新增插槽不会自动出现——
  在 `TERRITORIES` 里补一行即可。
- 样式/层级是**静态文本扫描**：只报"谁声明了什么"，不做实际级联计算。所以它不会
  告诉你"⑥ 压掉了 ⑨"，只会告诉你"这两个插件都在争 background"。
- 技能侧只列清单，**不做触发词去重**（那需要语义匹配，留到第二版）。

## 七、卸载

从 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉
`dsh-tiger-talisman`，删掉 `local-plugins\dsh-tiger-talisman`，重启。`tiger-talisman.log` 不会被删。
