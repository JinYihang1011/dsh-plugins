/**
 * dsh-tiger-talisman —— 浏览器半边（虎符咒）。
 *
 * 形态与 dsh-ui-tweaks / dsh-session-ops 一致：Module Loader 包（`factory(require)`），
 * 直接提交一个 `window.__ModuleLoader__.load({...})`，不需要打包器。
 *
 * 它把「插件共存」这件事变成**看得见**的一体检：谁占了哪个插槽、谁的样式表在
 * `<head>` 里带了多少 `!important`、谁的 z-index 落在哪一层、哪个插件被挂载了两次。
 * 领地表是**声明式**的（下面的 TERRITORIES）：插槽分「列表型 / 独占型 / 键控型」，
 * 独占型被多个插件占用就是**真冲突**，报告里单列。
 *
 * 第一版只体检、只报告，**不做任何强制**——仲裁规则先声明出来，等看清楚了再开。
 * 全程不改任何上游文件。
 */

window.__ModuleLoader__.load({
	id: "dsh-tiger-talisman",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let ui_primitives;
		try {
			ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			ui_primitives = void 0;
		}

		/** 侧栏入口与主面板共用的 id。 */
		const PANEL_ID = "tiger-talisman";
		const STYLE_ID = "dsh-tiger-talisman";
		const ENTRY_LABEL = "虎符咒";
		const API_PATH = "/tiger-talisman/api/inventory";

		/**
		 * 领地表：把 DSH 的插槽按「同一时刻允许几个占用者」分类。
		 *
		 *   list      —— 天然是列表，多个占用者并列即可（侧栏入口、设置分区…）
		 *   exclusive —— 同一时刻只该有一个活跃占用者（全屏弹层、底部动作区、输入框下沿…）
		 *   keyed     —— 宿主按键选中（`main` 按 activePanelId），同刻只渲染一个
		 *
		 * 今晚踩过的坑几乎都能在这张表里找到位置：cron 那块自绘覆盖层**根本没走插槽**，
		 * 所以它既不在任何领地里，也没人仲裁它；而 `sidebar.footer.action` 这类独占位
		 * 被两个插件同时占用时，宿主默认横排会把它们挤在一行——那就是需要仲裁的场景。
		 */
		const TERRITORIES = {
			root: { kind: "exclusive", note: "Web 外壳唯一入口" },
			main: { kind: "keyed", note: "按 activePanelId 选中，同刻只渲染一个" },
			"shell.overlay": { kind: "exclusive", note: "全屏弹层：同刻只该有一个活跃" },
			"sidebar.panellist": { kind: "list", note: "侧栏面板入口列表" },
			"sidebar.footer.action": { kind: "exclusive", note: "底部动作区：宿主默认横排，多占用者会被挤成一行" },
			"sidebar.settings": { kind: "list", note: "底部设置入口" },
			"sidebar.workspaces": { kind: "exclusive", note: "工作区 / 会话列表区域" },
			"sidebar.brand.mark": { kind: "exclusive", note: "侧栏品牌标记" },
			"sidebar.brand.name": { kind: "exclusive", note: "侧栏品牌文字" },
			"sidebar.toggle.badge": { kind: "list", note: "侧栏开关上的角标" },
			"sidebar.right.pane.tab": { kind: "list", note: "右栏页签" },
			"conversation.composer.dock": { kind: "exclusive", note: "输入框下沿：独占位" },
			"conversation.chat.turnTail": { kind: "list", note: "每轮回复尾部" },
			"conversation.session.header.utilities": { kind: "list", note: "会话头部工具位" },
			"settings.section": { kind: "list", note: "设置页分区" },
			"settings.plugin.item": { kind: "list", note: "插件设置项" },
			"plugins.bundle.config": { kind: "list", note: "插件页配置卡片" },
			"plugins.item": { kind: "list", note: "插件页条目" }
		};

		/** 拟议的层级秩序（只用于给报告里的 z-index 打标，不强制）。 */
		const LAYER_ORDER = [
			{ name: "轨道/图标栏", max: 49 },
			{ name: "面板内容", max: 199 },
			{ name: "浮层（下拉、提示）", max: 999 },
			{ name: "覆盖层 / 弹窗", max: 1999 },
			{ name: "系统层（宿主设置、模态）", max: Number.POSITIVE_INFINITY }
		];

		/** 与宿主图标同几何的兜底（宿主提供组件时不用）。 */
		const ICON_PATHS = ["M8 1.8l5.2 2.6v3.7c0 3.1-2.1 5.4-5.2 6.1-3.1-.7-5.2-3-5.2-6.1V4.4L8 1.8z", "M8 5.4v5.2"];

		function TigerIcon({ size }) {
			const HostIcon = ui_primitives?.IconShieldOutlineRegular;
			if (typeof HostIcon === "function") {
				return (0, react_jsx_runtime.jsx)(HostIcon, { size });
			}
			return (0, react_jsx_runtime.jsx)("svg", {
				"aria-hidden": "true",
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: ICON_PATHS.map((path) => (0, react_jsx_runtime.jsx)("path", { d: path }, path))
			});
		}

		/** 体检面板的样式（走主题变量，亮暗自动跟随）。 */
		const panelCss = `
.tigerPanel { box-sizing: border-box; width: 100%; height: 100%; overflow-y: auto; padding: 24px 32px 40px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
.tigerHead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.tigerTitle { font-size: 22px; font-weight: 600; }
.tigerSub { color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.tigerSummary { margin: 14px 0 22px; padding: 12px 14px; border-radius: var(--dsw-radius-md, 10px); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.tigerSection { margin: 22px 0 10px; font-size: 16px; font-weight: 600; }
.tigerTable { width: 100%; border-collapse: collapse; }
.tigerTable th, .tigerTable td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2)); vertical-align: top; }
.tigerTable th { color: var(--dsw-alias-label-tertiary); font-weight: 400; font-size: 12px; }
.tigerBadge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; border: 1px solid currentColor; opacity: .85; }
.tigerBadge[data-tone="bad"] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.tigerBadge[data-tone="warn"] { color: var(--dsw-alias-state-warning-primary, #d97706); }
.tigerBadge[data-tone="ok"] { color: var(--dsw-alias-label-tertiary); }
.tigerMono { font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 12px; }
.tigerEmpty { color: var(--dsw-alias-label-tertiary); }
.tigerError { color: var(--dsw-alias-state-error-primary, #e5484d); }
`;

		function installStyles() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin="${STYLE_ID}"]`) !== null) return () => {};
			const style = document.createElement("style");
			style.dataset.plugin = STYLE_ID;
			style.textContent = panelCss;
			document.head.append(style);
			return () => style.remove();
		}

		/**
		 * 给一个 z-index 值标注拟议秩序里的层名。
		 * @param value - z-index 数值。
		 * @returns 层名。
		 */
		function layerName(value) {
			for (const layer of LAYER_ORDER) {
				if (value <= layer.max) return layer.name;
			}
			return "未知";
		}

		/**
		 * 采集**插槽领地**：谁是哪个插槽的占用者，独占型有没有被多人占。
		 * @param slots - `ctx.slots` 服务（可为 undefined）。
		 * @returns 每个已知插槽一行。
		 */
		function collectSlots(slots) {
			const rows = [];
			for (const [slot, territory] of Object.entries(TERRITORIES)) {
				let entries = [];
				try {
					entries = slots?.entriesOfSlot?.(slot) ?? [];
				} catch (error) {
					entries = [];
				}
				const owners = entries.map((entry) => {
					const options = entry?.options ?? {};
					return {
						id: typeof options.id === "string" ? options.id : (typeof options.key === "string" ? options.key : null),
						order: typeof options.order === "number" ? options.order : null
					};
				});
				rows.push({
					slot,
					kind: territory.kind,
					note: territory.note,
					owners,
					conflict: territory.kind === "exclusive" && owners.length > 1
				});
			}
			rows.sort((a, b) => Number(b.conflict) - Number(a.conflict) || b.owners.length - a.owners.length || a.slot.localeCompare(b.slot));
			return rows;
		}

		/**
		 * 采集**样式领地**：每个插件往 `<head>` 放了几张样式表、多少规则、多少 `!important`、
		 * 用了哪些 z-index。同一个插件出现两张以上样式表就是**重复挂载**的痕迹。
		 * @returns 每个插件一行。
		 */
		function collectStyles() {
			if (typeof document === "undefined") return [];
			const byPlugin = new Map();
			for (const node of document.head.querySelectorAll("style[data-plugin]")) {
				const plugin = node.dataset?.plugin ?? "(未署名)";
				const text = typeof node.textContent === "string" ? node.textContent : "";
				const zIndexes = [...new Set([...text.matchAll(/z-index:\s*(\d+)/g)].map((match) => Number(match[1])))];
				const row = byPlugin.get(plugin) ?? { plugin, sheets: 0, rules: 0, importants: 0, zIndexes: [] };
				row.sheets += 1;
				row.rules += (text.match(/\{/g) ?? []).length;
				row.importants += (text.match(/!important/g) ?? []).length;
				row.zIndexes = [...new Set([...row.zIndexes, ...zIndexes])].sort((a, b) => a - b);
				byPlugin.set(plugin, row);
			}
			const rows = [...byPlugin.values()];
			rows.sort((a, b) => Number(b.sheets > 1) - Number(a.sheets > 1) || b.importants - a.importants || a.plugin.localeCompare(b.plugin));
			return rows;
		}

		/** 拉宿主侧的只读体检（插件清单 + 技能清单）。失败不抛，报告里单独一行说明。 */
		async function fetchInventory() {
			try {
				const response = await window.fetch(API_PATH, { headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return await response.json();
			} catch (error) {
				return { error: String(error?.message ?? error) };
			}
		}

		/** 建一个元素（面板用命令式渲染，节点多了也不必套一层 JSX）。 */
		function el(tag, className, text) {
			const node = document.createElement(tag);
			if (className !== void 0) node.className = className;
			if (text !== void 0) node.textContent = text;
			return node;
		}

		/**
		 * 把体检结果渲染进面板容器。
		 * @param host - 容器元素。
		 * @param snapshot - `{ phase, client, host, error }`。
		 */
		function renderReport(host, snapshot) {
			host.replaceChildren();
			const wrap = el("div", "tigerPanel");
			host.append(wrap);

			const head = el("div", "tigerHead");
			head.append(el("div", "tigerTitle", ENTRY_LABEL));
			head.append(el("div", "tigerSub", "插件与 Skill 共存的领地体检（只读，不强制）"));
			wrap.append(head);

			if (snapshot.phase === "loading") {
				wrap.append(el("div", "tigerSummary", "正在体检…"));
				return;
			}
			if (snapshot.phase === "error") {
				wrap.append(el("div", "tigerSummary tigerError", `体检失败：${snapshot.error}`));
				return;
			}

			const slots = snapshot.client?.slots ?? [];
			const styles = snapshot.client?.styles ?? [];
			const conflicts = slots.filter((row) => row.conflict);
			const duplicates = styles.filter((row) => row.sheets > 1);
			const plugins = snapshot.host?.plugins ?? [];
			const skills = snapshot.host?.skills ?? [];

			const summary = el("div", "tigerSummary");
			summary.append(el("div", null, `插件 ${plugins.length} 个 · 技能 ${skills.length} 个 · 有占用者的插槽 ${slots.filter((row) => row.owners.length > 0).length} 个`));
			if (conflicts.length === 0 && duplicates.length === 0) {
				summary.append(el("div", null, "冲突：未发现独占型插槽被多人占用，也没有重复挂载的痕迹。"));
			} else {
				if (conflicts.length > 0) summary.append(el("div", null, `冲突：${conflicts.length} 个独占型插槽被多人占用 —— ${conflicts.map((row) => row.slot).join("、")}`));
				if (duplicates.length > 0) summary.append(el("div", null, `重复挂载痕迹：${duplicates.length} 个插件往 <head> 放了不止一张样式表 —— ${duplicates.map((row) => row.plugin).join("、")}`));
			}
			if (snapshot.host?.error !== void 0) {
				summary.append(el("div", "tigerError", `宿主侧体检不可用：${snapshot.host.error}`));
			}
			wrap.append(summary);

			// ① 插槽领地
			wrap.append(el("div", "tigerSection", "① 插槽领地"));
			const slotTable = el("table", "tigerTable");
			const slotHead = el("tr");
			for (const label of ["插槽", "类型", "占用者", "说明"]) slotHead.append(el("th", null, label));
			slotTable.append(slotHead);
			for (const row of slots) {
				if (row.owners.length === 0) continue;
				const tr = el("tr");
				tr.append(el("td", "tigerMono", row.slot));
				const kind = el("td");
				const badge = el("span", "tigerBadge", row.kind === "exclusive" ? "独占" : row.kind === "keyed" ? "键控" : "列表");
				badge.dataset.tone = row.conflict ? "bad" : "ok";
				kind.append(badge);
				tr.append(kind);
				tr.append(el("td", null, row.owners.map((owner) => owner.id ?? "(匿名)").join("、")));
				tr.append(el("td", "tigerSub", row.conflict ? `⚠ ${row.note}` : row.note));
				slotTable.append(tr);
			}
			if (slotTable.children.length === 1) slotTable.append(el("tr", null, el("td", "tigerEmpty", "（没有采集到占用者）")));
			wrap.append(slotTable);

			// ② 样式领地
			wrap.append(el("div", "tigerSection", "② 样式领地（谁往 <head> 里放了东西）"));
			const styleTable = el("table", "tigerTable");
			const styleHead = el("tr");
			for (const label of ["插件", "样式表", "规则", "!important", "z-index", "层级"]) styleHead.append(el("th", null, label));
			styleTable.append(styleHead);
			for (const row of styles) {
				const tr = el("tr");
				tr.append(el("td", "tigerMono", row.plugin));
				const sheets = el("td");
				const badge = el("span", "tigerBadge", String(row.sheets));
				if (row.sheets > 1) badge.dataset.tone = "warn";
				sheets.append(badge);
				tr.append(sheets);
				tr.append(el("td", null, String(row.rules)));
				tr.append(el("td", null, String(row.importants)));
				tr.append(el("td", "tigerMono", row.zIndexes.length === 0 ? "—" : row.zIndexes.join(", ")));
				tr.append(el("td", "tigerSub", row.zIndexes.length === 0 ? "—" : [...new Set(row.zIndexes.map(layerName))].join(" / ")));
				styleTable.append(tr);
			}
			if (styleTable.children.length === 1) styleTable.append(el("tr", null, el("td", "tigerEmpty", "（没有采集到样式表）")));
			wrap.append(styleTable);

			// ③ 插件清单
			wrap.append(el("div", "tigerSection", "③ 插件（宿主侧只读扫描）"));
			const pluginTable = el("table", "tigerTable");
			const pluginHead = el("tr");
			for (const label of ["插件", "版本", "来源", "进 bundle 层", "浏览器半边"]) pluginHead.append(el("th", null, label));
			pluginTable.append(pluginHead);
			for (const row of plugins) {
				const tr = el("tr");
				tr.append(el("td", "tigerMono", row.name));
				tr.append(el("td", null, row.version ?? "—"));
				tr.append(el("td", "tigerSub", row.local ? "本机 link" : "npm"));
				tr.append(el("td", null, row.inBundles ? "是" : "否"));
				tr.append(el("td", "tigerSub", row.hasClient ? (row.clientPlatform ?? "web") : "无"));
				pluginTable.append(tr);
			}
			wrap.append(pluginTable);

			// ④ 技能清单
			wrap.append(el("div", "tigerSection", "④ 技能（触发词重叠是 Skill 侧的主要争用）"));
			const skillTable = el("table", "tigerTable");
			const skillHead = el("tr");
			for (const label of ["技能", "目录", "描述"]) skillHead.append(el("th", null, label));
			skillTable.append(skillHead);
			for (const row of skills) {
				const tr = el("tr");
				tr.append(el("td", null, row.name));
				tr.append(el("td", "tigerMono", row.dir));
				tr.append(el("td", "tigerSub", (row.description || row.whenToUse || "").slice(0, 120)));
				skillTable.append(tr);
			}
			wrap.append(skillTable);
		}

		/** 主面板：与「插件 / 记忆系统 / MCP连接器」同类的整屏界面。 */
		function TigerPanel(props) {
			const host = react.useRef(null);
			const [snapshot, setSnapshot] = react.useState({ phase: "loading" });
			const slotsService = props?.inject === void 0 ? void 0 : props.inject.slots;
			react.useEffect(() => {
				let alive = true;
				const client = { slots: collectSlots(slotsService), styles: collectStyles() };
				fetchInventory().then((inventory) => {
					if (!alive) return;
					setSnapshot({ phase: "ready", client, host: inventory });
				}, (error) => {
					if (!alive) return;
					setSnapshot({ phase: "ready", client, host: { error: String(error) } });
				});
				return () => {
					alive = false;
				};
			}, [slotsService]);
			react.useEffect(() => {
				if (host.current !== null) renderReport(host.current, snapshot);
			}, [snapshot]);
			return (0, react_jsx_runtime.jsx)("div", { ref: host, style: { width: "100%", height: "100%", minHeight: 0, overflow: "hidden" } });
		}

		/** 侧栏入口图标组件（宿主把 size 传进来：展开 16 / 收起 18）。 */
		function TigerPanelIcon({ size }) {
			return (0, react_jsx_runtime.jsx)(TigerIcon, { size });
		}

		/**
		 * 安装：注入面板样式 + 把入口与主面板注册进宿主的公开插槽。
		 *
		 * 用 `ctx.inject(["slots"], …)` 而不是写进 `inject`：拿不到 slots 时其余部分
		 * 仍然可用（面板会显示「没有采集到占用者」，而不是整段不加载）。
		 * @param ctx - 客户端上下文。
		 */
		function apply(ctx) {
			if (typeof document === "undefined") return;
			try {
				ctx?.effect?.(() => installStyles(), "tiger-talisman: panel styles");
			} catch (error) {
				console.error("[tiger-talisman] 注入样式失败：", error);
			}
			try {
				ctx?.inject?.(["slots"], (scoped) => {
					const disposers = [];
					disposers.push(scoped.slots.inject("sidebar.panellist", () => scoped.slots.register({
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 50,
						label: () => ENTRY_LABEL
					}, TigerPanelIcon)));
					disposers.push(scoped.slots.inject("main", () => scoped.slots.register({
						name: "main",
						key: PANEL_ID,
						inject: () => ({ slots: scoped.slots })
					}, TigerPanel)));
					return () => {
						for (const dispose of disposers.splice(0)) dispose();
					};
				});
			} catch (error) {
				console.error("[tiger-talisman] 注册入口失败：", error);
			}
			console.log("[tiger-talisman] 已挂上「虎符咒」入口与体检面板");
		}

		exports.apply = apply;
		exports.inject = [];
		exports.TERRITORIES = TERRITORIES;
		exports.internals = { PANEL_ID, STYLE_ID, ENTRY_LABEL, API_PATH, TERRITORIES, LAYER_ORDER, layerName, collectSlots, collectStyles, renderReport };
		return module.exports;
	}
});
