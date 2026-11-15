# 阶段 4c · 成本与额度面板 + 可选的 OpenTelemetry 导出 执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** spec §9.1：新的"Cost & quota"页按票、按角色、按天显示每次 agent 运行的消耗——API 模式显示 token 与费用，订阅模式显示运行次数、时长与 CLI 报告的用量；可以设阈值，快到上限时自动暂停新的 agent 运行并通知，也可以手动暂停 / 恢复。spec §9.8：可选的 OpenTelemetry 运行追踪导出，**默认关闭**；配置了导出地址后，每次导出由开发者确认（显示目标、条数、包含哪些字段），README 警告导出会把票内容发送给该服务。

**架构：** 数据早已在 `agent_run` 中（`role`、`ticket_key`、`executor`、`started_at`、`ended_at`、`status`、`usage_json`、`cost_usd`），面板只是聚合（`cost/usage-repo.ts`）。额度闸门放在 `runAgent` 入口（`cost/budget-gate.ts`）：暂停中、或本窗口已达阈值时，新的非写角色运行抛 `UsagePausedError`，现有的 job 错误处理把票置为 `blocked` 并写明原因与恢复方法——复用已有的 `blocked` + "Retry"，不新增状态。暂停记录存表（迁移 m14）。追踪导出不引入 OpenTelemetry SDK：从 `agent_run` 与原始日志构造 OTLP/HTTP JSON（`resourceSpans`）并 `POST /v1/traces`；导出批次存表（迁移 m16）以免重复导出。

**技术栈：** 同阶段 1–3。新增依赖：无（图表用 CSS 条形，不引入图表库；OTLP 手写，裁决 C-5）。

**设计依据（Spec）：**
- 设计文档 §9.1、§9.8、§8（`agent_run` 的"消耗（token 或额度估算）"）、§11 风险 3（订阅额度）、§2 反目标"无声失败：额度耗尽时不通知开发者"、§7.3（显著提示）。
- 功能说明 `docs/ba/functional-spec.md` §1（全局横幅"额度即将用尽，新任务已暂停"、左侧导航"成本与额度"）、§12（成本与额度页）、§13 第 6 项（运行追踪）。
- UI：`design/screens/10-cost-quota.png`、`design/code/10-cost-quota.html`（桌面）；移动端按阶段 3 的方法由本计划任务 3 产出简单的 390px 版式（不另做 Stitch 设计，裁决 C-6）。
- 代码：`executor/run-agent.ts`（`runChecked` 写 `agent_run`）、`db/migrations.ts`（当前 12 个）、`workflow/jobs.ts`（job 错误 → `blocked`）、`http/app.ts`（`/api/status`）、`packages/web/src/components/AppShell.tsx`（已有禁用的 "Cost & quota" 导航项）、4b 的 `credentials/credential-store.ts`（`otlpHeaders`）。

## 裁决（每条附"错了的代价"）

