# dsh-refresh-button

在输入卡片那一行的**模型选择左边**加**一个入口按钮**：图标 + 「界面」+ `▾`，
点开是下拉菜单，三项**都即点即执行（无二次确认）**：

| 菜单项 | 行为 |
| --- | --- |
| **刷新界面** | `window.location.reload()` —— 只重载当前页面（客户端） |
| **重启 DSH** | `POST /dsh-refresh-button/action {action:'restart'}`，由**宿主进程**踢一个脱离进程的脚本：等 ~0.9s → 结束所有 `DeepSeek Harness` 进程 → 等 2s → 重新拉起 exe |
| **关闭 DSH** | 同上但**不重启**：只结束所有 `DeepSeek Harness` 进程 |

## 零、四条实测结论（都是踩过的坑）

1. **不要用 `window.confirm` / `window.alert`**。原生模态框在 Electron 下会抢走焦点，用户点「取消」后
   焦点不归还页面 —— 现象就是**输入框点不进去、打不了字**。所以本插件零原生弹窗：确认步骤直接去掉，
   失败信息在菜单内联显示。
2. **位置由插槽决定，不靠 `order`**。上一版挂在 `conversation.composer.dock`（输入卡片下方那一行），
   想用 `order` 抢行尾，实测无效（同一行 `stats` 是 0、`cost-meter` 角标是 9，本插件 5→1000 都不动），
   只能用 `margin-left: auto` 顶到最右；这一版改挂 `conversation.input.right`（见第二节），位置是
   确定的，既不靠 `order` 也不靠外边距。
3. **改客户端后要换文件名**。`client.js` → `client.v2.js` → `client.v3.js`，同步改
   `exports["./client"]`：URL 一变必然缓存未命中，比反复清缓存可靠（宿主虽有 `client-hmr`
   轮询推送，但浏览器那侧仍可能吃到 HTTP/Code Cache）。
   > 注意：换文件名要**改 `package.json` 的 exports**，而浏览器清单是宿主启动时组装的 ——
   > 只换文件名又不重启 DSH 时，页面仍会加载旧 URL。只改文件内容则刷新页面即可。
4. **宿主侧 `spawn` 绝对不要带 `detached: true`**（Windows 独有坑）：detached 会用
   `DETACHED_PROCESS` 起进程，**PowerShell 5.1 在这种没有控制台的环境下会立刻退出
   （exit 0，约 120ms），脚本一行都不执行** —— 现象正是"点了按钮只显示正在…、什么都没发生"。
   实测二分：

   | spawn 选项 | 结果 |
   | --- | --- |
   | `-File` + `detached: true` | exit 0，135ms，脚本未执行 |
   | `-File` + `detached: true`（去掉 `-WindowStyle Hidden` 一样） | exit 0，126ms，未执行 |
   | `-Command` + `detached: true` | exit 0，142ms，未执行 |
   | **`-File` + 不 detached** | exit 0，431ms，**脚本正常执行** |

   不 detached 也不会被宿主之死带走：`restart.ps1` 用 `Stop-Process`（**不带 `/T`**）只结束目标
   进程、不杀进程树。

   **伴生坑**：`.ps1` / `.cmd` 必须写**纯 ASCII**。Windows PowerShell 5.1 与 cmd.exe 都按
   ANSI(GBK) 读无 BOM 的文件，中文多字节序列可能吞掉后面的引号导致解析失败；且验证必须用
   `powershell.exe`（5.1）的 `Parser::ParseFile`，**用 pwsh 7 验证是无效的**（读文件编码规则不同）。

## 一、为什么需要它

Windows 生产版 DSH **没有任何内置的重载/重启入口**：

- 桌面端应用菜单在 Windows 上只有两个 `visible: false` 的 DevTools 项（`apps/desktop` 的
  `refreshApplicationMenu`：`process.platform === "win32" ? devToolsItems : [...]`）；
- `role: 'reload'` 与「重启 App 与 Host」只出现在 `development = !app.isPackaged` 的分支里，
  打包安装后恒为 false；
- `Ctrl+R` / `F5` 没有绑定（Electron 的重载快捷键依赖菜单角色）。

唯一的手工办法是 `F12` → Console → `location.reload()`，而重启只能去托盘退出再启动。

## 二、为什么挂在 `conversation.input.right`（= 模型选择左边）

`@deepseek-ai/dsh-client-ui-conversation` 在 `conversation.composer.bar`
（`kind: "single"`, `scope: "session-maybe"`）的 **children 表**里声明了输入卡片那一行的插槽，
其中与本插件相关的是：

