# 阶段 2 · 设计辩论 + 开发（选定方案 → 设计定稿 → worktree 开发 → dev_done）执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 开发者选定方案（含该方案涉及的**一个或多个仓库**）后，设计 agent 写出逐项覆盖质量清单、按仓库分节的设计文档，挑刺 agent 逐条挑刺（标清单项 + 阻塞 / 非阻塞），最多 3 轮；仍有阻塞分歧时开发者逐条裁决或改选方案。定稿后重新读取 JIRA 快照（变化则做偏移检查并要求已知晓），然后开发 agent 在数据目录下为每个（票, 仓库）建立的 worktree 中按设计实现；平台在每次 commit 前拦截禁止路径、运行各仓库声明的命令、**以仓库自己的 git hooks** 提交带票号的小 commit，直到所有受影响仓库都干净且通过，进入 `dev_done`。可选（默认关闭）在开发者逐次确认后把 JIRA 改为 In Progress。

**架构：** 在阶段 1 的 Hono + `node:sqlite` + 进程内队列 + `Executor` 之上增加三组 job：`design/`（辩论循环，由纯函数 `nextDebateStep` 决定下一步，可从库中状态恢复）、`development/`（快照复读、多仓库 worktree、逐步开发循环）、`jira/jira-updater.ts`（单一写操作 `jira-update` 角色）。每个角色都是全新的 `claude -p` 会话，上下文由平台显式组装。一个 JIRA 项目映射到多个仓库；每个仓库的 `.slackoff/config.json` + `.slackoff/rules.md` 从**该仓库基础分支的提交**读取（agent 改不到）。开发 agent 的工作目录是票目录 `worktrees/<KEY>/`，其中只有受影响仓库的 worktree。git 操作全部由平台用 `execFile('git', …)` 完成，agent 不能运行 git。

**技术栈：** 同阶段 1（Node.js 24、TypeScript 可擦除语法、pnpm、Hono、`node:sqlite`、zod 4、React 19 + Vite + Tailwind + shadcn/ui、`node:test`、Playwright），新增依赖：无（git 用系统 `git`，glob 用 `node:path` 的 `matchesGlob`）。

**设计依据（Spec）：**
- 设计文档：`docs/superpowers/specs/2026-11-06-slack-off-design.md`（§10 阶段 2；§5.1–5.3 第 3、4、5 步；§6；§9.3；§9.5；§9.6 仓库级覆盖；§9.9 进入开发前复读快照；§13 worktree / 分支命名）
- 阶段 1 计划：`docs/superpowers/plans/2026-11-06-phase-1-mvp.md`（其全局约束继续有效）
- 数据模型：`docs/ba/05-er.mmd`（DESIGN_DOC、DEBATE_ROUND、DEBATE_RULING、DEV_ITERATION）；状态机：`docs/ba/02-state-machine.mmd`；时序：`docs/ba/03-sequence-b-debate.mmd`
- 功能说明：`docs/ba/functional-spec.md` §7（方案）、§8（设计与辩论）、§9（开发）、§13（设置）
- UI：`design/screens/05-solutions.png`、`06-design-debate.png`、`07-development.png` + `design/code/05*`–`07*`；移动端方法见 `design/README.md`"移动端"一节（m07 / m08 由任务 14 产出）
- 作者决定（2026-11-06 / 07，本计划据此编写）：拉票改为全部未关闭票（已落地）；手机可以确认 JIRA 写；平台 commit 必须运行仓库自己的 git hooks；一张票可以改多个仓库（微服务）；真实 JIRA 与作者自己测试仓库上的验证由作者手工完成。
- 技术验证结果（任务 1，已完成）：`docs/spikes/2026-11-dev-sandbox.md`。执行前审查（pre-flight）的 controller 裁决 P-C1…P-C21、P-docs、P-tests、P-phone、S-1…S-5 已并入下文各任务（裁决原文：`.superpowers/sdd/2026-11-07-phase-2-debate-dev/progress.md`）。

## 全局约束

- 阶段 1 全局约束全部继续有效（Node ≥24 直接跑 `.ts`、可擦除语法、`@slackoff/shared`、只监听 `127.0.0.1:4317` + 可选 Tailscale、`SLACKOFF_HOME`、不碰凭证、zod 校验失败重试 1 次后 `blocked`、用户提示词只追加、审计哈希链只增、快照只增、文案集中在 `packages/web/src/i18n/en.ts`、UI 不显示模型名）。
- 拉票口径（作者决定，已在阶段 1 落地，迁移 5）：拉取分配给我的全部未关闭票（`statusCategory != Done`）。**本阶段任何逻辑都不得假设票在 JIRA 中处于 Ready for Dev**；票可能已是 In Progress。
- 本阶段唯一的 JIRA 写操作是"改为 In Progress"：配置 `jira.syncStatus` 默认 `false`；开启后每次写都需开发者在 UI 上明确点 "Send to JIRA"（本机或已配对手机均可，作者决定；审计记录来源设备），写入审计；票已是目标状态时**跳过并说明**（不调 agent）；写失败只记录、**绝不阻塞或改变票的平台状态**。只读的 `jira-browser` 角色和其工具集不变。`jira-update` 只在本地 mock 页面（任务 1）和假 run（测试）上执行；真实 JIRA 由作者手工验证（任务 17）。
- 本阶段**不 push、不开 PR、不调用 `gh`**；agent 不能运行任何 `git` 命令。阶段 3 预告（本计划不含任务）：每个受影响仓库各开一个 PR，PR 描述互相引用。阶段 4 待办（裁决 S-1，本计划只记入 spec §10 与 README，不实现）：可选的 OS 级命令沙箱（如 `sandbox-exec` 包住 `runCommand` / commit，或 Claude Code `sandbox` 设置），把开发时运行的命令限制在票目录内。
- **开发会以开发者本人的用户权限运行仓库的命令（裁决 S-1）**：agent 写的测试 / 构建代码在平台（或 agent 经允许的命令）运行时不受文件工具沙箱约束，可以写票目录之外（任务 1 §1 已验证）。这与在自己仓库上用 Claude Code 是同一信任级别；缓解：开发 agent 无联网工具、文件工具受 `--restricted` 限制、方案由人选择并确认。README 安全说明必须写明（任务 17）。
- 多仓库：`projects[KEY].repos: [{name, path, baseBranch}]`；仓库名 `^[a-z0-9][a-z0-9._-]{0,39}$`，项目内唯一。受影响仓库集合在选方案时确定并锁定在 choice 上；之后只能通过"改选方案"改变（重新辩论）。
- worktree 固定在 `${SLACKOFF_HOME}/worktrees/<KEY>/<repoName>`，票目录 `${SLACKOFF_HOME}/worktrees/<KEY>/` 中只放受影响仓库的 worktree；每个仓库用同一个分支名 `slackoff/<KEY>-<slug>`（slug 见任务 7），从该仓库映射的 `baseBranch` 创建。平台对开发者仓库只做 `git worktree add` 和建分支，**不 checkout / reset / stash / clean 开发者的工作目录**；`reset --hard` / `clean` 只能作用于通过 `assertPlatformWorktree` 校验的路径。
- 所有 git / 项目命令用 `execFile`，不经 shell，`stdin` 关闭（`'ignore'`），无 TTY，独立进程组（超时杀整组），环境加 `GIT_TERMINAL_PROMPT=0`。
- **平台 commit 必须运行仓库自己的 git hooks（作者决定）**：任何地方都不得使用 `--no-verify`；hook 超时 `development.hookTimeoutMs` 默认 `300000`；hook 失败按测试失败处理——输出交回开发 agent 作为下一步的反馈，计入 `development.maxSteps`。某仓库本步 build / lint / test 失败 → 该仓库本步**不提交**（改动保留、输出交给下一步，裁决 P-C17）。commit 一律 `git add -A` 再 `git commit -m`，绝不 `commit -a`（超时被杀时不留 `index.lock`；被杀后若 `<repo>/.git/worktrees/<name>/index.lock` 存在则删除，裁决 S-5）。
- **agent 不能影响约束它的 hooks（裁决 S-3、P-C17）**：hooks 目录（解析后的 `core.hooksPath` 目录、`.husky/`、`.githooks/`；`.git/hooks` 在票目录之外，`--restricted` 下本就不可写）与 `.slackoff/` 是开发 agent 的禁止路径；平台**每次 commit 前**都从 HEAD 还原这些文件。仓库配置了 hooks（设置了 `core.hooksPath` 或 `package.json` 用到 husky）但 install 之后 hooks 目录里仍没有 hook → 该仓库 `blocked`（写明仓库名，任务 1 §3：husky v9 未安装时 hook 会被静默跳过）。
- 每个仓库的规则文件只从 `git show <baseBranch>:.slackoff/config.json` / `rules.md` 读取，只作用于该仓库自己的 worktree；`.slackoff/**`、`.git`、上述 hooks 目录永远是禁止路径。`commands.install`（可选）只在 worktree **新建时**由平台运行一次；install 造成的工作区改动（如 `pnpm-lock.yaml`）随即还原并在 UI 中列出，开发 agent 每一步看到的都是干净的工作区（裁决 S-4；需要重新生成 lockfile 的仓库必须把它写成显式的设计步骤）。
- 每个角色每次运行都是全新会话（不使用 `--resume` / `--continue`），上下文由平台组装。
- 沙箱基线适用于所有新角色：`--permission-mode default`、`--permission-prompts none`、按角色 `--tools`、显式 `--disallowedTools`、`--strict-mcp-config --setting-sources ""`、可选 `--model`；**禁止** `bypassPermissions` 与 `--dangerously-skip-permissions`。默认拒绝列表对 `implement-ticket` 仍拒绝 `WebFetch`、`WebSearch` 和全部 claude-in-chrome 工具。
- **技术验证决定值（任务 1，从 `executor/sandbox.ts` 导出，裁决 P-C15）**：`DEV_BASH_MODE = 'scoped'`（同时是 `PolicyContext.bashMode`，默认取该常量，便于测试 `'none'`）；允许规则只用精确的 `Bash(<cmd>)`，**不加** `Bash(<cmd> *)` 变体（它让任意额外参数传给测试运行器）；`DEV_BASH_FORM = 'cd <ticketDir>/<repo> && <cmd>'`（绝对路径；Bash 的 cwd 在调用之间保留，prompt 必须要求每次都用这个写法）；`DEV_RESTRICTED = true`（不加 `--restricted` 时文件工具可读写任意路径）；`JIRA_UPDATE_EXTRA_TOOLS = ['mcp__claude-in-chrome__computer']`（`form_input` 用不了 JIRA 式菜单）；`NAV_GUARD = 'hook'`，并且运行后**必须**扫描原始日志：既看 `navigate` / `tabs_create_mcp` 的输入 URL，也看工具**结果**里的 URL（"Tab Context" 行的 `("<url>")`、`get_page_text` 的 `URL:` 行）——点击链接造成的跳转不经过 hook。
- **多个已连接的 Chrome 浏览器（裁决 S-2）**：`-p` 模式下多个浏览器已连接且未选择时 chrome 角色直接失败（阶段 1 的 `jira-browser` 同样受影响）。新增仅限本机修改的 `jira.browser`（`{deviceId, name} | null`）；`jira-browser` 与 `jira-update` 允许 `select_browser`，prompt 把选择固定为该浏览器，导航守卫 hook 与运行后扫描都核对所选设备；未配置且检测到多个浏览器 → 明确的错误 "Choose the Chrome browser for JIRA in Settings"。
- 辩论轮数上限默认 `3`（`debate.maxRounds`，1–5）；开发步数上限默认 `12`（`development.maxSteps`，1–50）；命令超时默认 `600000` ms（`development.commandTimeoutMs`）；hook 超时默认 `300000` ms。
- 质量清单默认 22 项，id 固定；受影响仓库多于 1 个时再加 3 项跨仓库清单（任务 2）；可被规则文件增删；设计文档与挑刺都必须**逐项**给结论，由 zod schema 强制。
- R16 移动优先：每个新页面在 375–390px 宽可用、无横向滚动；拍板用吸底决策栏，按钮下方有 "This will: …" 说明；可点目标 ≥44px。
- R17 / R21 / R22：已配对手机不能修改 executor / projects（含 `repos`）/ jira（含新增 `syncStatus`、`inProgressStatus`、`browser`）/ prompts / remoteAccess / readyForDevStatus；仅限本机的路由不变（新增的"检测浏览器"路由也仅限本机）。`debate.maxRounds`、`development.maxSteps` / `hookTimeoutMs` / `commandTimeoutMs` **手机可改**（裁决 P-phone：它们不改变运行什么、浏览器去哪里）。手机**可以**做拍板（选方案与受影响仓库、裁决、改选方案、已知晓、要求修改、确认 JIRA 写），审计记录来源设备。
- R13：快照变化后的"已知晓"必须填写说明；R15 Host / Origin 守卫覆盖所有新路由；R18 不变。
- 新审计事件类型：`design_doc_saved`、`debate_round_recorded`、`debate_ruling`、`design_finalized`、`worktree_created`（只在首次插入时写，裁决 P-C14）、`worktree_removed`、`repo_installed`、`ticket_refreshed`、`dev_step_recorded`、`rule_violation`、`jira_write_requested`、`jira_write_decided`、`jira_write_finished`；`choice_recorded` 的 payload 增加 `affectedRepos`。
- 跨包共享的记录类型与派生逻辑（`Disagreement`、`TestRun`、`CommitOutcome`、`StepRepoResult`、`InstallReport`、`IterationRecord`、`StepRecord`、`JiraWriteRecord`、`DebateRoundRecord`、`RulingRecord`、`disagreements()`、`repoStatus()`）只在 `@slackoff/shared` 定义（裁决 P-C18、P-C16）；服务端计算每个仓库的状态并在 `/development` 返回，web 只渲染，不重新推导。

## 审阅重点

1. **多仓库部分成功**：同一步里仓库 A 的 commit 成功，仓库 B 的 hook 或测试失败（或服务在两次 commit 之间重启）→ A 的 commit 保留并显示；B 测试失败时本步不提交、hook 失败时 commit 中止，B 的改动都保留在 worktree 中交给下一步修复（重启中断的、未记录的步骤则只在平台 worktree 内丢弃未提交改动）；只有**所有**受影响仓库都没有未提交改动、测试与 hook 都通过（或明确标为 "tests not run"）时才进入 `dev_done`。（任务 2 `repoStatus`、任务 7、11）
2. **受影响仓库不可用或在设计之后变了**（项目未映射、映射里删掉 / 改名 / 改了路径、不是 git 仓库、基础分支不存在、改选方案后某仓库不再受影响）→ `blocked` 并写出仓库名和怎么修；不再受影响的仓库在开发开始时移除 worktree（不强制；有未提交改动 → `blocked`；分支保留）；已存的分支名复用，基础分支改了则保留原分支并在 UI 说明；agent 的文件工具只能触及票目录（其中只有受影响仓库）。（任务 4、6、7、8、11）
3. **agent 篡改约束它的东西**：禁止路径（`infra/**`）、平台规则（`.slackoff/**`、`.git`）以及**给它的 commit 把关的 hooks**（`.githooks/`、`.husky/`、相对 `core.hooksPath` 目录——它们从被提交的分支解析，改了就会运行改过的 hook）→ 文件工具层用路径拒绝规则先拦一道；平台在 commit 前按**该仓库**的规则还原改动、记 `rule_violation`，并在每次 commit 前从 HEAD 还原 hooks 与 `.slackoff/`；规则来自基础分支。配置了 hooks 但未安装（husky v9 的 `.husky/_` 不存在时 commit 会静默跳过 hook）→ `blocked`，绝不在没有 hooks 的情况下提交。（任务 4、6、7、11）
4. **JIRA 写：票已是 In Progress、登录过期、没有该状态流转、页面把 agent 带到别的 URL（包括点击链接、不经 `navigate` 的跳转）、确认后服务重启** → 已是目标状态直接 `not_needed`；其余记 `failed` 并说明（重启后不自动重发）；越界 URL 由运行后对工具**结果**的扫描发现；开发照常进行；未经确认绝不写。（任务 6、12）
5. **多个已连接的 Chrome 浏览器**（作者的 Mac + 另一台设备）→ 未配置 `jira.browser` 时拉票、复读快照、JIRA 写都给出 "Choose the Chrome browser for JIRA in Settings"，不留下无法理解的 `blocked` 原因或 zod 失败；配置后 prompt 固定该设备，hook 拒绝 `select_browser` 到其他设备，运行后扫描发现选了其他设备 → 失败。阶段 1 的 `jira-browser` 同样适用。（任务 4、6、12、16）

