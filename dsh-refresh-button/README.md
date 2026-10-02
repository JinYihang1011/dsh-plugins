# dsh-refresh-button

给 DSH 输入卡片下方那一行（`conversation.composer.dock`）加**一个入口按钮**：图标 + 「界面」+ `▾`，
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
2. **插槽的 `order` 控制不了可视位置**。同一行上 `stats` 是 `order: 0`、`dsh-cost-meter` 的角标是
   `order: 9`，本插件从 5 改到 1000 位置都不动。改用 **`margin-left: auto`** 把条目顶到行尾 ——
   这是 flex 行的确定性行为，与插槽排序语义无关。
3. **改客户端后要换文件名**。`client.js` → `client.v2.js` → `client.v3.js`，同步改
   `exports["./client"]`：URL 一变必然缓存未命中，比反复清缓存可靠（宿主虽有 `client-hmr`
   轮询推送，但浏览器那侧仍可能吃到 HTTP/Code Cache）。
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

## 二、这一行上有谁，以及为什么最终不靠 `order` 定位

`conversation.composer.dock` 的契约（asar 内 slots 声明）：

```
kind: "list", scope: "session", summary: "Ambient entries below the composer card."
registerOptions.order = "Position among the entries, ascending (default 0)"
```

同一行上已占位的条目：

| id | order | 来源 |
| --- | --- | --- |
| `stats` | 0 | 宿主 `dsh-client-ui-chat`（「9 轮 238 步 · 缓存命中 99.8%」那部分） |
| `cost-meter` | 5 | `dsh-cost-meter` |
| `cost-meter-corner` | 9 | `dsh-cost-meter`（那个百分比圆环） |
| `dsh-refresh-button` | 1000 | 本插件（**保留这个值，但定位不依赖它**） |

按契约文档，`order` 应当决定位置；但**实测把本插件的 order 从 5 改到 1000，可视位置完全不动**
（条目始终夹在 `cost-meter` 与 `cost-meter-corner` 之间）。因此最终改为在该条目的外层
`span` 上写 **`margin-left: auto`** —— flex 行里这会把条目连同其后的元素推到行尾，
是确定性的布局行为，与插槽排序语义无关。

## 三、安装 / 更新

```powershell
pwsh -File install.ps1                 # 装进 desktop profile（默认）
```

脚本做三件事：把文件同步到 `~/.dsh/local-plugins/dsh-refresh-button`（无空格非中文路径，
避免 pnpm `link:` 规格的引号问题）→ 定位 `dsh` CLI → 若 profile 未登记则
`dsh plugin --profile desktop add "link:<目录>"`。

**重启 DSH 后生效**：客户端半边会随页面加载，但宿主半边的重启路由只在启动时挂载。

## 四、更新客户端时怎么绕开缓存

客户端 bundle 由 `client-hmr` 每 500ms 轮询并推送，但浏览器可能仍吃 Chromium 的
HTTP/Code Cache。本插件把客户端入口从 `client.js` 换成 **`client.v2.js`**
（`exports["./client"]` 相应改写），URL 变化即必然缓存未命中 —— 这是最省事的规避方式。
以后再改客户端，继续递增文件名（`client.v3.js`）比反复清缓存可靠。

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
├─ client.v2.js       客户端半边：两个按钮（含 window.confirm 二次确认）
├─ cordis.patch.yml   bundle 挂载声明
├─ package.json       dsh.client.platform = web，exports["./client"] -> client.v2.js
├─ install.ps1        同步 + link 登记
└─ README.md
```
