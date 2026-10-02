/**
 * dsh-ui-tweaks —— 浏览器半边（Client side）。
 *
 * 形态与 dsh-session-ops / dsh-mcp-connector 一致：Module Loader 包（`factory(require)`），
 * 直接提交一个 `window.__ModuleLoader__.load({...})`，因此不需要打包器。
 *
 * 它做三类事，都**不改任何上游文件**，所以上游插件升级不会再把它抹掉：
 *   A. 注入一张**优先级更高**的样式表（①②③⑤⑥⑧）；
 *   B. 两个很小的交互补丁：⑦ 只在上游自己已经打开时才转发它自己的事件；
 *      ⑧ 在收起态的图标栏里补一个「操作」菜单（同样只把点击委托给原按钮）。
 *
 * 目前八段（互相独立，删掉任意一段即可单独关掉那一项）：
 *   ① dsh-mcp-connector 侧栏入口：🧩 emoji 图标 → 与「插件 / 记忆系统 / 技能中心」
 *      同源的线性图标；图标盒子 16px/18px 与宿主 PanelRow 一致。
 *   ② 同一个入口的行度量对齐宿主 ui-sidebar 的 panelRow。
 *   ③ 把这一行拉回上面那组的行距里。
 *   ④ dsh-cron 的「运行中任务」外显：整块隐藏。
 *   ⑤ 收起侧栏（桌面端标题栏模式）时隐藏 dsh-cron 的「定时任务」克隆按钮。
 *   ⑥ 左栏六个入口（新会话 / 定时任务 / 插件 / 技能中心 / 记忆系统 / MCP连接器）
 *      统一成同一行样式，并连成一组。
 *   ⑦ 「定时任务」打开时，点面板行让它让位。
 *   ⑧ 收起侧栏（桌面端标题栏）后，把「新会话」图标换成「操作」菜单：一颗图标按钮，
 *      点开是一张**只含文字**的菜单，列出侧栏当前的全部入口。菜单每次打开都从 DOM
 *      现场收集，所以以后新增的面板行会自动出现在里面。
 *
 * 注：① ② ③ 是 dsh-mcp-connector 仍是「弹窗 + 自绘入口」时的外观补丁；它一旦
 * 升级回原样，这三段会重新生效；如果它已经是以 `sidebar.panellist` 行出现的
 * 面板入口（本工作区打过面板补丁的那种形态），这三段就是死代码，不会命中。
 */

