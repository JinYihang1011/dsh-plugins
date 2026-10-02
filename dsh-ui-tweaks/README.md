# dsh-ui-tweaks

本地界面微调插件：**不碰任何上游文件**。A 段是一张优先级更高的样式表（①②③⑤⑥⑧⑨⑩），B 段是三个很小的交互补丁（⑦ 面板互斥——转发上游自己的事件 + 清掉宿主的面板选择；⑧ 「操作」菜单——把点击委托给原按钮；⑨ 的 JS 兜底——按 cron 的激活属性写内联底色）。

目前十段（互相独立，删掉哪一段就单独关掉那一项）：

| # | 目标 | 做什么 |
| --- | --- | --- |
| ① | `dsh-mcp-connector` 的侧栏入口图标 | 🧩 emoji → 与「插件 / 记忆系统 / 技能中心」同源的线性图标（宿主 `IconLinkOutlineRegular` 的同一份几何）；图标盒子 `20px → 16px`（折叠态 18px）。**仅当该插件仍是「弹窗 + 自绘入口」形态时命中** |
| ② | 同一个入口的行度量 | 对齐宿主 `ui-sidebar` 的 `panelRow`：`min-height 36` / `margin 0 2px` / `padding 7px 8px` / `gap 8` / `line-height 22` / `--dsw-radius-md`，hover 走主题变量 |
| ③ | 同一个入口的行距 | 把 `.panelList` 的 `margin-bottom` 从 `8px` 压到 `4px`；只在连接器确实挂出来时才生效 |
| ④ | `@goodandready/dsh-cron` 的「运行中任务」 | 整块隐藏（它是「定时任务」的另一个入口，点开同一块界面，长在侧栏里风格割裂） |
| ⑤ | 收起侧栏时的「定时任务」克隆按钮 | 桌面端标题栏模式下隐藏。它是宿主 `newSession` 的克隆（class 原样保留），会连宿主的 `position:fixed; left:48px` 收起态规则一起继承，于是和真正的「新会话」图标重叠着钉在标题栏左侧 |
| ⑥ | 左栏六个入口的风格与分组 | 「新会话」「定时任务」两个大按钮压成与 `panelRow` 同款行（36 高 / `7px 8px` / 16px 图标 / 主题 hover / 4px 行距），与 `nav.panelList` 里的 插件 / 技能中心 / 记忆系统 / MCP连接器 连成一列。只在展开态生效 |
| ⑦ | 「定时任务」与其他面板的**双向互斥** | DSH 的中间栏同一时刻只该有一块界面，但 dsh-cron 不参与宿主的面板互斥，所以两个方向都要管：**①** 面板行（插件 / 技能中心 / 记忆系统 / MCP连接器）被点、而 cron 开着 → 派发 cron 自己的 `dsh-panel-activate` 事件（`detail ≠ 'cron'` 它会自关）；不这么做，面板虽然被选中却被 cron 那块 `display:none` 掉全部兄弟节点的界面盖住，看着像「点不动」。**②** 「新会话 / 定时任务」这类铺满对话列的入口被点 → 先 `ctx.layout.selectPanel(null)` 清掉已选中的面板；不这么做，cron 会**浮在**那块面板之上，而它的「返回对话」只是关掉自己，底下露出来的还是上一个面板 |
| ⑨ | 「定时任务」的选中底色 | 宿主的面板行靠 `.panelRow.panelActive`（`aria-current="page"`）拿底色；cron 的入口不在那个 slot 里，打开时侧栏没有任何高亮、和旁边四行不一致。这里用 cron 自己在 `<html>` 上打的 `data-dsh-cron-active` 当选中态，给它同一份底色（另有一层 JS 内联兜底，见 5.2） |
| ⑩ | cron 打开时的「当前会话」高亮 | 宿主把「谁算当前会话」写成 `currentId = panelActive ? undefined : <主视图会话>`，所以**有面板激活时**侧栏那一行不带 `.selected`、没有灰底。cron 不是宿主的注册面板——互斥时把 `activePanelId` 清成 `null`，宿主于是又把会话行当成「当前」、上了 `.hIlkoa_selected` 的灰底。cron 打开期间把这份灰底收掉，观感才和「打开其它面板」一致；`:not(:hover)` 保住鼠标反馈 |

