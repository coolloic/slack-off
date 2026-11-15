# 阶段 4d · 选择偏好 + 提示词的恢复默认与样例票试运行 执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** spec §9.4：每次选方案时记录所选方案相对其他方案的特征（偏简单 / 偏可扩展、是否引入新依赖、改动范围、涉及仓库数），形成一段偏好摘要，下次生成方案时作为参考提供给方案 agent；开发者可以在 UI 查看、编辑、清空。spec §9.6：每个角色的"恢复默认"加上确认与独立审计，并可查看内置的 skill 文本；"用样例票试运行"把编辑中（尚未保存）的补充提示词放到一张随仓库发布的虚构样例票上运行一次，显示结果，不改变任何票的状态。

**架构：** 偏好是两张只增的表（迁移 m15）：`preference_signal`（每次选择一条特征记录）与 `preference_summary`（摘要的版本：自动生成、开发者编辑、清空）。特征与摘要都是**确定性计算**（不调用 agent，不花额度，裁决 D-1）。方案 agent 的系统提示词在 `assembleSystemPrompt` 中多一节"Developer preferences"，内容经与仓库提示词相同的 `neutralise` 处理；`agent_run` 记录本次使用的摘要版本。试运行复用 `runAgent`：系统提示词用"草稿补充文本"代替当前版本，输入来自 `skills/samples/`，cwd 是样例仓库的临时副本，`agent_run.purpose = 'trial'` 且 `ticket_key` 为 null。

**技术栈：** 同阶段 1–3。新增依赖：无。

**设计依据（Spec）：**
- 设计文档 §9.4、§9.6（"每个角色提供'恢复默认'，以及用一张样例票'试运行'的入口（阶段 4 实现）"；用户提示词只追加、不能覆盖硬性约束；版本记入 `agent_run`）、§8（`preference`、`prompt_version`、`agent_run`）、§10 阶段 4"选择偏好（§9.4）"。
- 功能说明 `docs/ba/functional-spec.md` §7（方案页"选择偏好提示（若有）：'你过去倾向于更简单、少依赖的方案'"）、§13 第 4 项（恢复默认、试运行，此前置灰）。
- 代码：`prompts/prompt-store.ts`（`savePrompt`、`resetPrompt`、`assembleSystemPrompt`、`neutralise`）、`http/app.ts`（`/api/prompts/*`，写操作仅限本机）、`requirements/requirement-repo.ts`（`INSERT INTO choice` 的事务，审计 `choice_recorded`）、`workflow/jobs.ts`（propose-solutions 运行）、`packages/shared/src/schemas.ts`（`solutionFields`）、`skills/propose-solutions/SKILL.md`、`packages/web/src/pages/SettingsPage.tsx`（`PromptEditor` 中已有 "Restore default" 与禁用的 "Try on a sample ticket"）、`pages/ticket/`（方案页签）、`docs/ba/05-er.mmd`（PREFERENCE）。
- 依赖：4c 任务 2 的 `RunAgentDeps.gate`（试运行经过额度闸门；4c 未完成时不经过，行为其余不变）。

## 裁决（每条附"错了的代价"）