---

## 文件结构

```
skills/
  propose-solutions/SKILL.md   （改）读全部仓库，方案声明 affectedRepos + 每仓库改动摘要
  design-solution/SKILL.md     设计模式（draft / revise / apply_rulings），按仓库分节
  critique-design/SKILL.md     逐项挑刺
  implement-ticket/SKILL.md    单步实现（可跨多个受影响仓库）
  jira-update/SKILL.md         只做一件写操作：改状态
  jira-browser/SKILL.md        （改）详情模式额外读出当前状态；只用配置的浏览器
packages/shared/src/
  states.ts (改), schemas.ts (改), checklist.ts (新), records.ts (新：跨包记录类型、disagreements、repoStatus)
packages/server/src/
  config.ts (改：projects[KEY].repos，兼容旧格式)
  db/migrations.ts (改：m6)
  projects/project-rules.ts          读规则文件、清单合并、命令校验、禁止路径、受影响仓库解析
  prompts/prompt-store.ts (改)       仓库级覆盖 + rules.md（多仓库）
  executor/{sandbox,types,claude-code,run-agent}.ts (改), executor/nav-guard.ts (新)
  git/worktree.ts                    worktree / 分支 / 还原 / 带 hooks 的 commit / diff
  development/{run-command,dev-repo,precheck,dev-jobs}.ts
  design/{design-repo,debate-step,debate-jobs}.ts
  jira/{jira-updater,jira-write-repo}.ts, jira/browser-jira.ts (改：固定浏览器、检测浏览器)
  requirements/requirement-repo.ts (改：choice.affectedRepos)
  tickets/ticket-repo.ts (改：ticket_repo 工作区、install 报告、jira_status 刷新)
  workflow/{jobs,recovery}.ts (改), http/{app,events}.ts (改)
  dev/{fake-mode,fake-source,fake-repo}.ts (改 / 新)
packages/server/test/  debate.test.ts, worktree.test.ts, development.test.ts, project-rules.test.ts, jira-update.test.ts, multi-repo.test.ts, sandbox.test.ts, precheck.test.ts, phase2-repos.test.ts,
                       fixtures/nav-*.jsonl …（以及各任务列出的阶段 1 测试夹具更新）
packages/web/src/
  pages/ticket/{DesignTab,DevelopmentTab,SolutionsTab,TicketPage}.tsx, pages/{SettingsPage,TicketsPage}.tsx, components/LiveLog.tsx
  lib/{debate-model,dev-model,tabs}.ts (+ .test.ts), lib/{api,states,settings-model,hooks}.ts (改), i18n/en.ts (改)
design/prompts/mobile/{m07-design-debate,m08-development}.md, design/code/mobile/m07*, m08*, design/screens/mobile/m07*, m08*
e2e/{phase2.spec.ts,mobile-phase2.spec.ts}（新）, e2e/{phase1.spec.ts,mobile.spec.ts}（改）
docs/spikes/2026-11-dev-sandbox.md（已完成）, docs/spikes/phase2-exit.md
```

---

### 任务 1：技术验证 — 命令级 Bash、多 worktree 中的开发 agent、hooks、jira-update 最小工具集（一次性）

> **已完成（commit `bc42c15`）。** 结论、证据与给后续任务的建议见 `docs/spikes/2026-11-dev-sandbox.md`；五个决定值已回填到全局约束和任务 6、7、11、12（下方步骤保留原文作记录，步骤 1 中的 `"Bash(pnpm test *)"` 是实验用规则，产品**不用**这种变体）。

决定任务 6、11、12 的实现细节。代码一次性，不进产品。在 scratch 目录里新建两个临时 git 仓库（`api`、`web`）做所有实验；**不对任何真实 JIRA 做写操作**。

- [x] **步骤 1：命令级 Bash。** 在临时仓库（`package.json` 的 `"test": "node --test"`）中运行 `claude -p '<让它运行 pnpm test，再尝试下列命令>' --output-format stream-json --verbose --permission-mode default --permission-prompts none --strict-mcp-config --setting-sources "" --tools Read Edit Write Bash --allowedTools Read Edit Write "Bash(pnpm test)" "Bash(pnpm test *)" --disallowedTools WebFetch WebSearch "Bash(git *)" < /dev/null`。对抗用例逐条记录是否被拒（看 `permission_denials`，并检查副作用文件是否出现）：`pnpm test && touch /tmp/x`、`pnpm test; touch x`、`pnpm test | sh`、`pnpm test $(touch x)`、`` pnpm test `touch x` ``、`pnpm test > ../outside.txt`、`git status`、`curl https://example.com`。
- [x] **步骤 2：多 worktree 布局与文件范围。** `git worktree add -b slackoff/T-1-x <scratch>/worktrees/T-1/api main`，`web` 同理；以票目录 `<scratch>/worktrees/T-1` 为 cwd，加 `--restricted`（2.1.319："confines the file tools to the working directories"），让 agent 分别：改 `api/` 与 `web/` 中的文件（应成功）；Write `../escape.txt`、`$HOME/escape.txt`、`api/.git`；Read `${SLACKOFF_HOME}/slackoff.db` 与主 checkout 中的文件（应失败）。再试 `cd api && pnpm test`、`pnpm --dir api test` 在何种 allow 规则下可用、且不打开步骤 1 的任何绕过。记录有无 `--restricted` 时的结果，以及与 `--setting-sources ""`、命令级 Bash 规则、`--add-dir` 的兼容性；确认主 checkout 的 `git status`、HEAD 不变。
- [x] **步骤 3：worktree 中的 hooks。** 在 `api` 中分别配置 (a) `.git/hooks/pre-commit`（公共目录）、(b) 提交到仓库的 `.husky/pre-commit` + `git config core.hooksPath .husky`（husky 方式）；在 worktree 中用 `execFile('git', ['commit', …], {stdio: ['ignore','pipe','pipe']})` 提交，确认 hook 被执行、hook 中的 `read x` 立即得到 EOF 而不挂起、失败时 commit 中止且退出码非 0、杀掉进程组后 worktree 的 `index.lock` 位置（`git rev-parse --git-path index.lock`）。记录 husky 类 hook 需要 `commands.install`（依赖安装）才能运行这一点。
- [x] **步骤 4：jira-update 最小工具集（只用本地 mock）。** 写一个本地静态页 `<scratch>/fake-jira/browse/T-1.html`（状态按钮 → 下拉 → "In Progress"，点击后文本变化），用 `python3 -m http.server --bind 127.0.0.1 <port>` 在本机提供；用 `--chrome` 依次尝试工具集 A = 只读集 + `computer`、B = 只读集 + `find` + `form_input`，看 agent 能否完成状态切换并在之后用 `get_page_text` 读回新状态。再验证导航守卫：`--settings '{"hooks":{"PreToolUse":[{"matcher":"mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__tabs_create_mcp","hooks":[{"type":"command","command":"node <guard.ts>"}]}]}}'` 与 `--setting-sources ""` 同用时 hook 是否执行、exit 2 是否阻止导航（页面里放一个指向别的 URL 的链接并让 agent 去点）。
- [x] **步骤 5：** 结论写入 `docs/spikes/2026-11-dev-sandbox.md`，必须给出五个决定值：`DEV_BASH_MODE = 'scoped' | 'none'`（任一对抗用例产生副作用即 `none`：agent 不能运行命令，平台每步替它跑测试）；`DEV_BASH_FORM`（多仓库下 agent 运行某仓库命令的允许写法，如 `pnpm --dir <repo> test`，`none` 时为空）；`DEV_RESTRICTED = true | false`——**若 `--restricted` 不能把文件工具限制在票目录内，停下找作者**（多仓库下这是"只能改受影响仓库"的唯一保证）；`JIRA_UPDATE_EXTRA_TOOLS`（只读集之外需要的最少工具名）；`NAV_GUARD = 'hook' | 'posthoc'`。另写"作者手工核对步骤"：真实 JIRA 状态切换、husky 仓库提交（供任务 17 的出口文档引用）。
- [x] **步骤 6：** 把决定值回填到任务 6、11、12，提交：`docs: dev sandbox, git hooks and jira-update spike findings`

### 任务 2：shared — 状态、清单、新 schema

**文件：** `packages/shared/src/{states,schemas,checklist,records,index}.ts`、`packages/shared/test/shared.test.ts`；为保持 `pnpm typecheck` 通过（裁决 P-C2、P-C3）：`packages/web/src/lib/states.ts`（`TONE` / `STEPS` / `NEEDS_YOU` 加入新状态）、`packages/web/src/i18n/en.ts`（新状态的 `state.*` 文案）；因 `FetchedTicket.status`、`Solution.affectedRepos` / `repoChanges` 而需更新的夹具：`packages/server/test/workflow.test.ts`（`fetched()`）、`packages/server/src/dev/fake-source.ts`（tickets）、`packages/server/src/dev/fake-mode.ts`（solutions）、`packages/server/test/{http,browser-jira,snapshot-store}.test.ts`（字面量）；文档（裁决 P-docs）：`docs/superpowers/specs/2026-11-06-slack-off-design.md` §5.1 / §5.2 / §9.3、`docs/ba/02-state-machine.mmd`、`docs/ba/05-er.mmd`

**接口（产出）：**
```ts
TicketState 新增 'checking_snapshot' | 'awaiting_snapshot_ack'
// 新增转换：
designing → design_final | awaiting_debate_ruling
awaiting_debate_ruling → designing (应用裁决) | design_final (全部采纳设计方) | awaiting_choice (改选方案)
design_final → checking_snapshot
checking_snapshot → awaiting_snapshot_ack | developing
awaiting_snapshot_ack → developing | refining
developing → dev_done
dev_done → developing (要求修改) | awaiting_choice (改选方案)
// checklist.ts
type ChecklistGroup = 'non_functional' | 'principles' | 'edge_cases' | 'cross_repo'
ChecklistItem { id: string /* ^[a-z][a-z0-9_]{1,39}$ */; group: ChecklistGroup; label: string }
DEFAULT_CHECKLIST: readonly ChecklistItem[]       // 22 项
CROSS_REPO_CHECKLIST: readonly ChecklistItem[]    // 3 项，仅受影响仓库 >1 时加入
coverage(entries: {item: string}[], items: readonly ChecklistItem[]): {missing: string[]; unknown: string[]; duplicate: string[]}
// schemas.ts
RepoName         string /* ^[a-z0-9][a-z0-9._-]{0,39}$ */
Solution         增加 affectedRepos: RepoName[]（≥1，不重复）; repoChanges: {repo: RepoName; summary: string}[]（与 affectedRepos 一一对应）
proposeResultSchema(repoNames: readonly string[]): z.ZodType<ProposeResult>   // affectedRepos 必须是映射中的名字
ChecklistEntry   { item: string; status: 'considered'|'not_applicable'; conclusion: string /* 非空 */ }
CritiqueComment  { id: string /* ^C-\d+$ */; checklistItem: string; repo: RepoName | null; blocking: boolean; text: string; suggestion: string | null }
CommentResponse  { commentId: string; verdict: 'accepted'|'rebutted'; reason: string /* 非空 */ }
DesignDoc        { contentMd: string /* 总体设计 + 跨仓库关注点 */; repos: {repo: RepoName; contentMd: string}[];
                   checklist: ChecklistEntry[]; responses: CommentResponse[] }
Critique         { comments: CritiqueComment[]; coverage: {item: string; status: 'ok'|'concern'; note: string}[] }
designDocSchema(items: readonly ChecklistItem[], mustAnswer: readonly string[], repos: readonly string[]): z.ZodType<DesignDoc>
critiqueSchema(items: readonly ChecklistItem[], repos: readonly string[]): z.ZodType<Critique>
Ruling           { commentId: string; decision: 'designer'|'critic'|'custom'; note: string }   // custom 时 note 非空
DevStepResult    { summary: string; commitMessage: string /* 单行，1–72 字符，不含票号前缀 */; done: boolean;
                   testsRun: {repo: RepoName; command: string; passed: boolean}[]; notes: string }
JiraUpdateResult { loginRequired: boolean; outcome: 'changed'|'already_in_status'|'transition_unavailable'|'failed';
                   observedStatus: string | null; detail: string }
FetchedTicket    增加 status: string | null（默认 null，兼容阶段 1 的输出）
// records.ts（裁决 P-C18：服务端各 repo 模块、HTTP 响应与 web 共用，只在这里定义）
type TestRun = {command: string; exitCode: number | null; timedOut: boolean; outputTail: string}
type CommitOutcome = {kind: 'committed'; sha: string} | {kind: 'nothing'} | {kind: 'skipped_checks_failed'}
                   | {kind: 'hook_failed'; timedOut: boolean; outputTail: string}   // skipped_checks_failed：本步 build/lint/test 失败，不提交（P-C17）
type StepRepoResult = {repo: string; violations: string[]; tests: TestRun[]; commit: CommitOutcome; pendingChanges: boolean}
type InstallReport = {run: TestRun; resetPaths: string[]}                          // S-4：install 之后被还原的路径
IterationRecord  {id; iteration; trigger: 'initial'|'developer_request'|'review_failed'|'rejected'|'retry'; note: string | null;
                  status: 'running'|'done'|'failed'; summary: string | null; startedAt; endedAt: string | null}
StepRecord       {id; step; summary; repos: StepRepoResult[]; createdAt}
JiraWriteRecord  {id; targetStatus; state: 'pending'|'confirmed'|'skipped'|'done'|'failed'|'not_needed'; detail: string | null;
                  result: unknown; decidedBy: string | null; requestedAt; decidedAt: string | null; finishedAt: string | null}
DebateRoundRecord {id; choiceId; designDocId; round; role: 'designer'|'critic'; content: Critique | {responses: CommentResponse[]}; createdAt}
RulingRecord     {id; debateRoundId; commentId; decision: Ruling['decision']; note; decidedBy; createdAt}
Disagreement     {roundId; commentId; checklistItem; repo: string | null; critic: {text; suggestion: string | null};
                  designer: {verdict: 'accepted'|'rebutted'; reason: string} | null}
disagreements(rounds: readonly DebateRoundRecord[]): Disagreement[]
  // 裁决 P-C1b：最后一个 critic 轮的**全部**阻塞评论（含设计方已 accepted 的），designer 取同一 round 号的 designer 轮中的回应（没有则 null）
type RepoStatus = 'green' | 'failing' | 'hook_failed' | 'not_run' | 'working'
repoStatus(r: {running: boolean; pending: boolean; hasTestCommand: boolean; lastTests: TestRun[] | null; lastCommit: CommitOutcome | null}): RepoStatus
  // 依次：running → working；lastCommit hook_failed → hook_failed；最近一次测试有 exitCode≠0 或 timedOut → failing；
  // pending → working；无测试命令 → not_run；否则 green
repoReady(s: RepoStatus): boolean        // green | not_run —— dev_done 的条件；not_run 在 UI 上绝不显示为通过
```
默认清单 id（顺序即 UI 顺序）：`non_functional`：`readability, maintainability, extensibility, observability, security, reusability, performance, reliability, compatibility, testability`；`principles`：`solid, dry, kiss, yagni, separation_of_concerns, fits_architecture`；`edge_cases`：`nulls, extremes, concurrency, timeouts, retries, partial_failure`；`cross_repo`：`api_contracts`（"API contracts between services"）、`rollout_order`（"Backward compatibility & rollout order"）、`versioning`（"Versioning of shared interfaces"）。label 用英文。`designDocSchema` / `critiqueSchema` 用 `superRefine` 调 `coverage`：缺项、未知项、重复项都报错并列出 id（runAgent 的重试会把它带回给 agent）；`designDocSchema` 还要求 `repos` 恰好覆盖受影响仓库（不多不少）、`mustAnswer` 中每个评论 id 恰有一条 response；`critiqueSchema` 要求 `checklistItem` 属于清单、`repo` 为 null 或受影响仓库、评论 id 不重复。阶段 1 已保存的方案没有 `affectedRepos`：读取已存记录时用 `StoredSolution`（两字段 `.default([])`），agent 输出一律走 `proposeResultSchema`。