- **裁决 C-1（订阅模式的"费用"）：** CLI 的 `result.total_cost_usd` 在订阅模式下是按 API 价格的估算，并非实际扣费。面板对订阅运行显示为 "API-equivalent estimate"，不叫 "cost"；阈值在订阅模式下按**运行次数**与**运行分钟数**设，在 API 模式下按**美元**设。代价：订阅额度的真实剩余量拿不到（CLI 不提供），阈值只是开发者自己的估计。
- **裁决 C-2（窗口）：** 阈值窗口 `budget.window: '5h' | 'day' | 'week'`（默认 `'5h'`，与订阅额度的常见滚动窗口一致），按 `agent_run.started_at` 滚动计算。代价：与 Anthropic 实际重置时刻不对齐，开发者可能早停或晚停。
- **裁决 C-3（暂停的效果）：** 暂停只拦**新的**非写角色运行（`jira-update`、`jira-comment` 是开发者逐次确认过的写，不拦）；正在运行的照常结束；被拦的 job 让票进入 `blocked`（原因 "Paused: <理由> — resume in Cost & quota, then Retry"），恢复后由开发者点 Retry，不自动重跑。代价：暂停期间被拦的每张票都要手动 Retry 一次。
- **裁决 C-4（自动识别额度耗尽）：** CLI 结果为错误且文本匹配 `USAGE_LIMIT_RE = /usage limit|rate limit|quota/i` 时，执行器抛 `UsageLimitError`，`runAgent` 记录后写一条自动暂停（理由 `limit_reached`），票 `blocked`。匹配是尽力而为（CLI 的措辞不保证稳定），出口核对第 2 项由作者确认。代价：措辞变了就退回为普通错误（`blocked` 但不自动暂停其他票）。
- **裁决 C-5（手写 OTLP/HTTP JSON）：** 只导出 traces，每次 agent 运行一个 span（`slackoff.agent_run`），工具调用作为 span events；不引入 `@opentelemetry/*`（依赖多、只用其中一小部分）。代价：不支持 gRPC / protobuf 端点（Langfuse 与 LangSmith 都接受 OTLP/HTTP JSON；不接受的后端需要一个 collector）。
- **裁决 C-6（不做新的 Stitch 设计）：** 桌面按 `design/screens/10-cost-quota.png`，手机为单列卡片。代价：手机版式可能需要作者事后微调。
- **裁决 C-7（逐次确认导出）：** 同索引裁决 X-7：没有后台自动导出；"Export N runs to <host>" 是一次确认，可在手机上确认（同交付确认，审计记录 `decidedBy`），只导出确认时预览中列出的运行（按运行 id 集合的哈希绑定，变了 → 409）。代价：持续追踪需要反复点（索引作者问题 5）。
- **裁决 C-8（导出内容）：** 默认属性只含元数据：`slackoff.role`、`slackoff.ticket_key`、`slackoff.executor`、`slackoff.status`、`slackoff.skill_version`、`slackoff.prompt_version_id`、时长、token 数、费用、工具名与次数、错误类别（不含错误文本）。`telemetry.includeContent`（默认 false，仅限本机）再加入提示词与输出文本（截断到 32 KB / 条）。即使只含元数据，票号也是票内容的一部分——README 警告照写。代价：只看元数据的追踪不能用于质量评审。

## 全局约束

- 阶段 1–3 的全局约束全部继续有效。
- **Node 26**（裁决 N-1）。
- **移动优先**：Cost & quota 页与设置页新分区在 390px 宽无横向滚动，可点目标 ≥44px，暂停 / 恢复 / 导出用吸底栏 + "This will: …"。
- **公开内容**：不出现公司主机名、真实人名或邮箱；示例一律 `https://your-company.atlassian.net`、`example-org`；OTLP 示例地址用 `https://otel.example.com/v1/traces` 与 `http://127.0.0.1:4318/v1/traces`。
- **对外写入逐次经开发者确认**：OTLP 导出是对外写入，每次导出一次确认（裁决 C-7）；默认关闭；未配置地址时导出按钮不出现。
- **测试与探测不碰宿主状态**：不读写剪贴板、LaunchServices、钥匙串、rc 文件、`~/.gitconfig`、`~/.claude`、`~/.nvm`；测试不联网——OTLP 用测试进程在 `127.0.0.1` 随机端口起的接收器，或注入的 `fetch`。
- **提交信息**以下面两行结尾：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Q3ZdR36s9c6TU4rsfHiJ3Z
  ```
- **迁移**（裁决 4C-0 / 4C-1）：4b 已用 m13，所以本阶段为 m14（`usage_pause`）、m15（`agent_run(started_at)` 索引与 `usage_pause` 触发器加固）、m16（`telemetry_export`）；任务 4–5 用 m16；测试断言 `migrations.length >= 16`（裁决 X-5）。
- **新配置键**：`budget = {enabled: false, window: '5h', maxRuns: number | null, maxRunMinutes: number | null, maxUsd: number | null, warnAt: 0.8}`（手机可改：放宽或收紧阈值都只影响开发者自己的消耗）；`telemetry = {endpoint: '', includeContent: false}`（仅限本机，加入 `sensitive()`）。OTLP 鉴权头存在 4b 的 `credentials.json`（`otlpHeaders`），不在配置中。
- **新审计事件**：`usage_paused`（`{reason: 'manual'|'threshold'|'limit_reached', detail}`）、`usage_resumed`、`telemetry_exported`（`{exportId, endpointHost, runCount, includeContent}`）。
- **新 SSE 事件**：`usage_changed`（暂停状态或阈值进度变化时，页面与横幅刷新）。

## 审阅重点

1. **暂停后票停在 blocked 却不知道为什么**：被闸门拦下的票必须写明原因、在票列表 "Needs me" 中出现、全局横幅 "Usage paused — N tickets waiting" 链接到 Cost & quota；恢复后横幅消失但票仍需 Retry（裁决 C-3）——Retry 按钮旁说明 "Resumed: retry to continue"。重启后暂停仍有效（存表）。（任务 2、3）
2. **阈值计算的边界**：窗口边界上开始的运行、仍在运行（`ended_at` 为 null）的运行（分钟数按当前时间计）、`cost_usd` 为 null（订阅旧数据、失败的运行）、`usage_json` 无法解析、执行器在窗口中途切换（订阅与 API 的阈值各算各的，只用当前执行器的阈值）、`warnAt` 到达但未到上限（只提醒不暂停）、阈值改小后立即越线（下一次运行前暂停，已在运行的不打断）。（任务 1、2）
3. **写角色与闸门**：开发者已确认的 JIRA 状态 / 评论写在暂停期间照常执行；交付中的 push / PR 不经过 agent，不受影响；验收与开发的 agent 运行被拦。（任务 2）
4. **导出把不该发的东西发出去**：`includeContent` 关时 span 中不得出现提示词、输出、错误文本、仓库路径、JIRA 地址；导出地址必须是 `https://`，或 `http://` 且主机为 `127.0.0.1` / `localhost` / `::1`（自建 Langfuse），且不得是 Slack Off 自己的端口；鉴权头只来自凭证文件、不出现在审计与响应中；同一运行不重复导出；导出失败不重试、记录 `failed` 与 HTTP 状态。（任务 4、5）
5. **聚合查询在大数据量下变慢**：上千条 `agent_run`、每条 `usage_json` 数 KB → 聚合只用 SQL 与 `json_extract`，按窗口与票分页，`/api/usage` 在 10,000 条运行时 <200 ms（测试用合成数据量测）。（任务 1）