- **裁决 D-1（确定性摘要）：** 摘要由规则从特征计数生成，例如 "In 7 of your last 9 choices you picked the simplest option (lowest complexity). You avoided new dependencies in 3 of 4 choices where an option added one. You usually chose solutions that change one repository."——只有达到最少样本（≥3 次选择，且比例 ≥ 60%）的倾向才写入；不让 agent 写摘要。代价：措辞死板，捕捉不到开发者备注中的细微偏好（开发者可以手工编辑补充）。
- **裁决 D-2（新依赖字段）：** `Solution` 增加可选字段 `newDependencies: string[]`（默认 `[]`，旧记录读作 `[]`），propose-solutions skill 要求填写"本方案新引入的第三方包或服务"。特征 `addsDependency` 取自该字段；字段在某组方案中全部为空时，该次选择不计入依赖倾向。代价：agent 漏填时依赖倾向偏少（只影响参考文本）。
- **裁决 D-3（编辑优先）：** 开发者编辑过的摘要不会被新的选择自动覆盖；页面显示 "N new choices since you edited this — Re-derive"。清空 = 新增一条空版本并记录截止点，截止点之前的信号不再参与推导。代价：开发者编辑后偏好不再自动更新，直到点 Re-derive。
- **裁决 D-4（偏好只给方案 agent）：** 只有 propose-solutions 看到偏好；设计、挑刺、开发、验收看不到（验收隔离要求它不看任何选择相关信息）。代价：无。
- **裁决 D-5（谁能改）：** 偏好摘要会进入 agent 的提示词，同提示词一样只能在本机编辑、清空、重新推导（R21 / F-I2）；手机只读。代价：手机上不能清空偏好。
- **裁决 D-6（恢复默认）：** 阶段 1 已实现 `resetPrompt`（写一个空版本）与按钮。阶段 4 只加：确认框（显示将被清空的当前补充文本）、独立审计类型 `prompt_reset`（替代此时的 `prompt_updated` length 0）、"View built-in instructions"（只读显示 skill 正文与版本）。仓库规则文件里的角色覆盖不受"恢复默认"影响，确认框写明。代价：无。
- **裁决 D-7（试运行的范围）：** 只支持只读角色：`refine-ticket`、`propose-solutions`、`design-solution`、`critique-design`。`implement-ticket`、`acceptance-review` 需要 worktree、沙箱与运行环境，`jira-*` 会访问真实 JIRA——它们的试运行按钮禁用并说明原因。样例是随仓库发布的虚构内容（`skills/samples/`），不使用开发者的真实票（避免把真实票内容带进一次与票无关的运行，也让结果可比较）。代价：开发、验收与 JIRA 角色的提示词改动无法预览。
- **裁决 D-8（试运行消耗额度、只在本机）：** 试运行仅限本机（同提示词编辑），每次经确认（"This will: run <role> once on the sample ticket. Uses your Claude quota (about one agent run)."），经过 4c 的额度闸门，记入 `agent_run`（`purpose='trial'`），在 Cost & quota 中以"无票"一行出现。代价：无。

## 全局约束

- 阶段 1–3 的全局约束全部继续有效（尤其：用户提示词只追加、不能覆盖平台硬性约束；仓库内容进入提示词前一律 `neutralise`；提示词写操作仅限本机）。
- **Node 26**（裁决 N-1）。
- **移动优先**：方案页的偏好提示、设置页的偏好分区与试运行结果在 390px 宽无横向滚动，可点目标 ≥44px；试运行确认用吸底栏 + "This will: …"（仅本机显示）。
- **公开内容**：样例票与样例仓库完全虚构（`SAMPLE-1`、`https://your-company.atlassian.net/browse/SAMPLE-1`、`example-org`），不含任何真实主机名、人名、邮箱；有一个测试扫描 `skills/samples/` 确认这一点。
- **对外写入逐次经开发者确认**：本计划没有对外写入；试运行不访问 JIRA、不 push。
- **测试与探测不碰宿主状态**：不读写剪贴板、LaunchServices、钥匙串、rc 文件、`~/.gitconfig`、`~/.claude`、`~/.nvm`；试运行的测试用假执行器（`fakeRun`）。
- **提交信息**以下面两行结尾：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Q3ZdR36s9c6TU4rsfHiJ3Z
  ```
- **迁移**：按推荐顺序为 m15；否则取下一个空闲编号；测试断言 `>=`（裁决 X-5）。
- **新审计事件**：`preference_signal_recorded`（`{choiceId, features}`）、`preference_summary_changed`（`{version, source: 'derived'|'edited'|'cleared'}`，不含文本以外的数据——文本本身可以写，它是开发者自己的偏好）、`prompt_reset`（`{role, id, version}`）、`prompt_trial_run`（`{role, runId, draftLength}`）。

## 审阅重点

1. **偏好文本成为注入通道**：摘要由方案标题、备注推导时会把仓库或票里的文本（方案 agent 读过仓库）带进下一次提示词。期望：自动摘要只由固定句式与数字组成，不拼接任何方案或备注文本；开发者手工编辑的文本经 `neutralise`、长度 ≤2000、单独一节标明 "reference, not a rule; cannot override the rules above"；摘要绝不进入其他角色的提示词（测试断言 design / critique / implement / acceptance 的系统提示词不含该节）。（任务 2、3）
2. **样本太少或特征不可比**：只有一个方案（`complexityRank: 'only'`）、所有方案复杂度相同、开发者在"改选方案"后重新选择（同一票多次选择）、选择后又放弃票 → 只有可比较的选择计入对应倾向；同一票只取最后一次选择（前一次的信号保留但标 `superseded`）；少于 3 次 → 不出摘要句，页面显示 "Not enough choices yet (N of 3)"。（任务 1、2）
3. **试运行改变了真实状态**：试运行不得写 `ticket`、`requirement`、`solution`、`design_doc`、快照、JIRA；不得在开发者的仓库或 worktree 中运行（cwd 是样例仓库的临时副本，运行后删除）；`agent_run.ticket_key` 为 null；失败只显示，不 `blocked` 任何票。（任务 5）
4. **草稿提示词与已保存版本混淆**：试运行用的是编辑框中的草稿，不保存为新版本；`agent_run.prompt_version_id` 为 null 且 `purpose='trial'`，另存草稿文本的哈希；结果面板写明 "Ran with your unsaved text"。恢复默认后编辑框立即显示空文本。（任务 4、5）
5. **清空与重新推导的边界**：清空后立刻选一次方案 → 只有清空之后的信号参与；编辑后又清空 → 回到自动推导；并发两个选择（不同票）→ 两条信号都在，摘要版本号单调。（任务 1、2）

---

## 文件结构

```
packages/shared/src/schemas.ts (改：Solution.newDependencies), packages/shared/src/preferences.ts (新：ChoiceFeatures、PreferenceSummary)
packages/server/src/
  preferences/preference-repo.ts, preferences/derive.ts (新)
  db/migrations.ts (改：m15), requirements/requirement-repo.ts (改：选择时记录信号), prompts/prompt-store.ts (改：偏好一节、草稿覆盖、prompt_reset)
  prompts/trial-run.ts (新), executor/run-agent.ts (改：purpose、promptOverride), workflow/jobs.ts (改：propose 运行记录偏好版本)
  http/app.ts (改：/api/preferences*、/api/prompts/:role/trial、/api/prompts/:role/default)