> 表格按编号排：① ② ③ ④ ⑤ ⑥ ⑦ ⑨ ⑩，⑧ 见下一行（它是后来加的，长度较长单独放）。

| ⑧ | 「操作」菜单（收起 / 展开都常驻） | 标题栏左上角排成 `[开关▯] [操作] 应用 编辑`。**收起态**：宿主只剩「开关 + 新会话」两颗图标，六个入口里其它五个都点不到（宿主把 `panelList` 整个 `display:none` 了），所以这里把「新会话」那颗图标换成**文字按钮「操作」**，样式逐条对齐 Desktop 菜单栏的「应用 / 编辑」（28 高 / `0 10px` / 6px 圆角 / 14px / 同款色与 hover / `cursor: default`）。**展开态**：用户要求它继续留着当快捷入口，同位置常驻。它比这个位置原来的东西都宽，两种状态都要把 `--dsh-windows-menu-start` 推到 100px（收起态宿主自己设的 84px、展开态默认 48px），Desktop 菜单才不会被盖住。点开是一张**只含文字**的菜单，列出侧栏当前的全部入口（第一项叫「新对话」）；每次打开都**从 DOM 现场收集**（`[data-slot="sidebar.panellist"]` 的每一行 + 新会话 + 定时任务），点哪一项就把点击**委托给那一项本身**——所以以后新增的面板行会自动出现在菜单里、风格也一致，不需要改代码 |

> ⑦ ⑧ 都是「转发点击」而不是复制上游逻辑：⑦ 转发 dsh-cron 自己的激活事件，⑧ 直接对原按钮调 `click()`。
> ⑧ 的入口如果标签为空会被跳过；一项都没有时点开不显示菜单（不会留一张空壳）。
> 「新对话」这项有个坑：收起态宿主**不渲染** `newSessionLabel` 的文字（`wide` 为 false 时才渲染），
> 此时 `[class*="newSessionLabel"]` 命中的是包着它的 `newSessionLabelMask`、文字为空——
> 用 `querySelector` 取第一个匹配就会把这一项当成「没有标签」丢掉（这就是最初「操作菜单里没有新对话」的成因）。
> 代码里用 `firstText()` 取**第一段非空文字**，读不到时按用户措辞兜底为「新对话」。

> ① ② ③ 是 `dsh-mcp-connector` 还是「弹窗 + 自绘入口」时的外观补丁。本工作区给它打过一份**面板补丁**（见 `03 脚本\dsh-mcp-panel-apply.mjs`），把它变成 `sidebar.panellist` 行 + `main` 主面板之后，① ② ③ 就是死代码（不会命中，也不会报错）；一旦该插件升级回原样，这三段会自动重新生效。

## 零、为什么「MCP连接器」看着不跟上面三个在一组

它不是 `sidebar.panellist` 那个 `<nav>` 的成员。DSH 没有公开的「新会话与工作区之间」插槽，所以 `dsh-mcp-connector` 注册到 `sidebar.footer.action` 托管生命周期，再把按钮 **Portal 到 `sidebar.workspaces` 之前**——落点是 `.regionArea` 的第一个子节点，夹在 `nav.panelList` 和会话列表之间。

于是它和上面三行之间隔的**不是** `.panelList` 的行间距（`gap: 4px`），而是 `.panelList` 的 `margin-bottom: 8px`。按 DSH 的样式表算、再用截图实测（285×373 的原图）：

| 入口 | 图标左边 | 文字左边 | 与上一行的中心距 |
| --- | --- | --- | --- |
| 插件 | 23 | 46 | — |
| 记忆系统 | 23 | 46 | 40 |
| 技能中心 | 24 | 46 | 40 |
| **MCP连接器（改前）** | 24 | **49** | **44** |

两处偏差：文字右移 3px（插件的图标盒子是 20px 而宿主 `panelGlyph` 是 16px，多出的 4px 把文字推远），行距多 4px（8px 的 margin-bottom 对 4px 的 gap）。① ② ③ 三段分别把它们补回来，实测目标是图标 24、文字 46、行距 40。