---

## 文件结构

```
packages/shared/src/usage.ts (新：UsageSummary 等跨包类型)
packages/server/src/
  cost/usage-repo.ts, cost/budget-gate.ts (新), telemetry/otlp.ts, telemetry/export-repo.ts (新)
  db/migrations.ts (改：m14、m15、m16), config.ts (改), executor/run-agent.ts (改：闸门、UsageLimitError), executor/claude-code.ts / claude-api.ts (改：识别额度耗尽)
  workflow/jobs.ts (改：UsagePausedError → blocked 原因), http/app.ts (改：/api/usage*、/api/telemetry/*、status.usage), main.ts
packages/server/test/  usage.test.ts, budget-gate.test.ts, otlp.test.ts (新), database.test.ts / http.test.ts / executor.test.ts (改)
packages/web/src/  pages/CostPage.tsx (新), components/UsageBanner.tsx (新), components/AppShell.tsx (改：启用导航), lib/usage-model.ts (+ test, 新), pages/SettingsPage.tsx (改：Budget 与 Run tracing 分区), lib/api.ts, i18n/en.ts, main.tsx (路由 /cost)
e2e/phase4c.spec.ts (新), playwright.config.ts, package.json, README.md, docs/spikes/phase4c-exit.md (新)
```

---

### 任务 1：用量聚合 — `usage-repo` 与 `GET /api/usage`

**文件：** `packages/shared/src/usage.ts`（新）+ `index.ts`、`cost/usage-repo.ts`（新）、`http/app.ts`、`test/usage.test.ts`（新）

**接口：**
```ts
// shared
type UsageWindow = '5h' | 'day' | 'week' | '30d'
interface UsageTotals { runs: number; failedRuns: number; runMinutes: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
                        usd: number /* API 模式运行的 cost_usd 之和 */; estimateUsd: number /* 订阅运行的 cost_usd 之和（API-equivalent） */ }
interface UsageSummary { window: UsageWindow; since: string; now: string; executor: 'claude-code' | 'claude-api';
  totals: UsageTotals; byTicket: (UsageTotals & {ticketKey: string | null; title: string | null})[] /* null = 无票的运行（发现、试运行） */;
  byRole: (UsageTotals & {role: AgentRole})[]; byDay: (UsageTotals & {day: string /* YYYY-MM-DD，本地时区 */})[];
  budget: BudgetProgress | null; paused: UsagePause | null }
interface BudgetProgress { limits: {runs: number | null; runMinutes: number | null; usd: number | null}; used: {runs: number; runMinutes: number; usd: number};
                           ratio: number /* 各项 used/limit 的最大值 */; state: 'ok' | 'warn' | 'over' }
interface UsagePause { id: number; reason: 'manual' | 'threshold' | 'limit_reached'; detail: string; pausedBy: string; pausedAt: string }
// server
usageSummary(db, o: { window: UsageWindow; now: Date; executor: Config['executor']['kind']; budget: Config['budget'] }): UsageSummary
  // token 取 usage_json 的 input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens（json_extract，缺失为 0）；
  // runMinutes = (COALESCE(ended_at, now) - started_at)；byTicket 按 usd+estimateUsd 降序，最多 50 行
GET /api/usage?window=5h|day|week|30d   → UsageSummary（任何设备可读）
```

