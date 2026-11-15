# 阶段 0 · BA 设计 执行计划

> **执行方式：** 这一期不写产品代码。由 Claude 通过 claude-in-chrome 操作 Excalidraw 和 Google Stitch，作者审批。用 `- [ ]` 跟踪进度。

**目标：** 产出整个 Web 应用的需求分析、UML、数据模型和 UI 设计，作者审批通过后进入阶段 1。

**设计文档：** `docs/superpowers/specs/2026-11-06-slack-off-design.md`（下称"设计文档"）

## 全局约束

- 所有图以设计文档为准；画图时发现设计文档有缺口或矛盾，先记进 `docs/ba/open-questions.md`，**不要在图里自行发挥**。
- 产物存放在 `docs/ba/`：每块画板导出 `.excalidraw` 源文件和 `.png` 图片，Stitch 页面存 `.png`，链接汇总到 `docs/ba/README.md`。
- **以下操作执行前必须先征得作者同意**：从 Excalidraw / Stitch 下载文件、生成分享链接、同意第三方服务条款。
- Excalidraw 用 excalidraw.com（无需登录）；内容存在浏览器本地，每块画板完成后**立即导出**，防止丢失。
- 只用作者自己的浏览器会话；遇到登录或权限弹窗时，停下来请作者处理。

## 审阅重点

- 状态机中的 `blocked`、`abandoned`、验收失败回流、需求变更后的分叉，必须都在图上画出来，不能只画正常路径。
- 时序图要标出每一个**对外写操作**（JIRA 改状态、发评论、push、开 PR）前面的开发者确认点。
- ER 图里的 `audit_event` 哈希链字段，以及 `requirement` 的版本关系，必须画出来。
- 页面设计要覆盖空状态、加载中、出错、等待拍板这几种状态，不能只画"有数据"的样子。

---

### 任务 1：准备工作区

- [ ] 新建 `docs/ba/README.md`（产物索引）和 `docs/ba/open-questions.md`。
- [ ] 打开 excalidraw.com，确认能正常绘制，并能导出 `.excalidraw` 和 `.png`。
- [ ] 提交：`docs(ba): scaffold BA workspace`

### 任务 2：画板 1 — 用户画像与端到端流程

- [ ] 画用户画像：软件开发工程师。目标：把票从 Ready for Dev 推进到 Ready for Human Review。他们在意的是：不用盯着 agent，只在关键节点拍板。
- [ ] 画泳道流程图，泳道依次为：开发者 / 平台 / 各个 agent / JIRA / Git·GitHub。覆盖设计文档 §5.3 的每一步，并标出拍板点 0～3。
- [ ] 导出到 `docs/ba/01-user-flow.{excalidraw,png}`，交作者审阅。
- [ ] 按作者反馈修改后提交。

### 任务 3：画板 2 — 票状态机

- [ ] 依据设计文档 §5.1 画 UML 状态图，状态名与文档完全一致：`discovered, refining, refined, awaiting_ac_review, proposing, awaiting_choice, designing, design_final, developing, dev_done, reviewing, awaiting_confirmation, pr_opened, blocked, abandoned`。
- [ ] 每条转换线都标出触发方：开发者 / agent / 系统。
- [ ] 进入 `developing` 和 `pr_opened` 时，标注要同步的 JIRA 状态。
- [ ] 导出 `docs/ba/02-state-machine.*`，审阅、修改、提交。

### 任务 4：画板 3 — 时序图

至少画三张：

- [ ] (a) 拉票 + 整理需求：开发者 → 平台 → 执行器 → `claude` CLI → claude-in-chrome → JIRA。
- [ ] (b) 设计辩论循环：设计 agent ↔ 挑刺 agent，包括轮数上限和分歧裁决。
- [ ] (c) 验收 → 确认 → push → 开 PR → 回写 JIRA，包括失败回流。
- [ ] 导出 `docs/ba/03-sequence-*.*`，审阅、修改、提交。

### 任务 5：画板 4 — 系统组件图

- [ ] 依据设计文档 §7：UI、Server、编排、队列、审计、`node:sqlite`、Executor（两个实现）、TicketSource（两个实现）、Worktree 管理、通知。
- [ ] 标出信任边界：本机 `127.0.0.1`、开发者的 Chrome、Anthropic、JIRA Cloud、GitHub。
- [ ] 导出 `docs/ba/04-components.*`，审阅、修改、提交。

### 任务 6：画板 5 — ER 图

- [ ] 依据设计文档 §8，画出全部实体、主要字段和外键：`ticket, requirement, solution, choice, design_doc, debate_round, dev_iteration, review_report, screenshot, agent_run, audit_event, preference`，再加上 §9.6 的 `prompt_version`。
- [ ] `requirement` 带 `version` 字段；`choice` 和 `design_doc` 引用某个具体的 `requirement_id`（版本锁定）。
- [ ] `audit_event` 带 `prev_hash` 和 `hash` 字段。
- [ ] 导出 `docs/ba/05-er.*`，审阅、修改、提交。

### 任务 7：功能说明书（写给 Stitch 用）

- [ ] 写 `docs/ba/functional-spec.md`。每个页面一节，每节写清楚：页面目的、展示的数据、可执行的操作，以及空状态 / 加载中 / 出错 / 等待拍板这几种状态的样子。
- [ ] 页面清单：票列表 / 看板、票详情（需求和 AC，可编辑）、方案对比与选择、设计和辩论记录（按质量清单项展示覆盖情况）、开发进度、验收报告（含截图）、成本面板、设置（执行器、JIRA 接入、仓库映射、每个 agent 的提示词）。
- [ ] 作者审阅后提交。

### 任务 8：用 Stitch 出 UI 设计

- [ ] 在作者的浏览器中打开 Google Stitch，逐页粘贴功能说明书的对应小节，生成设计。
- [ ] 每页生成后先给作者看；作者满意后，经同意再导出 `.png` 到 `docs/ba/ui/<page>.png`。
- [ ] 提交。

### 任务 9：设计稿贴回 Excalidraw

- [ ] 新建画板 6"UI 参考"，导入所有页面截图，用连线标出页面之间的跳转，并标注每页对应的状态机状态。
- [ ] 导出 `docs/ba/06-ui-reference.*`，提交。

### 任务 10：审批关口

- [ ] 更新 `docs/ba/README.md`，列出全部产物。
- [ ] 把 `open-questions.md` 里的未决问题逐条交给作者裁决；需要修改设计文档的，直接修改并提交。
- [ ] 作者明确批准阶段 0 后，在 `docs/ba/README.md` 写上"已批准 + 日期"并提交。
- [ ] 如果 ER 图或页面设计和阶段 1 计划有出入，先更新阶段 1 计划，再开始开发。