skills/propose-solutions/SKILL.md (改：newDependencies), skills/samples/ (新：sample-ticket.json、sample-requirement.json、sample-solution.json、sample-design.md、sample-repo/)
packages/server/test/  preferences.test.ts, trial-run.test.ts (新), skills-prompts.test.ts / database.test.ts / http.test.ts (改)
packages/web/src/  pages/SettingsPage.tsx (改：Preferences 分区、PromptEditor), pages/ticket/<方案页签> (改：偏好提示), components/TrialResult.tsx (新), lib/preferences-model.ts (+ test), lib/api.ts, i18n/en.ts
e2e/phase4d.spec.ts (新), playwright.config.ts, package.json, README.md, docs/ba/05-er.mmd, docs/spikes/phase4d-exit.md (新)
```

---

### 任务 1：特征、信号与摘要版本（迁移 m15）

**文件：** `packages/shared/src/schemas.ts`、`packages/shared/src/preferences.ts`（新）+ `index.ts`、`db/migrations.ts`（m15）、`preferences/preference-repo.ts`、`preferences/derive.ts`（新）、`requirements/requirement-repo.ts`、`skills/propose-solutions/SKILL.md`、`test/preferences.test.ts`（新）、`test/database.test.ts`、`test/skills-prompts.test.ts`、`docs/ba/05-er.mmd`

迁移 m15：`preference_signal(id, ticket_key, choice_id UNIQUE REFERENCES choice(id), features_json, superseded INTEGER NOT NULL DEFAULT 0, created_at)`——只允许把 `superseded` 从 0 改为 1，禁止 DELETE；`preference_summary(id, version UNIQUE, text, source CHECK IN ('derived','edited','cleared'), signals_upto INTEGER /* 推导时最后一条信号 id */, cleared_before INTEGER /* cleared：此 id 之前的信号不再参与 */, decided_by, created_at)`——禁止 UPDATE / DELETE；`agent_run` 加 `preference_version INTEGER`、`purpose TEXT NOT NULL DEFAULT 'ticket' CHECK (purpose IN ('ticket','discover','trial'))`、`draft_hash TEXT`（后两列供任务 5）。`05-er.mmd` 的 PREFERENCE 改为这两张表。

**接口：**
```ts
// shared
Solution += { newDependencies: string[] /* 默认 []；每项 1–100 字符，最多 20 项 */ }
interface ChoiceFeatures { optionCount: number; complexity: 'S'|'M'|'L'; complexityRank: 'only'|'lowest'|'middle'|'highest'|'tied';
  addsDependency: boolean; anyOptionAddsDependency: boolean; repoCount: number; minRepoCount: number; scopeSize: number; minScopeSize: number; hasNote: boolean }