**③ 为什么改 `.panelList` 而不用负上边距**：挂载点的父级 `.regionArea` 带 `overflow: hidden`，任何超出它上边缘的部分都会被裁掉——在这行上加 `margin-top: -4px` 会把 hover 药丸的顶部切平。所以改真正多出来的那份间距本身，并用 `body:has([data-mcp-connector-top-mount="true"])` 限定「连接器确实挂出来了」时才生效。

**为什么不用更「正统」的 `sidebar.panellist` 条目**：那个 slot 的每一行都由宿主的 `PanelRow` 渲染，`onClick` 是 `ctx.layout.selectPanel(id)`——它要求同时存在一个同 id 的 `main` 面板，否则选择会抛错。连接器是一个 `shell.overlay` 弹窗而不是主面板，硬塞进去要么得伪造一个空面板、要么得劫持按钮的点击（子元素的 `stopPropagation` 拦不住键盘 Enter 在按钮上产生的 click）。所以这里只做**外观统一**，行为仍是连接器自己的按钮——鼠标、键盘、无障碍语义全都保持原样。

---

## 一、为什么是插件，而不是继续改上游文件

第一次是把 `dsh-mcp-connector/lib/client.js` 直接改掉的。`dsh-mcp-connector` 一升级（0.2.63 → 0.2.64），pnpm 把整份文件覆盖回去，改动**无声消失**——正是这次「图标又变成原样」的原因。

所以改成：**上游文件一个字节都不动**，用一张优先级更高的样式表从外面覆盖，并且：

- 上游插件升级不会清除它（它在 `local-plugins` 里，属于本插件自己的文件）；
- 只依赖上游的类名与 data 属性（`.mcpConnectorLauncherIcon`、`[data-dsh-part="sidebar-jobs"]`）。万一上游改了名，最坏结果是这一段不再命中——**不会报错，也不会破坏界面**；
- 每一段都独立，可以用注释/删除精确关掉某一项。

emoji 那一段只能用 CSS：`🧩` 是**文本节点**，删不掉，所以先 `font-size: 0` 把字形收掉，再用 `mask` 在 `currentColor` 上画出描边 SVG。好处是颜色、hover、禁用态、亮暗主题全部自动跟随，没有任何写死的色值。

## 二、安装

```powershell
pwsh -File install.ps1
# 只预览不写入： pwsh -File install.ps1 -WhatIfOnly
```

脚本做四件事：同步文件到 `<DSH_HOME>\local-plugins\dsh-ui-tweaks` → 备份 profile 配置到 `profiles\desktop\.backup\` → `dsh plugin --profile desktop add "link:<dir>"`（被 lockfile 策略挡住时退回手工登记 link 依赖）→ 把 `dsh-ui-tweaks` 登记进 `dsh.profile.bundles`。

**装好后需要完全退出并重开 DeepSeek Harness**：profile 的 composition 要重新组装，宿主才会把这个包的浏览器半边交给 Module Loader。之后单独改样式只需**刷新页面**。

## 三、验证与诊断

```powershell
# 1) 宿主半边是否被 compose 进来（每次 apply 追加一行）
Get-Content "$env:DSH_HOME\ui-tweaks.log" -Tail 5
# 应该看到： apply: dsh-ui-tweaks 已加载（node …, electron …）

# 2) 浏览器侧：DevTools 里确认样式表在，且四段都在
document.querySelector('style[data-plugin="dsh-ui-tweaks"]')?.textContent

