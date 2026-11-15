# BA 产物索引（阶段 0）

状态：✅ 已批准（2026-11-06）

| # | 画板 | 源文件 | 导出 |
|---|---|---|---|
| 1 | 用户画像与端到端流程 ✅ 已审 | `01-user-flow.mmd` | `01-user-flow.excalidraw.png` |
| 2 | 票状态机 ✅ 已审（含 Q1/Q2 裁决） | `02-state-machine.mmd` | `02-state-machine.excalidraw.png` |
| 3 | 时序图 ✅ 已审：(a) 拉票+整理需求 (b) 选方案+设计辩论 (c) 开发+验收+交付 | `03-sequence-{a-refine,b-debate,c-deliver}.mmd` | `03-sequence-*.excalidraw.png` |
| 4 | 系统组件图 ✅ 已审 | `04-components.mmd` | `04-components.excalidraw.png` |
| 5 | ER 图 ✅ 已审（含快照 / AC 出处 / 偏移检查） | `05-er.mmd` | `05-er.excalidraw.png` |
| 6 | UI 参考 ✅ 已审：11 个 Stitch 页面 + 页面跳转 / 状态对应 | `06-ui-nav.mmd` | `06-ui-reference.jpg`（单页高清图见 `design/screens/`） |
| 6b | UI 参考（移动端）：m01–m10（m09/m10 为阶段 3，待作者审阅） | — | 画布 Frame「BA-06b」（图片来自 `design/screens/mobile/`） |

功能说明书：`functional-spec.md` ✅ · UI 设计稿：`../../design/`（Stitch，11 页）　·　待决问题：`open-questions.md`

导出格式：`*.excalidraw.png` 是带嵌入场景的 PNG，直接拖进 Excalidraw 就能继续编辑，所以不再单独导出 `.excalidraw`（`.excalidraw` 文件会包含作者整张本地画布）。从画板 2 起改用"复制到剪贴板"导出，避免系统保存对话框，PNG 不再带嵌入场景；可编辑源以 `.mmd` 和画布上的 Frame 为准。

制作方式：每张图先写 Mermaid 源文件（便于 diff 和审阅），再在 excalidraw.com 中用"Mermaid to Excalidraw"导入、调整布局，最后导出。