// server
choiceFeatures(chosen: StoredSolution, all: readonly StoredSolution[]): ChoiceFeatures
  // complexityRank：S<M<L；所有方案同复杂度 → 'tied'；只有一个方案 → 'only'
recordSignal(db, key: string, choiceId: number, features: ChoiceFeatures): void
  // 同一票此前未 superseded 的信号 → superseded=1；审计 preference_signal_recorded
```
选择方案的事务（`requirement-repo.ts` 中 `INSERT INTO choice` 的函数）在同一事务内计算特征并调用 `recordSignal`；skill 文本说明 `newDependencies`（"third-party packages or external services this solution adds; [] if none"），`skills-prompts.test.ts` 断言 skill 中出现该字段名。

- [ ] **步骤 1：写失败测试：** `user_version >= 15`；三个方案（S、M、L）选 S → `complexityRank: 'lowest'`；两个 M 选 M → `'tied'`；单方案 → `'only'`；`newDependencies` 缺省的旧方案读作 `[]`；同一票第二次选择 → 前一条 `superseded = 1`；`preference_signal` DELETE 抛错、`superseded` 从 1 改回 0 抛错；`preference_summary` UPDATE 抛错；选择事务中途抛错 → 选择与信号都不存在；审计链 ok。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck` 通过。
- [ ] **步骤 5：** 提交：`feat: record choice features (complexity rank, new dependencies, scope); migration 15`

### 任务 2：确定性摘要、编辑、清空

**文件：** `preferences/derive.ts`、`preferences/preference-repo.ts`、`http/app.ts`、`test/preferences.test.ts`、`test/http.test.ts`

**接口：**
```ts
MIN_SIGNALS = 3; MIN_SHARE = 0.6
deriveSummary(signals: readonly ChoiceFeatures[]): { text: string; counted: number }
  // 只用未 superseded、且在最近一次 cleared 之后的信号，最多最近 20 条；每条倾向句只在可比较样本 ≥ MIN_SIGNALS 且比例 ≥ MIN_SHARE 时输出：
  //  简单：可比较 = complexityRank ∈ {lowest, middle, highest}；"In {k} of your last {n} choices you picked the simplest option (lowest complexity)."（或 "the most complex option"）
  //  依赖：可比较 = anyOptionAddsDependency；"You avoided new dependencies in {k} of {n} choices where an option added one."（或 "chose an option that adds one"）
  //  仓库：可比较 = optionCount > 1；"You usually chose the option that changes the fewest repositories ({k} of {n})."
  //  范围：同上，按 scopeSize；"You usually chose the option with the smallest change scope ({k} of {n})."
  //  无句可出 → text ''
interface PreferenceState { current: {version: number; text: string; source: 'derived'|'edited'|'cleared'; createdAt: string} | null;
  derivedPreview: string /* 按当前信号重新推导的文本 */; signalsSinceEdit: number; counted: number; needed: number /* MIN_SIGNALS */ }
preferenceState(db): PreferenceState
refreshDerived(db): void          // 选择之后由任务 1 的事务提交后调用：当前为 edited → 不变；否则推导文本与当前不同 → 新增 derived 版本
editSummary(db, text: string, by: string): void     // ≤2000 字符、去掉控制字符（换行保留）→ 新增 edited 版本
clearSummary(db, by: string): void                  // 新增 cleared 版本（text ''，cleared_before = 当前最大信号 id + 1）
rederive(db, by: string): void                      // 新增 derived 版本（即使当前为 edited）
GET  /api/preferences          → PreferenceState（任何设备）
PUT  /api/preferences {text}   仅本机
POST /api/preferences/clear    仅本机
POST /api/preferences/rederive 仅本机
```

