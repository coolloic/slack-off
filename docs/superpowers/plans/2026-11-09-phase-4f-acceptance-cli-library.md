# 阶段 4f · 验收入口：命令行工具与库 执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** spec §5.3 第 6 步："命令行工具：以用户身份执行命令，证据是命令和终端输出。库：写一个最小的调用示例来使用它，证据是示例代码和运行输出。……命令行工具和库放到第 4 期。"阶段 3 只支持 `acceptance.entry: 'web' | 'api'`。本计划加入 `'cli'` 与 `'library'`：验收 agent 照旧只看需求与 AC、自己设计流程（每条 AC 至少一条正常路径与一条异常路径），但不写 Playwright 用例，而是写**声明式命令用例**（CLI）或**调用示例 + 用例**（库）；平台在验收沙箱中运行它们，平台自己的重跑结果是唯一证据。

**架构：** 复用阶段 3 的整个验收流水线（无历史导出、隔离检查、专用 Claude 配置目录、`acceptance` 沙箱、shell 前缀包装、平台重跑、`evaluate`、报告与失败回流）。新的只有三处：(1) 规则文件 `acceptance` 段变为按 `entry` 区分的联合类型；(2) 一个平台用例运行器 `acceptance/case-runner.ts` 与 agent 可调用的 shim `slackoff-cases`（与 `playwright` shim 同一机制：在 `<runRoot>/bin`、agent 只有一条精确 Bash 规则 `slackoff-cases run`）；(3) 证据引用多一种 `{kind: 'case'}`，报告 UI 用等宽文本显示命令与输出（`review_evidence.kind = 'log'` 已存在）。

**技术栈：** 同阶段 1–3。新增依赖：无。

**设计依据（Spec）：**
- 设计文档 §5.3 第 6 步（验收定位、各类项目的最终用户入口、报告每条 AC 的步骤 / 预期 / 实际 / 证据）、§6 验收 agent 隔离（硬性要求）、§11 风险 5（无法执行 e2e 时必须明说）、§9.5 规则文件。
- 阶段 3 计划任务 6–9、17 与裁决 T1-1、T5-2、T6-1…T6-7、T7-1…T7-9、T8-1、T8-2、T9-1…T9-8（运行目录、shim、包装、证据复制与包含性检查）。
- 代码：`projects/project-rules.ts`（`acceptanceSchema`）、`acceptance/workspace.ts`（`prepareRunDirs`、`writePlaywrightScaffold`、`assertAcceptanceIsolation`）、`acceptance/app-runner.ts`、`acceptance/spec-guard.ts`、`acceptance/verdicts.ts`（`evaluate`、`evidenceResolver`）、`acceptance/evidence-copy.ts`、`acceptance/review-jobs.ts`、`executor/sandbox.ts`（acceptance-review 的工具策略）、`skills/acceptance-review/SKILL.md`、`packages/shared/src/schemas.ts`（`AcceptanceEvidenceRef`、`acceptanceResultSchema`）、`packages/web/src/pages/ticket/AcceptanceTab.tsx`。

## 裁决（每条附"错了的代价"）

