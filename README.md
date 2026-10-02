# DSH 本地插件集（JinYihang1011）

一组为 **DeepSeek Harness（DSH）** 写的插件，**每个插件一个子目录**，都只依赖 DSH 自己的
公开能力（cordis 插件 + 客户端插槽），不修改任何上游文件。

| 子目录 | 插件 | 一句话 |
| --- | --- | --- |
| [`dsh-tiger-talisman/`](./dsh-tiger-talisman) | **虎符咒** | 给共存的插件与 Skill 划领地：插槽（列表/独占/键控）、层级、样式、重复挂载，**只读体检** |
| [`dsh-ui-tweaks/`](./dsh-ui-tweaks) | 界面微调 | 用一张外挂样式表把第三方插件的侧栏入口/行距拉回与宿主一致（不碰上游） |
| [`dsh-win-notify/`](./dsh-win-notify) | Windows 通知 | 审批请求与用户问询出现时发系统通知 |
| [`dsh-session-ops/`](./dsh-session-ops) | 会话操作 | 会话行菜单补上「打开工作区位置 / 移动到工作区 / 删除会话（可撤销）」 |
| [`dsh-refresh-button/`](./dsh-refresh-button) | 界面菜单 | 输入卡片下的「界面」菜单：刷新界面 / 重启 DSH / 关闭 DSH |
| [`dsh-approval-rules/`](./dsh-approval-rules) | 审批规则 | 按命令的审批规则表：命中的提权/工具调用自动通过或直接拒绝 |

## 安装

每个插件都可以用 `link:` 从本机装：

```powershell
dsh plugin --profile desktop add "link:<本目录>/<插件目录>"
```

或直接引用本仓库（monorepo 子目录）：

```powershell
dsh plugin --profile desktop add "github:JinYihang1011/dsh-plugins#path:/dsh-tiger-talisman"
```

装完**完全重启一次 DSH**（profile composition 要重新组装）。

## 约定

- **不碰上游**：优先用外挂样式表 / 事件转发，而不是改别人的 `lib/client.js`；上游升级时最坏情况
  只是某条规则不再命中，而不是报错。
- **每个插件自带自测**：`node test/*.mjs`，不需要浏览器、不需要网络。
- **HTML/CSS 里带 `!important` 的规则按特异度决胜**：同表内互相压制是静默的，改之前先算特异度。

## 许可

MIT（见 [LICENSE](./LICENSE)）。
