# dsh-session-ops

给 DSH 的**会话行「...」菜单**补三个原生没有的操作：

| 菜单项 | 行为 |
| --- | --- |
| **打开工作区位置** | 在宿主桌面的文件管理器里打开该会话的工作目录（一次点击，无对话框） |
| **移动到工作区…** | 把该会话归到另一个工作区下（会列出所有工作区，标注「当前归属 / 可直接登记 / 需搬迁」） |
| **删除会话…** | 把该会话日志**整棵移入回收站**并从侧栏移除；Toast 里提供「撤销」 |

排序为 `450` / `500` / `600`，排在宿主自带的 置顶(100) · 重命名(200) · 分叉(300) · 归档(400) 之后。

## 零、打开工作区位置（`openLocation`）

「工作区位置」= 该会话日志头部记录的 `cwd`——工作区归属本来就是按这条 `cwd` 判定的
（见下一节）。这一项**不由插件做任何平台判断**：

1. 读该会话的持久化头部拿 `cwd`，`realpath` 规范化后确认它存在且是目录
   （冷会话也能用，不激活 Agent）；
2. 调宿主自己的 `sessionController.openWorkspacePath({ path })`——DSH 自带的
   「在文件管理器中打开／显示」走的就是这条实现，所以**路径校验、平台分派
   （Windows → Explorer、macOS → Finder、桌面 Linux → xdg-open、WSL → 先 `wslpath -w`）
   全部与宿主一致**；插件不复制这套逻辑（复制就会漂移）；
3. 宿主没有可用的桌面文件管理器时直接报错，而不是假装成功。

失败原因用 Toast 说明（路径不存在 / 不是目录 / 宿主拒绝打开，含宿主给的 cause）。

---

## 一、为什么这件事必须由插件来做

DSH 的「会话属于哪个工作区」由**两条事实共同**决定（`@deepseek-ai/dsh-workspace` 的实体）：

1. 工作区记录里的 `sessionIds` 顺序（所有权账本）；
2. 该会话**日志头部记录的 `cwd`**，`realpath` 规范化后必须**逐字等于**工作区的 `path`。

读取时 `sessionIds` 会被 `host.sessionPath(id) === record.path` 过滤，`attachSession()` 也用同一条规则校验并抛错。官方没有暴露任何 Remote 命令或 UI 操作能改这两条事实，所以：

- 直接改 `workspace.json` 的 `sessionIds` 是**无效**的（读取即被过滤，下次变更被剪除）；
- 把 `<会话id>` 日志目录挪进目标工作区的 `--<编码路径>--` 下也是**无效**的（归属看头部 `cwd`，不看文件位置，反而造成同一 id 两处存在）；
- 浏览器半边也做不到（客户端无法写宿主注册表与文件系统），因此本插件是「宿主半边 + 浏览器半边」两个文件。

## 二、两个操作的确切语义

### 移动（`moveSession`）

| 情形 | 做什么 | 风险 |
| --- | --- | --- |
| 会话 `cwd` 已等于目标工作区路径 | 调注册表 `attachSession()` 纯登记，**字节不动** | 无 |
| `cwd` 与目标工作区不同 | ① 原件复制进回收站 → ② 改写日志**第一行的 `cwd`** → ③ 副本以临时名落到目标项目目录 → ④ 摘掉旧文件与旧目录 → ⑤ 临时名转正 → ⑥ 用后端自己的 `stat()` 复验头部 → ⑦ 刷新注册表头部索引 → ⑧ 从原工作区摘账目、登记到目标工作区 | 见下 |

搬迁的安全性依据（都实测过）：

- 事件行**逐字节不变**，只有头部一行被替换；已有 138 个真实会话日志验证「解压 → 全部行合法 JSON → 带校验和回压后逐字节可还原」。
- zstd 帧按后端自己的写法重压（`ZSTD_c_checksumFlag = 1`，取自 `dsh-session-persistence-jsonl` 的 `CHECKSUM_OPTIONS`）。
- 目标路径不是自己拼的，而是调后端公开的 `locate({ id, cwd })`（`projectKey` + `encodeSegment` 的权威实现）。
- 自校验失败会自动**回滚原件**并抛错。
- **拒绝搬迁正在运行的会话**（`workspace/session-activity` 瀑布非空一律拒绝）；只是被打开着的会话需要显式勾选「强制」。
- **绝不永久删除**：任何写坏都能从回收站 `restore.json` 记录的原始路径拿回。

### 删除（`deleteSession`）

DSH 原生**没有会话删除**（只能归档）。本插件提供的是**安全删除**：