| 槽位 | kind / scope | 渲染位置（`InputBar` 里） |
| --- | --- | --- |
| `conversation.input.permission` | single / session | 左组 `modes`，权限选择器 |
| `conversation.input.left` | list / session | 左组末尾（`dsh-client-auto-continue` 的「自动继续」在这里） |
| **`conversation.input.right`** | **list / session** | **右组 `standardControls` 的第一个** |
| `conversation.input.model` | single / session | `standardControls` 的第二个，紧跟 `input.right` |
| `conversation.input.activity` | single / session | `standardControls` 之后（活动面板） |
| `conversation.composer.dock` | list / session | 输入卡片**下方**那一行（上一版所在处） |

宿主源码里的顺序就是契约：

```jsx
<div className={standardControls}>
  {renderSlot("conversation.input.right", {})}   {/* ← 本插件 */}
  {renderSlot("conversation.input.model", {...})} {/* ← 模型选择 */}
</div>
```

所以"模型选择左边"不是用 CSS 猜出来的位置，而是这个槽位字面上的含义。登记方式：

```js
ctx.slots.inject("conversation.input.right", () =>
  ctx.slots.register({ name: "conversation.input.right", id: "dsh-refresh-button", order: 0 }, DockMenu)
)
```

**注意**：`register` 对未声明的槽位会直接抛
`slot "..." is not declared (a parent entry's children table must declare it)` ——
换槽位前先确认目标槽位出现在宿主某个 entry 的 children 表里。

外观上刻意与同一行对齐：高 28px、字号 13px、`--dsw-alias-label-secondary`、
`--dsw-radius-sm`、hover 用 `--dsw-alias-interactive-bg-hover`，与权限选择器、模型选择一致。
面板向上弹（`bottom: 100%` + `right: 0`），与宿主自己的权限/模型菜单同向；输入卡片
祖先链上没有 `overflow: hidden`，所以不需要 Portal。

它随 `standardControls` 一起在工作流活动面板展开时隐藏 —— 与模型选择的行为一致。

## 三、安装 / 更新

```powershell
pwsh -File install.ps1                 # 装进 desktop profile（默认）
```

脚本做三件事：把文件同步到 `~/.dsh/local-plugins/dsh-refresh-button`（无空格非中文路径，
避免 pnpm `link:` 规格的引号问题）→ 定位 `dsh` CLI → 若 profile 未登记则
`dsh plugin --profile desktop add "link:<目录>"`。

**重启 DSH 后生效**（首次安装）：客户端半边会随页面加载，但宿主半边的重启路由只在启动时挂载。
已经装好的情况下只改客户端：**刷新页面**即可（入口就是本插件的「刷新界面」）。

## 四、更新客户端时怎么绕开缓存

客户端 bundle 由 `client-hmr` 每 500ms 轮询并推送，但浏览器可能仍吃 Chromium 的
HTTP/Code Cache。增加新版本时把客户端入口递增文件名（`client.v4.js`），同步改
`exports["./client"]` —— URL 变化即必然缓存未命中。只改内容不改名时，刷新页面通常就够；
若改动没生效，先看 DevTools Console 里本插件打的那行
`[dsh-refresh-button] v1.0.4 → 注册在 conversation.input.right`。

## 五、安全边界

- 重启路由只接受**同源**请求（复用 `dsh-builtin-browser` 的 `sameOrigin` 判定：
  拒绝 `sec-fetch-site: cross-site`、`Origin: null`，其余比对 `Origin.host` 与 `Host`），
  且只接受 `POST`；
- 路由挂载 `kind: 'exact'`，仅 `/dsh-refresh-button/restart` 这一个路径；
- 重启脚本硬编码 exe 路径 `D:\Apps\DeepSeek Harness\DeepSeek Harness.exe`，不存在时直接返回
  500 而不动作；
- 没有 `webServer` 服务的宿主（headless / CLI profile）会跳过注册，插件照常加载，
  只是重启按钮会报失败。

## 六、文件

```
dsh-refresh-button/
├─ index.js           宿主半边：Web 路由 + 脱离进程的重启脚本
├─ client.v3.js       客户端半边：「界面」菜单（刷新界面 / 重启 DSH / 关闭 DSH）
├─ cordis.patch.yml   bundle 挂载声明
├─ package.json       dsh.client.platform = web，exports["./client"] -> client.v3.js
├─ install.ps1        同步 + link 登记
├─ restart.ps1        （宿主踢的那个重启脚本）
└─ README.md
```