# 3) 离线自测（不需要运行中的 DSH）
node test/client-smoke.mjs
```

目视检查：

- 「MCP连接器」左边是一个与上面几行同粗细的**线性链接图标**（不是彩色拼图 emoji）；
- 它的行高、行距、左边距与「插件 / 记忆系统 / 技能中心」一致（文字左边缘应当对齐）；
- 侧栏里**没有**「运行中任务」这一块；顶部的「定时任务」按钮与它打开的面板一切照旧。

## 四、单独关掉某一项

编辑 `client.js` 里 `tweakCss` 的对应段落（每段都有 ①…⑧ 编号注释）后，把文件同步到 `local-plugins`（`install.ps1`）并刷新页面；也可以直接在 DevTools 里试：

```js
// 临时恢复 emoji 看对比
const s = document.querySelector('style[data-plugin="dsh-ui-tweaks"]');
s.textContent = s.textContent.replace(/\/\* ①[\s\S]*?(?=\/\* ②)/, '');
```

## 五、已知限制

- 依赖上游的类名/属性名，以及宿主 `ui-sidebar` 的几个布局常量（`.panelList` 的 `gap: 4px`、展开态 `margin-bottom: 8px`、折叠态 `gap/margin-bottom: 12px`；`data-sidebar-collapsed="true"` 打在 AppFrame 根节点上）。DSH 改了这些时它最多差几像素或被静默跳过，不会报错。
- 用的是 `-webkit-mask-*`（Chromium/Electron 认）与标准 `mask-*` 双写。② 只覆盖展开态 `[data-wide="true"]`。
- ⑥ 只覆盖展开态：收起态宿主自己会把 `newSession` 变成 36×36 圆形图标、并隐藏 `panelList`，这里不介入。
- ④ 只隐藏不卸载：`dsh-cron` 自己的轮询/高亮逻辑照旧。
- ⑦ 依赖 dsh-cron 自己的事件名 `dsh-panel-activate`。上游改了名，这段会静默失效（回到「点不动」的老表现），不会报错。

### 5.1 「样式整体消失」的坑（2026-10-02 实测）

现象：刷新后 **④⑤⑥ 全部不生效**（「运行中任务」冒出来、六个入口退回大按钮），但 **⑦ 仍然生效**——说明插件确实加载了，只是那张样式表不在文档里。

成因：DSH 的客户端插件可能被**挂载两次**（profile `dsh.profile.bundles` 与插件市场的 client-only shim 各一次）。最初的 `installStyles()` 是「`head` 里已有 `style[data-plugin=…]` 就跳过」的去重写法：后一个实例什么都不做，而前一个实例被清理时会把它创建的**唯一一张**样式表摘掉 → 样式整体消失。

修法：**去掉去重，每个实例只管自己那一张**，清理也只摘自己那一张。内容完全相同，多一份没有视觉影响，反而保证「最新那份在最后、优先级最高」。自测里有专门的回归断言（`实例 1 清理后，实例 2 的样式表仍在`）。

**同类现象（来自上游插件）**：改动任何客户端插件会触发**批次重载**；`dsh-cron` 只在首次 `ensureStyles()` 时插一次样式，重载时新实例先插、旧实例后清理 → cron 那块界面变成没有边框、挤在左上角的样子。**刷新一次（Ctrl+R）即恢复**，不是坏了。

### 5.2 取宿主服务（`layout`）的两个坑（2026-10-02 实测）

⑦ 要调 `ctx.layout.selectPanel(null)` 才能把宿主的主面板清掉。这里连续踩了两个坑：

1. **不要缓存**：`const layout = ctx.get("layout")` 写在 `apply` 里、之后再也不用 `ctx` —— 那一刻服务可能还没就绪，`layout` 就是 `undefined`，`clearPanel()` 从此永远是空操作，而且**不报错**。现象是「点定时任务先清面板」整条静默失效、cron 浮在面板之上、两行同时高亮。
2. **`ctx.get(name)` 在客户端插件里不一定拿得到**：改用 cordis 的正规姿势 `ctx.inject(["layout"], (scoped) => { … })` —— apply 立刻返回（样式不受影响），服务就绪时才回调。客户端插件里就是这么用的（`ctx.inject(["sidebarRightTabs"], …)`、`ctx.inject(["settingsScope"], …)`）。现在三条路并行：`ctx.inject` → `ctx.layout` → `ctx.get("layout")`，任一成功即存下；一条都没拿到时控制台会打印 `[ui-tweaks] 还没拿到 layout 服务，无法清掉主面板`。

**更稳的一招**：别把互斥只挂在「拦点击」上。⑨ 那个盯 `data-dsh-cron-active` 的观察器顺带承担了清面板——**由 cron 自己的状态驱动**，不看点击、不看时机，只要它变成打开就一定把主面板清掉。

## 六、卸载

从 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉 `dsh-ui-tweaks`，删掉 `local-plugins\dsh-ui-tweaks`，重启。`ui-tweaks.log` 不会被删。