window.__ModuleLoader__.load({
	id: "dsh-ui-tweaks",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 注入用的 <style> 标识。 */
		const STYLE_ID = "dsh-ui-tweaks";

		/**
		 * 与 `@deepseek-ai/dsh-client-ui-primitives` 的 `IconLinkOutlineRegular`
		 * **同几何**的 SVG：`viewBox="0 0 16 16"`、`fill="none"`、`stroke-width="1"`、
		 * 圆角端点/连接（regular 版就是 1px 描边）。
		 *
		 * 这里刻意复制几何而不是去 require primitives —— mask 要的是一张图片，
		 * 不是 React 组件；而且这个插件不注册任何槽位，多引一个模块没必要。
		 * 描边色取黑色：mask 只用 alpha 通道，真正的颜色由 `currentColor` 在
		 * 宿主元素上画出来。
		 */
		const LINK_ICON_SVG = [
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">',
			'<path d="M6.59961 9.40051C6.82779 9.6334 7.10015 9.81842 7.40074 9.94472C7.70132 10.071 8.02409 10.1361 8.35013 10.1361C8.67618 10.1361 8.99894 10.071 9.29953 9.94472C9.60011 9.81842 9.87247 9.6334 10.1007 9.40051L12.9015 6.59967C13.3658 6.13541 13.6266 5.50572 13.6266 4.84915C13.6266 4.19258 13.3658 3.56289 12.9015 3.09863C12.4372 2.63436 11.8075 2.37354 11.151 2.37354C10.4944 2.37354 9.86472 2.63436 9.40045 3.09863L9.05034 3.44873"/>',
			'<path d="M9.40051 6.59959C9.17233 6.3667 8.89997 6.18169 8.59939 6.05538C8.2988 5.92907 7.97603 5.86401 7.64999 5.86401C7.32395 5.86401 7.00118 5.92907 6.70059 6.05538C6.40001 6.18169 6.12765 6.3667 5.89946 6.59959L3.09863 9.40043C2.63436 9.8647 2.37354 10.4944 2.37354 11.151C2.37354 11.8075 2.63436 12.4372 3.09863 12.9015C3.56289 13.3657 4.19258 13.6266 4.84915 13.6266C5.50572 13.6266 6.13541 13.3657 6.59967 12.9015L6.94978 12.5514"/>',
			"</svg>",
		].join("");

		/** `mask-image` / `background-image` 要的数据 URI（URL 编码，避免引号与 # 被截断）。 */
		const LINK_MASK = `url("data:image/svg+xml,${encodeURIComponent(LINK_ICON_SVG)}")`;

		/**
		 * 宿主 PanelRow 的行度量（ui-sidebar 的 .panelRow）：
		 * `min-height 36 / margin 0 2px / padding 7px 8px / gap 8 / line-height 22 /
		 * radius --dsw-radius-md / hover --dsw-alias-interactive-bg-hover`。
		 * ⑥ 用它把两个「大按钮」压成同一行；上外边距取 4px，和 panelList 的 gap 对齐。
		 */
		const ROW_METRICS = `
	height: auto !important;
	min-height: 36px !important;
	margin: 4px 2px 0 !important;
	padding: 7px 8px !important;
	justify-content: flex-start !important;
	gap: 8px !important;
	border: 0 !important;
	background: transparent !important;
	box-shadow: none !important;
	border-radius: var(--dsw-radius-md, 8px) !important;
	color: var(--dsw-alias-label-primary) !important;
	font-size: 14px !important;
	font-weight: 400 !important;
	line-height: 22px !important;
`;

		/** 「已收起侧栏」的判据：宿主给某个框架节点打 `data-sidebar-collapsed="true"`。 */
		const EXPANDED = 'body:not(:has([data-sidebar-collapsed="true"]))';

		/** 全部微调样式。每一段都是独立的，删掉哪一段就关掉哪一项。 */
		const tweakCss = `
/* ① dsh-mcp-connector 侧栏入口的图标：🧩 → 线性链接图标。
      （仅当该插件仍是「弹窗 + 自绘入口」形态时命中；面板形态下它不存在。） */
.mcpConnectorLauncherIcon {
	font-size: 0 !important;
	flex: 0 0 16px !important;
	width: 16px !important;
	height: 16px !important;
	background-color: currentColor;
	-webkit-mask-image: ${LINK_MASK};
	mask-image: ${LINK_MASK};
	-webkit-mask-repeat: no-repeat;
	mask-repeat: no-repeat;
	-webkit-mask-position: center;
	mask-position: center;
	-webkit-mask-size: 16px 16px;
	mask-size: 16px 16px;
}

/* 折叠态宿主用 18px 的图标（renderSlot('sidebar.panellist', { size: wide ? 16 : 18 })）。 */
.mcpConnectorLauncher[data-wide="false"] .mcpConnectorLauncherIcon {
	flex: 0 0 18px !important;
	width: 18px !important;
	height: 18px !important;
	-webkit-mask-size: 18px 18px;
	mask-size: 18px 18px;
}

/* ② 同一入口的行度量对齐宿主 ui-sidebar 的 .panelRow。 */
.mcpConnectorLauncher[data-wide="true"] {
	height: auto !important;
	min-height: 36px !important;
	margin: 0 2px !important;
	padding: 7px 8px !important;
	gap: 8px !important;
	line-height: 22px !important;
	border-radius: var(--dsw-radius-md, 8px) !important;
}

.mcpConnectorLauncher[data-wide="true"]:hover,
.mcpConnectorLauncher[data-wide="true"]:focus-visible {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)) !important;
}

/* ③ 把这一行拉回上面那组的行距里（它落在 .regionArea，隔的是 .panelList 的
      margin-bottom 而不是行间距 gap）。只在连接器确实挂出来时生效。 */
body:has([data-mcp-connector-top-mount="true"]) nav:has([data-slot="sidebar.panellist"]) {
	margin-bottom: 4px !important;
}

/* ④ @goodandready/dsh-cron 的「运行中任务」外显：整块隐藏（点开就是「定时任务」
      那块界面，长在侧栏里风格割裂）。只隐藏不卸载。 */
[data-dsh-part="sidebar-jobs"] {
	display: none !important;
}

/* ⑤ 收起侧栏时隐藏 dsh-cron 的「定时任务」克隆按钮。

      dsh-cron 的入口是宿主 newSession 按钮的克隆（class 原样保留），于是宿主的
        [data-windows-titlebar] .collapsed .newSession { position:fixed; left:48px }
      也会命中它——和真正的「新会话」图标重叠着钉在标题栏左侧。
      宿主在收起态把 panelList / regionArea / footArea 全部 display:none，所以这里
      把克隆按钮一并藏掉，收起态只留宿主的开关 + 新会话图标。 */
html[data-windows-titlebar]:has([data-sidebar-collapsed="true"]) [data-dsh-cron-entry] {
	display: none !important;
}

/* ⑥ 六个入口统一成同一行，并连成一组。

      宿主：新会话（newSession 大按钮）→ 定时任务（dsh-cron 克隆，同样带 newSession
      class）→ nav.panelList 里的 插件 / 技能中心 / 记忆系统 / MCP连接器（panelRow）。
      前两个是「边框 + 高亮底」的大按钮，和后面四行完全不像一组；这里把大按钮压成
      同一行度量：min-height 36 / padding 7px 8px / margin 4px 2px 0 / gap 8 /
      radius --dsw-radius-md / hover 主题变量，图标统一 16px。
      只在展开态生效——收起态宿主本来就把 newSession 变成 36×36 的圆形图标。

      「新会话」这一段必须 :not([data-dsh-cron-entry])：cron 的入口是克隆宿主的
      newSession 按钮做出来的（class 里照样带 newSession），下面另有它自己那一段。
      不摘出去的话，这段的 background: transparent !important 会以更高特异度
      （(0,2,2) 对 ⑨ 的 (0,2,1)）压掉「打开定时任务时的选中底色」——实测就是
      这个原因让 ⑨ 完全不生效。 */
${EXPANDED} button[class*="newSession"]:not([data-dsh-cron-entry]) {${ROW_METRICS}}

${EXPANDED} button[class*="newSession"]:not([data-dsh-cron-entry]):hover,
${EXPANDED} button[class*="newSession"]:not([data-dsh-cron-entry]):focus-visible {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)) !important;
}

/* 宿主的 newSessionContent 是居中排布（width:100cqw + justify-content:center），
   大按钮变行之后要改成左对齐，文字才会和 panelRow 的标签对齐。 */
${EXPANDED} button[class*="newSession"] [class*="newSessionContent"] {
	justify-content: flex-start !important;
	gap: 8px !important;
	width: 100% !important;
}

/* 大按钮里的图标是 14px，panelRow 的 panelGlyph 是 16px。 */
${EXPANDED} button[class*="newSession"] svg {
	width: 16px !important;
	height: 16px !important;
}

${EXPANDED} [data-dsh-cron-entry] {${ROW_METRICS}}

${EXPANDED} [data-dsh-cron-entry]:hover,
${EXPANDED} [data-dsh-cron-entry]:focus-visible {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)) !important;
}

/* 面板列表与上面两行同组：补 4px 上外边距，六行等距。 */
${EXPANDED} nav:has([data-slot="sidebar.panellist"]) {
	margin-top: 4px !important;
}

/* ⑧ 收起态（桌面端标题栏）的「操作」菜单。

      宿主在收起态把「新会话」压成标题栏里一颗 28×28 的圆形图标
      （position:fixed; left:48px; 见宿主的 [data-windows-titlebar] .collapsed
      .newSession 规则）。这里把它藏掉，在同一位置放一颗「操作」按钮：点开是一张
      **只含文字**的菜单，列出侧栏当前的全部入口（新会话 / 定时任务 / 插件 /
      技能中心 / 记忆系统 / MCP连接器，以后新增的面板行会自动进来）。
      按钮尺寸、位置、hover、focus 环全部照抄宿主标题栏那两颗图标，所以收起态
      仍然是「开关 + 一颗图标」的节奏。 */
html[data-windows-titlebar]:has([data-sidebar-collapsed="true"]) button[class*="newSession"] {
	display: none !important;
}

/* 「操作」是与「应用 / 编辑」并排的文字菜单，样式逐条对齐 Desktop 菜单栏
   （shadow DOM 里的 :host/button）：28px 高、0 10px 内边距、6px 圆角、14px 字号、
   label-secondary + hover 转 label-primary、cursor: default。
   它比宿主原来占这个位置的东西都宽（收起态是 28px 圆图标、展开态什么都没有但
   菜单默认就放在 48px），所以**两种状态都要**把 Desktop 菜单的起点让开：
   收起态宿主自己设的是 84px，展开态默认 48px。 */
html[data-windows-titlebar] {
	--dsh-windows-menu-start: 100px !important;
}

.dshRailTrigger {
	position: fixed;
	top: calc((var(--dsh-windows-titlebar-height, 40px) - 28px) / 2);
	left: 48px;
	z-index: 30;
	-webkit-app-region: no-drag;
	display: none;
	align-items: center;
	justify-content: center;
	height: 28px;
	margin: 0;
	padding: 0 10px;
	border: none;
	border-radius: 6px;
	background: transparent;
	color: var(--dsw-alias-label-secondary, inherit);
	font: inherit;
	font-size: 14px;
	line-height: 1;
	white-space: nowrap;
	cursor: default;
}

/* 展开态与收起态都常驻（用户要求「左侧栏打开时也保留操作菜单」）。
   收起态它顶替宿主那颗被藏起来的「新会话」图标；展开态它排在开关与「应用/编辑」之间。 */
html[data-windows-titlebar] .dshRailTrigger {
	display: inline-flex;
}

.dshRailTrigger:hover,
.dshRailTrigger[aria-expanded="true"] {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
	color: var(--dsw-alias-label-primary, inherit);
}

.dshRailTrigger:focus-visible {
	outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, currentColor));
	outline-offset: 2px;
}

.dshRailMenu {
	position: fixed;
	top: var(--dsh-windows-titlebar-height, 40px);
	left: 8px;
	z-index: 2100;
	min-width: 176px;
	padding: 6px;
	display: flex;
	flex-direction: column;
	gap: 2px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28));
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base, #232323)));
	box-shadow: 0 12px 28px rgba(0, 0, 0, 0.36);
}

/* 菜单项：与宿主 panelRow 同一套度量（36 行高用 padding 撑、圆角、主题 hover），
   只是没有图标——按用户要求「仅文字」。 */
.dshRailMenuItem {
	display: block;
	width: 100%;
	margin: 0;
	padding: 7px 10px;
	border: 0;
	border-radius: var(--dsw-radius-sm, 6px);
	background: transparent;
	color: var(--dsw-alias-label-primary, inherit);
	font: inherit;
	font-size: 14px;
	font-weight: 400;
	line-height: 22px;
	text-align: left;
	white-space: nowrap;
	cursor: pointer;
}

.dshRailMenuItem:hover,
.dshRailMenuItem:focus-visible {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
	outline: none;
}

/* ⑨ 「定时任务」打开时，它自己那一行也要有选中底色。

      宿主的面板行靠 .panelRow.panelActive（aria-current="page"）拿到底色；
      dsh-cron 的入口不在那个 slot 里、也不参与宿主的面板互斥，所以它打开时侧栏里
      没有任何高亮，和旁边「插件 / 技能中心 / 记忆系统 / MCP连接器」不一致。
      cron 自己会在 <html> 上打 data-dsh-cron-active，用它当选中态即可。

      多写一个 body 是**故意的**：⑥ 里 cron 那一段同样匹配这一行（特异度 0,2,1），
      加上 body 让这条到 0,2,2，无论书写顺序如何都稳赢。 */
html[data-dsh-cron-active] body [data-dsh-cron-entry] {
	background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)) !important;
}

/* ⑩ cron 打开时，宿主的「当前会话」高亮也要收起来。

      宿主把「谁算当前会话」写成：currentId = panelActive ? undefined : <主视图会话>
      （workspace 里的 Rows 就是这么算的），所以**有面板激活时**侧栏里那一行不带
      .selected、没有灰底。而 dsh-cron 不是宿主的注册面板——我们为了不让它浮在面板
      之上，把 activePanelId 清成了 null，宿主于是又把会话行当成「当前」、给它上了
      .hIlkoa_selected 的灰底。为了和「打开其它面板」时的观感一致，cron 打开期间把
      这份灰底收掉。

      :not(:hover) 是有意的：hover 的灰底是鼠标反馈，与面板状态无关，要保留。
      特异度 (0,3,1)+important 稳压宿主的 .hIlkoa_sessionRow.hIlkoa_selected (0,2,0)。 */
html[data-dsh-cron-active] [class*="sessionRow"][class*="selected"]:not(:hover),
html[data-dsh-cron-active] [class*="searchResultRow"][class*="selected"]:not(:hover) {
	background: transparent !important;
}
`;

		/**
		 * 写入样式表。
		 *
		 * 刻意**不做「已存在就跳过」的去重**。实测踩到过：DSH 的客户端插件可能被
		 * 挂载两次（profile bundles 与市场的 client-only shim 各一次），或者一次
		 * 热加载留下一个待清理的旧实例。去重时后一个实例什么都不做，而前一个实例
		 * 被清理时会把那唯一一张样式表摘掉——样式就整体消失了：
		 * 现象是「运行中任务」又冒出来、六个入口退回大按钮，但 JS 补丁（⑦）还在。
		 * 所以每个实例只管自己那一张，清理也只摘自己那一张。内容完全相同，多一份
		 * 没有视觉影响，反而保证「最新那份在最后、优先级最高」。
		 * @returns 解绑函数。
		 */
		function installStyles() {
			if (typeof document === "undefined") return () => {};
			let style = null;
			const append = () => {
				const head = document.head;
				if (head === null || head === void 0) return false;
				style = document.createElement("style");
				style.dataset.plugin = STYLE_ID;
				style.textContent = tweakCss;
				head.append(style);
				return true;
			};
			if (append()) {
				return () => {
					style?.remove();
					style = null;
				};
			}
			// 极少数情况下 apply 早于 <head>：下一帧再试，最多约 2 秒。
			let tries = 0;
			let cancelled = false;
			const timer = setInterval(() => {
				if (cancelled) return;
				tries += 1;
				if (append() || tries > 40) clearInterval(timer);
			}, 50);
			return () => {
				cancelled = true;
				clearInterval(timer);
				style?.remove();
				style = null;
			};
		}

		/** ⑨ 的选中底色值（样式表与内联兜底共用一份）。 */
		const CRON_ACTIVE_BG = "var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))";

		/**
		 * ⑨ 的兜底：按 `<html>` 上的 `data-dsh-cron-active` 给「定时任务」那一行
		 * 直接写**内联**底色（一次同步）。
		 *
		 * 为什么还要 JS：样式表里的 ⑨ 会被任何特异度更高、或同样带 `!important` 的
		 * 上游规则盖掉（今天就踩到一次——⑥ 的 `button[class*="newSession"]` 连 cron 的
		 * 克隆按钮一起匹配了）。内联样式带 important 优先级高于**任何**样式表规则，
		 * 所以这一条一定能出效果；两层互为保险，任一层失效另一层还在。
		 * 行本身被重建时内联样式会丢，所以调用方还要盯 body 的子树变化重放一次。
		 */
		function applyCronActiveSkin() {
			if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
			const entry = document.querySelector("[data-dsh-cron-entry]");
			if (entry === null || entry === void 0 || typeof entry.style?.setProperty !== "function") return;
			const active = typeof document.documentElement?.hasAttribute === "function"
				&& document.documentElement.hasAttribute("data-dsh-cron-active");
			const current = typeof entry.style.getPropertyValue === "function" ? entry.style.getPropertyValue("background") : "";
			if (active) {
				if (current === "") entry.style.setProperty("background", CRON_ACTIVE_BG, "important");
			} else if (current !== "") {
				entry.style.removeProperty("background");
			}
		}

		/**
		 * ⑨ 装上兜底：盯 `<html data-dsh-cron-active>`（打开/关闭）与 body 的子树变化
		 * （那一行可能被重建），用 rAF 节流后重放一次同步。
		 * @returns 解绑函数。
		 */
		function installCronActiveSkin(clearPanel) {
			if (typeof document === "undefined" || typeof MutationObserver !== "function") return () => {};
			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				const run = () => {
					scheduled = false;
					applyCronActiveSkin();
				};
				if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
				else setTimeout(run, 50);
			};
			/**
			 * 属性变化时：同步底色；并且**只要 cron 变成打开**，就把宿主的主面板清掉。
			 *
			 * 这一条是互斥的**第二条保险**，而且比拦点击更可靠：它由 cron 自己的状态驱动，
			 * 不依赖「我有没有抢到那次点击」。实测就踩到过——`layout` 服务在 apply 那一刻
			 * 还没就绪、被缓存成 undefined，于是点击那条路静默失效，cron 就浮在面板上面。
			 */
			const onActiveChanged = () => {
				applyCronActiveSkin();
				if (document.documentElement.hasAttribute("data-dsh-cron-active")) clearPanel();
			};
			const attrObserver = new MutationObserver(onActiveChanged);
			attrObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-dsh-cron-active"] });
			// 那一行可能被重建（内联样式会丢），所以也盯 body 的子树变化重放一次底色。
			// 注意：这条路**只补底色**，不碰面板，避免「写面板 → 触发渲染 → 再触发」的循环。
			const bodyObserver = new MutationObserver(schedule);
			if (document.body !== null && document.body !== void 0) {
				bodyObserver.observe(document.body, { childList: true, subtree: true });
			}
			onActiveChanged();
			return () => {
				attrObserver.disconnect();
				bodyObserver.disconnect();
			};
		}

		/**
		 * ⑦ 让「定时任务」与宿主的面板行**双向互斥**（任何时刻只有一块界面占着中间栏）。
		 *
		 *   · 面板行被点（插件 / 技能中心 / 记忆系统 / MCP连接器）→ dsh-cron 开着的话让它让位。
		 *     cron 打开时会把对话列里所有兄弟节点 display:none 掉、只留自己那块；它只在点到
		 *     「会话 / 工作区 / 新会话」时自关，没覆盖 sidebar.panellist 的面板行——于是面板
		 *     其实被选中了却被盖住，看着像点不动。
		 *   · 「新会话 / 定时任务」这类铺满对话列的入口被点 → 先清掉已选中的面板
		 *     （ctx.layout.selectPanel(null)）。否则 cron 会**浮在**那块面板之上，而它的
		 *     「返回对话」只是关掉自己，底下露出来的还是上一个面板。
		 *
		 * 「以后新加的按钮」：注册成 sidebar.panellist 的面板行天然走第一条（外加宿主自己
		 * 的选中态）；沿用 dsh-cron 那种「克隆宿主 newSession 按钮」写法的入口天然走第二条
		 * ——选择器就是 `button[class*="newSession"]`，不点名任何具体插件。
		 * @param clearPanel - 清掉当前主面板（内部调用 ctx.layout.selectPanel(null)）。
		 * @returns 解绑函数。
		 */
		function installCronYield(clearPanel) {
			if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
				return () => {};
			}
			const onClick = (event) => {
				const target = event.target;
				if (target === null || typeof target.closest !== "function") return;
				const row = target.closest("button");
				if (row === null) return;
				if (row.closest("nav") !== null) {
					// 第一条：面板行 → 让 dsh-cron 让位（只在它确实打开时才派发）。
					if (!document.documentElement.hasAttribute("data-dsh-cron-active")) return;
					document.dispatchEvent(new CustomEvent("dsh-panel-activate", { detail: "ui-tweaks:panel-row" }));
					return;
				}
				// 第二条：铺满对话列的入口（新会话 / 定时任务，以及以后克隆它的按钮）。
				if (typeof row.matches !== "function") return;
				if (!row.matches('button[class*="newSession"], [data-dsh-cron-entry]')) return;
				clearPanel();
			};
			document.addEventListener("click", onClick, true);
			return () => document.removeEventListener("click", onClick, true);
		}

		/** ⑧ 「操作」菜单的类名（按钮是文字，不是图标——与「应用 / 编辑」同款）。 */
		const RAIL_TRIGGER_CLASS = "dshRailTrigger";
		const RAIL_MENU_CLASS = "dshRailMenu";
		const RAIL_ITEM_CLASS = "dshRailMenuItem";

		/**
		 * 取元素内第一段非空文字（读侧栏条目的可见标签用）。
		 *
		 * 为什么不是 querySelector 一下就拿：收起态宿主**不渲染** newSessionLabel 的
		 * 文字（`wide` 为 false 时才渲染），此时 `[class*="newSessionLabel"]` 命中的是
		 * 包着它的 newSessionLabelMask，textContent 为空——只取第一个匹配就会把这一项
		 * 当成「没有标签」而丢掉（这正是「操作菜单里没有新对话」的成因）。
		 * @param element - 容器。
		 * @param selector - 候选子元素。
		 * @returns 第一段非空 textContent；读不到为空串。
		 */
		function firstText(element, selector) {
			if (typeof element?.querySelectorAll !== "function") return "";
			for (const node of element.querySelectorAll(selector)) {
				const text = typeof node.textContent === "string" ? node.textContent.trim() : "";
				if (text !== "") return text;
			}
			return "";
		}

		/**
		 * 现场收集侧栏里的入口。
		 *
		 * 直接读 DOM 而不是写死六项：以后新装的面板（会注册成 sidebar.panellist 行）
		 * 或新加的按钮会自动出现在菜单里，不需要改这份代码。
		 * @returns {Array<{label: string, element: Element}>} 采集到的入口。
		 */
		function railEntries() {
			const entries = [];
			const seen = new Set();
			const push = (element, label) => {
				if (element === null || element === void 0 || seen.has(element)) return;
				const text = typeof label === "string" ? label.trim() : "";
				if (text === "") return;
				seen.add(element);
				entries.push({ label: text, element });
			};
			const newSession = typeof document.querySelector === "function"
				? document.querySelector('button[class*="newSession"]:not([data-dsh-cron-entry])')
				: null;
			if (newSession !== null) {
				// 收起态读不到可见文字（见 firstText 的注释），此时按用户指定的措辞叫「新对话」。
				push(newSession, firstText(newSession, '[class*="newSessionLabel"]') || "新对话");
			}
			const cron = typeof document.querySelector === "function" ? document.querySelector("[data-dsh-cron-entry]") : null;
			if (cron !== null) {
				push(cron, firstText(cron, ".dsh-cron-entry-label") || cron.getAttribute("aria-label"));
			}
			const outlets = typeof document.querySelectorAll === "function"
				? document.querySelectorAll('[data-slot="sidebar.panellist"]')
				: [];
			for (const outlet of outlets) {
				const row = typeof outlet.closest === "function" ? outlet.closest("button") : null;
				if (row !== null) push(row, row.getAttribute("aria-label"));
			}
			return entries;
		}

		/**
		 * ⑧ 「操作」菜单（收起态与展开态都常驻在标题栏左上角，排在开关与
		 * 「应用 / 编辑」之间）。
		 *
		 * 收起后宿主只剩「开关 + 新会话」两颗图标，六个入口里的其它五个都点不到
		 * （宿主把 panelList 整个 display:none 了），所以那时它是唯一的去处；
		 * 展开时侧栏里虽然能看到六个入口，但用户要求这个菜单继续留着当快捷入口。
		 * 点开是一张只含文字的菜单，列出侧栏当前的全部入口（现场从 DOM 收集），
		 * 点哪一项就把点击**委托给那一项本身**——于是和直接点侧栏完全一致，
		 * 也不会跟宿主的选中态打架，更不用复制任何上游逻辑。
		 * @returns 解绑函数。
		 */
		function installRailMenu() {
			if (typeof document === "undefined" || typeof document.body?.append !== "function") {
				return () => {};
			}
			const trigger = document.createElement("button");
			trigger.type = "button";
			trigger.className = RAIL_TRIGGER_CLASS;
			trigger.setAttribute("aria-label", "操作");
			trigger.setAttribute("title", "操作");
			trigger.setAttribute("aria-haspopup", "menu");
			trigger.setAttribute("aria-expanded", "false");
			trigger.textContent = "操作";
			let menu = null;

			const closeMenu = () => {
				if (menu === null) return;
				menu.remove();
				menu = null;
				trigger.setAttribute("aria-expanded", "false");
			};

			const openMenu = () => {
				closeMenu();
				const entries = railEntries();
				if (entries.length === 0) return;
				menu = document.createElement("div");
				menu.className = RAIL_MENU_CLASS;
				menu.setAttribute("role", "menu");
				for (const entry of entries) {
					const item = document.createElement("button");
					item.type = "button";
					item.className = RAIL_ITEM_CLASS;
					item.setAttribute("role", "menuitem");
					item.textContent = entry.label;
					item.addEventListener("click", (event) => {
						event.preventDefault();
						event.stopPropagation();
						closeMenu();
						try {
							entry.element.click();
						} catch (error) {
							console.error("[ui-tweaks] 委派点击失败：", error);
						}
					});
					menu.append(item);
				}
				document.body.append(menu);
				trigger.setAttribute("aria-expanded", "true");
			};

			const onTriggerClick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (menu === null) openMenu();
				else closeMenu();
			};
			const onDocumentClick = (event) => {
				if (menu === null) return;
				const target = event.target;
				if (target === trigger || trigger.contains?.(target) === true) return;
				if (menu.contains?.(target) === true) return;
				closeMenu();
			};
			const onKeyDown = (event) => {
				if (event.key === "Escape") closeMenu();
			};

			trigger.addEventListener("click", onTriggerClick);
			document.addEventListener("click", onDocumentClick, true);
			document.addEventListener("keydown", onKeyDown, true);

			// 「操作」在收起态与展开态都常驻，所以不需要盯着 data-sidebar-collapsed
			// 去关菜单——菜单只由「点外面 / Esc / 点了某一项」关闭。
			document.body.append(trigger);
			return () => {
				closeMenu();
				trigger.removeEventListener("click", onTriggerClick);
				document.removeEventListener("click", onDocumentClick, true);
				document.removeEventListener("keydown", onKeyDown, true);
				trigger.remove();
			};
		}

		/**
		 * 挂上样式表与两个交互补丁。客户端上下文由 Module Loader 提供，本插件不注册任何槽位。
		 * 三段互相独立：任何一段出错都不会连累另外两段。
		 * @param ctx - 客户端上下文（用它的 effect 绑定生命周期）。
		 */
		function apply(ctx) {
			if (typeof document === "undefined") return;
			try {
				ctx?.effect?.(() => installStyles(), "dsh-ui-tweaks: styles");
			} catch (error) {
				console.error("[ui-tweaks] 注入样式失败：", error);
			}
			/**
			 * 取宿主的面板服务（layout）——**三条路都试**，因为客户端服务的就绪时机不确定：
			 *   ① `ctx.inject(["layout"], …)`：cordis 的正规姿势。apply 立刻返回（样式不受影响），
			 *      服务就绪时才回调，把句柄交给我们；这是唯一**保证**拿得到的一条路。
			 *   ② `ctx.layout`：宿主若已按 inject 注入就直接用它。
			 *   ③ `ctx.get("layout")`：运行时直接取（技能中心插件的「返回对话」就是这么读的）。
			 *
			 * **绝不在 apply 那一刻定死**：之前就是把 `ctx.get` 的结果缓存成 undefined，
			 * 于是「点定时任务先清掉下面的面板」整条静默失效——现象正是 cron 浮在面板之上。
			 * 所以这里每成功取到一次就存下，取不到就下次再试。
			 */
			let layoutHandle = void 0;
			const resolveLayout = () => {
				if (layoutHandle !== void 0 && layoutHandle !== null) return layoutHandle;
				try {
					layoutHandle = ctx?.layout ?? ctx?.get?.("layout") ?? void 0;
				} catch (error) {
					layoutHandle = void 0;
				}
				return layoutHandle;
			};
			try {
				ctx?.inject?.(["layout"], (scoped) => {
					layoutHandle = scoped?.layout ?? scoped?.get?.("layout") ?? scoped ?? void 0;
					return () => {
						layoutHandle = void 0;
					};
				});
			} catch (error) {
				console.warn("[ui-tweaks] ctx.inject(layout) 不可用，退回 ctx.get：", error);
			}
			const clearPanel = () => {
				try {
					const layout = resolveLayout();
					if (layout === void 0 || layout === null) {
						console.warn("[ui-tweaks] 还没拿到 layout 服务，无法清掉主面板");
						return;
					}
					layout.selectPanel?.(null);
				} catch (error) {
					console.error("[ui-tweaks] 清除主面板失败：", error);
				}
			};
			try {
				ctx?.effect?.(() => installCronYield(clearPanel), "dsh-ui-tweaks: cron yield");
			} catch (error) {
				console.error("[ui-tweaks] 安装面板互斥补丁失败：", error);
			}
			try {
				ctx?.effect?.(() => installRailMenu(), "dsh-ui-tweaks: rail menu");
			} catch (error) {
				console.error("[ui-tweaks] 安装「操作」菜单失败：", error);
			}
			try {
				ctx?.effect?.(() => installCronActiveSkin(clearPanel), "dsh-ui-tweaks: cron active skin");
			} catch (error) {
				console.error("[ui-tweaks] 安装定时任务选中底色兜底失败：", error);
			}
			console.log("[ui-tweaks] 已注入界面微调样式与三个交互补丁");
		}

		exports.apply = apply;
		exports.inject = [];
		exports.tweakCss = tweakCss;
		exports.internals = {
			LINK_ICON_SVG,
			LINK_MASK,
			ROW_METRICS,
			EXPANDED,
			RAIL_TRIGGER_CLASS,
			RAIL_MENU_CLASS,
			RAIL_ITEM_CLASS,
			firstText,
			railEntries,
			applyCronActiveSkin
		};
		return module.exports;
	},
});