- [ ] **步骤 1：写失败测试：** 插入合成 `agent_run`（订阅与 API 各若干、跨窗口边界一条、`ended_at` null 一条、`usage_json` 非法一条、`cost_usd` null 一条）：`totals` 与手算一致；窗口边界外的不计；非法 `usage_json` 计 0 且不抛错；`byDay` 按本地时区分组；`byTicket` 中 null 票一行；10,000 条合成运行时 `usageSummary` < 200 ms；`GET /api/usage?window=x` → 400。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): usage summary by ticket, role and day from agent runs`

### 任务 2：阈值、暂停与闸门（迁移 m14）

**文件：** `db/migrations.ts`（m14）、`cost/budget-gate.ts`（新）、`config.ts`、`executor/run-agent.ts`、`executor/claude-code.ts`、`executor/claude-api.ts`（若 4b 已完成）、`workflow/jobs.ts`、`http/app.ts`、`main.ts`、`test/budget-gate.test.ts`（新）、`test/database.test.ts`、`test/executor.test.ts`、`test/workflow.test.ts`

迁移 m14：`usage_pause(id, reason CHECK IN ('manual','threshold','limit_reached'), detail, paused_by, paused_at, resumed_by, resumed_at)`——只允许把 `resumed_*` 从 NULL 更新一次，禁止 DELETE（同 m4 的 `guard()` 写法）。

**接口：**
```ts
Config.budget = { enabled: boolean /* false */; window: '5h'|'day'|'week' /* '5h' */; maxRuns: number | null /* 1..10000 */; maxRunMinutes: number | null /* 1..100000 */;
                  maxUsd: number | null /* 0.01..100000 */; warnAt: number /* 0.5..0.99，默认 0.8 */ }
class UsagePausedError extends Error { readonly pause: UsagePause }
class UsageLimitError extends Error {}           // 执行器抛出：结果为错误且文本匹配 USAGE_LIMIT_RE
USAGE_LIMIT_RE = /usage limit|rate limit|quota/i
currentPause(db): UsagePause | null
pauseUsage(db, reason, detail: string, by: string): UsagePause      // 已暂停 → 返回现有的，不新建；审计 usage_paused；emit usage_changed
resumeUsage(db, by: string): void                                   // 未暂停 → 无操作；审计 usage_resumed
budgetGate(o: { db; config: () => Config; now?: () => Date }): { check(role: AgentRole): void }
  // write 角色（jira-update、jira-comment）直接通过；已暂停 → 抛 UsagePausedError；
  // budget.enabled 且 usageSummary(...).budget.state === 'over' → pauseUsage('threshold', "<哪一项> reached <used>/<limit> in the last <window>") 后抛 UsagePausedError
RunAgentDeps += { gate?: { check(role: AgentRole): void } }   // 缺省 = 不检查（现有测试不改）
// runAgent：在 runChecked 之前 gate.check(req.role)；捕获 UsageLimitError → pauseUsage('limit_reached', 首行文本) 后重新抛出
// jobs：UsagePausedError / UsageLimitError → 票 blocked，blocked_reason = "Paused: <detail> — resume in Cost & quota, then Retry"
POST /api/usage/pause  {note?}    任何已配对设备（decidedBy 由请求来源决定）
POST /api/usage/resume            任何已配对设备
/api/status += { usage: { paused: UsagePause | null; budgetState: 'ok'|'warn'|'over'|null; waitingTickets: number /* blocked 且原因以 "Paused:" 开头 */ } }
```

- [ ] **步骤 1：写失败测试：** `user_version >= 13`；`usage_pause` DELETE 抛错、`resumed_at` 二次更新抛错；`maxRuns: 3`、窗口内已有 3 次运行 → 第 4 次 `runAgent`（refine-ticket）抛 `UsagePausedError` 且审计 `usage_paused` reason `threshold`、执行器未被调用；同条件下 `jira-update` 运行照常；手动暂停 → 下一次 propose 运行被拦、票 `blocked` 且原因以 "Paused:" 开头；恢复 → Retry 后运行；重启（新 db 连接）后暂停仍在；假 CLI 返回 `is_error` + "Claude usage limit reached" → `UsageLimitError`、自动暂停 reason `limit_reached`；`warnAt` 到达未超 → 不暂停、`/api/status.usage.budgetState === 'warn'`；`budget.enabled: false` → 从不因阈值暂停；`maxUsd` 只在 `executor.kind === 'claude-api'` 时生效；阈值配置非法值（`warnAt: 1`）→ 400。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck`、`pnpm e2e` 通过。
- [ ] **步骤 5：** 提交：`feat(server): usage thresholds and pause — new agent runs stop with a clear blocked reason; migration 13`