1. 有工作在跑 → 直接拒绝（不做「停止并删除」，避免误伤）。
2. 只是被打开着 → 需要显式勾选「强制」（界面提示先切换到别的会话）。
3. 会话日志所在**整个会话目录**搬进回收站：`<回收站>\<yyyyMMdd-HHmmss>-<会话id>\<会话id>\`，并写 `restore.json`（含 `originalSessionDir` / `cwd`）。
4. 可选一并删除它的 subagent 子会话（侧栏本来就看不到它们）。
5. 注册表收尾：从所有工作区 `detachSession()`、取消置顶、取消归档，并刷新头部索引，侧栏立即掉行。
6. Toast 里的**撤销**调用 `restore` 把日志放回原位并重新登记。

回收站默认在 `%DSH_HOME%\session-trash\`（可用配置 `trashDir` 改到别处，比如你自己的 `99 待删\`）。

## 三、安装

```powershell
pwsh -File install.ps1
# 只预览不写入： pwsh -File install.ps1 -WhatIfOnly
```

脚本做四件事：同步文件到 `<DSH_HOME>\local-plugins\dsh-session-ops`（无空格、非中文路径，避免 pnpm `link:` 的引号问题）→ 备份 profile 配置到 `profiles\desktop\.backup\` → `dsh plugin --profile desktop add "link:<dir>"`（被 lockfile 策略挡住时退回手工登记 link 依赖）→ 把 `dsh-session-ops` 登记进 `dsh.profile.bundles`。

**安装后需要完全退出并重开 DeepSeek Harness**：宿主半边要重新 compose 才会挂上 `/session-ops/api` 路由；浏览器半边随页面加载。

## 四、验证与诊断

```powershell
# 浏览器半边的三项是否出现：侧栏任意会话行的 "..." 菜单
# （「打开工作区位置」/「移动到工作区…」/「删除会话…」）
# 宿主半边的诊断日志（每次 apply 都会追加一行）
Get-Content "$env:DSH_HOME\session-ops.log" -Tail 20
# 应该看到：
#   apply: dsh-session-ops 已加载（node …, electron …）
#   apply: 已挂载 /session-ops/api
# 打开工作区位置时还会追加一行：已打开工作区位置：<绝对路径>
```

无 cookie 也能直接打 API（本机回环 + 无 Origin 视为可信，与 dsh-mcp-connector 同一约定）：

```powershell
curl.exe --noproxy '*' -X POST -H "content-type: application/json" `
  --data-binary '{"method":"listTrash"}' http://127.0.0.1:19387/session-ops/api

# 试「打开工作区位置」（会把该会话的 cwd 交给宿主桌面打开）：
curl.exe --noproxy '*' -X POST -H "content-type: application/json" `
  --data-binary '{"method":"openLocation","params":{"sessionId":"session-xxxx"}}' `
  http://127.0.0.1:19387/session-ops/api
```

可用方法：`prepare` / `openLocation` / `move` / `delete` / `restore` / `listTrash`。

离线自测（不需要运行中的 DSH）：

```powershell
# 宿主半边：用真实会话日志的副本跑仿制后端（移动 / 登记 / 删除 / 恢复 / 打开位置 / HTTP fence）
node test/host-smoke.mjs "C:\Users\26640\.dsh\sessions"
# 浏览器半边：仿制 react 与 slots，检查注册项、菜单文案、请求参数与 Toast
node test/client-smoke.mjs
```

## 五、配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-session-ops
  name: dsh-session-ops
  config:
    allowRelocate: false        # 只允许 cwd 匹配时登记，禁止跨目录搬家
    trashDir: "D:\\DSH回收站"    # 自定义回收站根目录
    enabled: true
    debug: false
```

## 六、已知限制

- **正在运行的会话不能搬**。DSH 进程持有其写句柄；插件只做「已关闭的日志文件」上的操作。
- 跨目录搬家会改写会话头部 `cwd`，因此会话的**工作目录语义**会变成目标工作区路径——这正是「移动」的含义，但如果你只想让它在侧栏换个分组而保留原 cwd，那就做不到（DSH 不提供这种分离）。
- **「打开工作区位置」开的是宿主桌面的窗口**：远程/无头 Web 部署下没有可用的文件管理器，会直接报错（`workspaceDesktop().available` 为假时不假装成功）。另外它只作为会话行菜单出现——DSH 目前**没有**工作区分组行级的菜单 slot，所以插件无法把入口挂到分组标题上。
- 浏览器半边只在 web 部署（`ctx.webServer` 存在）下可用；非 web 部署不会挂路由，插件安静跳过。
- 本机回环 + 无 `Origin` 的请求被视为可信（沿用 dsh-mcp-connector 的约定）。若你的机器上有不受信的本地进程，请把插件停用或收紧 `isTrustedRequest`。
- 插件更新会覆盖 `profiles\desktop\node_modules\dsh-session-ops`（link: 指向 `local-plugins`，改源码后重新 `install.ps1` 即可）。
- **宿主半边改完必须重启 DSH**（当前 composition 没有对 `local-plugins` 开 HMR）；浏览器半边改完刷新页面即可。

## 七、卸载

```powershell
pwsh -File uninstall.ps1
```

或手工：从 `profiles\desktop\package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉 `dsh-session-ops`，删掉 `local-plugins\dsh-session-ops`，重启。回收站与 `session-ops.log` 不会被卸载脚本删除。
