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
 * 两个刻意的实现选择：
 *   1. 绝对不用 window.confirm / window.alert —— 原生模态框在 Electron 下会抢走焦点，
 *      取消后不归还页面，表现为「输入框点不进去、打不了字」。失败信息改为菜单内联展示。
 *   2. 位置不依赖插槽的 `order`（实测改它无效），改用 `margin-left:auto` 把条目顶到
 *      该行最右端 —— 这是 flex 行的确定性行为。
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

    const ACTION_ROUTE = "/dsh-refresh-button/action"

    const C = {
      label: "var(--dsw-alias-label-secondary, #8a8f98)",
      labelStrong: "var(--dsw-alias-label-primary, #e6e6e6)",
      hover: "var(--dsw-alias-fill-hover, rgba(128,128,128,0.14))",
      border: "var(--dsw-alias-border-l2, rgba(128,128,128,0.28))",
      panel: "var(--dsw-alias-bg-layer-2, #26262b)",
      error: "var(--dsw-alias-state-error-primary, #e5484d)"
    }

    const WRAP = {
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
      // 不依赖插槽 order：用 auto 外边距把条目顶到该行最右端
      marginLeft: "auto",
      flex: "none"
    }

    const TRIGGER = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      height: "24px",
      padding: "0 8px",
      fontSize: "12px",
      lineHeight: 1,
      whiteSpace: "nowrap",
      cursor: "pointer",
      color: C.label,
      background: "transparent",
      border: "none",
      borderRadius: "6px",
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
          // 入口图标用 ⏻（与菜单里「重启 DSH」同一个矢量图标，保证任何字体下都能渲染）
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
          ctx.slots.inject("conversation.composer.dock", () =>
            ctx.slots.register(
              {
                name: "conversation.composer.dock",
                id: name,
                order: 1000
              },
              DockMenu
            )
          ),
        "dsh-refresh-button: composer dock menu"
      )
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