- [ ] **步骤 1：写失败测试：** `canTransition('designing','design_final')`、`('awaiting_debate_ruling','awaiting_choice')`、`('awaiting_snapshot_ack','refining')`、`('dev_done','developing')`、`('dev_done','awaiting_choice')` 为 true；`('design_final','developing')` 为 false；`DEFAULT_CHECKLIST.length === 22`、`CROSS_REPO_CHECKLIST.length === 3`、id 全部唯一；`designDocSchema(DEFAULT_CHECKLIST, [], ['api'])` 对少一项 → 抛错且信息含缺失 id；`conclusion: ''` 抛错；`repos` 少了 `web`（受影响 `['api','web']`）→ 抛错含 `web`；`mustAnswer: ['C-1']` 而 responses 为空 → 抛错；`critiqueSchema` 对 `checklistItem: 'vibes'`、`repo: 'billing'`（不在集合中）抛错；`proposeResultSchema(['api'])` 对 `affectedRepos: ['web']` 抛错、对 `affectedRepos: []` 抛错；`Ruling.parse({commentId:'C-1', decision:'custom', note:' '})` 抛错；`DevStepResult` 的 `commitMessage` 含换行或 73 字符 → 抛错；`FetchedTicket.parse(阶段 1 样例)` 得到 `status === null`；`disagreements`：第 3 轮 critic 两条阻塞（设计方一条 accepted、一条 rebutted）+ 一条非阻塞 → 返回 2 条且各带设计方 verdict，只看最后一个 critic 轮；`repoStatus`：hook_failed 优先于测试失败、无测试命令且无改动 → `not_run`（`repoReady` 为 true）、测试超时 → `failing`、`skipped_checks_failed` 且测试失败 → `failing`。
- [ ] **步骤 2：** `pnpm -F @slackoff/shared test` 预期失败。
- [ ] **步骤 3：** 实现；更新 web `states.ts`（新状态的色调、`STEPS` 归属，`NEEDS_YOU` 加 `awaiting_debate_ruling`、`awaiting_snapshot_ack`、`dev_done`）与 `en.ts` 的 `state.*`；更新上面列出的服务端夹具（`fetched()` 等给出 `status`，fake 方案给出 `affectedRepos` / `repoChanges`）。
- [ ] **步骤 4：** 测试通过；`pnpm test`、`pnpm typecheck` 无错。
- [ ] **步骤 5（文档，裁决 P-docs：spec 文字随作者决定）：** spec §5.1 加 `checking_snapshot`、`awaiting_snapshot_ack`、`awaiting_debate_ruling → designing`（设计方应用裁决后再定稿）、`dev_done → developing / awaiting_choice`；§5.2 "进入 developing 时 JIRA 改为 In Progress" 改为"可选（`jira.syncStatus`，默认关），每次写需开发者确认（本机或已配对手机）"；§9.3 写明非"全部采纳设计方"的裁决由设计 agent 应用后再定稿；`02-state-machine.mmd` 同步状态与转换；`05-er.mmd` 的 `DESIGN_DOC`、`DEBATE_ROUND`、`DEBATE_RULING`、`DEV_ITERATION`、`CHOICE` 字段对齐迁移 6，并补上 `DEV_STEP`、`TICKET_REPO`、`JIRA_WRITE`。
- [ ] **步骤 6：** 提交：`feat(shared): phase 2 states, quality checklist, multi-repo solution and debate/dev schemas`

### 任务 3：迁移 6 + 设计 / 开发 / JIRA 写记录 / 票工作区仓库

> 注：阶段 1 已占用迁移 5（`ticket.jira_open` + `discovery_run`，拉取全部未完成票），本任务新增**迁移 6**，不改已发布的 m1–m5。

**文件：** `db/migrations.ts`、`design/design-repo.ts`、`development/dev-repo.ts`、`jira/jira-write-repo.ts`、`tickets/ticket-repo.ts`、`requirements/requirement-repo.ts`、`test/phase2-repos.test.ts`；需更新的阶段 1 测试（裁决 P-C3）：`test/database.test.ts`（现有 `assert.equal(migrations.length, 5)` 改为 6，其余用 `migrations.length` 的断言不变）、`test/tickets.test.ts`（`recordChoice` 4 参数调用保持有效，补一条 5 参数用例）

迁移 6（每条 `ADD COLUMN` 单独一条语句，裁决 P-C14）：
- `choice ADD COLUMN affected_repos_json TEXT`（阶段 1 的旧行为 NULL）
- `ticket_repo(ticket_key, repo_name, repo_path, base_branch, branch, worktree_path, install_json, created_at, PRIMARY KEY (ticket_key, repo_name))`（`install_json` = `InstallReport`，未运行 install 时 NULL）
- `design_doc(id, ticket_key, requirement_id, choice_id, version, content_json, checklist_json, responses_json, is_final INTEGER DEFAULT 0, created_at, UNIQUE(ticket_key, version))`（`content_json` = `{contentMd, repos}`）
- `debate_round(id, ticket_key, choice_id, design_doc_id, round, role CHECK IN ('designer','critic'), content_json, created_at)`
- `debate_ruling(id, ticket_key, debate_round_id, comment_id, decision CHECK IN ('designer','critic','custom'), note, decided_by, created_at, UNIQUE(debate_round_id, comment_id))`
- `dev_iteration(id, ticket_key, iteration, trigger CHECK IN ('initial','developer_request','review_failed','rejected','retry'), note, status CHECK IN ('running','done','failed'), summary, started_at, ended_at)`（`developer_request` 是对 ER 的补充：dev_done 后开发者要求修改；`retry`：步数用完 `blocked` 后重试开始的新迭代，裁决 P-C17）
- `dev_step(id, iteration_id, step, summary, repos_json, created_at, UNIQUE(iteration_id, step))`（`repos_json` = `StepRepoResult[]`）
- `jira_write(id, ticket_key, target_status, state CHECK IN ('pending','confirmed','skipped','done','failed','not_needed'), detail, result_json, decided_by, requested_at, decided_at, finished_at)`
- `agent_run ADD COLUMN rules_hash TEXT`；`agent_run ADD COLUMN repo_prompt_hash TEXT`（两条语句）
- 触发器：`debate_round`、`debate_ruling`、`dev_step` 禁止 UPDATE / DELETE，并用 m4 的 `guard()` 禁止 REPLACE；`design_doc` 同样用 `guard('design_doc')` 禁止 REPLACE，且只允许把 `is_final` 从 0 改为 1，其他任何 UPDATE / DELETE 都 `RAISE(ABORT, 'design docs are immutable')`。

**接口（产出）：**
```ts
// requirement-repo.ts
recordChoice(db, key, solutionId, note, affectedRepos: string[] | null = null): void   // 第 5 参数默认 null（裁决 P-C3），现有调用不用改；审计 choice_recorded 含 affectedRepos；任务 8 传真实集合
currentChoice(db, key): {id: number; solutionId: number; requirementId: number; note: string | null; affectedRepos: string[] | null} | null
// ticket-repo.ts
setRepoWorkspace(db, key, w: {repo: string; repoPath: string; baseBranch: string; branch: string; worktreePath: string}): void
  // upsert；同时把 ticket.branch / worktree_path 设为分支名 / 票目录；只在首次插入时审计 worktree_created（裁决 P-C14）
listRepoWorkspaces(db, key): RepoWorkspace[]                                // 同字段 + install: InstallReport | null + createdAt；只读
removeRepoWorkspace(db, key, repo: string): void                            // 审计 worktree_removed（裁决 P-C9）
recordInstall(db, key, repo: string, r: InstallReport): void                // 写 install_json；审计 repo_installed（含 resetPaths，裁决 S-4）
setJiraStatus(db, key, status: string): void                                // 更新 ticket.jira_status；审计 ticket_refreshed（裁决 P-C21，任务 10、12 使用）
// design-repo.ts
addDesignDoc(db, key, d: {requirementId: number; choiceId: number; doc: DesignDoc}): {id: number; version: number}   // 审计 design_doc_saved
listDesignDocs(db, key): DesignDocRecord[]              // {id, version, choiceId, requirementId, doc: DesignDoc, isFinal, createdAt}
markFinal(db, key, docId): void                         // 审计 design_finalized
addRound(db, key, r: {choiceId; designDocId; round: number; role: 'designer'|'critic'; content: Critique | {responses: CommentResponse[]}}): {id: number}   // 审计 debate_round_recorded
listRounds(db, key, choiceId?: number): DebateRoundRecord[]
saveRulings(db, key, roundId: number, rulings: Ruling[], decidedBy: string): void   // 每条一个审计 debate_ruling；同一轮重复提交 → InvalidTransitionError
listRulings(db, key): RulingRecord[]
// dev-repo.ts（TestRun / CommitOutcome / StepRepoResult / IterationRecord / StepRecord 来自 @slackoff/shared，任务 2）
startIteration(db, key, trigger, note: string | null): {id: number; iteration: number}
openIteration(db, key): {id: number; iteration: number} | null
addStep(db, iterationId, s: {step: number; summary: string; repos: StepRepoResult[]}): {id: number}
  // 审计 dev_step_recorded；任一仓库 violations 非空时另写 rule_violation（payload 含仓库名）
finishIteration(db, iterationId, status: 'done'|'failed', summary: string): void
listIterations(db, key): (IterationRecord & {steps: StepRecord[]})[]
// jira-write-repo.ts
requestJiraWrite(db, key, targetStatus): {id: number}            // 审计 jira_write_requested
recordNotNeeded(db, key, targetStatus, detail: string): {id: number}
decideJiraWrite(db, id, decision: 'confirmed'|'skipped', decidedBy: string): void   // 仅 pending；审计 jira_write_decided
finishJiraWrite(db, id, state: 'done'|'failed'|'not_needed', detail: string, result: unknown): void   // 仅 confirmed；审计 jira_write_finished
listJiraWrites(db, key): JiraWriteRecord[]                       // JiraWriteRecord（以及 listRounds / listRulings 返回的 DebateRoundRecord / RulingRecord）来自 @slackoff/shared；DesignDocRecord 留在 design-repo.ts
```
`decidedBy` 取值：`'local'` 或 `` `device:${id}` ``（来自远程会话）。

- [ ] **步骤 1：写失败测试：** `user_version === 6` 且 `migrations.length === 6`；对 `debate_round` UPDATE、`dev_step` DELETE 抛错；`INSERT OR REPLACE` 到 `design_doc` 抛错；同一迭代同一 `step` 第二次 `addStep` 抛错；`design_doc` 改 `content_json` 抛 `immutable`，`is_final` 0→1 成功、1→0 抛错；`addDesignDoc` 版本 1、2 递增；同一轮 `saveRulings` 第二次抛 `InvalidTransitionError`；`recordChoice(…, ['api','web'])` 后 `currentChoice().affectedRepos` 相同且审计 payload 含之；4 参数 `recordChoice` → `affectedRepos === null`；阶段 1 风格的旧 choice 行 `affectedRepos === null`；`setRepoWorkspace` 两个仓库后 `listRepoWorkspaces` 长度 2、`ticket.worktree_path` 为票目录；对同一仓库再次 `setRepoWorkspace` → 仍只有一条 `worktree_created` 审计；`removeRepoWorkspace` 后长度 1 且有 `worktree_removed`；`recordInstall` 后 `install.resetPaths` 可读回；`setJiraStatus` 写 `ticket_refreshed`；`startIteration(…, 'retry', …)` 成功；`decideJiraWrite` 对非 pending 抛错；`finishJiraWrite` 对未确认的记录抛错；每个写函数各产生对应审计事件且 `verifyAuditChain` 为 ok。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): migration 6 — design, debate, development, jira writes and per-repo workspaces`

### 任务 4：配置扩展（多仓库映射）+ 项目规则文件

**文件：** `config.ts`、`projects/project-rules.ts`、`workflow/jobs.ts`（`cwdFor` 改用新映射）、`http/app.ts`（仅 `sensitive`）、`test/config.test.ts`（默认配置的 `deepEqual` 与旧格式 `projects` 断言，裁决 P-C3）、`test/project-rules.test.ts`、`test/http.test.ts`、`test/workflow.test.ts`（`config()` 夹具改为新格式，裁决 P-C3）

**接口：**
```ts
Config.projects: Record<string, { repos: RepoRef[] }>     // RepoRef {name: RepoName; path: string; baseBranch: string}；≥1 个，name 唯一
  // 兼容：读到旧格式 {repoPath, baseBranch} → {repos: [{name: legacyRepoName(repoPath), path: repoPath, baseBranch}]}；保存总是写新格式
legacyRepoName(path: string): string        // basename 小写化、非法字符换 '-'、去掉开头的非 [a-z0-9] 字符、截断到 40；空 → 'repo'（裁决 P-C13）
  // 同一项目内与已有名字冲突时依次加 -2、-3…（settings-model 新增行时同样处理）
Config.jira += { syncStatus: boolean /* 默认 false */; inProgressStatus: string /* 默认 'In Progress'，与 readyForDevStatus 同一校验 */;
                 browser: {deviceId: string /* ^[A-Za-z0-9._:-]{1,128}$，会进 prompt */; name: string /* 1–80 字符，无换行 */} | null /* 默认 null；裁决 S-2 */ }
Config.debate = { maxRounds: number /* 1..5，默认 3 */ }
Config.development = { maxSteps: number /* 1..50，默认 12 */; commandTimeoutMs: number /* 10_000..3_600_000，默认 600_000 */;
                       hookTimeoutMs: number /* 10_000..3_600_000，默认 300_000 */ }

ProjectRules {                                   // 每个仓库自己的 .slackoff/config.json；未知键忽略
  forbiddenPaths: string[]                       // glob，相对该仓库根
  commands: { install?: string; test?: string; build?: string; lint?: string }
  jiraStatus: { inProgress?: string }
  checklist: { add: ChecklistItem[]; remove: string[] }
  prompts: Partial<Record<AgentRole, { mode: 'append'|'replace'; text: string }>>
}
loadProjectRules(repoPath: string, baseBranch: string): Promise<LoadedRules>
  // LoadedRules {rules: ProjectRules; rulesMd: string; hash: string /* sha256 前 12 位，覆盖两份文件 */; found: boolean}
  // `git -C repoPath show <baseBranch>:.slackoff/config.json`（及 rules.md）；文件不存在 → 默认值、found=false；非法 → ProjectRulesError（含仓库名、文件、字段路径）
type RepoContext = RepoRef & { rules: LoadedRules }
projectRepos(t: Ticket, config: Config): RepoRef[]                                    // 未映射 → RepoNotMappedError("Map project <KEY> to a repo in Settings")（裁决 P-C19）
affectedRepos(t: Ticket, choice: {affectedRepos: string[] | null}, config: Config): RepoRef[]
  // null（阶段 1 旧选择）且项目只有 1 个仓库 → 该仓库；null 且多个 → RepoNotMappedError("Choose the affected repositories again")；
  // 名字不在映射中 → RepoNotMappedError("Repository <name> is no longer mapped for project <P> — fix Settings or choose a different solution")
resolveChecklist(repos: readonly RepoContext[]): ChecklistItem[]
  // DEFAULT_CHECKLIST（+ CROSS_REPO_CHECKLIST 当 repos.length > 1）− 被**每个**仓库都 remove 的项 + 各仓库 add 的并集（同 id 取先出现者）；remove 未知 id → ProjectRulesError
isSafeCommand(cmd: string): boolean                          // /^[A-Za-z0-9_.\/:@=+,-]+( [A-Za-z0-9_.\/:@=+,-]+)*$/，≤200 字符
ALWAYS_FORBIDDEN: readonly string[] = ['.git', '.git/**', '.slackoff/**', '.husky/**', '.githooks/**']   // hooks 目录：裁决 S-3、P-C17
isForbidden(path: string, rules: ProjectRules, extra: readonly string[] = []): boolean
  // node:path matchesGlob，对 ALWAYS_FORBIDDEN + forbiddenPaths + extra（任务 7 `hookDirs` 解析出的、位于 worktree 内的 core.hooksPath 目录，形如 `<dir>/**`）