### 任务 3：Cost & quota 页、横幅、阈值设置

**文件：** `pages/CostPage.tsx`（新）、`components/UsageBanner.tsx`（新）、`components/AppShell.tsx`（启用 "Cost & quota"，路由 `/cost`）、`main.tsx`、`lib/usage-model.ts`（+ `.test.ts`，新）、`pages/SettingsPage.tsx`（新"Budget"分区）、`lib/api.ts`、`i18n/en.ts`

页面（桌面按 `design/screens/10-cost-quota.png`；手机单列卡片）：窗口切换（5 h / day / week / 30 days）；顶部三个数字卡（Runs、Run time、Cost 或 "API-equivalent estimate"，按当前执行器，裁决 C-1）；阈值进度条（ok 灰、warn 琥珀、over 红）与 "Pause new agent runs" / "Resume" 按钮（吸底栏 + "This will: stop new agent runs; running ones finish. Tickets that would start one wait in Blocked until you resume and retry."）；按天的 CSS 条形图（最多 30 根，条形宽度按最大值归一）；按票表（手机为列表：票号、标题、runs、cost）；按角色表。全局横幅（AppShell 顶部）：暂停时 "Usage paused — <reason>. N tickets waiting." 链接到 `/cost`；`warn` 时 "Usage at 84% of your 5-hour budget."。设置页 Budget 分区：开关、窗口、三项阈值（订阅时隐藏 `maxUsd`、API 时隐藏前两项之外不隐藏）、`warnAt`（百分比显示）。

- [ ] **步骤 1：写失败测试（usage-model）：** 订阅执行器时主数字标签为 "API-equivalent estimate"；API 时为 "Cost"；`ratio 0.84` → `warn` 文案含 "84%"；条形归一（最大值 100%）；空数据 → "No agent runs in this window"；横幅模型：暂停 + 3 张等待票 → 文案含 "3 tickets waiting"；手机模型：表格列折叠为列表项。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm -F web test`、`pnpm -F web build` 通过。
- [ ] **步骤 5：** 提交：`feat(web): Cost & quota page, usage banner, budget settings`

### 任务 4：OTLP span 构造与导出记录（迁移 m16）

**文件：** `telemetry/otlp.ts`、`telemetry/export-repo.ts`（新）、`db/migrations.ts`（m16）、`config.ts`、`http/app.ts`（`sensitive` 加 `telemetry`）、`test/otlp.test.ts`（新）、`test/database.test.ts`

迁移 m16：`telemetry_export(id, endpoint_host, run_ids_json, run_ids_hash, include_content, span_count, decided_by, requested_at, finished_at, status CHECK IN ('running','done','failed'), http_status, detail)`——禁止 DELETE；`agent_run_exported(run_id PRIMARY KEY REFERENCES agent_run(id), export_id)`——禁止 UPDATE / DELETE。

**接口：**
```ts
Config.telemetry = { endpoint: string /* '' = 关；https://…，或 http:// 且主机为 127.0.0.1 / localhost / [::1]；端口不得为 SLACKOFF_PORTS */; includeContent: boolean /* false */ }
SPAN_NAME = 'slackoff.agent_run'
buildOtlpPayload(runs: AgentRunRow[], o: { includeContent: boolean; readRawLog: (path: string) => string | null; serviceVersion: string }): object
  // {resourceSpans:[{resource:{attributes:[service.name="slack-off", service.version]}, scopeSpans:[{scope:{name:"slack-off"}, spans:[…]}]}]}
  // traceId = sha256(ticket_key ?? run.id) 前 32 hex（同一票的运行同一条 trace）；spanId = sha256(run.id) 前 16 hex；
  // start/end 为 unix 纳秒字符串；status.code = ok→1(OK) 其他→2(ERROR)；attributes 见裁决 C-8（gen_ai.usage.input_tokens / output_tokens 也写）；
  // events：原始日志中每个 tool_use → {name:"tool", attributes:[tool.name]}（最多 200 个）；includeContent → 加 slackoff.prompt / slackoff.output（各截断 32 KB）