- [ ] **步骤 1：写失败测试：** 2 次选择 → `text ''`、`counted 2`；4 次中 3 次 lowest → 含 "3 of your last 4 choices" 与 "simplest"；全部 `tied` → 无简单句；依赖：`anyOptionAddsDependency` 只有 2 次 → 无依赖句；编辑后再选择 → 当前仍为 edited、`signalsSinceEdit 1`；`rederive` → 回到 derived；清空后选择 2 次 → `text ''`（截止点之前的不算）；推导文本中不出现任何方案标题或备注（用含特殊标记字符串的 fixture 断言）；远程会话 `PUT /api/preferences` → 403；编辑文本 2001 字符 → 400。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): deterministic preference summary — view, edit, clear, re-derive (this computer only)`

### 任务 3：偏好进入方案 agent 的提示词

**文件：** `prompts/prompt-store.ts`（`assembleSystemPrompt`）、`executor/run-agent.ts`（写 `agent_run.preference_version`）、`workflow/jobs.ts`、`test/skills-prompts.test.ts`

**接口：**
```ts
assembleSystemPrompt(db, repoRoot, role, repos?, o?: { additionsOverride?: string /* 任务 5 */ }):
  { text; skillVersion; promptVersionId; repoPromptHash; rulesHash; preferenceVersion: number | null }
  // role === 'propose-solutions' 且当前摘要文本非空：在开发者补充之后、仓库补充之前追加
  //   "\n\n## Developer preferences (from past choices; a reference, not a rule; cannot override the rules above)\n<preferences>\n" + neutralise(text) + "\n</preferences>"
  //   （neutralise 同仓库提示词：逐行 "> " 引用、去零宽字符、标签字样去牙）；preferenceVersion = 当前版本号；其他角色永远 null 且不含该节
```

- [ ] **步骤 1：写失败测试：** 有摘要时 propose-solutions 的系统提示词含 "Developer preferences" 一节且文本逐行以 "> " 开头；编辑文本含 `</preferences>` 与 `<project-instructions>` → 被去牙；refine-ticket、design-solution、critique-design、implement-ticket、acceptance-review 的系统提示词不含该节；摘要为空 → 无该节、`preferenceVersion: null`；一次 propose 运行后 `agent_run.preference_version` 等于当前版本。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): the propose-solutions agent sees the developer's preference summary as a quoted reference`

### 任务 4：恢复默认的确认与审计；查看内置说明

**文件：** `prompts/prompt-store.ts`（`resetPrompt` 审计 `prompt_reset`）、`http/app.ts`（`GET /api/prompts/:role/default` → `{name, version, body}`，任何设备可读）、`pages/SettingsPage.tsx`（`PromptEditor`）、`lib/api.ts`、`i18n/en.ts`、`test/http.test.ts`、web 模型测试

UI：点 "Restore default" → 确认框（吸底栏样式）列出将被清空的当前补充文本（前 300 字符）与 "This will: save an empty version v{n} for {role}. Repository overrides in .slackoff/config.json are not affected."；确认后编辑框为空、历史出现新版本；"View built-in instructions" 打开只读面板显示 skill 正文（等宽字体，手机上可滚动，不横向溢出）。

