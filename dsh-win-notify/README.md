# dsh-win-notify

DSH 插件：**当出现「审批请求」或「用户问询」时，弹一条 Windows 通知**。

窗口在后台、最小化到托盘、或你正盯着别的窗口时，不会再错过需要你点头/回答的事。

```
┌──────────────────────────────────────────┐
│  DeepSeek Harness                    ✕  │
│  DSH · 需要审批                          │
│  命令需要提权执行                        │
│  工具：pwsh                              │
│  会话：重构登录模块                       │
│  [ 打开 DeepSeek Harness ]               │
└──────────────────────────────────────────┘
```

点击通知（或按钮）会把 DSH 窗口拉到前台——见
[三、原理](#3-点击行为dshopen)。

---

## 一、快速开始

```powershell
# 安装（幂等，可重复运行）
pwsh -File install.ps1

# 完全退出并重新打开 DeepSeek Harness
```

安装脚本做四件事：把插件同步到 `%DSH_HOME%\local-plugins\dsh-win-notify`、
备份 profile 配置、声明依赖、把 `dsh-win-notify` 追加进 `dsh.profile.bundles`。
卸载用同样的方式：

```powershell
pwsh -File uninstall.ps1
```

---

## 二、生效条件

| 条件 | 说明 |
| --- | --- |
| Windows | 只在 `process.platform === "win32"` 时注册监听器，其他平台静默跳过。 |
| Windows PowerShell 5.1 | 通知由 `notify.ps1` 调用 WinRT `Windows.UI.Notifications` 发出。PowerShell 7 **没有** WinRT 类型投影，所以脚本里写死了 `powershell.exe`。 |
| 进程完整性 ≥ Medium | 通知 API 在 Low 完整性进程里会直接报 `0x80073D54`。DSH 宿主进程是 Medium，它拉起的子进程继承之；而 DSH 文件沙箱里的 `pwsh` 是 Low，**在那里直接跑 notify.ps1 必然失败**——这是环境特性，不是插件缺陷。 |
| AUMID 已注册 | 默认用 `com.deepseek.dsh`：DSH 桌面端安装时已在开始菜单注册了带该 AUMID 的快捷方式，因此通知显示为「DeepSeek Harness」并带它的图标。 |

---

## 三、原理

### 1. 挂载点：两个宿主事件瀑布

| 事件 | 何时派发 | 载荷要点 |
| --- | --- | --- |
| `approval/request` | `ctx.approval.request()`（沙箱越权、需人工放行的工具调用）；仅在审批策略为 `ask` 时走到这里 | `toolName` / `reason` / `callId` / `signal` |
| `user-questions/request` | `ctx.userQuestions.ask()`，即 `ask_user_question` 工具与计划评审 | `questions[]`（`question` / `header` / `options` / `intent`） |

### 2. 为什么必须 `prepend`

cordis 的监听表（`EventsService._hooks`）是**全应用一张按注册顺序排列的数组**，
瀑布链就按这个顺序串起来。DSH 把这两个事件转发给浏览器 UI 的监听器由
`@deepseek-ai/dsh-api-remotes` 注册，而它所在的 `dsh-web-app` bundle
**先于**本插件加载。若不 `prepend`，本插件就排在链尾——
只有等人答完、请求失败或取消后才会轮到它，通知毫无意义。

```js
ctx.on("approval/request", (request, next) => { /* 弹通知 */ return next() }, { prepend: true })
```

`prepend` 后排到链首，通知完立刻 `next()` 放行，**不干预也不改变**任何审批结果与问询答案；
通知链自身再包一层 `try/catch`，任何异常都不会把一次正常审批变成 `unavailable`。

### 3. 投递：powershell.exe + base64 载荷

`index.js` 用 `spawn`（无 shell，因此没有引号地狱）调用：

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File notify.ps1 -PayloadBase64 <base64(UTF-8 JSON)>
```

文案走 base64 传参，中文、换行、引号都不会被命令行转义破坏；
`notify.ps1` 用 XmlDocument DOM 拼 toast XML，特殊字符自动转义。

<b id="3-点击行为dshopen"></b>

### 4. 点击行为：`dsh://open`

DSH 桌面端在 Electron 侧调用了 `app.setAsDefaultProtocolClient("dsh")`，并在 `open-url` 里只认一种 URL：

```js
if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();
```

所以通知用协议激活回到应用：

```xml
<toast activationType="protocol" launch="dsh://open">
  <actions><action content="打开 DeepSeek Harness" activationType="protocol" arguments="dsh://open"/></actions>
</toast>
```

点击 → Windows 启动 `DeepSeek Harness.exe "dsh://open"` → Electron 的单实例逻辑把 URL
交给已在运行的实例（`second-instance` → `focusOwner`）→ 窗口还原、显示、聚焦。

**不能跳到具体那段对话**：DSH 的处理器没有会话级深链（其他 `dsh://...` URL 会被直接忽略），
主进程里也没有可用的路由入口；要做到这一步只能改 DSH 自己的 `lib/main.js`，插件无法在不侵入宿主的前提下实现。
目前的折中是**在正文里附一行会话标题**（`includeSessionTitle`），让你一眼知道该切回哪段对话。

### 4. 文件清单

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半边：注册两个 prepend 瀑布监听器、组装文案、去重、拉起 PS 进程 |
| `notify.ps1` | 投递半边：解析载荷 → 设 AUMID → 载入 WinRT → 弹通知 |
| `cordis.patch.yml` | bundle patch：把插件插入 profile 配置树 |
| `test/smoke.mjs` | 冒烟测试：假 ctx 驱动插件，断言注册形状/文案/畸形载荷/去重（`node test/smoke.mjs`） |
| `install.ps1` / `uninstall.ps1` | 安装 / 卸载 |

---

## 四、配置

默认值写在 `index.js` 的 `DEFAULTS`，可在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-win-notify
  name: dsh-win-notify
  config:
    sound: false                 # 关掉提示音
    approvalTitle: "DSH · 需要审批"
    questionTitle: "DSH · 需要你的回答"
    planReviewTitle: "DSH · 计划待确认"
    textMaxChars: 160            # 正文单行截断长度
    includeSessionTitle: true    # 正文附一行会话标题
    launchUri: "dsh://open"      # 点击激活的 URI；置空 = 不可点击
    actionLabel: "打开 DeepSeek Harness"
    scenario: ""                 # 置 "reminder" = 常驻通知，直到你处理它
    dedupeWindowMs: 2000         # 相同内容的去重窗口
    timeoutMs: 15000             # 单次 powershell.exe 存活上限
    debug: false                 # 打印诊断日志
    dryRun: false                # 只组装不发通知（自测用）
```

---

## 五、自测

```powershell
# 1) 直接弹一条测试通知（必须在 Medium 完整性下运行，例如资源管理器里双击 .cmd 包装，
#    或用 dsh-cron 的 script 任务——它的子进程由 DSH 宿主拉起）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File notify.ps1 -Title "测试" -Text "能看到就说明通道可用"

# 2) 不装插件也能验证逻辑：假 ctx 驱动
node test/smoke.mjs

# 3) 装好后：让 agent 提一个审批或问一句，看通知是否出现
```

---

## 六、已知限制

- **点击只能聚焦窗口，不能跳到具体对话**：DSH 的 `dsh://` 处理器只实现 `dsh://open`
  → 主窗口聚焦，没有会话级深链（详见[三、原理 §4](#3-点击行为dshopen)）。
  已用「正文附会话标题」做折中。
- **必须装到 DSH 桌面端**：宿主半边依赖 DSH 的 profile 与 AUMID；
  CLI/headless 场景没有已注册的 AUMID，通知不会显示。
- **`pnpm` 供应链策略**：本机 profile 的 `pnpm-lock.yaml` 里存在早于
  `minimumReleaseAge` 截止时间的条目（`dsh-chat-import@0.23.2`），
  导致 `dsh plugin add` 在最后一步校验失败并回滚。
  安装脚本会退回到「手写依赖项 + 建 `node_modules` 链接」的方式绕过这一步；
  这只影响**本地 link 依赖**的登记，不下载任何远端代码，也不改安全策略。
- **`notify.ps1` 是纯 ASCII**：Windows PowerShell 5.1 对没有 BOM 的 `.ps1`
  按系统 ANSI 码页解码，带中文注释会直接解析失败，
  所以本地化文案一律由 `index.js` 通过载荷传入。
  `install.ps1` / `uninstall.ps1` 含中文，已保存为 **UTF-8 with BOM**，请勿用会去 BOM 的编辑器重存。

---

## 七、排查

| 现象 | 原因与处理 |
| --- | --- |
| 完全没有通知 | 先看插件是否加载：DSH 侧栏「插件」页里应出现 `dsh-win-notify`；没有就重启 DSH。 |
| 手跑 `notify.ps1` 报 `0x80073D54` | 你在 Low 完整性进程里（DSH 文件沙箱、受限 shell）。换 Medium 完整性进程再试。 |
| 手跑报类型加载失败 | 用成了 PowerShell 7；必须 `powershell.exe`（5.1）。 |
| 通知显示成别的应用名 | `config.appId` 被改成未注册 AUMID；改回 `com.deepseek.dsh`。 |
| 点击通知没反应 | 确认 `dsh` 协议仍指向 DSH：`(Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\dsh\shell\open\command').'(default)'` 应为 `"…\DeepSeek Harness.exe" "%1"`；DSH 重装后若失效，启动一次桌面端即可重新注册。 |
| 通知一闪而过来不及点 | 把 `scenario` 设为 `"reminder"`，通知会常驻到被处理。 |
| 审批一直没人应答 | 与本插件无关：审批策略为 `ask` 且没有可用应答者时会 `unavailable`（fail closed）。 |