exportableRuns(db, o: { limit: number /* ≤500 */ }): AgentRunRow[]   // status <> 'running' 且未出现在 agent_run_exported 中，按 started_at
previewExport(db, config): { endpointHost: string; runCount: number; includeContent: boolean; attributes: string[]; runIdsHash: string } | null   // 未配置 → null
```

- [ ] **步骤 1：写失败测试：** `user_version >= 14`；三条运行（同票两条、无票一条）→ 两条 trace，traceId 一致性；`includeContent: false` 时序列化后的 JSON 不含提示词、输出、错误文本、仓库路径、`jira.baseUrl`（用 fixture 中的这些字符串断言不出现）；`includeContent: true` 时含截断后的提示词；原始日志缺失 → 无 events、不抛错；配置 `endpoint: 'http://example.com/v1/traces'` → 报错；`'http://127.0.0.1:4317/v1/traces'` → 报错（Slack Off 端口）；`'http://127.0.0.1:4318/v1/traces'` 与 `'https://otel.example.com/v1/traces'` → 通过；远程会话改 `telemetry` → 403；已导出的运行不再出现在 `exportableRuns` 中。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): OTLP/HTTP JSON spans for agent runs (metadata by default); migration 14`

### 任务 5：逐次确认的导出与"Run tracing"设置

**文件：** `telemetry/export-repo.ts`、`http/app.ts`、`pages/SettingsPage.tsx`（新"Run tracing"分区）、`pages/CostPage.tsx`（导出卡片）、`lib/api.ts`、`i18n/en.ts`、`test/otlp.test.ts`、`test/http.test.ts`

**接口：**
```ts
GET  /api/telemetry/preview   → previewExport(...) | null
POST /api/telemetry/export {runIdsHash}   // 任何已配对设备（同交付确认）；预览变了 → 409 "the runs to export changed — preview again"；
  // 用 4b 的 readCredentials(home).otlpHeaders 作为请求头（加 Content-Type: application/json）；fetch POST，超时 30 s，redirect:'manual'；
  // 2xx → status done、写 agent_run_exported；否则 failed（http_status、detail 经 redactSecrets，截断 500 字符）；从不自动重试；审计 telemetry_exported
```
设置页 Run tracing 分区（仅限本机）：地址输入、`includeContent` 开关（打开时红色说明 "Prompts and agent output — ticket text and code — are sent too"）、鉴权头（4b 的 `CredentialField` 变体，键值对，最多 10 个，`PUT /api/credentials/otlp-headers`）、固定警告 "Exporting sends ticket keys and run details (and, if you turn it on, ticket content and code) to this service. Off by default. Each export is confirmed."。Cost 页导出卡片：未配置不显示；配置后 "Export 37 runs to otel.example.com" + 吸底确认（"This will: send 37 agent runs (role, ticket key, duration, tokens, cost, tool names) to otel.example.com. Recorded in the audit log."）。