- **裁决 F-1（声明式用例，不让 agent 直接跑被测命令）：** agent 的 Bash 仍只有一条精确命令（`slackoff-cases run`），它不能直接运行被测 CLI 或任意 node 脚本；它把用例写成 JSON（`acceptance/cases/*.case.json`），由 shim 交给平台运行器执行并写回结果，agent 读结果后迭代。这样被执行的只有规则文件声明的命令前缀 + 用例给出的参数，审阅与守卫面都小。代价：表达不了交互式（TTY）CLI；README 写明交互式工具按 "E2E not executed: interactive CLIs are not supported" 处理。
- **裁决 F-2（库只支持 Node）：** `library.runtime: 'node'`，调用示例是 `acceptance/examples/*.mjs`，从导出快照中的包入口导入（`import … from '<library.import>'`，平台在示例目录放一个指向快照包的 `node_modules/<name>` 符号链接——在 runRoot 内，由平台创建）。其他语言的库按 "E2E not executed: only Node libraries are supported" 处理。代价：Python / Go 等库得不到验收（报告明说，不假装通过）。
- **裁决 F-3（示例的守卫）：** 示例代码由 agent 编写、在验收沙箱中运行；`spec-guard` 对示例沿用对 Playwright 用例的规则，另外允许导入声明的库名与 `node:assert`、`node:util`；仍拒绝 `node:fs`、`node:child_process`、`node:net`、`process.env`、动态 `import()`。OS 沙箱是边界，守卫只是附加一层（同 Task 7 minor 的结论）。代价：需要读写文件的库示例写不出来——这类库应在规则文件里声明 `testCommand` 作为补充证据。
- **裁决 F-4（输出上限与超时）：** 每个用例超时 `acceptance.caseTimeoutMs`（默认 30,000，范围 1,000–600,000，手机可改），stdout / stderr 各保留最后 64 KB；整轮仍受 `acceptance.runTimeoutMs`。代价：输出很大的命令只保留尾部（证据标注 "truncated"）。
- **裁决 F-5（每个用例一个干净的工作目录）：** 每个用例在 `<runRoot>/cases-work/<n>/` 中运行（运行前创建为空目录，`HOME` 指向它，`TMPDIR` 为 runRoot 的 tmp）；用例可以声明 `files: Record<相对路径, 文本>` 作为输入文件（≤20 个、每个 ≤64 KB、路径不得含 `..` 或以 `/` 开头）。代价：需要预置大量数据的 CLI 测不了。

## 全局约束

- 阶段 1–3 的全局约束全部继续有效，**验收隔离是硬性要求**（spec §6）：agent 上下文只有需求、AC、讨论结论；运行目录在 `SLACKOFF_HOME`、映射仓库与 worktree 之外；无 `.git`、数据库、设计 / 辩论文本；隔离检查失败 → `not_executed`，绝不按通过处理。
- **Node 26**（裁决 N-1）。
- **移动优先**：报告中的命令与输出证据在 390px 宽无横向页面滚动（证据块自身可横向滚动，`pre` 设 `max-width: 100%`），可点目标 ≥44px。
- **公开内容**：fixture 与 fake 仓库只用虚构内容，示例一律 `https://your-company.atlassian.net`、`example-org`。
- **对外写入逐次经开发者确认**：本计划不新增对外写入。
- **测试与探测不碰宿主状态**：不读写剪贴板、LaunchServices、钥匙串、rc 文件、`~/.gitconfig`、`~/.claude`、`~/.nvm`；用例的 `HOME` 永远是用例自己的工作目录。
- **提交信息**以下面两行结尾：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Q3ZdR36s9c6TU4rsfHiJ3Z
  ```
- **无法执行时必须明说**：交互式 CLI、非 Node 库、构建失败、`cli.command` 在快照中不存在、没有任何用例 → `verdict: 'not_executed'` 并写明原因。
- **跨包类型**只在 `@slackoff/shared` 定义：`AcceptanceCase`、`CaseResult`、新的 `AcceptanceEvidenceRef` 分支。
- 不需要数据库迁移（`review_evidence.kind` 已含 `'log'`）。

## 审阅重点

1. **用例借参数逃出声明的命令**：参数中的 `;`、`$(…)`、反引号、换行，`args` 让被测 CLI 去执行任意命令（`--exec`、`-e`）→ 运行器从不经 shell（`spawn(file, argv)`）；`cli.command` 只按空白拆分且第一个元素必须解析到快照内或 PATH 上的允许程序（`node`、`npx` 不在默认允许中——必须是快照内路径或规则文件声明的程序名）；被测 CLI 自己执行别的命令时仍在 `acceptance` 沙箱内（读不到凭证、连不上 Slack Off）。（任务 2、3）
2. **用例结果被 agent 伪造**：agent 能写 `acceptance/` 下的文件，包括一个假的 `results.json`。期望：平台在 agent 结束后**自己**重跑全部用例（同阶段 3 的 Playwright 重跑），报告只用平台重跑的结果；agent 自己报告的 pass 与平台重跑不一致 → 该 AC `mismatch` 并按平台结果。（任务 4）
3. **库示例读到不该读的东西**：示例 `import` 快照之外的路径（`../../`、绝对路径、`file://`）、经 `createRequire` 动态加载、读 `process.env`、`import.meta.resolve` 到 `SLACKOFF_HOME` → 守卫拒绝（附加层），OS 沙箱拒绝读取（边界）；符号链接 `node_modules/<name>` 只指向快照内的包目录。（任务 3）
4. **构建与安装步骤**：库或 CLI 需要先 `install` / `build` 才能运行；构建失败、构建产物位置不对、构建修改了已跟踪文件（同 T9-4）→ `not_executed` 并写明原因，不调用 agent。（任务 4）
5. **证据显示**：极长的输出、含 ANSI 转义序列、含二进制或无效 UTF-8、含看起来像链接或 HTML 的文本 → 证据去掉 ANSI、按 UTF-8 替换无效字节、作为纯文本渲染（不经 Markdown / HTML），截断处标注。（任务 5）