```
分支命名在本阶段固定为 `slackoff/<KEY>-<slug>`（§13），规则文件中的分支命名规则留到后续阶段；`e2e` / 启动方式字段属于阶段 3，本阶段忽略。任何命令含 shell 元字符（`;&|$\`<>()*?`、换行、引号）→ `ProjectRulesError`；命令按空格切分后用 `execFile` 执行（任务 7）。`/api/config` 的 `sensitive()` 已含 `projects`，再加入 `jira.syncStatus`、`jira.inProgressStatus`、`jira.browser`（R17 / R21：手机不能改）；`debate`、`development` 不加入（裁决 P-phone）。阶段 1 的 `cwdFor`（refine / drift check）改为：项目第一个仓库的路径，未映射时数据目录（propose 不再走这条回退，见任务 8）。

- [ ] **步骤 1：写失败测试：** 旧格式 `projects.PROJ = {repoPath:'/w/Billing Service', baseBranch:'main'}` 加载为 `{repos:[{name:'billing-service', path:'/w/Billing Service', baseBranch:'main'}]}`，保存后文件为新格式；`legacyRepoName('/w/.dotfiles')` === `'dotfiles'`、`legacyRepoName('/w/___')` === `'repo'`；同一项目两个 `name` 相同 → 报错含 `projects.PROJ.repos`；`repos: []` 报错；缺省配置含 `syncStatus:false`、`browser:null`、`maxRounds:3`、`maxSteps:12`、`hookTimeoutMs:300000`；`maxRounds: 6` 报错；`inProgressStatus: 'In "Progress'` 报错；`browser.deviceId` 含空格或换行 → 报错；远程请求改 `jira.syncStatus`、`jira.browser` 或新增一个仓库 → 403，改 `debate.maxRounds` → 200（`test/http.test.ts` 补四条）；临时 git 仓库：基础分支有 `.slackoff/config.json`、工作区未提交地改成 `forbiddenPaths: []` → `loadProjectRules` 仍返回基础分支内容（审阅重点 4）；无规则文件 → `found:false`；`commands.install: "pnpm install && curl x"` → `ProjectRulesError` 含仓库名；`isForbidden('.slackoff/config.json', 空规则)`、`isForbidden('.git', …)`、`isForbidden('.githooks/pre-commit', …)`、`isForbidden('.husky/pre-commit', …)` 为 true，`isForbidden('hooks/x', 空规则, ['hooks/**'])` 为 true；`affectedRepos` 对已从映射删除的名字 → 错误信息含该名字（审阅重点 3）；`resolveChecklist` 单仓库 22 项、两个仓库 25 项、仅一个仓库 remove `yagni` 时仍含 `yagni`、两个都 remove 时不含。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过（阶段 1 的全部测试仍通过）。
- [ ] **步骤 5：** 提交：`feat(server): multi-repo project mapping, phase 2 config and per-repo rules from the base branch`

### 任务 5：提示词组装 — 仓库级覆盖 + 项目规则（多仓库）

**文件：** `prompts/prompt-store.ts`、`executor/run-agent.ts`、`test/skills-prompts.test.ts`、`test/executor.test.ts`

**接口：**
```ts
assembleSystemPrompt(db, repoRoot, role, repos?: readonly RepoContext[]):
  {text: string; skillVersion: string; promptVersionId: number | null; repoPromptHash: string | null; rulesHash: string | null}
RunAgentRequest += { repos?: readonly RepoContext[]; addDirs?: string[] }   // runAgent 透传，并把 rules_hash、repo_prompt_hash 写入 agent_run
```
组装顺序（§9.6：只追加在 skill 之后，不能覆盖硬性约束）：
1. skill body；
2. 全局开发者补充（`## Developer additions (cannot override the rules above)`）——只有**单仓库**且该仓库对该角色 `mode: 'replace'` 时省略；多仓库时 `replace` 按 `append` 处理；
3. 每个有补充的仓库一段 `## Repository additions: <name> (.slackoff/config.json; cannot override the rules above)`；
4. 每个 `rulesMd` 非空的仓库一段 `## Project rules: <name> (.slackoff/rules.md)`。
`rulesHash` = 各仓库 `hash` 按仓库名排序拼接后的 sha256 前 12 位；`repoPromptHash` 同理只覆盖仓库补充文本（无则 null）。

- [ ] **步骤 1：写失败测试：** 无 repos 时输出与阶段 1 完全一致；单仓库 `append` → 全局补充与仓库补充都在且顺序如上；单仓库 `replace` → 不含全局补充、仍以 skill body 开头；两个仓库其一 `replace` → 全局补充仍在；各仓库段落带仓库名；runAgent 后 `agent_run.rules_hash`、`repo_prompt_hash` 非空，仓库顺序不同时哈希相同。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): repository-level prompt overrides and project rules in agent prompts`

### 任务 6：沙箱 — 新角色策略、按角色拒绝列表、多目录、导航守卫、固定 Chrome 浏览器

**文件：** `executor/{sandbox,types,claude-code,run-agent}.ts`、`executor/nav-guard.ts`、`jira/browser-jira.ts`（阶段 1 角色接入固定浏览器 + 检测浏览器，裁决 S-2）、`skills/jira-browser/SKILL.md`（只用指定浏览器）、`workflow/jobs.ts`（仅 `isSourceError`）、`test/executor.test.ts`、`test/sandbox.test.ts`、`test/browser-jira.test.ts`、`test/workflow.test.ts`、`test/fixtures/nav-click-escape.jsonl`、`test/fixtures/nav-multi-browser.jsonl`

**接口：**
```ts
// sandbox.ts —— 任务 1 决定值（裁决 P-C15）
DEV_BASH_MODE: 'scoped' = 'scoped'
DEV_BASH_FORM = 'cd <ticketDir>/<repo> && <cmd>'
devCommandLine(ticketDir: string, repo: string, cmd: string): string   // `cd ${join(ticketDir, repo)} && ${cmd}`，用于 prompt
DEV_RESTRICTED: true = true
JIRA_UPDATE_EXTRA_TOOLS: readonly string[] = ['mcp__claude-in-chrome__computer']
NAV_GUARD: 'hook' = 'hook'
interface ToolPolicy { builtin: readonly string[]; allowed: readonly string[]; denied: readonly string[]; chrome: boolean; restricted: boolean }
interface PolicyContext {
  commands?: readonly string[]                 // 裸命令（如 'pnpm test'），去重
  bashMode?: 'scoped' | 'none'                 // 默认 DEV_BASH_MODE
  denyPaths?: readonly string[]                // 仓库内相对的禁止 glob，转成路径拒绝规则
  navAllow?: readonly string[]
  browser?: {deviceId: string} | 'list' | null // chrome 角色：固定设备 / 检测模式 / 未配置
}
toolPolicy(role: AgentRole, ctx?: PolicyContext): ToolPolicy
assertWithinPolicy(role, allowedTools, chrome, ctx?): ToolPolicy           // 校验用 policy.denied（不再用全局 DENIED_TOOLS）
bashAllowRules(commands: readonly string[]): string[]     // 每条命令 c → 仅 [`Bash(${c})`]；**没有** `Bash(${c} *)` 变体
pathDenyRules(globs: readonly string[]): string[]         // 每个 g → [`Edit(/**/${g})`, `Write(/**/${g})`]（任务 1 §2.1 验证过的写法）
CHROME_ALL_TOOLS: readonly string[]                       // 全部 claude-in-chrome 工具名（只读 + 写类）
RunAgentRequest += { policy?: PolicyContext }             // 裁决 P-C6
ExecRequest += { disallowedTools: string[]; restricted: boolean; addDirs: string[]; settingsJson: string | null }
// executor/types.ts
class NavigationViolationError extends Error { detail: string[] }      // 越界 URL 或非指定浏览器
class BrowserChoiceRequiredError extends Error {}                      // 文案 "Choose the Chrome browser for JIRA in Settings"
// nav-guard.ts（同时是 PreToolUse hook 脚本：从 stdin 读 hook JSON，不允许则 stderr 说明 + exit 2）
navAllowed(url: string, allow: readonly string[]): boolean
navViolations(rawLogPath: string, allow: readonly string[]): string[]
  // 扫描 tool_use 中 navigate / tabs_create_mcp 的 url，**以及** tool_result 文本中的 URL："Tab Context" 行的 ("<url>") 与 get_page_text 的 `URL:` 行（任务 1 §4.3）
browserViolations(rawLogPath: string, deviceId: string): string[]      // 任何 select_browser 的 deviceId ≠ 配置值、或出现 switch_browser
multipleBrowsersReported(rawLogPath: string): boolean                   // tool_result 含 "Multiple Chrome browsers are connected"
navGuardSettings(o: {allow: readonly string[] | null; deviceId: string | null}): string
  // --settings JSON：matcher `navigate|tabs_create_mcp|select_browser`，命令 `node <abs nav-guard.ts>`，allow / deviceId 经环境变量
  // SLACKOFF_NAV_ALLOW / SLACKOFF_BROWSER 传入；没有 tool_input.url 的调用（tabs_create_mcp 发 `{}`）放行；allow 为 null 时不查 URL