- [ ] **步骤 1：写失败测试：** `resetPrompt` 写审计 `prompt_reset`（不再写 `prompt_updated`）；`GET /api/prompts/refine-ticket/default` 返回 skill 正文与版本；不存在的角色 → 404；web：确认框文案含 "Repository overrides"、未确认时不调用 reset API。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm -F web build` 通过。
- [ ] **步骤 5：** 提交：`feat: restore default with confirmation and its own audit event; view the built-in instructions`

### 任务 5：样例票试运行

**文件：** `skills/samples/`（新）、`prompts/trial-run.ts`（新）、`executor/run-agent.ts`（`RunAgentRequest.purpose`、`additionsOverride`）、`http/app.ts`、`components/TrialResult.tsx`（新）、`pages/SettingsPage.tsx`（启用 "Try on a sample ticket"）、`lib/api.ts`、`i18n/en.ts`、`test/trial-run.test.ts`（新）

样例（全部虚构、英文）：`sample-ticket.json`（`FetchedTicket` 形状：`SAMPLE-1` "Export the weekly report as CSV"，描述 + 3 条评论，其中一条与描述有轻微矛盾，好让 refine 有"不清楚"可报）、`sample-requirement.json`（`Requirement`，3 条 AC、1 条讨论结论）、`sample-solution.json`（`StoredSolution`）、`sample-design.md`、`sample-repo/`（一个 ~10 个文件的极小 Node 项目：报表模块 + 测试，`.slackoff/` 不存在）。

**接口：**
```ts
TRIAL_ROLES: readonly AgentRole[] = ['refine-ticket', 'propose-solutions', 'design-solution', 'critique-design']
interface TrialResult { runId: string; role: AgentRole; ok: boolean; output: unknown | null /* 通过 schema 的结果 */; error: string | null; durationMs: number; costUsd: number | null }
runTrial(deps: { run: <T>(req: RunAgentRequest<T>) => Promise<T>; repoRoot: string; tmpRoot: string }, role: AgentRole, draft: string): Promise<TrialResult>
  // role 不在 TRIAL_ROLES → ValidationError；draft ≤ 同 savePrompt 的上限；
  // 复制 skills/samples/sample-repo 到 mkdtemp(tmpRoot/'slackoff-trial-')（运行后删除）；输入按角色组装，与该角色在 jobs.ts 中的 prompt 形状相同（refine：样例票；propose：样例需求 + repos=[sample]；
  //   design：需求 + 方案 + 备注 ''；critique：需求 + 设计文本）；schema 同正式运行；
  // run 请求带 purpose:'trial'、additionsOverride: draft、无 ticketKey、无 repos 规则；retries 0；失败 → ok:false、error（不抛出）
RunAgentRequest += { purpose?: 'ticket'|'discover'|'trial'; additionsOverride?: string }
  // purpose 'trial' → agent_run.purpose='trial'、prompt_version_id=null、draft_hash=sha256(draft) 前 12 位；审计 prompt_trial_run
POST /api/prompts/:role/trial {text}   仅本机；同一时间只允许一次试运行（进行中 → 409）
```
UI：编辑框下 "Try on a sample ticket" 按钮（本机、角色在 `TRIAL_ROLES` 中时启用；其他角色禁用并提示 "Not available for this role: it changes code, runs the app or uses JIRA"）→ 吸底确认（裁决 D-8 文案）→ 运行中显示活动流（复用 `LiveLog`，按 `runId` 过滤）→ `TrialResult`：成功时按角色渲染结果摘要（refine：AC 列表与不清楚之处；propose：方案标题与复杂度；design：前 40 行；critique：阻塞 / 非阻塞条数与前 5 条），失败时显示错误；顶部标注 "Ran with your unsaved text on SAMPLE-1. Nothing was saved."。

- [ ] **步骤 1：写失败测试（`run` 为记录请求的假函数或 `fakeRun`）：** 四个角色各一次：请求 `purpose: 'trial'`、`additionsOverride` 等于草稿、无 `ticketKey`、cwd 在临时目录且运行后已删除；系统提示词含草稿而不含当前已保存版本的文本；`implement-ticket` → `ValidationError`；运行前后 `ticket`、`requirement`、`solution`、`design_doc`、`ticket_snapshot` 的行数不变；`agent_run` 一行 `purpose='trial'`、`prompt_version_id` null、`draft_hash` 非空；假运行抛错 → `ok:false` 且没有票变为 `blocked`；并发第二次 → 409；远程会话 → 403；4c 的闸门已暂停时 → `ok:false`、error 以 "Paused:" 开头（4c 未完成时跳过此用例并注明）；`skills/samples/` 中没有 `atlassian.net` 的非占位主机、没有 `@` 邮箱（除 `example.com`）。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck`、`pnpm -F web build` 通过。
- [ ] **步骤 5：** 提交：`feat: try a prompt draft on a fictional sample ticket (read-only roles, nothing saved)`

### 任务 6：UI 收尾、e2e、README、出口核对