---

## 文件结构

```
packages/shared/src/schemas.ts (改：AcceptanceCase、CaseResult、AcceptanceEvidenceRef.case)
packages/server/src/
  projects/project-rules.ts (改：acceptance 联合类型), config.ts (改：acceptance.caseTimeoutMs)
  acceptance/case-runner.ts (新), acceptance/cases-shim.mjs (新：slackoff-cases), acceptance/workspace.ts (改：cases/examples 脚手架), acceptance/spec-guard.ts (改：示例规则)
  acceptance/verdicts.ts (改：case 证据), acceptance/evidence-copy.ts (改：log 证据), acceptance/review-jobs.ts (改：按 entry 分支), executor/sandbox.ts (改：Bash(slackoff-cases run))
skills/acceptance-review/SKILL.md (改：cli / library 入口的写法)
packages/server/test/  case-runner.test.ts (新), project-rules.test.ts / spec-guard.test.ts / review.test.ts / acceptance-isolation.test.ts / skills-prompts.test.ts (改), fixtures/acceptance-cli/, fixtures/acceptance-lib/ (新)
packages/web/src/  pages/ticket/AcceptanceTab.tsx (改), components/LogEvidence.tsx (新), lib/review-model.ts (+ test)
dev/fake-acceptance.ts, dev/fake-repo.ts (改：第三个 fake 仓库 'cli'), e2e/phase4f.spec.ts (新), playwright.config.ts, package.json, README.md, docs/spikes/2026-11-acceptance-cli-library.md (任务 1), docs/spikes/phase4f-exit.md (新)
```

---

### 任务 1：技术验证 — 用例 shim、库示例的导入、沙箱内的 Node（一次性）

**文件：** `docs/spikes/2026-11-acceptance-cli-library.md`（新）

| 决定值 | 问题 | 用于 |
|---|---|---|
| `CASES_SHIM_FORM` | agent 在 `--restricted` 下调用 `slackoff-cases run` 的两种形式（cwd 保留 / `cd <workDir>/acceptance && …`）是否都匹配一条精确规则（同 `ACCEPT_BASH_FORM`） | 任务 4 |
| `LIB_LINK` | 示例目录下 `node_modules/<name>` → 快照包目录的符号链接，在 `acceptance` 沙箱内 ESM 与 CJS 包都能导入（同 `ACCEPT_PLAYWRIGHT_LINK` 的结论是否适用）；scoped 包名 `@scope/name` 的目录形状 | 任务 3 |
| `CLI_RESOLVE` | `cli.command` 首个元素为快照内相对路径（`./bin/tool.mjs`，带 shebang）时，在沙箱内直接 `spawn` 是否可行，还是必须 `node <path>` | 任务 3 |
| `CASE_TTY` | 被测 CLI 检测不到 TTY 时的常见行为（彩色输出关闭、交互提示直接失败）——确认"非交互"约定足够 | 任务 3 |

- [ ] **步骤 1–3：** 在临时目录用 fixture CLI 与 fixture 库逐项实测（沙箱用阶段 3 的 `acceptance` scope；不运行真实 `claude` 之外的任何外部服务；`CASES_SHIM_FORM` 需要一次真实 `claude` 运行，最多 2 次）。
- [ ] **步骤 4：** 写 spike 文档；提交：`docs: acceptance CLI and library entry spike`