// browser-jira.ts
BrowserJira.listBrowsers(): Promise<{deviceId: string; name: string}[]>   // mode: browsers；只允许 ToolSearch + list_connected_browsers
```
策略表：
| 角色 | builtin（`--tools`） | allowed | denied | chrome | restricted |
|---|---|---|---|---|---|
| `propose-solutions`（改）、`design-solution`、`critique-design` | Read Grep Glob | 同 builtin | 阶段 1 `DENIED_TOOLS` | 否 | `DEV_RESTRICTED` |
| `implement-ticket` | Read Grep Glob Edit Write（`bashMode='scoped'` 且有命令时 + Bash，必须显式写进 `--tools`，`--restricted` 否则会去掉它） | builtin 中的非 Bash 工具 + `bashAllowRules(ctx.commands)` | `WebFetch WebSearch NotebookEdit` + `CHROME_ALL_TOOLS` + `Bash(git *) Bash(gh *) Bash(curl *) Bash(wget *) Bash(ssh *) Bash(scp *) Bash(nc *)` + `pathDenyRules(['.slackoff/**', '.githooks/**', '.husky/**', ...ctx.denyPaths])` | 否 | `DEV_RESTRICTED` |
| `jira-browser`（阶段 1，改） | ToolSearch | `CHROME_READ_TOOLS`（+ `select_browser` 当 `ctx.browser` 为设备；+ `list_connected_browsers` 当为 `'list'`） | `DENIED_TOOLS` 去掉上述按需放行的工具 | 是 | 否 |
| `jira-update` | ToolSearch | `CHROME_READ_TOOLS` + `JIRA_UPDATE_EXTRA_TOOLS` + `select_browser`（`ctx.browser` 为设备时） | `DENIED_TOOLS` 去掉 allowed 中的工具（`form_input`、`javascript_tool`、`file_upload` 等仍拒绝） | 是 | 否 |

`claude-code.ts` 改用 `req.disallowedTools`（不再引用全局 `DENIED_TOOLS`），allowed 与 disallowed 有交集则拒绝；`restricted` 为真时加 `--restricted`；每个 `addDirs` 加 `--add-dir <dir>`；`settingsJson` 非空时加 `--settings <json>`。`runAgent` 把 `req.policy` 传给 `toolPolicy` / `assertWithinPolicy`，据此算出 `disallowedTools`、`restricted`、`settingsJson`（裁决 P-C6）。只读角色在多仓库时 cwd = 第一个仓库、其余仓库进 `addDirs`；`implement-ticket` 的 cwd = 票目录、`addDirs` 为空（票目录内只有受影响仓库，审阅重点 2）。`jira-update` 的 `navAllow` = `[`${base}/`, `${base}/browse/${key}`]`：`navAllowed` 要求 origin 与 base 相同，且路径恰为 `/` 或 `/browse/<KEY>`（允许 query / hash）。

chrome 角色的运行后检查（`runAgent`，在解析输出与 zod 重试**之前**）：`policy.browser` 为 `null` 且 `multipleBrowsersReported` → 抛 `BrowserChoiceRequiredError`（不重试）；为设备时 `browserViolations` 非空 → `NavigationViolationError`；有 `navAllow` 时 `navViolations` 非空 → `NavigationViolationError`（任务 12 记为 failed）。chrome 角色都传 `navGuardSettings`（`jira-browser` 的 `allow` 为 null，只核对设备；未配置浏览器且无 `navAllow` 时不传，argv 与阶段 1 相同）。

阶段 1 `jira-browser` 接入（裁决 S-2）：`BrowserJira` 读取 `cfg.browser`；配置了 → `allowedTools` 加 `select_browser`、`policy.browser = {deviceId}`、prompt 加一行 `browser: call select_browser with deviceId <id> ("<name>") before any other browser tool; never select another browser`；`discover` / `fetchTicket` 遇到 `BrowserChoiceRequiredError` 与 `JiraLoginRequiredError` 同样上抛；`workflow/jobs.ts` 的 `isSourceError` 加入它，因此与登录过期走同一路径：页面顶部 `source_error` 显示该文案，票上的抓取进入 `blocked` 时原因就是这句话（不是 zod 失败或笼统的 agent 错误），`retry` 可恢复。`listBrowsers`（设置页"Detect browsers"，任务 13 路由）用 `policy.browser = 'list'`。SKILL.md 规则 1 增加：只用 prompt 指定的浏览器；若工具报告多个浏览器已连接而 prompt 没有指定，立即停止。`list_connected_browsers` 在 `-p` 模式下的输出格式未经任务 1 验证——不可用时设置页退回手动填写 deviceId（任务 16）。

- [ ] **步骤 1：写失败测试（argv 断言，用记录参数的假 claude）：** `implement-ticket` 且 `commands:['pnpm test']` → argv 含 `--restricted`、`--tools` 含 `Bash`、`--allowedTools … "Bash(pnpm test)"` 且**不含** `"Bash(pnpm test *)"`、`--disallowedTools` 含 `WebFetch`、`WebSearch`、`mcp__claude-in-chrome__navigate`、`Bash(git *)`、`Edit(/**/.slackoff/**)`、`Write(/**/.githooks/**)`、`Write(/**/.husky/**)`，`denyPaths:['infra/**']` 时另含 `Write(/**/infra/**)`；不含 `--chrome`、不含 `--add-dir`、不含 `bypassPermissions`、不含 `--no-verify`；`commands: []` → `--tools` 不含 Bash；`policy.bashMode='none'` 时即便有命令也不含 Bash；`devCommandLine('/h/worktrees/K-1', 'api', 'pnpm test')` === `'cd /h/worktrees/K-1/api && pnpm test'`；`implement-ticket` 请求 `WebFetch` → `SandboxPolicyError`；`design-solution` 两个仓库 → `--add-dir <第二个仓库>` 恰出现一次；`jira-update` argv 含 `--chrome`、`mcp__claude-in-chrome__computer`，配置浏览器时含 `select_browser` 与 `--settings`，不含 `form_input`、`javascript_tool`、`file_upload` 于 allowed；单仓库时 `refine-ticket` 与未配置浏览器的 `jira-browser` 的 argv 与阶段 1 逐字相同，`propose-solutions` 与阶段 1 相同**仅多** `--restricted`（裁决 P-C4）（回归）；`jira-browser` 配置浏览器 → allowed 含 `select_browser`、prompt 含 deviceId、disallowed 不含 `select_browser`；`navAllowed('https://j.example.com/browse/K-1?x=1', allow)` true，`'https://j.example.com/browse/K-2'`、`'https://evil.example/browse/K-1'`、`'https://j.example.com.evil.io/'` false；`navViolations` 从 `nav-click-escape.jsonl`（所有 `navigate` 都合法，越界 URL 只出现在点击之后 `get_page_text` 的 `URL:` 行和 "Tab Context" 行）找出越界 URL；`browserViolations` 对 `select_browser` 到其他 deviceId 返回非空；`nav-multi-browser.jsonl` + 未配置浏览器 → `runAgent` 抛 `BrowserChoiceRequiredError` 且文案为 "Choose the Chrome browser for JIRA in Settings"、未触发 zod 重试；refine 中的抓取遇到它 → `source_error` 事件与 `blocked` 原因都是该文案（`workflow.test.ts`）；hook 脚本对越界 URL exit 2、对 `tabs_create_mcp` 的 `{}` 输入 exit 0、对 `select_browser` 到其他设备 exit 2；`BrowserJira.listBrowsers` 的 argv 只允许 `ToolSearch` 与 `list_connected_browsers`。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(executor): sandbox policies for design, critique, implement and jira-update roles; pinned Chrome browser`

### 任务 7：git worktree 管理（多仓库）+ 带 hooks 的 commit + 命令运行

**文件：** `git/worktree.ts`、`development/run-command.ts`、`test/worktree.test.ts`

`run-command.ts` 从 `git/worktree.ts` 导入 `git()` 所用的进程组执行实现，依赖方向只有 development → git；`TestRun` / `CommitOutcome` 来自 `@slackoff/shared`，`git/` 不导入 `development/`（裁决 P-C16）。

**接口：**
```ts
class WorktreeError extends Error {}
git(cwd: string, args: string[], timeoutMs?: number): Promise<{code: number | null; stdout: string; stderr: string; timedOut: boolean}>
  // execFile，stdio ['ignore','pipe','pipe']，detached（超时杀整组），GIT_TERMINAL_PROMPT=0
ticketSlug(title: string): string        // NFKD 去变音 → 小写 → 非 [a-z0-9] 变 '-' → 合并、去首尾 '-' → 截断到 ≤40（在 '-' 处截断）；空 → 'ticket'
branchName(key: string, title: string): string     // `slackoff/${key}-${ticketSlug(title)}`，并经 `git check-ref-format --branch` 校验；只在该 (票, 仓库) 首次建 worktree 时调用（裁决 P-C8）
ticketDir(home: string, key: string): string       // join(home, 'worktrees', key)
worktreePath(home: string, key: string, repo: string): string   // join(ticketDir(home, key), repo)
ensureWorktree(o: {home; key; repo: RepoRef; branch: string}): Promise<{path: string; created: boolean}>
  // branch 由调用方给出：已存的 ticket_repo.branch，或首次时的 branchName(key, title)
removeWorktree(home, key, repo: RepoRef): Promise<void>     // `worktree remove`（不加 --force）；有未提交改动 → WorktreeError 含仓库名；分支保留（裁决 P-C9）
assertPlatformWorktree(home: string, path: string): void    // realpath 必须是 realpath(home)/worktrees/<KEY>/<repo>，否则 WorktreeError
changedPaths(wt: string): Promise<string[]>                 // status --porcelain -z -uall，含未跟踪
revertPaths(home, wt, paths: string[]): Promise<void>        // 已跟踪 → restore --source=HEAD --staged --worktree；未跟踪 → 删除
hookDirs(wt: string): Promise<string[]>
  // `rev-parse --path-format=absolute --git-path hooks`（遵从 core.hooksPath）落在 worktree 内时返回其相对路径（如 '.githooks'、'.husky/_'）；否则 []
hooksInstalled(wt: string): Promise<{configured: boolean; installed: boolean; hooksPath: string | null}>
  // configured = 设置了 core.hooksPath，或 worktree 的 package.json 依赖 / 脚本中出现 husky；installed = 解析后的 hooks 目录里
  // 至少有一个可执行、非 *.sample 的文件（裁决 S-3；任务 1 §3：husky v9 未安装时 commit 会静默跳过 hook）
restoreProtected(home, wt): Promise<string[]>
  // 从 HEAD 还原 `.slackoff/`、`.husky/`、`.githooks/` 与 hookDirs(wt)：已跟踪的 restore，未跟踪的删除（被 .gitignore 忽略的不动，如 `.husky/_`）；返回被还原的路径
commitAll(home, wt, message: string, hookTimeoutMs: number): Promise<CommitOutcome>
  // restoreProtected → `add -A` → `commit -m`（两步，绝不 `commit -a`，裁决 S-5；运行仓库自己的 hooks，绝不 --no-verify）；
  // 无改动 → nothing；退出码非 0 或超时 → hook_failed（outputTail 为 hook 输出末尾 8KB）；
  // 超时杀进程组后，若 `rev-parse --path-format=absolute --git-path index.lock` 指向的锁存在则删除——先校验该路径恰为
  // `<git-common-dir>/worktrees/<id>/index.lock`（<id> 取自 worktree 的 `.git` 文件，worktree 本身先过 assertPlatformWorktree）；
  // 不对锁路径调用 assertPlatformWorktree（锁在主仓库的 .git 下）；仓库无 user.name/email 时用 -c user.name="Slack Off" -c user.email=slackoff@localhost
resetToHead(home, wt): Promise<void>                         // reset --hard HEAD + clean -fd，先 assertPlatformWorktree
commitsSince(wt, baseBranch): Promise<{sha: string; subject: string}[]>
diffStat(wt, baseBranch): Promise<{files: number; insertions: number; deletions: number}>
diffText(wt, baseBranch, maxBytes = 1_000_000): Promise<{text: string; truncated: boolean}>
runCommand(cwd: string, cmd: string, timeoutMs: number): Promise<TestRun>
  // development/run-command.ts；isSafeCommand 校验后按空格切分 execFile；同样 stdin 关闭、独立进程组；outputTail 为合并输出末尾 8KB
```
`ensureWorktree` 规则（错误信息都带仓库名）：`rev-parse --show-toplevel` 失败 → `WorktreeError("<name>: <path> is not a git repository")`；`rev-parse --verify <baseBranch>^{commit}` 失败 → `WorktreeError("<name>: base branch <b> not found")`；目标路径已是该仓库的 worktree 且在该分支 → 复用（`created:false`）；分支已存在但无 worktree → `worktree add <path> <branch>`；否则 `worktree add -b <branch> <path> <baseBranch>`；路径已存在但不是该仓库的 worktree → `WorktreeError`。hooks 位置由 git 自己解析（公共目录的 `hooks/` 或 `core.hooksPath`；相对的 `core.hooksPath` 按 worktree 解析，即来自被提交的分支），平台不改 hooks 配置，只保证提交前 hooks 文件等于 HEAD。

- [ ] **步骤 1：写失败测试（真实临时 git 仓库）：** `ticketSlug('Implement Stripe tax calculation fallback webhook')` === `'implement-stripe-tax-calculation'`；`ticketSlug('Café — ünïcode!!')` === `'cafe-unicode'`；`ticketSlug('???')` === `'ticket'`；两个仓库 `api`、`web` 各自 `ensureWorktree` → 路径为 `worktrees/K-1/api`、`worktrees/K-1/web`，分支名相同；主 checkout 有未提交改动和一个 stash 时 `ensureWorktree` 成功，且之后主 checkout 的 HEAD、`git status --porcelain`、`git stash list` 完全不变（审阅重点 2）；第二次调用 `created:false`；**先删除 worktree 目录**再 `worktree prune`，然后再调用 → 复用已有分支（裁决 P-tests）；传入与 `branchName` 结果不同的已存分支名 → 用传入的分支；`web` 基础分支不存在 → `WorktreeError` 含 `web` 和分支名；`removeWorktree` 干净时成功且分支仍在，有未提交文件时 `WorktreeError` 含仓库名；`resetToHead(home, 主 checkout)` → 抛 `WorktreeError` 且主 checkout 未变；`revertPaths` 能还原已跟踪文件并删除未跟踪文件。**hooks：** `pre-commit` 输出 "lint failed" 并 exit 1 → `{kind:'hook_failed'}` 且 `outputTail` 含 "lint failed"、HEAD 未前进；hook exit 0 → `committed`，sha 40 位、subject 等于 message；hook `sleep 5` 且 `hookTimeoutMs=500` → `hook_failed`、`timedOut:true`、`<repo>/.git/worktrees/<name>/index.lock` 不存在、无残留 `sleep` 进程、随后 `commitAll` 可正常提交；预先放一个陈旧的 `index.lock` 再让 hook 超时 → 锁被删除；hook 中 `read x` 不挂起（stdin 关闭）；`core.hooksPath=.husky` 的仓库中 `.husky/pre-commit` 在 worktree 内被执行。**篡改 hooks（裁决 S-3）：** `core.hooksPath=.githooks`、hook 拒绝提交，worktree 中把 `.githooks/pre-commit` 改成 `exit 0` → `commitAll` 仍为 `hook_failed`，且 `.githooks/pre-commit` 已恢复为 HEAD 内容；worktree 中改 `.slackoff/config.json` → 提交后该文件等于 HEAD；`hookDirs` 对 `core.hooksPath=.githooks` 返回 `['.githooks']`、对公共 `.git/hooks` 返回 `[]`；husky v9 布局（`core.hooksPath=.husky/_`，`.husky/_/` 被忽略且不存在）→ `hooksInstalled` 为 `{configured:true, installed:false}`，生成 `.husky/_/pre-commit` 后 `installed:true`。无改动 → `nothing`；`runCommand(wt, 'node -e "x"')` 因引号被拒；超时用例 `timedOut:true`。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): per-ticket, per-repo git worktrees, commits through the repo's own hooks, safe command runner`

### 任务 8：多仓库方案 + 选择受影响仓库

**文件：** `skills/propose-solutions/SKILL.md`、`workflow/jobs.ts`（`runPropose`、`choose`）、`http/app.ts`（`/choose`）、`test/multi-repo.test.ts`、`test/workflow.test.ts`

**接口：**
```ts
Workflow.choose(key: string, solutionId: number, note: string, affectedRepos?: string[]): void
  // 省略 → 用该方案的 affectedRepos；给出 → 必须非空、全部在映射中、不重复，否则 ValidationError；与方案不同也允许（开发者编辑），审计记录两者
Workflow.rechoose(key: string): void      // awaiting_debate_ruling | dev_done → awaiting_choice（本任务实现 dev_done 分支，任务 9 用于裁决）
POST /api/tickets/:key/choose  body {solutionId, note, affectedRepos?}
```
`runPropose`：项目未映射 → `RepoNotMappedError` → `blocked`，原因 "Map project <KEY> to a repo in Settings"（裁决 P-C19；不再回退到数据目录）；cwd = 第一个仓库，其余仓库 `addDirs`；argv 与阶段 1 相同，只可能多出 `--restricted` / `--add-dir`（裁决 P-C4）；prompt 增加 `repos: [{name, path, baseBranch}]`；schema = `proposeResultSchema(repo names)`。只有一个仓库时方案的 `affectedRepos` 必然是它。SKILL 要点：读每个仓库（只读）；每个方案在 `affectedRepos` 中只列真正需要改的仓库，并在 `repoChanges` 中逐仓库写改动摘要；涉及多个仓库时在 `risks` 写明接口契约和发布顺序。

- [ ] **步骤 1：写失败测试：** `workflow.test.ts` 的夹具把 `PROJ` 映射到一个临时假仓库（裁决 P-C19），阶段 1 的 workflow 用例照常通过；项目未映射 → propose 前 `blocked` 且原因为 "Map project PROJ to a repo in Settings"、未调用 agent；单仓库 → propose 的 argv 与阶段 1 相同、仅多 `--restricted`（裁决 P-C4 的回归用例）；项目映射两个仓库 → argv 含 `--add-dir`、prompt 含两个仓库名；方案 `affectedRepos: ['billing']`（不在映射中）→ 重试 1 次后 `blocked`；`choose` 不给 `affectedRepos` → choice 取方案的集合；给 `['web']`（方案为 `['api','web']`）→ 保存 `['web']`、审计 payload 同时含两者；给 `[]` 或未知名字 → `ValidationError`（HTTP 400）；远程会话 `/choose` 成功（拍板允许）；`dev_done` → `rechoose` → `awaiting_choice`。阶段 1 e2e 会因 `choose` 之后进入 `designing` 而改变终点，其更新归任务 17（裁决 P-C12）。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat: multi-repo solutions with affected repositories confirmed at choice`

### 任务 9：设计 + 辩论流程（含 skills `design-solution`、`critique-design`）

**文件：** `skills/{design-solution,critique-design}/SKILL.md`、`design/{debate-step,debate-jobs}.ts`、`workflow/{jobs,recovery}.ts`、`http/events.ts`、`test/debate.test.ts`、`test/skills-prompts.test.ts`

先把 `jobs.ts` 中的 `mustGet / move / atomic / job / requireState / cwdFor` 收拢成导出的 `WorkflowCtx`，`createDebateJobs(ctx)`、后续 `createDevJobs(ctx)` 都接收它（`jobs.ts` 已超过 400 行，新流程放各自文件）。`WorkflowCtx` 另有两个由后续任务填充的挂钩，默认 no-op：`afterDesignFinal(key: string): void`（任务 10 实现）和 `onDevelopmentStarted(key: string, repos: RepoContext[]): void`（任务 12 实现；调用方 fire-and-forget，不等待、不因其失败而改变票状态，裁决 P-C7）。辅助函数 `repoContexts(key): Promise<RepoContext[]>` = `affectedRepos(ticket, currentChoice, config)` + 每个仓库 `loadProjectRules`。

**接口：**
```ts
type DebateStep =
  | {kind: 'draft'} | {kind: 'critique'; round: number} | {kind: 'revise'; round: number; mustAnswer: string[]}
  | {kind: 'finalize'; docId: number} | {kind: 'escalate'} | {kind: 'apply_rulings'; roundId: number; mustAnswer: string[]}
  // apply_rulings.mustAnswer = 裁决为 critic / custom 的评论 id（裁决 P-C1b）
nextDebateStep(s: {docs: DesignDocRecord[]; rounds: DebateRoundRecord[]; rulings: RulingRecord[]; maxRounds: number}): DebateStep
  // docs/rounds/rulings 只含当前 choice；DebateRoundRecord / RulingRecord / Disagreement / disagreements() 来自 @slackoff/shared（任务 2）
Workflow += { ruleDebate(key: string, rulings: Ruling[], decidedBy: string): void }   // 仅 awaiting_debate_ruling
BusEvent += {type: 'debate_updated'; ticketKey: string}
```
`nextDebateStep` 规则（纯函数，可从库中状态恢复）：
- 无设计文档 → `draft`。
- 最新文档已被 critic 评过：该轮无阻塞意见 → `finalize(该文档)`；有阻塞 → `revise`（`mustAnswer` = 该轮阻塞评论 id）。
- 最新文档未被评过：critic 轮数已达 `maxRounds`（即最新文档是第 max 轮修订后的版本，或其后应用裁决产生的版本）→ 若该轮已有裁决：全为 `designer` → `finalize(最新文档)`；最新文档比每条裁决都新（`createdAt` 晚于全部裁决，即裁决已被应用）→ `finalize(最新文档)`（裁决 P-C1，防止 `apply_rulings` 无限循环）；否则 `apply_rulings`；无裁决 → `escalate`。否则 → `critique(round = critic 轮数 + 1)`。

流程：
- `choose` 之后入队 `design:<KEY>`；job 循环调用 `nextDebateStep` 直到 `finalize` 或 `escalate`。每一步开始前调用 `repoContexts`（映射变了 → `RepoNotMappedError` → `blocked`，审阅重点 3）。
- `draft` / `revise` / `apply_rulings`：`design-solution`，cwd = 第一个受影响仓库，其余 `addDirs`（只读工具）；输入：锁定版本的需求、选定方案、开发者备注、受影响仓库列表、清单（`resolveChecklist(repos)`），`revise` 另加当前文档和该轮评论，`apply_rulings` 另加 `disagreements()` 与裁决；schema = `designDocSchema(items, step.mustAnswer, repoNames)`（`draft` 为 `[]`）；`revise` 的新文档与同一 round 号的 `designer` 轮（responses）在同一个 `atomic()` 中写入（裁决 P-C1b），`apply_rulings` 只写新文档。
- `critique`：`critique-design`（全新会话），输入：需求、当前文档、受影响仓库、清单、此前各轮评论与设计方的结构化回应（`CommentResponse`，不含设计 agent 的其他文字、不含任何会话 id）；schema = `critiqueSchema(items, repoNames)`。
- `finalize` → `markFinal` → `design_final` → `ctx.afterDesignFinal(key)`。
- `escalate` → `awaiting_debate_ruling`（审计 payload 含分歧数）。
- `ruleDebate`：裁决必须与 `disagreements` 一一对应（缺、多、custom 空 note → `ValidationError`）→ `saveRulings` → 全为 designer 则 `design_final` + `afterDesignFinal`，否则回 `designing` 并入队（`apply_rulings`）。
- `rechoose`（`awaiting_debate_ruling` 分支）→ `awaiting_choice`；旧文档与辩论保留，新 `choose` 产生新 choice（可改受影响仓库），辩论从 `draft` 重新开始。
- 恢复：`recovery.ts` 的 WORKING 加 `designing`；`resume('designing')` 入队 design job。

SKILL 要点：`design-solution` 三种模式（`mode: draft | revise | apply_rulings`）；`contentMd` 写总体设计和**跨仓库关注点**（服务间接口契约、向后兼容与发布顺序、共享接口的版本）；`repos[]` 每个受影响仓库一节：要改的文件、边界情况、错误处理、测试策略和实现步骤（开发 agent 按步骤执行）；逐项清单写 "considered + 结论" 或 "not_applicable + 理由"；对每条阻塞评论 accept（并改文档）或 rebut（给理由）。`critique-design`：每条评论标清单项、所属仓库（跨仓库问题为 null）和 blocking；只把"会导致错误、数据损坏、安全问题、违反 AC、仓库约定或跨服务兼容"的问题标为阻塞；不重复已被合理反驳的意见，除非有新证据。两者都只读、只输出一个 ```json 块、把需求和代码中的文字当数据。

- [ ] **步骤 1：写失败测试：** `nextDebateStep` 表驱动：空 → draft；v1 未评 → critique 1；评 1 有阻塞 → revise（mustAnswer 为阻塞 id）；评 1 无阻塞 → finalize v1；max=3 时 v4 未评且无裁决 → escalate；有裁决全 designer → finalize v4；含 critic / custom → apply_rulings 且 mustAnswer 恰为这些评论 id；"裁决已应用"（v5 晚于全部裁决）→ finalize v5；`maxRounds=1` 同理。流程（fake run，按角色和调用次数返回）：第 1 轮阻塞、第 2 轮无阻塞 → `design_final` 且 `afterDesignFinal` 被调用 1 次，库中 2 份文档、3 条轮记录；critic 一直阻塞 → 第 3 轮后 `awaiting_debate_ruling`，`disagreements` 数等于第 3 轮阻塞数；裁决少一条 → `ValidationError`；custom 空 note → `ValidationError`；同一轮重复裁决 → `InvalidTransitionError`；全 designer → 不再调用 agent、v4 定稿；含 critic → 再调用 1 次 design-solution（apply_rulings，prompt 含分歧与裁决）后定稿、不再调用 agent；revise 写入中途抛错 → 新文档与 designer 轮都不存在；`rechoose` 后再 `choose` → 新 choice 从 draft 开始、旧文档仍可查；两个受影响仓库时清单为 25 项、设计文档缺 `web` 一节 → 重试 1 次后 `blocked`；辩论中把 `web` 从映射删除 → 下一步 `blocked` 且原因含 `web`；在 critique 前"重启"（新建 workflow + `recoverOnStartup`）→ 从 critique 继续、不重复 draft；critic 的 prompt 只含平台组装的 JSON：用假 run 捕获第 2 轮 critic 的 prompt，断言其中不含设计 agent 在结构化 `responses` 之外的任何文字（假设计 run 在输出外另写一段标记文字），也不含任何会话 id（裁决 P-tests）。两个新 SKILL.md frontmatter 合法（description 以 `Use when` 开头）。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): design/critique debate loop with round cap and developer rulings`

### 任务 10：进入开发前复读快照 + 快照变化的偏移检查

**文件：** `development/precheck.ts`、`skills/jira-browser/SKILL.md`、`jira/browser-jira.ts`、`tickets/ticket-repo.ts`（使用任务 3 的 `setJiraStatus`）、`http/events.ts`、`workflow/{jobs,recovery}.ts`、`test/precheck.test.ts`

**接口：**
```ts
Workflow += {
  ackSnapshot(key: string, note: string): void   // awaiting_snapshot_ack → developing 并入队 develop:<KEY>（裁决 P-C21）；note 必填（R13）
  replan(key: string): void                      // awaiting_snapshot_ack → refining
}
BusEvent += {type: 'snapshot_changed'; ticketKey: string; needsAck: boolean}
```
实现 `ctx.afterDesignFinal`：`design_final → checking_snapshot` 并入队 `precheck:<KEY>`。流程（状态 `checking_snapshot`）：`source.fetchTicket` → `loginRequired` → `JiraLoginRequiredError`（→ `blocked`，重试回到 `checking_snapshot`；`BrowserChoiceRequiredError` 同样处理，原因即其文案）→ `saveSnapshot`；`status` 非 null 时**无论快照是否变化**都 `setJiraStatus`（审计 `ticket_refreshed`，裁决 P-C21）。
- `created:false` → `developing`，入队开发（任务 11）。
- `created:true` → `refine-ticket` 核对模式（与阶段 1 `runDriftCheck` 同一 prompt 组装，抽成共享函数 `buildDriftPrompt`），基准 = 首个需求 + 基准快照，当前 = 选定方案锁定的需求，最新快照 = 刚保存的 → `saveDrift(trigger 'snapshot_changed')`（其审计 `drift_checked` 含 `needsAck`）→ emit `snapshot_changed` → `driftNeedsAck(result) ? awaiting_snapshot_ack : developing`（spec §9.9 只警告不阻塞：只有"无出处 / 矛盾"才要求已知晓，裁决 P-C5）；进入 `developing` 时入队开发。
- `ackSnapshot` → `acknowledgeDrift(note)` → `developing` → 入队 `develop:<KEY>`。`replan` → `refining`。
- 恢复：WORKING 加 `design_final`（重新调用 `afterDesignFinal`）和 `checking_snapshot`。
`jira-browser` 详情模式额外读出当前 JIRA 状态到 `status`（读不到就 null，不得猜）。

- [ ] **步骤 1：写失败测试：** 设计定稿后自动进入 `checking_snapshot`；快照未变 → `developing` 且无 drift 记录、开发 job 入队；快照变了且偏移结果需要已知晓 → 新 drift 记录 `trigger === 'snapshot_changed'` → `awaiting_snapshot_ack`、收到 `snapshot_changed`（`needsAck:true`）；快照变了但偏移结果不需要已知晓 → 同样有 drift 记录与 `snapshot_changed`（`needsAck:false`）事件和 `drift_checked` 审计，但直接 `developing`；空 note `ackSnapshot` → `ValidationError`；ack 后 `developing` 且开发 job 入队；`replan` → `refining`；登录过期 → `blocked`，`retry` 后回到 `checking_snapshot` 并重新抓取；快照未变但 `status: 'In Progress'` → 写入 `ticket.jira_status` 并有 `ticket_refreshed` 审计；重启时停在 `design_final` 或 `checking_snapshot` 的票都被恢复。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): re-read the JIRA snapshot before development and require ack on change`

### 任务 11：开发流程（多仓库，含 skill `implement-ticket`）

**文件：** `skills/implement-ticket/SKILL.md`、`development/dev-jobs.ts`、`workflow/{jobs,recovery}.ts`、`http/events.ts`、`test/development.test.ts`

**接口：**
```ts
Workflow += { requestChanges(key: string, note: string): void }   // dev_done → developing，新迭代 trigger 'developer_request'，note 必填
BusEvent += {type: 'dev_step'; ticketKey: string; iteration: number; step: number}
// 仓库状态用 @slackoff/shared 的 repoStatus / repoReady（任务 2），本任务不另写判定函数
```
流程 `develop:<KEY>`（状态 `developing`）：
1. **工作区准备。** `repoContexts(key)`（项目未映射或任一受影响仓库不可用 → `blocked`，原因含仓库名，审阅重点 2）。
   - 不再受影响的仓库（`listRepoWorkspaces` 中有、受影响集合中没有，例如改选方案后）→ `removeWorktree`（不强制）+ `removeRepoWorkspace`；有未提交改动 → `blocked`（"<repo> is no longer affected but its worktree has uncommitted changes"）；分支保留（裁决 P-C9）。
   - 每个受影响仓库：有已存行 → 复用其 `branch`（不再按当前标题计算 slug，裁决 P-C8）；已存 `repo_path` 与映射中的路径不同 → `blocked`（"<repo>: mapped path changed from <old> to <new> — restore it or choose a different solution"）；已存 `base_branch` 与映射不同 → 保留现有分支继续，`/development` 显示说明（任务 13 `baseBranchChanged`）。无已存行 → `branch = branchName(key, title)`。然后 `ensureWorktree({home, key, repo, branch})` → `setRepoWorkspace`。
   - 仅当 `created:true` 且声明了 `commands.install`：平台 `runCommand(install)`，失败 → `blocked`（原因含仓库名与输出末尾）；成功后 `changedPaths` 全部 `revertPaths`，`recordInstall({run, resetPaths})`（UI 列出，裁决 S-4）。复用的 worktree 不再运行 install。
   - 每个仓库 `hooksInstalled`：`configured && !installed` → `blocked`（"<repo>: git hooks are configured (core.hooksPath=…) but not installed; declare commands.install"，裁决 S-3）。
2. 本票第一次进入开发（尚无任何迭代）→ `ctx.onDevelopmentStarted(key, repos)`（fire-and-forget，裁决 P-C7）。
3. 取 `openIteration`；没有 → 若最近一次迭代是 `failed`（步数用完后 `retry`）则 `startIteration('retry')` 并对每个仓库 `resetToHead`（commit 保留、未提交改动丢弃；README 与 UI 说明，裁决 P-C17），否则 `startIteration('initial')`。若上一次中断的步骤**没有** `dev_step` 记录，对每个仓库 `resetToHead`（丢弃中断留下的半步改动）；若上一步已记录（例如 hook 或测试失败留下的改动），保留改动交给下一步。
4. 循环 `step = 已有步数 + 1 … development.maxSteps`：
   - `implement-ticket`，cwd = `ticketDir(home, key)`，`policy` = `{commands: 各仓库声明的 test/build/lint 裸命令去重, denyPaths: 各仓库 forbiddenPaths 与各仓库 hookDirs 的 '<dir>/**' 的并集（拒绝规则不分仓库，宁可多拒）}`（`bashMode` 用默认 `DEV_BASH_MODE`；为 `'none'` 时不给命令），schema `DevStepResult`，`repos` = 仓库上下文；prompt 含：锁定需求、定稿设计（总体 + 各仓库节）、选定方案与备注、本迭代 note、已完成步骤摘要、上一步每个仓库的测试 / hook 输出末尾、每个仓库的禁止路径、每个仓库可运行命令的**唯一写法** `devCommandLine(ticketDir, repo, cmd)`（`cd <ticketDir>/<repo> && <cmd>`，并说明 Bash 的 cwd 在调用之间保留、不得用其他写法）、`mode: step`。
   - 对每个受影响仓库：`changedPaths` → 命中 `isForbidden(path, rules, hookDirs 的 '<dir>/**')` 的路径 `revertPaths`，记入 violations（审阅重点 3）；有改动时平台运行该仓库的 `build`、`lint`、`test`（声明了才跑）；**任一失败 → 本步不提交该仓库**，`commit = {kind:'skipped_checks_failed'}`，改动保留、输出交给下一步（裁决 P-C17）；否则 `commitAll(`${key}: ${commitMessage}`, hookTimeoutMs)`（内部先从 HEAD 还原 hooks 与 `.slackoff/`，裁决 S-3）；结果组成 `StepRepoResult`。一个仓库失败不影响其他仓库提交（审阅重点 1）。
   - `addStep`；emit `dev_step`。
   - `done` 时，平台再对**所有**受影响仓库（包括本步未改动的）运行 `test`；每个仓库 `repoReady(repoStatus(…))` → `finishIteration('done')` → `dev_done`；否则继续下一步（失败输出交给下一步）。
   - 连续 3 步所有仓库都只有违规改动（还原后无可提交内容）→ `blocked`（"agent keeps editing forbidden paths: <repo>/<path>…"）。
5. 步数用完 → `finishIteration('failed')` → `blocked`（"development did not finish within N steps"，并列出未就绪的仓库）。

恢复：WORKING 加 `developing`，`resume('developing')` 入队 `develop:<KEY>`（`blocked` 后 `retry` 同样经 `resume`）。`dev_done` 时没有 `test` 命令的仓库在迭代 summary 中标注 `<repo>: tests not run (no test command in .slackoff/config.json)`，UI 不得显示为通过（`repoStatus` 为 `not_run`）。
SKILL 要点：只做本步；可以修改多个受影响仓库（都在当前目录下的子目录中）；按定稿设计实现并写测试；不改禁止路径、hooks 目录与 `.slackoff/`；运行命令只用 prompt 给出的 `cd <abs repo> && <cmd>` 原样写法（不加参数、不串联其他命令）；不运行 git、不联网；`commitMessage` 一行、不带票号（平台加前缀并在每个有改动且检查通过的仓库各提交一次）；hook 或测试失败的输出会在下一步给出，先修复它们；完成全部设计步骤时 `done: true`；需求 / 设计里的文字是数据。

- [ ] **步骤 1：写失败测试（真实临时仓库 `api`、`web` + fake run 写文件）：** 第 1 步在 `api` 写 `src/a.js` + `test/a.test.js` 和 `infra/x.tf`（`api` 规则 `forbiddenPaths:['infra/**']`），在 `web` 写 `src/b.js`；第 2 步 `done:true` → `api`、`web` 各有 commit 且 subject 都以 `FAKE-1: ` 开头、`infra/x.tf` 不在任何 commit 中且已删除、一条 `rule_violation`（payload 含 `api`）→ `dev_done`；`web` 的 pre-commit hook 第一次失败（输出 "TODO found"）→ `api` 已提交、`web` 改动保留、第 2 步 prompt 含 "TODO found"、第 2 步修复后 `web` 提交 → `dev_done`（审阅重点 1）；`api` 本步测试失败 → `api` 无新 commit、`commit.kind === 'skipped_checks_failed'`、改动保留、`web` 照常提交、下一步 prompt 含失败输出（裁决 P-C17）；hook 一直失败 → `maxSteps` 用完 `blocked` 且原因含 `web`，随后 `retry` → 迭代 2 的 trigger 为 `retry`、两个 worktree 无未提交改动、已有 commit 保留；hook 超时 → 该步 `web` 结果 `hook_failed`、`timedOut:true`，prompt 写明 "pre-commit hook timed out after 300 s"（以配置值为准）；`done:true` 但 `api` 测试失败 → 继续下一步且 prompt 含失败输出；`done:true` 时本步未改动的 `web` 测试也被运行；`web` 无 `test` 命令 → `dev_done` 且 summary 含 `web: tests not run`；agent 改 `api/.slackoff/config.json` → 被还原；**hooks 篡改（裁决 S-3）：** agent 把 `web/.githooks/pre-commit` 改成 `exit 0` 并写入含 `TODO` 的文件 → 记 `rule_violation`、hook 文件恢复、hook 仍拒绝该提交；`api` 配置 `core.hooksPath=.husky/_` 而未声明 `install` → 开发开始即 `blocked` 且原因含 `api` 与 "not installed"，agent 未被调用；**install（裁决 S-4）：** `web` 新建 worktree 时运行其 `install`（假 install 修改一个已跟踪文件并新建一个未跟踪文件）→ 两者都被还原、`listRepoWorkspaces` 的 `install.resetPaths` 列出它们、第 1 步开始前工作区干净；复用 worktree 时不运行 install；连续 3 步只改 `infra/**` → `blocked`；第 2 步执行中途"重启"（两个 worktree 都有未提交文件、该步未记录）→ 恢复后两个仓库的未提交文件都被丢弃、从第 2 步重跑、主 checkout 不变；hook 失败步骤之后"重启" → 保留 `web` 的改动；`web` 基础分支不存在 → `blocked` 含 `web`，`api` 的 worktree 保留，修复后 `retry` 继续（审阅重点 2）；**工作区变化（裁决 P-C8、P-C9）：** 票标题在开发前改变 → 已存分支名被复用；映射中 `web` 的路径改变 → `blocked` 含 `web`；映射中 `web` 的 `baseBranch` 改变 → 继续使用原分支；`rechoose` 后只选 `api` 再开发 → `web` 的 worktree 与 `ticket_repo` 行被删除、分支仍在，`web` 有未提交文件时 → `blocked` 含 `web`；`requestChanges` 空 note → `ValidationError`，有 note → 新迭代 trigger `developer_request`；`onDevelopmentStarted` 只在第一次进入开发时被调用 1 次且收到两个仓库上下文；agent 进程 cwd 等于 `ticketDir(home, key)` 且该目录下只有 `api`、`web`；agent prompt 含 `cd <ticketDir>/api && node --test`。SKILL.md frontmatter 合法。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): multi-repo implement-ticket loop with forbidden paths and git hooks enforced by the platform`

### 任务 12：JIRA 改为 In Progress（可选、逐次确认，含 skill `jira-update`）

**文件：** `skills/jira-update/SKILL.md`、`jira/jira-updater.ts`、`workflow/{jobs,recovery}.ts`（接入；`WorkflowDeps` 增加 `updater: JiraUpdater`，裁决 P-C7）、`main.ts`（构造 `BrowserJiraUpdater`）、`test/jira-update.test.ts`、`test/fixtures/nav-click-escape.jsonl`（复用任务 6）

**接口：**
```ts
interface JiraUpdater { setStatus(key: string, targetStatus: string): Promise<JiraUpdateResult> }
class BrowserJiraUpdater implements JiraUpdater { constructor(run: Run, cfg: Config['jira'], cwd: string) }   // cfg.browser 用于固定浏览器
WorkflowDeps += { updater: JiraUpdater }
maybeRequestInProgress(key: string, repos: RepoContext[]): void            // 赋给 ctx.onDevelopmentStarted
Workflow += {
  confirmJiraWrite(key: string, writeId: number, decidedBy: string): void   // pending → confirmed，入队 jira-write:<id>
  skipJiraWrite(key: string, writeId: number, decidedBy: string): void
  retryJiraWrite(key: string, writeId: number): void                         // 仅 failed：新建一条 pending
}
BusEvent += {type: 'jira_write_updated'; ticketKey: string}
```
规则：
- `maybeRequestInProgress`：`config.jira.syncStatus` 为 false → 什么都不做。目标状态 = `repos` 中第一个受影响仓库规则文件的 `jiraStatus.inProgress` ?? `config.jira.inProgressStatus`（规则值同样过 `isValidReadyForDevStatus` 校验；多个仓库声明了不同值时用全局配置值并在 detail 中说明）。`ticket.jira_status` 与目标（trim、忽略大小写）相同 → `recordNotNeeded(detail: "Already <status> in JIRA — nothing to change")`；否则 `requestJiraWrite`。
- job：`BrowserJiraUpdater.setStatus` → 角色 `jira-update`，`chrome: true`，`allowedTools` = `CHROME_READ_TOOLS` + `JIRA_UPDATE_EXTRA_TOOLS`（即 `computer`）+（配置了 `jira.browser` 时）`select_browser`，`policy` = `{navAllow: 按任务 6, browser: cfg.browser ? {deviceId} : null}`；prompt：（配置了浏览器时）先 `select_browser` 到 `<deviceId>`、不得选其他浏览器；打开 `${base}/browse/${key}` 的新标签页；只用 `find` 定位元素、`computer` 的 `left_click`（按 ref）点击，**不得**输入文字或按键；只把状态改为目标值，不改其他字段、不评论；最后必须用 `get_page_text` 读回状态；关闭标签页。`already_in_status` → `not_needed`；`changed` → 平台再用只读 `source.fetchTicket` 核对 `status`，一致 → `done` 并 `setJiraStatus`（裁决 P-C21），否则 `failed`（"JIRA did not confirm the change"）；`transition_unavailable` / `failed` / `loginRequired` / `NavigationViolationError`（包括只在工具结果中出现的越界 URL，以及选了其他浏览器）/ `BrowserChoiceRequiredError`（"Choose the Chrome browser for JIRA in Settings"）/ 任何异常 → `failed` 并写明原因。**任何结果都不改票的平台状态。**
- 确认可来自本机或已配对手机（作者决定）；`decidedBy` 与结果都进审计。
- 启动恢复：处于 `confirmed` 但未结束的写记录一律 `finishJiraWrite('failed', 'interrupted by restart — retry to send again')`，**不自动重发**。
- 本任务的所有验证只用假 run / 假 source（以及任务 1 的本地 mock）；真实 JIRA 由作者按任务 17 的出口文档手工验证。

SKILL 要点：每次只做 prompt 中指定的那一个状态变更；只用 prompt 指定的浏览器；只在给定的两个 URL 内活动、不点击指向其他页面的链接；只用 `find` + `computer left_click`，不输入、不按键，结束前用 `get_page_text` 读回状态；看到登录页输出 `loginRequired: true`；目标状态不在可选流转中 → `transition_unavailable`，不得选相近的状态；不得编辑字段、评论、指派；输出 `JiraUpdateResult`。

- [ ] **步骤 1：写失败测试（假 run / 假 source）：** `syncStatus:false` → 进入 developing 后无 `jira_write` 记录；开启且 `jira_status` 为 `in progress` → 一条 `not_needed`、未调用 agent；开启且为 `Ready for Dev` → `pending`，未确认前 agent 调用次数为 0；确认 → 调用 1 次、核对通过 → `done` 且 `ticket.jira_status` 更新为目标值、有 `ticket_refreshed` 审计；核对不一致 → `failed`；`loginRequired` → `failed` 含 "log in"；`NavigationViolationError` → `failed` 含越界 URL；原始日志只在工具结果里出现越界 URL（`nav-click-escape.jsonl`）→ `failed` 含该 URL；未配置浏览器且日志报告多个浏览器 → `failed` 含 "Choose the Chrome browser for JIRA in Settings"；配置了浏览器 → 请求的 `allowedTools` 含 `select_browser`、prompt 含 deviceId 与 "get_page_text"；`skip` → `skipped`、不调用；`retry` 对非 failed 抛错；以上所有情况票状态都停在 `developing` / 继续开发（审阅重点 5）；`decidedBy: 'device:3'` 出现在审计 payload；`confirmed` 记录在 `recoverOnStartup` 后为 `failed` 且 agent 未被调用；`jira-update` 的 argv 断言见任务 6。SKILL.md frontmatter 合法。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): optional, per-write confirmed JIRA In Progress sync via jira-update role`

### 任务 13：HTTP API + SSE

**文件：** `http/app.ts`、`http/events.ts`、`test/http.test.ts`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tickets/:key/design` | `{choiceId, affectedRepos, checklist, maxRounds, docs: [{version, isFinal, createdAt, checklist}], rounds, rulings, disagreements, step: DebateStep}`（不含正文） |
| GET | `/api/tickets/:key/design/docs/:version` | 单个版本（含 `contentMd`、`repos`、responses） |
| POST | `/api/tickets/:key/debate/rulings` | `{rulings: Ruling[]}` |
| POST | `/api/tickets/:key/rechoose` | `awaiting_debate_ruling` 或 `dev_done` |
| POST | `/api/tickets/:key/snapshot-ack` · `/replan` | `{note}` / 无 |
| GET | `/api/tickets/:key/development` | `{branch, ticketDir, repos: [{name, branch, worktreePath, baseBranch, baseBranchChanged: {stored, mapped} \| null, rulesFound, commands, forbiddenPaths, hooks: {configured, installed, hooksPath}, install: InstallReport \| null, diffStat, commits, status: RepoStatus}], iterations (steps，每步按仓库的 tests / commit / violations), jiraWrites, jiraSync: {enabled, targetStatus}}`；`status` 由服务端用 `repoStatus` 计算（裁决 P-C18） |
| GET | `/api/tickets/:key/diff?repo=<name>` | `text/plain`，`diffText` 结果，截断时响应头 `X-Truncated: 1`；未知仓库 404 |
| POST | `/api/tickets/:key/development/request-changes` | `{note}` |
| POST | `/api/tickets/:key/jira-writes/:id/confirm` · `/skip` · `/retry` | |
| POST | `/api/jira/browsers/detect` | 仅限本机（R21）：`BrowserJira.listBrowsers()` → `{browsers: [{deviceId, name}]}`；失败 → 502 并带原因（裁决 S-2） |
| GET | `/api/events` | 新增 `debate_updated`、`dev_step`、`jira_write_updated`、`snapshot_changed` |

`/development` 的响应类型在 `web/src/lib/api.ts` 中命名为 `DevelopmentResponse`，其中的记录类型直接用 `@slackoff/shared` 的定义（任务 16 使用）。`decidedBy` 由服务端根据请求来源决定（本机 `local`，远程会话 `device:<id>`），不接受客户端传入。`/api/status` 的待拍板数与 `NEEDS_YOU` 加入 `awaiting_debate_ruling`、`awaiting_snapshot_ack`、`dev_done`，并另计 pending 的 JIRA 写。所有新路由经过 R15 守卫与远程会话认证；均不属于仅限本机的路由（R17 / R21 只约束配置类写入，已在任务 4 处理）。

- [ ] **步骤 1：写失败测试（`app.request()`）：** 裁决缺一条 → 400；非 `awaiting_debate_ruling` 时提交裁决 → 409；同一轮第二次提交 → 409；`rechoose` 在 `developing` 时 → 409；`snapshot-ack` 空 note → 400；`request-changes` 在 `developing` 时 → 409；`jira-writes/:id/confirm` 对另一张票的 id → 404；远程会话确认后审计 `decidedBy` 为 `device:<id>`、body 里伪造的 `decidedBy` 被忽略；`/design` 对未知票 404；`/diff?repo=web` 无 worktree → 409、`repo=billing` → 404；`/development` 返回两个仓库且顺序与映射一致，`status` 与 `repoStatus` 对同一数据的结果相同，`install.resetPaths` 与 `baseBranchChanged` 按库中数据返回；SSE 收到 `dev_step`、`snapshot_changed`；远程无会话访问 `/api/tickets/K-1/design` → 401；远程会话 `POST /api/jira/browsers/detect` → 403，本机 → 200 且返回假 run 给出的列表。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): http api for design debate, multi-repo development and jira write decisions`

### 任务 14：移动端设计稿 m07 / m08（由 controller 通过浏览器操作 Stitch 完成）

不写产品代码；按 `design/README.md`"移动端"一节的方法执行，作者审批后才开始任务 15、16。

交付物：
- `design/prompts/mobile/m07-design-debate.md`、`m08-development.md`：英文提示词，附 `00-global.md`；内容依据 `docs/ba/functional-spec.md` §8、§9 和本计划任务 13 的数据。
- m07 Design & debate（390×844）：顶栏票号 + 橙色 "Awaiting ruling" 徽章；可横向滚动的页签；受影响仓库标签（如 `api` `web`）；设计文档版本选择 + 可折叠的总体设计与各仓库小节；质量清单按组折叠（含 "Cross-repo" 组）、每项显示结论与评论数，"Disputed" 红标；辩论时间线每轮一张卡片，挑刺与设计方观点**上下堆叠**、评论带仓库标签；分歧裁决每条一张卡片，三个选项为整行 ≥44px 的单选行，custom 展开文本框；吸底栏：左次按钮 "Choose a different solution"，右橙色主按钮 "Finalize design"，下方 "This will:" 说明（"Record your rulings in the audit log and finalize the design. JIRA is not changed."）。
- m08 Development（390×844）：**仓库选择器**（顶部分段控件 / 下拉，显示每个仓库的通过 / 失败 / 进行中状态点）；所选仓库的分支 / worktree（等宽、可复制、截断不溢出）、commit 列表、测试与 hook 结果（"pre-commit hook failed" 与 "tests not run" 的警示样式）、禁止路径拦截卡片；JIRA 同步卡片的三种状态（关闭 / 待确认：橙色卡片 "Set PROJ-128 to In Progress in JIRA" + "This will: open the ticket in your Chrome and change only its status" / 已跳过或失败）；可折叠的实时日志；`dev_done` 时吸底栏：左 "Request changes"，右主按钮 "Hand off to acceptance" 置灰并注明 "Available in phase 3"；`awaiting_snapshot_ack` 变体：快照变化摘要 + "Acknowledge & start development"（需填说明）/ "Re-plan from requirements"。
- 每页两张截图：`design/screens/mobile/m07-design-debate{,-viewport}.png`、`m08-development{,-viewport}.png`（CDP 390 宽、DPR 2）；代码导出 `design/code/mobile/m07-design-debate.html`、`m08-development.html`，并跑 `python3 design/fix-mobile-export.py <html> PROJ-128`。
- 桌面稿修正：`design/code/06-design-debate.html` 底部 "Automated sequence upon finalization … transition JIRA to In Progress" 与 "JIRA is read-only except that one confirmed status change … upon finalization" 改为 "JIRA is not changed. If JIRA status sync is on, you will be asked separately before Slack Off sets the ticket to In Progress."；`design/code/07-development.html` 的分支 / worktree 区改为按仓库分组（至少两个仓库）；重新截图 `design/screens/06-design-debate.png`、`07-development.png`。
- `design/README.md` 的"本地修改记录 / 移动端"补上 06、07、m07、m08 的修改说明。
- [ ] **提交：** `design: mobile design debate (m07) and development (m08); desktop 06/07 JIRA copy and multi-repo grouping`

### 任务 15：Web — 方案页的受影响仓库 + 设计与辩论页签

**文件：** `pages/ticket/SolutionsTab.tsx`、`pages/ticket/DesignTab.tsx`、`pages/ticket/TicketPage.tsx`、`pages/TicketsPage.tsx`（`tabFor` 改用共享的 `defaultTab`，裁决 P-C11）、`components/LiveLog.tsx`、`lib/debate-model.ts`、`lib/debate-model.test.ts`、`lib/tabs.ts`、`lib/tabs.test.ts`、`lib/hooks.ts`（裁决 P-C10）、`lib/api.ts`、`i18n/en.ts`（新状态的色调与 `NEEDS_YOU` 已在任务 2 完成）

**接口：**
```ts
affectedDraft(solution: {affectedRepos: string[]}, mapped: string[], picked: string[] | null): {repos: string[]; edited: boolean; error: string | null}
  // 默认取方案的集合；空集 → error；edited = 与方案不同
checklistPanel(checklist: ChecklistItem[], doc: DesignDoc | null, rounds: DebateRoundRecord[]):
  {group: ChecklistGroup; items: {id; label; status: 'considered'|'not_applicable'|'missing'; conclusion: string; comments: number; disputed: boolean}[]; disputed: number}[]
  // disputed = 当前未解决的阻塞评论指向该项
rulingDraftValid(disagreements: Disagreement[], draft: Record<string, {decision?: Ruling['decision']; note: string}>): {ok: boolean; missing: string[]}
finalizeCaption(draft): string   // 全部 designer → "Finalize version vN as is"；否则 "Ask the designer agent to apply your rulings, then finalize"
// Disagreement / DebateRoundRecord 来自 @slackoff/shared
// lib/tabs.ts（裁决 P-C11：TicketPage 与 TicketsPage 共用，替换两处各自的实现）
TABS: readonly ['snapshot','requirements','coverage','solutions','design','development']
defaultTab(state: TicketState): Tab
// lib/hooks.ts（裁决 P-C10）
SSE 监听增加 debate_updated、dev_step、jira_write_updated、snapshot_changed（对应票的数据 refetch）；
agent_event 按票保存在有界缓冲（每票最近 500 条，先进先出）中，供 LiveLog 订阅：useAgentEvents(key, roles?: AgentRole[])
```
Solutions（05 / m04）：项目映射多于 1 个仓库时，每张方案卡片显示受影响仓库标签和逐仓库改动摘要；选中方案后出现可勾选的仓库列表（≥44px 行），默认即方案的集合；改动后决策卡片的 "This will:" 说明 "Start the design for <repos> (edited from the proposal)"；单仓库项目界面与阶段 1 相同。
Design & debate（06 / m07）：受影响仓库标签；文档版本切换（Markdown 渲染：总体设计 + 各仓库小节，v(n−1)↔vn 行 diff）、清单面板（含 Cross-repo 组）、辩论时间线（每轮可折叠，最后一轮默认展开，评论带仓库标签）、轮数指示 "Round 2 of 3"、实时活动流（`LiveLog` 用 `useAgentEvents(key, ['design-solution','critique-design'])`）、`awaiting_debate_ruling` 时的裁决卡片（`DecisionCard`：主按钮 "Finalize design"，`rulingDraftValid` 不通过时禁用并列出缺项；次按钮 "Choose a different solution"）。"Export" 下载当前版本 `.md`。`TABS` 加 `design`、`development`（去掉 "phase 2/3" 灰显）；共享 `defaultTab` 保留阶段 1 的各状态映射，并对 `designing / awaiting_debate_ruling / design_final` 返回 `design`（任务 16 再补开发相关状态）。

- [ ] **步骤 1：写失败测试（`node --test`）：** `affectedDraft` 默认等于方案集合、`edited:false`；取消全部 → `error` 非空；改为子集 → `edited:true`；`checklistPanel` 对单仓库清单分 3 组（10 / 6 / 6），对 25 项清单分 4 组（含 3 项 `cross_repo`）、缺结论的项为 `missing`、有未解决阻塞评论的项 `disputed`；`rulingDraftValid` 缺一条 → `missing` 含该 id，custom 空白 note 视为缺；`finalizeCaption` 两种文案；`defaultTab`：阶段 1 各状态与原 `TicketPage.defaultTab` / `TicketsPage.tabFor` 的结果一致，`awaiting_debate_ruling` → `design`；事件缓冲：同一票第 501 条事件挤掉第 1 条，其他票不受影响。
- [ ] **步骤 2：** 实现页签与组件；所有新文案进 `en.ts`。
- [ ] **步骤 3：** `pnpm -F web test`、`pnpm -F web build` 通过；在 390px 下手动检查无横向滚动、按钮 ≥44px（同样的检查由任务 17 的 `mobile-phase2.spec.ts` 自动化，裁决 P-tests）。
- [ ] **步骤 4：** 提交：`feat(web): affected repositories on solutions; design & debate tab with checklist coverage and rulings`

### 任务 16：Web — 开发页签（按仓库）、快照变化确认、JIRA 写确认、设置

**文件：** `pages/ticket/DevelopmentTab.tsx`、`pages/ticket/CoverageTab.tsx`、`pages/SettingsPage.tsx`、`lib/dev-model.ts`、`lib/dev-model.test.ts`、`lib/{api,settings-model,tabs,hooks}.ts`、`lib/tabs.test.ts`、`i18n/en.ts`

**接口：**
```ts
repoViews(dev: DevelopmentResponse): {name: string; status: RepoStatus /* 原样取 dev.repos[i].status，不重新推导（裁决 P-C18） */;
                                      commits: {sha7: string; subject: string}[]; lastTests: TestRun[]; lastHook: CommitOutcome | null; violations: string[];
                                      notes: string[] /* install 还原的路径、基础分支已变更的说明 */}[]