**文件：** 方案页签组件（偏好提示行）、`pages/SettingsPage.tsx`（Preferences 分区）、`lib/preferences-model.ts`（+ test）、`e2e/phase4d.spec.ts`（新，desktop 与 390×844）、`playwright.config.ts`、`package.json`、`dev/fake-mode.ts`（`fakeRun` 支持 `purpose: 'trial'`；fake 方案带 `newDependencies`）、`README.md`、`docs/spikes/phase4d-exit.md`（新）

- 方案页签：摘要非空时在方案卡片上方显示一行 "Your past choices: you tended to pick the simplest option and avoid new dependencies." + "Edit"（本机）链接到设置页；为空时不显示。设置页 Preferences 分区：当前摘要（来源与时间）、"Not enough choices yet (N of 3)"、编辑框（本机）、"Clear" 与 "Re-derive"（本机，均经确认）、"N new choices since you edited this"。
- e2e desktop：用 API 快速路径为 FAKE-1、FAKE-2、FAKE-3 各选一次最简单的方案 → 设置页摘要含 "3 of your last 3" → FAKE-? 的方案页显示偏好提示 → 编辑摘要 → 清空 → 提示消失；Agent prompts 中 refine-ticket 输入草稿 → Try on a sample ticket → 确认 → 结果面板显示 AC 列表与 "Nothing was saved"；"Restore default" 确认后编辑框为空。390px：方案页提示行与设置页偏好分区只读可见、`scrollWidth === 390`；试运行按钮在手机上不出现。
- README：Preferences（记录什么、如何生成、只给方案 agent、如何编辑与清空）；Agent prompts 中 Restore default 与 Try on a sample ticket（支持哪些角色、消耗额度、不保存）。
- `docs/spikes/phase4d-exit.md`：作者手工核对 0. 真实运行中 propose-solutions 的原始日志里有偏好一节且为引用格式；1. 对四个试运行角色各试一次真实运行，结果合理；2. 偏好摘要在三次真实选择后的措辞是否有用（作者主观判断，记录）。

- [ ] **步骤 1：** UI 收尾与 e2e；`pnpm test`、`pnpm typecheck`、`pnpm e2e` 全部通过。
- [ ] **步骤 2：** README 与出口文档。
- [ ] **步骤 3：** 提交：`test: phase 4d e2e (preferences, trial run, restore default; 390px); docs: README and phase 4d exit checklist`

---

## 自审

**1. Spec 覆盖：** §9.4 记录选择特征（任务 1）、偏好摘要（任务 2）、下次生成方案时提供给方案 agent（任务 3）、UI 查看 / 编辑 / 清空（任务 2、6）；功能说明 §7 方案页偏好提示（任务 6）；§9.6 恢复默认（任务 4，阶段 1 已有的部分见裁决 D-6）、样例票试运行（任务 5）、提示词版本记入 `agent_run`（任务 5 的 `purpose` / `draft_hash`）；§8 `preference`（任务 1，拆为两张表，`05-er.mmd` 同步）。无缺口；试运行不支持写角色是有意的（裁决 D-7）。

**2. 步骤扫描：** 摘要句式与阈值写死在任务 2，因为它们决定输出；样例内容只给出主题与形状，由实现者写。

**3. 类型一致性：** `Solution.newDependencies`、`ChoiceFeatures`、`choiceFeatures`、`recordSignal`（任务 1 → 2）；`deriveSummary`、`PreferenceState`、`refreshDerived`（任务 2 → 3、6）；`assembleSystemPrompt(…, o.additionsOverride)` 与返回的 `preferenceVersion`（任务 3 → 5）；`agent_run.purpose` / `draft_hash` / `preference_version`（任务 1 迁移 → 3、5）；`RunAgentRequest.purpose` / `additionsOverride`、`TRIAL_ROLES`、`runTrial`、`TrialResult`（任务 5 → 6）；4c 的 `RunAgentDeps.gate`（任务 5 使用）。

**4. 审阅重点：** 注入（任务 2 不拼接文本、任务 3 neutralise 与只给 propose）；样本与可比性（任务 1、2）；试运行不改状态（任务 5）；草稿与版本（任务 4、5）；清空边界（任务 2）。

**5. 比例：** 计划长度主要在规则与断言；页面只描述内容与文案。