### 任务 2：shared 类型与规则文件的 `acceptance` 联合类型

**文件：** `packages/shared/src/schemas.ts`、`projects/project-rules.ts`、`config.ts`、`test/project-rules.test.ts`、`packages/shared/test/shared.test.ts`

**接口：**
```ts
// shared
AcceptanceCase = { name: string /* ^[a-z0-9][a-z0-9-]{0,63}$ */; acId: string; kind: 'happy'|'error'|'edge'; title: string;
  args: string[] /* ≤50 项，每项 ≤2000 字符，不含 NUL */; stdin?: string /* ≤64 KB */; env?: Record<string, string> /* 同规则文件 env 的键值规则，≤10 项 */;
  files?: Record<string, string> /* 裁决 F-5 */; example?: string /* library：examples/ 下的文件名 ^[a-z0-9-]{1,64}\.mjs$ */;
  expect: { exitCode?: number; stdoutIncludes?: string[]; stderrIncludes?: string[]; stdoutMatches?: string /* 正则源码，≤200 字符，编译失败 → 用例无效 */ } }
CaseResult = { name: string; passed: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; stdoutTail: string; stderrTail: string; truncated: boolean; failures: string[] }
AcceptanceEvidenceRef += {kind: 'case'; case: string /* AcceptanceCase.name */; caption: string}
// project-rules.ts：acceptance 改为按 entry 的 discriminatedUnion
{entry: 'web'|'api', …阶段 3 字段不变}
| {entry: 'cli'; install?: Command; build?: Command; cli: { command: Command /* 拆分后首项：快照内相对路径（./ 开头）或 ^[a-z][a-z0-9._-]{0,63}$ 的程序名 */ }; testCommand?: Command; env: Env}
| {entry: 'library'; install?: Command; build?: Command; library: { runtime: 'node'; import: string /* npm 包名语法 */; path: string /* 快照内包目录，相对、无 .. ，默认 '.' */ }; testCommand?: Command; env: Env}
Config.acceptance += { caseTimeoutMs: number /* 1_000..600_000，默认 30_000，手机可改 */ }
```

- [ ] **步骤 1：写失败测试：** 阶段 3 的 web / api 规则文件照常解析（现有测试不改）；`entry: 'cli'` 缺 `cli.command` → `ProjectRulesError` 含字段路径；`cli.command: 'node ../x.mjs'` → 报错（`..`）；`cli.command: '/usr/bin/curl x'` → 报错（绝对路径）；`entry: 'library'` 的 `library.runtime: 'python'` → 报错；`library.import: 'Bad Name'` → 报错；`AcceptanceCase` 的 `stdoutMatches: '('` → 抛错；`files` 含 `'../x'` → 抛错；`acceptanceResultSchema` 接受 `{kind:'case', case:'list-empty', caption:'…'}` 作为证据；`caseTimeoutMs: 500` → 报错。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck` 通过。
- [ ] **步骤 5：** 提交：`feat: acceptance entries cli and library in the rules file; case and case-evidence types`

### 任务 3：用例运行器（沙箱中、无 shell）

**文件：** `acceptance/case-runner.ts`（新）、`acceptance/spec-guard.ts`（示例规则）、`acceptance/workspace.ts`（`writeCasesScaffold`：`acceptance/cases/`、`acceptance/examples/`、库的 `node_modules/<name>` 链接）、`test/case-runner.test.ts`（新）、`test/spec-guard.test.ts`、`test/fixtures/acceptance-cli/`（一个 40 行的 Node CLI：`list`、`add <name>`、无参数时 exit 2 并打印用法）、`test/fixtures/acceptance-lib/`（一个导出 `slugify` 的小库）

**接口：**
```ts
loadCases(acceptanceDir: string, acIds: readonly string[]): { cases: AcceptanceCase[]; problems: string[] }
  // 读 cases/*.case.json（≤200 个文件，每个 ≤256 KB，lstat 普通文件、不跟随符号链接）；无效的列入 problems（文件名 + 原因）；名字重复 → problem；acId 不在列表 → problem
