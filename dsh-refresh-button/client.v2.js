/**
 * dsh-refresh-button —— 客户端半边（浏览器侧）。
 *
 * 为什么需要它：Windows 生产版 DSH 没有任何内置的「重新加载页面 / 重启」入口
 * （桌面端应用菜单在 Windows 上只有两个隐藏的 DevTools 项，`role: 'reload'`
 *  只出现在 development = !app.isPackaged 的分支里），Ctrl+R / F5 也没绑定。
 *
 * 两个按钮都注册在 `conversation.composer.dock`（输入卡片下方的环境条目行），
 * 合成一个条目，保证它们始终相邻：
 *   · ⟳ 刷新 —— window.location.reload()，只重载页面
 *   · ⏻ 重启 —— 二次确认后 POST 宿主路由，由宿主重启整个 DSH
 *
 * 形态对齐宿主自带模板（asar 内 templates/decoration/）：纯 ModuleLoader bundle，
 * 无构建步骤；React 来自浏览器模块表。样式对齐同行内建条目：无边框、currentColor
 * 图标、仅悬停给一层淡背景。
 */
window.__ModuleLoader__.load({
  id: "dsh-refresh-button",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const react = require("react")
    const h = react.createElement
    const { useState, useCallback } = react

    const name = "dsh-refresh-button"
    // 运行时注入的 Cordis 服务名；槽位本身由 @deepseek-ai/dsh-client-ui-conversation 提供
    const inject = ["slots"]

    const RESTART_ROUTE = "/dsh-refresh-button/restart"

    // 与内建图标按钮同口径：无边框、透明底、次级文字色
    const BTN = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "24px",
      height: "24px",
      minWidth: "24px",
      maxWidth: "24px",
      padding: "0",
      margin: "0",
      flex: "none",
      overflow: "hidden",
      lineHeight: 0,
      cursor: "pointer",
      color: "var(--dsw-alias-label-secondary, #8a8f98)",
      background: "transparent",
      border: "none",
      borderRadius: "6px",
      transition: "background 120ms, color 120ms, opacity 120ms"
    }

    const ROW = {
      display: "inline-flex",
      alignItems: "center",
      gap: "2px",
      marginLeft: "6px",
      flex: "none"
    }

    const busyStyle = (busy) => (busy ? Object.assign({}, BTN, { opacity: "0.45", cursor: "default" }) : BTN)

    function useHover(busy) {
      return {
        onMouseEnter: (event) => {
          if (busy) return
          event.currentTarget.style.background = "var(--dsw-alias-fill-hover, rgba(128,128,128,0.14))"
          event.currentTarget.style.color = "var(--dsw-alias-label-primary, #e6e6e6)"
        },
        onMouseLeave: (event) => {
          event.currentTarget.style.background = "transparent"
          event.currentTarget.style.color = "var(--dsw-alias-label-secondary, #8a8f98)"
        }
      }
    }

    /** 与内建图标同一族风格：15px、currentColor、线宽 2。 */
    function Glyph({ paths }) {
      return h(
        "svg",
        {
          width: 15,
          height: 15,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          focusable: false,
          style: { display: "block" }
        },
        paths.map((d, i) => h("path", { key: i, d }))
      )
    }

    const REFRESH_PATHS = ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"]
    const RESTART_PATHS = ["M18.36 6.64a9 9 0 1 1-12.73 0", "M12 2v10"]

    function RefreshButton() {
      const [busy, setBusy] = useState(false)
      const onRefresh = useCallback(() => {
        setBusy(true)
        setTimeout(() => {
          try {
            window.location.reload()
          } catch (err) {
            setBusy(false)
          }
        }, 40)
      }, [])
      return h(
        "button",
        Object.assign(
          {
            type: "button",
            style: busyStyle(busy),
            disabled: busy,
            title: "刷新界面（重载页面，等价于 F12 → location.reload()）",
            "aria-label": "刷新界面",
            onClick: onRefresh
          },
          useHover(busy)
        ),
        h(Glyph, { paths: REFRESH_PATHS })
      )
    }

    function RestartButton() {
      const [busy, setBusy] = useState(false)
      const onRestart = useCallback(async () => {
        const ok = window.confirm(
          "确定要重启 DSH 吗？\n\n" +
            "· 当前窗口会关闭（含正在进行的对话）\n" +
            "· 会话记录不会丢失，重启后重新打开即可\n" +
            "· 整个重启约需 5~10 秒"
        )
        if (!ok) return
        setBusy(true)
        try {
          const response = await fetch(RESTART_ROUTE, { method: "POST" })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || !data || data.ok !== true) {
            throw new Error((data && data.error) || "HTTP " + response.status)
          }
          // 宿主会在约 0.9 秒后开始结束进程；保持「重启中」外观即可
        } catch (err) {
          setBusy(false)
          window.alert("重启请求失败：" + (err && err.message ? err.message : String(err)))
        }
      }, [])
      return h(
        "button",
        Object.assign(
          {
            type: "button",
            style: busyStyle(busy),
            disabled: busy,
            title: "重启 DSH（会先弹窗二次确认）",
            "aria-label": "重启 DSH",
            onClick: onRestart
          },
          useHover(busy)
        ),
        h(Glyph, { paths: RESTART_PATHS })
      )
    }

    function RefreshDock() {
      return h("span", { style: ROW }, h(RefreshButton), h(RestartButton))
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.composer.dock", () =>
            ctx.slots.register(
              {
                name: "conversation.composer.dock",
                id: name,
                // 内建 stats 为 order 0、dsh-cost-meter 的角标为 9；取大值排到最右端
                order: 1000
              },
              RefreshDock
            )
          ),
        "dsh-refresh-button: composer dock entries"
      )
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