- [ ] **步骤 1：写失败测试：** 测试进程在 `127.0.0.1` 随机端口起 OTLP 接收器：预览 → 导出 → 接收器收到一个请求、`Content-Type: application/json`、带配置的鉴权头、`resourceSpans[0].scopeSpans[0].spans.length` 等于预览条数；再次预览 → `runCount: 0`；导出前新增一条运行 → 用旧哈希导出 → 409；接收器返回 500 → `failed`、运行未标记为已导出、没有第二次请求；审计 payload 不含鉴权头值；`telemetry.endpoint` 为空 → `GET /api/telemetry/preview` 为 null；接收器 302 → `failed`，不跟随。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm -F web build` 通过。
- [ ] **步骤 5：** 提交：`feat: confirmed OTLP export of agent runs; Run tracing settings with the export warning`

### 任务 6：e2e、README、出口核对

**文件：** `e2e/phase4c.spec.ts`（新，desktop 与 390×844）、`playwright.config.ts`、`package.json`、`dev/fake-mode.ts`（fake 运行写入合成的 `usage_json` 与 `cost_usd`；`FAKE_SWITCHES.usageLimitOnce`：某票第一次 propose 返回额度错误）、`README.md`、`docs/spikes/phase4c-exit.md`（新）

- e2e desktop：FAKE-1 整理与出方案后打开 Cost & quota → 数字卡与按票表含 FAKE-1；设置 Budget `maxRuns` 为当前已用次数 → FAKE-2 点 Refine → 票 `blocked`、原因以 "Paused:" 开头、横幅出现 → Resume → Retry → 运行完成；在 e2e 自己起的本地 OTLP 接收器上配置地址 → 导出确认 → 接收器收到 span 且不含 FAKE 票的描述文本。390px：Cost 页、横幅、暂停吸底栏可用，`scrollWidth === 390`，按钮 ≥44px。
- README：新增 "Cost & quota"（订阅估算的含义、阈值与窗口、暂停的效果与 Retry、额度耗尽的自动暂停是尽力而为）与 "Run tracing (optional)"（默认关；每次导出确认；Langfuse / LangSmith 的 OTLP 地址形式用占位；**警告：导出会把票号与运行信息——打开 includeContent 时还有票内容与代码片段——发送给该服务**，原文对应 spec §9.8 "导出会把票内容和代码片段发送给该服务"）。
- `docs/spikes/phase4c-exit.md`：作者手工核对 0. 订阅模式真实运行若干次后面板数字与 `~/.slackoff/runs/` 中 result 事件一致；1. 阈值暂停与恢复；2. 真实额度耗尽时的 CLI 文本是否被 `USAGE_LIMIT_RE` 识别（无法自然触发则记"未核对"）；3. 向自己的 Langfuse 或 LangSmith **测试项目**导出一次，看到 span 与属性；4. 打开 `includeContent` 导出一次测试票，确认后端只收到测试内容，然后关掉。

- [ ] **步骤 1：** fake 模式与 e2e；`pnpm test`、`pnpm typecheck`、`pnpm e2e` 全部通过。
- [ ] **步骤 2：** README 与出口文档。
- [ ] **步骤 3：** 提交：`test: phase 4c e2e (pause, resume, confirmed export, 390px); docs: cost & quota, run tracing warning, phase 4c exit checklist`

---

## 自审

**1. Spec 覆盖：** §9.1 按票 / 按运行展示（任务 1、3）、API 显示 token 与费用 / 订阅显示次数与时长与可得用量（任务 1、3，裁决 C-1）、阈值自动暂停并通知（任务 2、3）；功能说明 §12 的按票 / 角色 / 天统计、手动暂停 / 恢复（任务 3）；§1 全局横幅（任务 3）；§9.8 OTel 记录角色 / 耗时 / 工具调用 / 结果 / 消耗（任务 4）、默认不导出、可接 LangSmith / Langfuse（任务 4、5）、README 警告（任务 6）；反目标"额度耗尽时不通知"（任务 2 自动暂停 + 横幅）。审计日志页（功能说明 §11，导航中同样禁用）不在 spec §10 阶段 4 列表中，本计划不做。

**2. 步骤扫描：** 每个任务的签名、表结构、断言具体；手写 OTLP 只规定字段映射，序列化由实现者完成。

**3. 类型一致性：** `UsageSummary` / `BudgetProgress` / `UsagePause`（任务 1 → 2、3）；`Config.budget`（任务 2 → 3）；`UsagePausedError`、`UsageLimitError`、`budgetGate`、`RunAgentDeps.gate`（任务 2；4d 的试运行使用 `gate`）；`Config.telemetry`、`buildOtlpPayload`、`previewExport`、`runIdsHash`（任务 4 → 5）；`Credentials.otlpHeaders`（4b 任务 2 → 本计划任务 5）。

**4. 审阅重点：** blocked 原因与横幅（任务 2、3 测试）；阈值边界（任务 1、2）；写角色不受闸门影响（任务 2）；导出内容与地址（任务 4、5）；大数据量（任务 1 的 200 ms 断言）。

**5. 比例：** 计划给出表、签名与断言；页面布局引用设计图，不写组件代码。