runCases(o: { cases: readonly AcceptanceCase[]; target: CliTarget | LibTarget; runRoot: string; sandbox: SandboxScope | null /* null 只用于 shim 路径（已在 agent 的沙箱包装内）；平台重跑必须给 acceptance scope */; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<CaseResult[]>
  // 依次运行（不并发）；每个用例：清空并创建 <runRoot>/cases-work/<n>/、写 files、
  //   cli：argv = 拆分(cli.command) + args（首项为 ./ 路径时按 CLI_RESOLVE 解析为快照内绝对路径）；
  //   library：argv = [process.execPath, <acceptanceDir>/examples/<example>] + args（example 必填）；
  // 经 sandboxArgv(sandbox, …)（sandbox 非 null 时）与 startProcess 运行，cwd = 用例工作目录，env = targetEnv + 用例 env + HOME=工作目录；stdin 写入后关闭；
  // 超时 → 杀进程组、timedOut；比对 expect 生成 failures（每条一句英文）；stdout/stderr 去 ANSI（/\x1b\[[0-9;?]*[ -\/]*[@-~]/g）、无效 UTF-8 替换、各保留尾部 64 KB
caseTranscript(c: AcceptanceCase, r: CaseResult, displayCommand: string): string
  // "$ <displayCommand> <args 以 shell 引号显示>\n<stdin 摘要>\n--- stdout ---\n…\n--- stderr ---\n…\nexit <code>"——证据文件内容
type CliTarget = { kind: 'cli'; repo: string; command: string[]; snapshotDir: string }
type LibTarget = { kind: 'library'; repo: string; importName: string; packageDir: string }
```
`spec-guard` 新增 `checkExample(source, {libraryName})`：允许 `import … from '<libraryName>'`（及其子路径）、`node:assert`、`node:assert/strict`、`node:util`；其余规则同 Playwright 用例。

- [ ] **步骤 1：写失败测试（真实 `sandbox-exec`，非 darwin 跳过并注明）：** fixture CLI：`args: ['add', 'x; touch /tmp/pwned']` → 参数原样到达 CLI（输出含该字符串）、没有文件被创建；`args: []` → exit 2、`expect.exitCode: 2` 通过；`stdoutIncludes` 不满足 → `failures` 含期望文本；用例在 CLI 中 `fetch('http://127.0.0.1:4317/api/status')`（fixture 提供 `probe` 子命令）→ 输出含 `EPERM`；读注入 HOME 外的 `~/.ssh`（fixture `read` 子命令）→ `EPERM`；超时 1 s 的 `sleep` 子命令 → `timedOut`、进程组已不存在；输出含 ANSI 颜色 → 去掉；100 KB 输出 → `truncated`；`files: {'in.txt': 'a'}` 出现在工作目录；fixture 库：示例 `import {slugify} from 'acceptance-lib'` 运行通过；示例 `import fs from 'node:fs'` → 守卫拒绝；示例 `import x from '../../x.mjs'` → 守卫拒绝；`loadCases` 对符号链接文件、重复名、未知 acId 各给出 problem。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): acceptance case runner — declared CLI or Node example, no shell, in the acceptance sandbox`

### 任务 4：agent 工具、skill、shim 与验收 job 的分支

**文件：** `acceptance/cases-shim.mjs`（新）、`executor/sandbox.ts`（acceptance-review 策略：entry 为 cli / library 时允许的 Bash 规则恰为 `Bash(slackoff-cases run)`，不含 `playwright test`）、`acceptance/workspace.ts`（shim 写入 `<runRoot>/bin`，只读）、`acceptance/review-jobs.ts`、`acceptance/verdicts.ts`、`acceptance/evidence-copy.ts`、`skills/acceptance-review/SKILL.md`、`test/review.test.ts`、`test/acceptance-isolation.test.ts`、`test/skills-prompts.test.ts`

规则：
- 一张票的受影响仓库中，只要有一个声明了 `acceptance`，就按该仓库的 entry 走；多个仓库声明了不同 entry → 每个仓库各自一组用例目录（`acceptance/<repo>/cases/`），shim 与运行器按仓库运行；web / api 仓库照阶段 3。
- `slackoff-cases run`：shim 只接受恰好这两个参数；它与阶段 3 的 `playwright` shim 一样，本身已在 agent 的沙箱包装内运行（T6-3），所以不再嵌套 `sandbox-exec`，而是以 `env -i` + 固定环境直接执行运行器的 Node 入口（`case-runner` 的 CLI 形式，参数固定），读取 `acceptance/**/cases/*.case.json`，写 `acceptance/results/cases.json` 供 agent 阅读。不经服务端、不开 socket。
- agent 结束后：平台在**全新的**用例工作目录中自己重跑全部用例（`runCases`），证据只来自这次重跑；每个 `{kind:'case'}` 证据 → 一个 `review_evidence`（`kind 'log'`，文件为 `caseTranscript` 的文本，`.txt`，按阶段 3 的复制与包含性规则）；`evaluate` 中 flow 的 `tests` 字段对 case 入口填用例名，`testsPassed` = 平台重跑中这些用例全部通过。
- 安装 / 构建：在 acceptance-install 沙箱中先 `install` 再 `build`（同阶段 3 install 的处理，含 T9-4 的已跟踪文件哈希核对），失败 → `not_executed`（"the build failed: …"）。
- `cli.command` 首项在快照中不存在 → `not_executed`（"<path> does not exist in the exported snapshot"）；没有任何有效用例 → AC 全部 `not_tested`、verdict `failed`（agent 没完成工作，同阶段 3 无用例时的处理）。
- skill：新增"Command-line tools"与"Libraries"两节：用例 JSON 的形状、每条 AC 至少一个 happy 与一个 error 用例、edge 用例或说明、证据用 `{kind:'case'}`、只用 `slackoff-cases run`、不要假设 TTY。

- [ ] **步骤 1：写失败测试：** cli 入口的验收运行请求中 allowedTools 恰含 `Bash(slackoff-cases run)` 且不含 `Bash(playwright test)`；shim 收到其他参数 → exit 2；agent（fakeRun）写一个假的 `results/cases.json` 声称全部通过、但用例实际失败 → 报告该 AC `fail` 且 `mismatch` 非空；平台重跑的证据文件在 `reviews/` 下、内容以 `$ ` 开头；构建失败 → `not_executed` 且未调用 agent；`cli.command` 不存在 → `not_executed`；隔离检查（无 `.git`、无设计文本、cwd 在 `SLACKOFF_HOME` 之外）对 cli 入口同样执行并在报告中列出；`skills-prompts.test.ts`：skill 含 `slackoff-cases run` 与 `"kind": "case"`。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck`、`pnpm e2e` 通过。
- [ ] **步骤 5：** 提交：`feat: acceptance for command-line tools and Node libraries — declared cases, platform re-run, log evidence`

### 任务 5：报告 UI 中的命令与输出证据

**文件：** `components/LogEvidence.tsx`（新）、`pages/ticket/AcceptanceTab.tsx`、`lib/review-model.ts`（+ test）、`i18n/en.ts`、`http/app.ts`（证据接口对 `kind 'log'` 返回 `text/plain; charset=utf-8` 且 `X-Content-Type-Options: nosniff`）

UI：每条 flow 的证据中，`log` 类型显示为可折叠的等宽块（默认显示前 20 行，"Show all"），标题为命令行；截断时显示 "Output truncated to the last 64 KB"；纯文本渲染（`textContent`），绝不当作 HTML 或 Markdown；手机上块内横向滚动、页面不横向滚动。

- [ ] **步骤 1：写失败测试：** review-model 把 `log` 证据映射为 `{kind:'log', title, lines, truncated}`；含 `<img src=x onerror=alert(1)>` 的输出在组件模型中原样作为文本；证据接口对 log 返回 `text/plain` 与 `nosniff`；超过 20 行时默认折叠。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm -F web test`、`pnpm -F web build` 通过。
- [ ] **步骤 5：** 提交：`feat(web): command and output evidence in the acceptance report`

### 任务 6：fake 模式、e2e、README、出口核对

**文件：** `dev/fake-repo.ts`（第三个 fake 仓库 `cli`：fixture CLI + `.slackoff/config.json` 的 `acceptance: {entry:'cli', cli:{command:'./bin/tool.mjs'}}`；映射进 FAKE 项目）、`dev/fake-mode.ts`（第四个 fake 方案只改 `cli`；`FAKE-4` 票）、`dev/fake-acceptance.ts`（cli 入口时写 2 个用例：一条通过、一条按开关失败一次）、`e2e/phase4f.spec.ts`（新，desktop 与 390×844）、`playwright.config.ts`、`package.json`、`README.md`、`docs/spikes/phase4f-exit.md`（新）

- e2e desktop：FAKE-4 走到 `dev_done` → Hand off → 第 1 次某 AC 失败（平台重跑真实失败）→ 自动修复迭代 → 第 2 次通过 → Acceptance 页签中该 AC 的证据是命令块，以 `$ ./bin/tool.mjs` 开头。390px：命令块在页面内、`scrollWidth === 390`。阶段 1–3 的 e2e 不受影响（新增仓库只映射给 FAKE-4 的方案）。
- README `acceptance` 一节：`entry` 四种取值、cli 与 library 的字段、用例 JSON 形状与例子、非交互约定、只支持 Node 库、无法执行时的报告。
- `docs/spikes/phase4f-exit.md`：作者手工核对 0. 一个真实的小 CLI 测试仓库走完验收；1. 一个真实的小 Node 库测试仓库走完验收；2. 交互式 CLI 的报告为 "not executed" 且原因可读；3. 真实 `claude` 下 `slackoff-cases run` 两种调用形式都被允许（`CASES_SHIM_FORM` 未核对时）。

- [ ] **步骤 1：** fake 模式与 e2e；`pnpm test`、`pnpm typecheck`、`pnpm e2e` 全部通过。
- [ ] **步骤 2：** README 与出口文档。
- [ ] **步骤 3：** 提交：`test: phase 4f e2e (CLI acceptance with a fix round, 390px); docs: README acceptance entries and phase 4f exit checklist`

---

## 自审

**1. Spec 覆盖：** §5.3 第 6 步命令行工具（"以用户身份执行命令，证据是命令和终端输出"：任务 3、4、5）、库（"写一个最小的调用示例来使用它，证据是示例代码和运行输出"：任务 3、4，示例代码本身作为证据之一由任务 4 一并复制）、每条 AC 的步骤 / 预期 / 实际 / 证据 / 通过失败（沿用 `AcceptanceFlow`）、至少正常 + 异常 + 边界（skill 与 `acceptanceResultSchema` 已有规则）；§6 隔离（任务 4 测试）；§11 风险 5（任务 4 的 `not_executed` 情形）。

**2. 步骤扫描：** 每个任务给出签名、规则与断言；shim 的运行位置写成单一结论（在 agent 的沙箱包装内、不嵌套沙箱、不经服务端）。因此 `runCases` 在 shim 路径下收到的 `sandbox` 为 null（已在沙箱内），在平台重跑路径下为 `acceptance` scope——任务 3 的签名中 `sandbox: SandboxScope | null` 按此理解。

**3. 类型一致性：** `AcceptanceCase` / `CaseResult` / `AcceptanceEvidenceRef.case`（任务 2 → 3、4、5）；`CliTarget` / `LibTarget` / `runCases` / `caseTranscript` / `loadCases`（任务 3 → 4）；`Config.acceptance.caseTimeoutMs`（任务 2 → 3）；`checkExample`（任务 3 → 4）；决定值 `CASES_SHIM_FORM`、`LIB_LINK`、`CLI_RESOLVE`（任务 1 → 3、4）。

**4. 审阅重点：** 参数逃逸（任务 3 首个用例）；伪造结果（任务 4）；库示例越界（任务 3 守卫 + 沙箱）；构建失败（任务 4）；证据渲染（任务 5）。

**5. 比例：** 规则与断言为主；运行器与 shim 的实现由签名与测试决定。
