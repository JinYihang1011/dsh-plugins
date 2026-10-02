/**
 * dsh-session-ops —— 浏览器半边（Client side）。
 *
 * 形态与 dsh-mcp-connector 一致：Module Loader 包（`factory(require)`），
 * 直接提交一个 `window.__ModuleLoader__.load({...})`，因此不需要打包器。
 *
 * 贡献两处：
 *   · `sidebar.workspaces.session.menu.item` —— 会话行 "..." 菜单里加
 *     「打开工作区位置」（order 450）、「移动到工作区…」（order 500）
 *     与「删除会话…」（order 600），
 *     排在宿主自带的 置顶(100)/重命名(200)/分叉(300)/归档(400) 之后。
 *   · `shell.overlay` —— 两个对话框 + 一条 Toast，由上面几项写进共享 store 驱动。
 *     必须挂在 overlay 上：会话行菜单一关，行内的组件就被卸载了。
 *
 * 一切真正的读写都在宿主半边（见 index.js）：本文件只发同源 fetch。
 */

window.__ModuleLoader__.load({
	id: "dsh-session-ops",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		/** 宿主半边的同源端点。 */
		const API = "/session-ops/api";

		/** 图标与弹层组件优先用宿主自带的 primitives，取不到时退回自绘。 */
		let primitives;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			primitives = undefined;
		}

		/** 客户端所需服务：槽位系统。 */
		const inject = ["slots"];

		/* ───────────────────────── 共享 store ───────────────────────── */

		const listeners = new Set();
		let request = null;
		let toast = null;
		let seq = 0;
		let snapshot = { request: null, toast: null };

		function publish() {
			snapshot = { request, toast };
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch (error) {
					console.error("[session-ops] listener failed:", error);
				}
			}
		}

		function subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}

		function getSnapshot() {
			return snapshot;
		}

		function useStore() {
			return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		/** 打开一个对话框请求。 */
		function openRequest(next) {
			seq += 1;
			request = { ...next, seq };
			publish();
		}

		/** 关闭当前对话框。 */
		function settleRequest() {
			request = null;
			publish();
		}

		/** 弹一条 Toast；actions 形如 `[{ label, onClick }]`。 */
		function pushToast(next) {
			seq += 1;
			toast = { ...next, seq };
			publish();
		}

		function dismissToast() {
			toast = null;
			publish();
		}

		/* ───────────────────────── 宿主 API ───────────────────────── */

		async function callHost(method, params) {
			const response = await window.fetch(API, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method, params }),
				credentials: "same-origin",
			});
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			if (!response.ok || payload?.ok !== true) {
				throw new Error(payload?.message ?? `HTTP ${response.status}`);
			}
			return payload.detail;
		}

		/* ───────────────────────── 样式 ───────────────────────── */

		const S = {
			mask: {
				position: "fixed",
				inset: 0,
				zIndex: 1300,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))",
				padding: 24,
			},
			dialog: {
				width: "min(560px, 100%)",
				maxHeight: "80vh",
				overflow: "auto",
				background: "var(--dsw-alias-bg-layer-2, #26272c)",
				color: "var(--dsw-alias-label-primary, #e8e8ea)",
				border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12))",
				borderRadius: "var(--dsw-radius-panel, 12px)",
				boxShadow: "var(--dsw-elevation-prominent, 0 18px 48px rgba(0,0,0,0.45))",
				padding: 18,
				display: "flex",
				flexDirection: "column",
				gap: 12,
			},
			title: { fontSize: 15, fontWeight: 600, margin: 0 },
			desc: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #a8a8b0)", margin: 0, lineHeight: 1.55 },
			list: { display: "flex", flexDirection: "column", gap: 6, maxHeight: "42vh", overflow: "auto" },
			row: (selected, disabled) => ({
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 10,
				width: "100%",
				textAlign: "left",
				padding: "9px 11px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: `1px solid ${selected ? "var(--dsw-alias-button-primary-fill, #4d6bfe)" : "var(--dsw-alias-border-l3, rgba(255,255,255,0.12))"}`,
				background: selected ? "var(--dsw-alias-interactive-bg-active, rgba(255,255,255,0.10))" : "transparent",
				color: "inherit",
				cursor: disabled ? "not-allowed" : "pointer",
				opacity: disabled ? 0.55 : 1,
				font: "inherit",
			}),
			rowTitle: { fontSize: 13, fontWeight: 500 },
			rowPath: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #a8a8b0)", wordBreak: "break-all" },
			badge: {
				fontSize: 11,
				padding: "1px 6px",
				borderRadius: 999,
				border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.16))",
				color: "var(--dsw-alias-label-secondary, #a8a8b0)",
				whiteSpace: "nowrap",
			},
			warning: {
				display: "flex",
				gap: 8,
				alignItems: "flex-start",
				fontSize: 12,
				lineHeight: 1.5,
				padding: "9px 11px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.14))",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.05))",
				color: "var(--dsw-alias-label-secondary, #a8a8b0)",
			},
			footer: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 },
			error: { fontSize: 12, color: "#ff6b6b", margin: 0, lineHeight: 1.5 },
			button: (primary) => ({
				font: "inherit",
				fontSize: 13,
				padding: "6px 13px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: `1px solid ${primary ? "transparent" : "var(--dsw-alias-border-l3, rgba(255,255,255,0.16))"}`,
				background: primary ? "var(--dsw-alias-button-primary-fill, #4d6bfe)" : "transparent",
				color: primary ? "var(--dsw-alias-label-primary-foreground, #fff)" : "inherit",
				cursor: "pointer",
			}),
			checkboxRow: { display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, cursor: "pointer" },
		};

		/** 宿主 Button（有 primitives 时用它，保证风格一致）。 */
		function Btn({ primary, disabled, onClick, children }) {
			if (primitives?.Button) {
				return h(
					primitives.Button,
					{ variant: primary ? "primary" : "outline", disabled, onClick },
					children,
				);
			}
			return h("button", { type: "button", style: S.button(primary), disabled, onClick }, children);
		}

		/** 对话框外壳。 */
		function Dialog({ title, description, onClose, closeLabel, footer, children }) {
			if (primitives?.Modal) {
				return h(
					primitives.Modal,
					{ open: true, onClose, closeLabel: closeLabel ?? "关闭", title, description, footer },
					children,
				);
			}
			return h(
				"div",
				{ style: S.mask, role: "presentation", onClick: (event) => event.target === event.currentTarget && onClose() },
				h(
					"div",
					{ role: "dialog", "aria-modal": "true", style: S.dialog, onClick: (event) => event.stopPropagation() },
					h("h2", { style: S.title }, title),
					description ? h("p", { style: S.desc }, description) : null,
					children,
					h("div", { style: S.footer }, footer),
				),
			);
		}

		/** 警告条。 */
		function Warning({ children }) {
			return h(
				"div",
				{ style: S.warning },
				primitives?.IconWarningOutlineRegular ? h(primitives.IconWarningOutlineRegular, { size: 14 }) : null,
				h("span", null, children),
			);
		}

		/* ───────────────────────── 菜单项 ───────────────────────── */

		/** 会话行菜单：「打开工作区位置」——在文件管理器里打开该会话的工作目录。 */
		function OpenLocationMenuItem(props) {
			const { sessionId, displayTitle, useMenuOpenState } = props;
			const [, setMenuOpen] = useMenuOpenState();
			return h(
				primitives?.MenuItemButton ?? "button",
				{
					...(primitives?.MenuItemButton
						? {}
						: { type: "button", role: "menuitem", style: S.row(false, false) }),
					icon: primitives?.IconFolderOpenOutlineRegular
						? h(primitives.IconFolderOpenOutlineRegular, { size: 14 })
						: undefined,
					onSelect: () => {
						setMenuOpen(false);
						// 一次点击就打开：没有对话框，失败才用 Toast 说明原因。
						callHost("openLocation", { sessionId })
							.then((result) => {
								pushToast({
									text: `已在文件管理器中打开：${result?.path ?? displayTitle}`,
									tone: "success",
									holdMs: 4000,
								});
							})
							.catch((reason) => {
								pushToast({
									text: `打不开工作区位置：${reason instanceof Error ? reason.message : String(reason)}`,
									tone: "error",
									holdMs: 10000,
									icon: primitives?.IconWarningOutlineRegular
										? h(primitives.IconWarningOutlineRegular, { size: 14 })
										: undefined,
								});
							});
					},
				},
				"打开工作区位置",
			);
		}

		/** 会话行菜单：「移动到工作区…」。 */
		function MoveSessionMenuItem(props) {
			const { sessionId, displayTitle, useMenuOpenState } = props;
			const [, setMenuOpen] = useMenuOpenState();
			return h(
				primitives?.MenuItemButton ?? "button",
				{
					...(primitives?.MenuItemButton ? {} : { type: "button", role: "menuitem", style: S.row(false, false) }),
					icon: primitives?.IconWorkspaceTreeOutlineRegular
						? h(primitives.IconWorkspaceTreeOutlineRegular, { size: 14 })
						: undefined,
					onSelect: () => {
						setMenuOpen(false);
						openRequest({ kind: "move", sessionId, displayTitle });
					},
				},
				"移动到工作区…",
			);
		}

		/** 会话行菜单：「删除会话…」。 */
		function DeleteSessionMenuItem(props) {
			const { sessionId, displayTitle, useMenuOpenState } = props;
			const [, setMenuOpen] = useMenuOpenState();
			return h(
				primitives?.MenuItemButton ?? "button",
				{
					...(primitives?.MenuItemButton ? { separatorBefore: true } : { type: "button", role: "menuitem", style: S.row(false, false) }),
					icon: primitives?.IconTrashOutlineRegular ? h(primitives.IconTrashOutlineRegular, { size: 14 }) : undefined,
					onSelect: () => {
						setMenuOpen(false);
						openRequest({ kind: "delete", sessionId, displayTitle });
					},
				},
				"删除会话…",
			);
		}

		/* ───────────────────────── 移动对话框 ───────────────────────── */

		function MoveDialog({ request, onClose }) {
			const [state, setState] = react.useState({ phase: "loading" });
			const [selected, setSelected] = react.useState(null);
			const [force, setForce] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			react.useEffect(() => {
				let cancelled = false;
				callHost("prepare", { sessionId: request.sessionId })
					.then((detail) => {
						if (cancelled) return;
						setState({ phase: "ready", detail });
						// 默认选中一个「不是当前归属」的工作区，省一次点击。
						const candidate =
							detail.workspaces.find((workspace) => !workspace.accounted) ??
							detail.workspaces.find((workspace) => workspace.accounted) ??
							null;
						setSelected(candidate?.id ?? null);
					})
					.catch((reason) => {
						if (cancelled) return;
						setState({ phase: "ready", detail: null });
						setError(reason instanceof Error ? reason.message : String(reason));
					});
				return () => {
					cancelled = true;
				};
			}, [request.sessionId]);

			if (state.phase === "loading") {
				return h(Dialog, {
					title: "移动到工作区",
					description: `正在读取「${request.displayTitle}」的存储信息…`,
					onClose,
					closeLabel: "关闭",
					footer: h(Btn, { onClick: onClose }, "取消"),
				});
			}

			const detail = state.detail;
			const session = detail?.session;
			const target = detail?.workspaces?.find((workspace) => workspace.id === selected) ?? null;
			const needsRelocate = Boolean(session && target && !target.matchesCwd);
			const blockedByLive = Boolean(session?.live && !force);
			const blockedByWork = Boolean(session && session.activityCount > 0);

			const confirm = () => {
				if (!target) return;
				setBusy(true);
				setError(null);
				callHost("move", { sessionId: request.sessionId, workspaceId: target.id, force })
					.then((result) => {
						setBusy(false);
						onClose();
						pushToast({
							text:
								result.mode === "relocate"
									? `已把「${request.displayTitle}」搬迁到「${target.title}」（原日志备份在回收站）`
									: result.mode === "attach"
										? `已把「${request.displayTitle}」登记到「${target.title}」`
										: `「${request.displayTitle}」已经属于「${target.title}」`,
							tone: "success",
						});
					})
					.catch((reason) => {
						setBusy(false);
						setError(reason instanceof Error ? reason.message : String(reason));
					});
			};

			const footer = [
				h(Btn, { key: "cancel", onClick: () => !busy && onClose() }, "取消"),
				h(
					Btn,
					{ key: "ok", primary: true, disabled: busy || !target || blockedByWork || blockedByLive, onClick: confirm },
					busy ? "移动中…" : "移动",
				),
			];

			return h(
				Dialog,
				{
					title: "移动到工作区",
					description: `把「${session ? request.displayTitle : request.displayTitle}」归到另一个工作区下。`,
					onClose: () => !busy && onClose(),
					closeLabel: "关闭",
					footer,
				},
				detail === null
					? h("p", { style: S.error }, error ?? "读取失败")
					: h(
							"div",
							null,
							h(
								"p",
								{ style: S.desc },
								`当前工作目录：${session?.cwd ?? "（未记录）"}`,
								session?.workspaceId ? "（已归属某个工作区）" : "（当前未分组）",
							),
							h(
								"div",
								{ style: S.list },
								detail.workspaces.length === 0
									? h("p", { style: S.desc }, "还没有登记任何工作区。")
									: detail.workspaces.map((workspace) =>
											h(
												"button",
												{
													key: workspace.id,
													type: "button",
													style: S.row(workspace.id === selected, workspace.accounted),
													onClick: () => setSelected(workspace.id),
												},
												h(
													"span",
													null,
													h("div", { style: S.rowTitle }, workspace.title),
													h("div", { style: S.rowPath }, workspace.path),
												),
												h(
													"span",
													{ style: S.badge },
													workspace.accounted ? "当前归属" : workspace.matchesCwd ? "可直接登记" : "需搬迁",
												),
											),
										),
							),
							needsRelocate
								? h(
										Warning,
										null,
										"目标工作区路径与会话记录的工作目录不同：将改写会话日志头部记录的 cwd，并把日志文件搬到目标工作区对应的目录；事件内容逐字节不变，原件先备份进回收站，校验失败会自动回滚。",
									)
								: null,
							blockedByWork
								? h(Warning, null, `该会话还有 ${session.activityCount} 项工作在跑，先停止再移动。`)
								: null,
							session?.live
								? h(
										"label",
										{ style: S.checkboxRow },
										h("input", { type: "checkbox", checked: force, onChange: (event) => setForce(event.target.checked) }),
										"该会话正被打开；我已切换到别的会话，强制移动",
									)
								: null,
							error ? h("p", { style: S.error }, error) : null,
						),
			);
		}

		/* ───────────────────────── 删除对话框 ───────────────────────── */

		function DeleteDialog({ request, onClose }) {
			const [state, setState] = react.useState({ phase: "loading" });
			const [includeChildren, setIncludeChildren] = react.useState(true);
			const [force, setForce] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			react.useEffect(() => {
				let cancelled = false;
				callHost("prepare", { sessionId: request.sessionId })
					.then((detail) => {
						if (!cancelled) setState({ phase: "ready", detail });
					})
					.catch((reason) => {
						if (cancelled) return;
						setState({ phase: "ready", detail: null });
						setError(reason instanceof Error ? reason.message : String(reason));
					});
				return () => {
					cancelled = true;
				};
			}, [request.sessionId]);

			if (state.phase === "loading") {
				return h(Dialog, {
					title: "删除会话",
					description: `正在读取「${request.displayTitle}」的存储信息…`,
					onClose,
					closeLabel: "关闭",
					footer: h(Btn, { onClick: onClose }, "取消"),
				});
			}

			const detail = state.detail;
			const session = detail?.session;
			const childCount = detail?.children?.length ?? 0;
			const blockedByWork = Boolean(session && session.activityCount > 0);
			const blockedByLive = Boolean(session?.live && !force);

			const confirm = () => {
				setBusy(true);
				setError(null);
				callHost("delete", { sessionId: request.sessionId, includeChildren, force })
					.then((result) => {
						setBusy(false);
						onClose();
						pushToast({
							text: `已删除 ${result.count} 个会话（移入回收站：${result.trashRoot}）`,
							tone: "success",
							holdMs: 12000,
							actions: [
								{
									label: "撤销",
									onClick: () => {
										dismissToast();
										Promise.all(
											(result.trashed ?? []).map((entry) => callHost("restore", { trashPath: entry.to }).catch(() => null)),
										).then(() =>
											pushToast({ text: "已从回收站恢复", tone: "success" }),
										);
									},
								},
							],
						});
					})
					.catch((reason) => {
						setBusy(false);
						setError(reason instanceof Error ? reason.message : String(reason));
					});
			};

			const footer = [
				h(Btn, { key: "cancel", onClick: () => !busy && onClose() }, "取消"),
				h(
					Btn,
					{ key: "ok", primary: true, disabled: busy || blockedByWork || blockedByLive, onClick: confirm },
					busy ? "删除中…" : "删除",
				),
			];

			return h(
				Dialog,
				{
					title: "删除会话",
					description: `删除「${request.displayTitle}」。DSH 原生不提供删除（只能归档），本插件把会话日志整棵移入回收站，因此可撤销。`,
					onClose: () => !busy && onClose(),
					closeLabel: "关闭",
					footer,
				},
				detail === null
					? h("p", { style: S.error }, error ?? "读取失败")
					: h(
							"div",
							null,
							h("p", { style: S.desc }, `日志：${session?.sizeBytes !== undefined ? `${Math.max(1, Math.round(session.sizeBytes / 1024))} KB` : "未知大小"} · 工作目录 ${session?.cwd ?? "（未记录）"}`),
							h("p", { style: S.desc }, `回收站：${detail.trashRoot}`),
							childCount > 0
								? h(
										"label",
										{ style: S.checkboxRow },
										h("input", {
											type: "checkbox",
											checked: includeChildren,
											onChange: (event) => setIncludeChildren(event.target.checked),
										}),
										`同时删除它的 ${childCount} 个子会话（subagent，侧栏本来就看不到）`,
									)
								: null,
							blockedByWork
								? h(Warning, null, `该会话还有 ${session.activityCount} 项工作在跑，先停止再删除。`)
								: null,
							session?.live
								? h(
										"label",
										{ style: S.checkboxRow },
										h("input", { type: "checkbox", checked: force, onChange: (event) => setForce(event.target.checked) }),
										"该会话正被打开；我已切换到别的会话，强制删除",
									)
								: null,
							error ? h("p", { style: S.error }, error) : null,
						),
			);
		}

		/* ───────────────────────── Overlay 宿主 ───────────────────────── */

		/** shell.overlay 条目：对话框与 Toast 都挂在这里（菜单一关不会带走它们）。 */
		function SessionOpsOverlay() {
			const state = useStore();
			const current = state.request;
			const dialog =
				current === null
					? null
					: current.kind === "move"
						? h(MoveDialog, { key: current.seq, request: current, onClose: settleRequest })
						: h(DeleteDialog, { key: current.seq, request: current, onClose: settleRequest });
			const currentToast = state.toast;
			const toastNode =
				currentToast === null || primitives?.Toast === undefined
					? null
					: h(primitives.Toast, {
							key: `toast-${currentToast.seq}`,
							text: currentToast.text,
							tone: currentToast.tone ?? "success",
							icon: currentToast.icon,
							holdMs: currentToast.holdMs ?? 6000,
							actions: currentToast.actions ?? [],
							onDone: dismissToast,
						});
			return h(react.Fragment, null, dialog, toastNode);
		}

		/* ───────────────────────── 插件入口 ───────────────────────── */

		/**
		 * 注册两个会话行菜单项与 Overlay 宿主。
		 * @param ctx - 客户端上下文（需已挂载 slots 服务）。
		 */
		function apply(ctx) {
			try {
				const face = () => ({});

				ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
					ctx.slots.register(
						{
							name: "sidebar.workspaces.session.menu.item",
							id: "session-ops.openLocation",
							order: 450,
							inject: face,
						},
						OpenLocationMenuItem,
					),
				);

				ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
					ctx.slots.register(
						{
							name: "sidebar.workspaces.session.menu.item",
							id: "session-ops.move",
							order: 500,
							inject: face,
						},
						MoveSessionMenuItem,
					),
				);

				ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
					ctx.slots.register(
						{
							name: "sidebar.workspaces.session.menu.item",
							id: "session-ops.delete",
							order: 600,
							inject: face,
						},
						DeleteSessionMenuItem,
					),
				);

				ctx.slots.inject("shell.overlay", () =>
					ctx.slots.register(
						{
							name: "shell.overlay",
							id: "session-ops.dialogs",
							inject: face,
						},
						SessionOpsOverlay,
					),
				);

				console.log("[session-ops] client apply() completed");
			} catch (error) {
				console.error("[session-ops] client apply() failed:", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
