/**
 * dsh-refresh-button —— 客户端半边（浏览器侧）。
 *
 * 一个入口按钮（图标 + 「界面」+ ▾）打开下拉菜单，三项：
 *   · 刷新界面 → window.location.reload()
 *   · 重启 DSH → POST /dsh-refresh-button/action {action:'restart'}（宿主重启整个 DSH）
 *   · 关闭 DSH → POST /dsh-refresh-button/action {action:'quit'}（宿主结束进程，不重启）
 *
 * 按用户要求：**三项都不做二次确认**，点击即执行；菜单本身就是那一步确认。
 *
 * 位置：**模型选择左边**。注册在 `conversation.input.right`
 * （`@deepseek-ai/dsh-client-ui-conversation` 在 `conversation.composer.bar`
 * 下声明的一个 `list` / `session` 槽位），宿主在输入卡片那一行的
 * `standardControls` 里按顺序渲染：
 *
 *     <div class="standardControls">
 *       renderSlot("conversation.input.right")   ← 本插件在这里
 *       renderSlot("conversation.input.model")   ← 模型选择
 *     </div>
 *
 * 也就是说它就是字面意义上的"模型选择左边"，与权限选择器、模型选择同高
 * （28px）。随着 `standardControls` 一起在活动面板展开时隐藏，行为一致。
 *
 * 两个刻意的实现选择：
 *   1. 绝对不用 window.confirm / window.alert —— 原生模态框在 Electron 下会抢走焦点，
 *      取消后不归还页面，表现为「输入框点不进去、打不了字」。失败信息改为菜单内联展示。
 *   2. 下拉面板用普通绝对定位（`bottom: 100%` + `right: 0`，向上弹出），不用 Portal：
 *      输入卡片的祖先链上没有任何 `overflow: hidden`（`.card` 只有 `position: relative`），
 *      面板不会被裁掉；向上弹出也和宿主自己的权限/模型菜单同向。
 */