iterationView(it: IterationRecord & {steps: StepRecord[]}, repo: string): {title: string; tests: 'passed'|'failed'|'not_run'; hook: 'passed'|'failed'|'timed_out'|'none'; violations: string[]}
jiraCard(writes: JiraWriteRecord[], sync: {enabled: boolean; targetStatus: string}):
  | {kind: 'off'} | {kind: 'pending'; id: number; thisWill: string} | {kind: 'running'}
  | {kind: 'done'|'not_needed'|'skipped'; text: string} | {kind: 'failed'; id: number; text: string}
RepoRow { key: string; name: string; path: string; baseBranch: string }      // settings-model：每行一个 (项目, 仓库)，按 key 分组成 repos[]
browserChoice(cfg: Config['jira']['browser'], detected: {deviceId; name}[] | null): {selected: string | null; options: {deviceId; label}[]; manual: boolean}
  // detected 为 null（未检测或检测失败）→ manual: true，显示 deviceId 文本框
```
Development（07 / m08）：≥lg 每个受影响仓库一个分组（分支、worktree、基础分支、规则文件、commit、测试 / hook、拦截记录、"Open diff"；`notes` 显示为提示行："Reset after install: pnpm-lock.yaml"、"Base branch changed to <mapped> — this ticket keeps <branch> from <stored>"）；<lg 顶部仓库选择器，一次显示一个仓库（状态点来自 `repoViews`）；JIRA 卡片（`jiraCard`；pending 用橙色 `DecisionCard`，主按钮 "Send to JIRA"、次按钮 "Don't change JIRA"，"This will: open <KEY> in your Chrome and change only its status to <status>. Recorded in the audit log."）；规则文件卡片（未找到 → "No .slackoff/config.json on <base> — no forbidden paths beyond .git/.slackoff, no test command"）；"Open diff"（页内 `<pre>` 显示 `/diff?repo=`，截断提示）；`LiveLog`（`useAgentEvents(key, ['implement-ticket'])`；`dev_step`、`jira_write_updated` 由 `lib/hooks.ts` 触发 refetch，裁决 P-C10）。`dev_done`：`DecisionCard` 主按钮 "Hand off to acceptance" 禁用并显示 "Available in phase 3"，次按钮 "Request changes"（展开必填说明）；另有 "Choose a different solution"（`rechoose`）。`awaiting_snapshot_ack`：在 AC coverage 页签复用阶段 1 的偏移卡片，主按钮 "Acknowledge & start development"（note 必填），次按钮 "Re-plan from requirements"；共享 `defaultTab`（`lib/tabs.ts`，任务 15）对该状态返回 `coverage`，对 `checking_snapshot / developing / dev_done` 返回 `development`。
设置：仓库映射表改为每行（项目 key、仓库名、路径、基础分支），同一项目可多行，校验仓库名格式与项目内唯一（由路径生成默认名时用 `legacyRepoName` 的同一规则，重名加 -2…）；"Agent prompts" 列出新角色 `design-solution`、`critique-design`、`implement-ticket`、`jira-update`；"流程"分区：`debate.maxRounds`、`development.maxSteps`、`development.hookTimeoutMs`、`development.commandTimeoutMs`（后两者以秒显示；手机可改，裁决 P-phone）；JIRA 分区：`syncStatus` 开关（默认关，说明 "Off: Slack Off never writes to JIRA in this phase"）、`inProgressStatus`，以及 **"Chrome browser for JIRA"**（裁决 S-2）：显示当前 `jira.browser`，"Detect browsers" 按钮调 `/api/jira/browsers/detect` 后给出单选列表，检测失败时可手动填 deviceId，"None (only one browser connected)" 清除；说明 "Needed when more than one Chrome browser is connected to Claude". 远程会话下仓库映射、`syncStatus`、`inProgressStatus`、浏览器选择只读并说明需在本机修改。

- [ ] **步骤 1：写失败测试：** `repoViews` 原样使用服务端的 `status`（给 `status:'not_run'` 的仓库得到 `not_run`，不得为 green，即使它没有失败的测试）、sha 截 7 位、`install.resetPaths` 与 `baseBranchChanged` 各生成一条 `notes`；`defaultTab('awaiting_snapshot_ack')` === `'coverage'`、`defaultTab('dev_done')` === `'development'`；`browserChoice` 对 `detected: null` → `manual:true`，对已配置设备 → `selected` 为其 deviceId；`iterationView` 对某仓库超时的 hook 为 `timed_out`；`jiraCard`：`enabled:false` → off；有 pending → pending 且 `thisWill` 含目标状态；最新为 `not_needed` → 文案含 "Already"；`failed` → 带 id 可重试；`settings-model`：两行同 key 不同 name → `projects[key].repos` 长度 2；同 key 同 name → 错误；非法仓库名 → 错误；远程会话时仓库映射、`syncStatus` 与浏览器选择只读，`debate.maxRounds` 可编辑。
- [ ] **步骤 2：** 实现。
- [ ] **步骤 3：** `pnpm -F web test`、`pnpm -F web build` 通过；390px 手动检查（仓库选择器、吸底栏；由任务 17 的 `mobile-phase2.spec.ts` 自动化，裁决 P-tests）。
- [ ] **步骤 4：** 提交：`feat(web): per-repo development tab, snapshot-change ack, JIRA write confirmation, multi-repo settings and JIRA browser choice`

### 任务 17：fake 模式、e2e、README、出口验证

**文件：** `dev/fake-mode.ts`、`dev/fake-repo.ts`、`main.ts`、`playwright.config.ts`（新增 phase 2 的 desktop / mobile 两个 project）、`package.json`（`e2e` 脚本）、`e2e/phase2.spec.ts`、`e2e/mobile-phase2.spec.ts`、`e2e/phase1.spec.ts`、`e2e/mobile.spec.ts`（裁决 P-C12）、`README.md`、`docs/superpowers/specs/2026-11-06-slack-off-design.md`（§10 阶段 4 加一条，裁决 S-1）、`docs/spikes/phase2-exit.md`

fake 模式（`SLACKOFF_FAKE_EXECUTOR=1`）：
- `createFakeRepos(home): Promise<RepoRef[]>`：在 `${home}/fake-repos/{api,web}` 建两个 git 仓库（`main` 分支）。`api` 提交 `.slackoff/config.json` = `{"forbiddenPaths":["infra/**"],"commands":{"test":"node --test"}}`；`web` 提交 `{"commands":{"test":"node --test"}}` 和 `.githooks/pre-commit`（暂存内容含 `TODO` 时输出 "TODO found" 并 exit 1），提交前 `chmod +x`（以 100755 模式入库，否则 `hooksInstalled` 判为未安装、hook 也不会运行，裁决 P-C20），并 `git config core.hooksPath .githooks`。未映射 `FAKE` 时在内存中映射 `FAKE → [api, web]`。
- `fakeRun` 按角色：`propose-solutions` 方案 1 `affectedRepos: ['api','web']`、方案 2 `['web']`；`design-solution` 返回覆盖 `resolveChecklist` 全部项、各仓库一节的文档（`revise` / `apply_rulings` 时对 `mustAnswer` 全部 `accepted`）；`critique-design` 对 FAKE-1 第 1 轮 1 条阻塞、第 2 轮无，对 FAKE-2 每轮 2 条阻塞；`implement-ticket` **只写入 `req.repos` 中的仓库**（`join(req.cwd, repo.name)`，裁决 P-C20）：第 1 步在 `api`（若受影响）写 `src/export-csv.js`、`test/export-csv.test.js`、`infra/main.tf`，在 `web`（若受影响）写 `src/export-button.js`（含 `TODO`），第 2 步去掉 `TODO` 并 `done:true`；`jira-update` 返回 `changed` 并把假 source 中该票 `status` 改为目标值。

e2e（各自独立 playwright 调用、全新数据目录；用 API 快速走完阶段 1 部分）：
- 阶段 1 的 `phase1.spec.ts` / `mobile.spec.ts`：选方案之后票不再停在阶段 1 的终点，而是进入 `designing`（fake 模式下很快到 `design_final` 及以后）；把这两个 spec 的终点断言改为"选方案后状态为 `designing` 或其后的设计状态、Design 页签可打开"，其余阶段 1 断言不变（裁决 P-C12）。
- `phase2.spec.ts`（desktop 1440）：FAKE-1 refine → Solutions 显示 `api` `web` 标签 → 选方案 1（不改仓库）→ 设计页签 Round 1 阻塞、Round 2 无阻塞、清单 25/25 → Developing → Development 页签两个仓库分组：`api` 有 `FAKE-1: ` commit 与 `infra/main.tf` 拦截卡片，`web` 第 1 步显示 "pre-commit hook failed"（含 "TODO found"）、第 2 步后有 commit → `dev_done`，"Hand off to acceptance" 禁用；然后本机开启 JIRA sync，**FAKE-2** 选方案 2 并在仓库列表中保持 `web` → `awaiting_debate_ruling` → 未选全时 Finalize 禁用 → 选全（含一条 custom 意见）→ 定稿 → developing → "Send to JIRA" 卡片 → 确认 → done（裁决 P-C20：JIRA 同步明确用 FAKE-2）；FAKE-2 的 worktree 目录下只有 `web`；`/api/audit` `ok:true`。
- `mobile-phase2.spec.ts`（390×844）：FAKE-2 的裁决全部通过吸底栏完成；FAKE-1 的 Development 页签用仓库选择器切换 `api` / `web` 后各自显示 commit；每页 `scrollWidth === 390`；吸底栏主按钮 `min-height: 44px` 且下方有 "This will:"（替代任务 15、16 的手动 390px 检查，裁决 P-tests）。

README：多仓库映射（`projects[KEY].repos`，旧格式自动迁移）；每个仓库的规则文件格式（`.slackoff/config.json` 字段含 `install`、`rules.md`、从基础分支读取）；worktree 位置 `worktrees/<KEY>/<repo>` 与分支命名（首次创建后固定）；平台提交会运行仓库自己的 git hooks（非交互、超时可配置；husky 类 hook 需要声明 `install`，配置了 hooks 却未安装时票会 `blocked`；agent 不能修改 hooks 目录，平台每次提交前从 HEAD 还原）；`install` 只在新建 worktree 时运行一次，它造成的文件改动会被还原并在页面中列出；步数用完后"重试"会开始新迭代并丢弃未提交改动；开发 agent 的沙箱（能做什么 / 不能做什么：`--restricted` 只能碰票目录、只能原样运行声明的命令 `cd <repo> && <cmd>`、无联网和浏览器工具、不能运行 git）；JIRA In Progress 同步默认关闭且每次需确认（手机也可确认）；多个 Chrome 浏览器连接到 Claude 时在设置中选择 JIRA 用的浏览器；阶段 2 不 push / 不开 PR（阶段 3 每个仓库各开一个互相引用的 PR）。**安全说明（裁决 S-1）**单列一节，原文包含 "Development runs your repository's commands (tests, builds, install, git hooks) with your user permissions"，并说明：agent 写的测试代码运行时不受文件工具沙箱约束、可以访问你能访问的一切；缓解措施（无联网工具、文件工具受限、方案由你选择并确认）；只对你信任其票内容的项目开启；OS 级命令沙箱列为阶段 4 待办。spec §10 阶段 4 列表加一条"可选的 OS 级命令沙箱（开发时运行的测试 / 构建 / install / hooks 限制在票目录内）"。

- [ ] **步骤 1：** 实现 fake 模式；写两个新 e2e；按上文更新两个阶段 1 e2e 与 `playwright.config.ts`。
- [ ] **步骤 2：** `pnpm test`、`pnpm typecheck`、`pnpm e2e`（四次 playwright 调用）全部通过。
- [ ] **步骤 3：** README（含安全说明）与 spec §10 更新。
- [ ] **步骤 4：出口文档（作者手工验证）。** 写 `docs/spikes/phase2-exit.md`：先列自动化结果（单元测试、e2e 桌面与 390px），再列作者在自己的测试 JIRA 项目和测试仓库上**手工**执行的核对项（引用 `docs/spikes/2026-11-dev-sandbox.md` §6），每项含步骤、期望、"结果：____ / 日期：____ / 备注：____" 空栏，至少包括：
  1. 单仓库测试票：选方案 → 辩论 → 定稿 → 快照复读 → 开发 → `dev_done`；在 worktree 中手动运行测试通过；设计文档与辩论记录在 UI 可查；主 checkout（HEAD、status、stash）未变。
  2. 两个仓库的测试票：两个 worktree、同名分支、各自 commit；在其中一个仓库制造 hook 失败，确认反馈循环与另一仓库的 commit 保留；把一个仓库的基础分支改成不存在的名字，确认 `blocked` 原因含仓库名，修复后重试继续。
  3. 使用 husky v9（`core.hooksPath=.husky/_`）的测试仓库：声明 `install` 后 `.husky/_/pre-commit` 存在、hook 在 worktree 中运行且输出出现在 commit 结果中、故意失败的 hook 显示为 `hook_failed` 并进入下一步 prompt；hook 超时提示清楚；去掉 `install` 新建一张票 → `blocked`（"not installed"），没有不经 hooks 的提交。
  4. 真实 JIRA（仅测试票、作者自愿开启 `jira.syncStatus`）：确认 → 状态变为 In Progress 并被核对；原始日志里只出现 `find` / `computer left_click` / `get_page_text`，唯一的 URL 是 `<jira>/browse/<KEY>`，其他字段与评论未变；审计 `jira_write_requested` → `jira_write_decided` → `jira_write_finished(done)`；对已是 In Progress 的票 → `not_needed`、未打开浏览器；JIRA 登录过期时 → `failed` 且开发继续；从已配对手机确认一次，审计记录设备。
  5. 多个 Chrome 浏览器连接到 Claude：未选择浏览器时拉票与 JIRA 写都提示 "Choose the Chrome browser for JIRA in Settings"；在设置中检测并选择本机浏览器后两者都成功，且没有在另一台设备上打开标签页。
  6. 开发者在设置中删除一个受影响仓库的映射后，开发中的票 `blocked` 并写明仓库名。
- [ ] **步骤 5：** 提交：`test: phase 2 e2e (desktop + 390px); docs: README and phase 2 exit checklist`