window.__ModuleLoader__.load({
  id: "dsh-refresh-button",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const react = require("react")
    const h = react.createElement
    const { useCallback, useEffect, useRef, useState } = react

    const name = "dsh-refresh-button"
    // 运行时注入的 Cordis 服务名；槽位本身由 @deepseek-ai/dsh-client-ui-conversation 提供
    const inject = ["slots"]

    /** 宿主在 `conversation.composer.bar` 里声明的槽位：模型选择左边那一格。 */
    const SLOT = "conversation.input.right"

    const ACTION_ROUTE = "/dsh-refresh-button/action"

    const C = {
      label: "var(--dsw-alias-label-secondary, #8a8f98)",
      labelStrong: "var(--dsw-alias-label-primary, #e6e6e6)",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14))",
      border: "var(--dsw-alias-border-l2, rgba(128,128,128,0.28))",
      panel: "var(--dsw-alias-bg-layer-2, #26262b)",
      error: "var(--dsw-alias-state-error-primary, #e5484d)"
    }

    const WRAP = {
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
      flex: "none"
    }

    // 与同一行上的权限选择器（28px / 13px / label-secondary / radius-sm）对齐
    const TRIGGER = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      height: "28px",
      padding: "0 8px",
      fontSize: "13px",
      fontWeight: 500,
      lineHeight: "20px",
      whiteSpace: "nowrap",
      cursor: "pointer",
      color: C.label,
      background: "transparent",
      border: "none",
      borderRadius: "var(--dsw-radius-sm, 6px)",
      transition: "background 120ms, color 120ms, opacity 120ms"
    }

    const PANEL = {
      position: "absolute",
      bottom: "calc(100% + 6px)",
      right: "0",
      minWidth: "136px",
      padding: "4px",
      display: "flex",
      flexDirection: "column",
      gap: "2px",
      background: C.panel,
      border: "1px solid " + C.border,
      borderRadius: "8px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.28)",
      zIndex: 60
    }

    const ITEM = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      width: "100%",
      padding: "6px 10px",
      fontSize: "12px",
      lineHeight: 1.2,
      textAlign: "left",
      whiteSpace: "nowrap",
      cursor: "pointer",
      color: C.label,
      background: "transparent",
      border: "none",
      borderRadius: "6px"
    }

    const ERROR = {
      padding: "4px 10px 6px",
      fontSize: "11px",
      lineHeight: 1.35,
      color: C.error,
      maxWidth: "220px",
      whiteSpace: "normal"
    }

    function Glyph({ paths, size }) {
      return h(
        "svg",
        {
          width: size || 14,
          height: size || 14,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          focusable: false,
          style: { display: "block", flex: "none" }
        },
        paths.map((d, i) => h("path", { key: i, d }))
      )
    }

    const ICON_REFRESH = ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"]
    const ICON_RESTART = ["M18.36 6.64a9 9 0 1 1-12.73 0", "M12 2v10"]
    const ICON_QUIT = ["M18 6 6 18", "m6 6 12 12"]

    function hoverIn(event, strong) {
      event.currentTarget.style.background = C.hover
      event.currentTarget.style.color = strong ? C.labelStrong : C.labelStrong
    }
    function hoverOut(event) {
      event.currentTarget.style.background = "transparent"
      event.currentTarget.style.color = C.label
    }

    function DockMenu() {
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState("")
      const [error, setError] = useState("")
      const rootRef = useRef(null)

      // 点外面 / 按 Esc 关闭
      useEffect(() => {
        if (!open) return
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) {
            setOpen(false)
            setError("")
          }
        }
        const onKey = (event) => {
          if (event.key === "Escape") {
            setOpen(false)
            setError("")
          }
        }
        document.addEventListener("mousedown", onDown, true)
        document.addEventListener("keydown", onKey, true)
        return () => {
          document.removeEventListener("mousedown", onDown, true)
          document.removeEventListener("keydown", onKey, true)
        }
      }, [open])

      const onRefresh = useCallback(() => {
        setOpen(false)
        try {
          window.location.reload()
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }, [])

      const act = useCallback(async (action) => {
        setBusy(action)
        setError("")
        try {
          const response = await fetch(ACTION_ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action })
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || !data || data.ok !== true) {
            throw new Error((data && data.error) || "HTTP " + response.status)
          }
          // 宿主会在约 0.9 秒后结束进程；保持「进行中」状态即可
        } catch (err) {
          setBusy("")
          setError((err && err.message) || String(err))
        }
      }, [])

      const items = [
        { key: "refresh", label: "刷新界面", icon: ICON_REFRESH, onClick: onRefresh },
        { key: "restart", label: busy === "restart" ? "正在重启…" : "重启 DSH", icon: ICON_RESTART, onClick: () => act("restart") },
        { key: "quit", label: busy === "quit" ? "正在关闭…" : "关闭 DSH", icon: ICON_QUIT, onClick: () => act("quit") }
      ]

      return h(
        "span",
        { ref: rootRef, style: WRAP },
        h(
          "button",
          {
            type: "button",
            style: Object.assign({}, TRIGGER, open ? { background: C.hover, color: C.labelStrong } : {}),
            title: "界面操作：刷新 / 重启 / 关闭",
            "aria-label": "界面操作",
            "aria-expanded": open,
            onClick: () => {
              setOpen((v) => !v)
              setError("")
            },
            onMouseEnter: (event) => hoverIn(event, false),
            onMouseLeave: (event) => {
              if (!open) hoverOut(event)
            }
          },
          // 入口图标用「重启」那个矢量图标（不依赖字体，任何环境下都能渲染）
          h(Glyph, { paths: ICON_RESTART, size: 14 }),
          h("span", null, "界面"),
          h("span", { style: { fontSize: "9px", opacity: 0.8 } }, "▾")
        ),
        open
          ? h(
              "div",
              { style: PANEL, role: "menu" },
              items.map((item) =>
                h(
                  "button",
                  {
                    key: item.key,
                    type: "button",
                    role: "menuitem",
                    style: Object.assign({}, ITEM, busy && busy !== item.key ? { opacity: 0.5 } : {}),
                    disabled: item.key !== "refresh" && busy !== "",
                    onClick: item.onClick,
                    onMouseEnter: (event) => hoverIn(event, true),
                    onMouseLeave: hoverOut
                  },
                  h(Glyph, { paths: item.icon }),
                  h("span", null, item.label)
                )
              ),
              error ? h("div", { style: ERROR }, error) : null
            )
          : null
      )
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: name,
                order: 0
              },
              DockMenu
            )
          ),
        "dsh-refresh-button: composer model-seat left"
      )
      console.info("[dsh-refresh-button] v1.0.4 → 注册在 " + SLOT + "（模型选择左边）")
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
