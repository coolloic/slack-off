# 阶段 4a · 沙箱收尾（git hooks、本机网络隔离、非 macOS、遗留安全小项）执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 关掉阶段 3 留下的最后一条已知本机攻击路径：平台提交时，仓库的 pre-commit / commit-msg 等 hook 会执行开发 agent 改过的配置（lint-staged、eslint 配置、`package.json` 脚本），而且不在沙箱中（裁决 F-2）。阶段 4a 之后，平台触发的每个 git hook（commit 与 delivery 的 push）都在新的 `dev-hook` 沙箱配置中运行：可以写本仓库的 git 目录（index、objects、refs，lint-staged 需要），但连不上 Slack Off 与其他本机守护进程的端口、读不到凭证与平台数据目录。另外提供一个可选的"本机端口白名单"模式（裁决 T5-6 的遗留），让非 macOS 平台的行为明确可见，给开发 agent 的 Bash 包装加一道守卫，并修掉安全相关的遗留小项。

**架构：** hook 沙箱不包 `git commit` 本身（签名需要 ssh-agent / gpg-agent，见 T5-4），而是包 hook：平台为每个 worktree 生成一个**包装 hooks 目录**（平台自己的目录，在 `SLACKOFF_HOME/sandbox/<KEY>/<repo>/hooks/`，agent 写不到），里面对已固定（F2-I1 pin）的 hooks 目录中每个 hook 放一个同名脚本，脚本以 `dev-hook` 配置经 `sandbox-exec` 执行真正的 hook；提交与推送时用 `-c core.hooksPath=<包装目录>` 代替原来的 `-c core.hooksPath=<固定目录>`。这样 git、签名与凭证都在沙箱之外，hook 及其启动的一切（node、lint-staged、eslint、commitlint）都在沙箱之内。网络白名单是 `sandboxProfile` 的一个开关；非 macOS 的行为经新的 `GET /api/sandbox` 与设置页的状态卡显示。

**技术栈：** 同阶段 1–3（Node.js 26 直接运行 `.ts`、TypeScript 可擦除语法、pnpm、Hono、`node:sqlite`、zod 4、React 19 + Vite + Tailwind + shadcn/ui、`node:test`、Playwright 1.64.1）。新增依赖：无。

**设计依据（Spec）：**
- 设计文档：`docs/superpowers/specs/2026-11-06-slack-off-design.md` §10 阶段 4 "OS 级命令沙箱……阶段 4 剩余：开发 agent 经精确 Bash 规则自己运行的命令、git hooks、非 macOS 平台"；§2 反目标（Agent 在开发者不知情时对外产生影响）；§3 本机优先。
- 裁决与遗留：`docs/spikes/phase3-rulings.md`（R-LOCAL、R-LOCAL-3、T5-1…T5-8、T5-6、T7-2、F-2、F-3、Deferred minors）；`docs/spikes/2026-11-dev-sandbox.md`；`docs/spikes/phase3-exit.md` 第 8、9 项与"Residual risks"。
- 代码：`packages/server/src/sandbox/local-sandbox.ts`（`SandboxKind`、`sandboxProfile`、`sandboxParams`、`sandboxArgv`、`sandboxSelfCheck`、`commandSandbox`、`writeShellPrefix`）、`sandbox/selfcheck.mjs`、`git/worktree.ts`（`commitAll`、`hooksFingerprint`、`HooksPin`、`restoreProtected`）、`development/dev-jobs.ts`（`agentCommands`、`commitAll` 调用）、`delivery/git-push.ts`（`git push`）、`executor/run-agent.ts`、`ports.ts`。

## 裁决（本计划的前提；每条附"错了的代价"）

- **裁决 A-1（包 hook，不包 git）：** `git commit` / `git push` 仍在沙箱外运行（签名与推送凭证），只有 hook 进程在 `dev-hook` 沙箱中。实现方式是平台生成的包装 hooks 目录 + `-c core.hooksPath=<包装目录>`。代价：git 自身的可执行配置（`core.fsmonitor`、`diff.external`、filter）仍在沙箱外——阶段 3 已用 `-c core.fsmonitor=false -c diff.external=` 与 git 目录写保护处理（T5-3），本计划不再扩展。
- **裁决 A-2（`dev-hook` 的写权限）：** 允许写：本票 worktree、该仓库 git 公共目录下的 `objects/`、`refs/`、`logs/`、`index`、`*.lock`、`ORIG_HEAD`、`COMMIT_EDITMSG`、`worktrees/<name>/`（index、HEAD、logs）、本票缓存与 tmp 目录；拒绝写：公共目录的 `config`、`hooks/`、`info/`、`packed-refs` 之外的根文件、任何 worktree 的 `.git` 指针文件；读拒绝与端口拒绝同 `dev-command`。代价：写别处的 hook（例如往 `~/.cache` 写缓存的工具）失败，失败可见（`hook_failed` 与输出尾部）。
- **裁决 A-3（hook 沙箱的开关）：** 新配置 `development.allowUnsandboxedHooks`（默认 false，仅限本机修改，同 `allowUnsandboxedCommands` 的处理）：沙箱不可用或自检失败时，提交不执行、开发步骤 `blocked`，文案指向该开关；打开后 hook 在沙箱外运行，每次提交写 `hooks_unsandboxed` 审计。不复用 `allowUnsandboxedCommands`：作者明确需要 hooks，而 hook 配置比命令配置更可能需要单独放开。代价：多一个开关。
- **裁决 A-4（本机端口白名单默认关）：** 新配置 `development.localNetwork: 'denylist' | 'allowlist'`，默认 `'denylist'`（阶段 3 的行为：拒绝固定端口表 + `deniedLocalPorts`）。`'allowlist'` 拒绝连接一切本机 TCP 端口，只放行规则文件 `sandbox.localPorts`、验收 `acceptance.baseUrl` 的端口，以及沙箱内进程自己监听的端口（若任务 1 证实 SBPL 能表达；否则不放行，测试自己起服务器的仓库须声明端口）。仅限本机修改。代价：默认仍留有"连到其他本机服务"的残余风险，README 如实写明。
- **裁决 A-5（非 macOS）：** 阶段 4 不实现 Linux 后端（bubblewrap / landlock 需要一台 Linux 机器核对，本仓库的执行环境是 macOS）。非 macOS 的行为改为**明确可见**：启动时日志一行、`GET /api/sandbox` 与设置页状态卡显示"Sandbox unavailable on linux"、开发命令与 hooks 照旧拒绝运行（除非对应开关）、验收照旧 `not_executed`。新增 `SandboxBackend` 抽象只到"可用 / 不可用 + 原因"这一层，为以后的 Linux 后端留口子。代价：Linux 用户只能在关掉保护后使用开发与验收（README 写明）；见索引作者问题 6。
- **裁决 A-6（开发 agent 的 Bash：核对，不重做）：** 代码中 `agentCommands`（`dev-jobs.ts`）已为有声明命令的 implement-ticket 运行写出 `CLAUDE_CODE_SHELL_PREFIX` 包装（R-LOCAL-3 / T5-1），测试 `development.test.ts` 覆盖。阶段 4 只加一道守卫：`runAgent` 拒绝"允许 Bash 却没有 `shellPrefix`、也没有明确的 unsandboxed 理由"的 implement-ticket 请求。代价：无（守卫只会把漏接的调用变成可见错误）。
- **裁决 A-7（遗留小项的归属）：** 本计划处理安全相关的遗留：worktree 根目录可被 `mv` 走（Task 5 minor）、`acceptRunBase()` 可能选到 `/private/tmp/claude-*`（Task 6 minor，先核对阶段 3 任务 9 是否已修）、fake 模式验收配置目录的内存改写可能被设置页保存写回磁盘（Task 17 minor）、票号正则在 4 个文件中重复（Task 18 minor，校验逻辑应只有一份）。非安全的遗留（草稿无 TTL、e2e 选择器 `exact:true`）归 4e 任务 4。代价：无。

## 全局约束

- 阶段 1–3 的全局约束全部继续有效（同阶段 3 计划"全局约束"第一条，以及本机命令沙箱、验收隔离、对外写入确认、push / PR 规则等各条）。
- **Node 26**（裁决 N-1）：`engines.node >=26`；所有命令与测试在 Node 26 上运行。
- **移动优先**：新 UI 在 390px 宽无横向滚动（`scrollWidth === 390`），可点目标 ≥44px，拍板用吸底栏 + "This will: …"。
- **公开内容**：仓库中不出现公司主机名、真实人名或邮箱；示例一律用 `https://your-company.atlassian.net`、`example-org`、`/Users/<you>`。
- **对外写入逐次经开发者确认**：本计划不新增对外写入；hook 沙箱不改变 push / PR / JIRA 的确认流程。
- **测试与探测不碰宿主状态**：测试、spike 与自检绝不读写用户的剪贴板、LaunchServices、钥匙串、shell rc 文件、`~/.gitconfig`、`~/.claude`、`~/.nvm`；涉及 HOME 的用例一律注入临时 `homeDir`；git 用例设置 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`。
- **提交信息**以下面两行结尾：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Q3ZdR36s9c6TU4rsfHiJ3Z
  ```
- **失败关闭**：任何沙箱不可用 / 自检失败的路径都不得静默不加沙箱运行；只有对应的仅限本机开关能放开，且每次都有审计。
- **新配置键**（`config.json`，带默认值，无需迁移）：`development.allowUnsandboxedHooks`（false）、`development.localNetwork`（`'denylist'`）——两者都加入 `http/app.ts` 的 `sensitive()`（仅限本机修改）。规则文件新字段 `sandbox.localPorts: number[]`（≤20 项，1–65535，不得含 `DENIED_PORTS` 中的端口）。
- **新审计事件**：`hooks_unsandboxed`（payload `{repo, reason}`）、`hooks_sandboxed_failed`（不需要：失败记在 `dev_step` 的 `hook_failed` 中，不另加事件）。

## 审阅重点

1. **lint-staged 类 hook 的正常写操作被沙箱拒绝**：lint-staged 会 `git stash`（写 `refs/stash`、`logs/refs/stash`、objects）、改 index、写 `.git/lint-staged_*` 临时文件、用 `git worktree` 下的 `gitdir` 指针找到公共目录；husky v9 的 `.husky/_/h` 会 `sh -e` 执行用户脚本。期望：这些全部成功；被拒绝的只有 `config`、`hooks/`、`info/` 与凭证 / 端口。测试用离线的假 lint-staged 脚本（任务 2）复现这些写操作，任务 1 让作者在真实 husky 仓库上核对。（任务 1、2、3）
2. **hook 绕过包装**：仓库在 worktree 级配置 `core.hooksPath`、agent 改 `.husky/` 或 `package.json` 的 `prepare`、hook 在提交时 `exec` 到包装目录之外的脚本、`git -c` 被 hook 自己再次调用 `git commit --no-verify`（嵌套 git 仍在沙箱内，嵌套提交写 objects/refs 是允许的，但读不到凭证）。期望：`-c core.hooksPath=<包装目录>` 优先于任何配置层；包装目录在 agent 可写范围之外且每次提交前重写；包装只执行固定目录（F2-I1）中指纹相符的 hook，指纹不符 → 不执行、`hook_failed`。（任务 3）
3. **沙箱不可用时的提交**：非 macOS、`sandbox-exec` 缺失或自检失败 → 提交不执行（不是"不带 hook 提交"，绝不 `--no-verify`），开发步骤 `blocked`，文案指向 "Run git hooks without the sandbox"；开关只能在本机打开；push 的 pre-push 同样处理（交付步骤 `failed`，`blocked`）。（任务 3、5）
4. **白名单模式下的本机端口**：`localhost`、`127.0.0.1`、`::1`、Tailscale 地址上未声明的端口一律 `EPERM`；声明的端口与验收 `baseUrl` 端口可连；声明表中出现 `DENIED_PORTS` → 规则文件报错；IPv6 与 IPv4 行为一致；自检多一项"连接未声明端口必须 `EPERM`"。（任务 1、4）
5. **开发 agent 的 Bash 漏包**：将来有人改 `dev-jobs.ts` 时，implement-ticket 允许 `Bash(...)` 却没传 `shellPrefix`，agent 运行的命令就不在沙箱中且能连 4317。期望：`runAgent` 抛 `SandboxPolicyError`，测试覆盖。（任务 6）

---

## 文件结构

```
packages/server/src/
  sandbox/local-sandbox.ts (改：SandboxKind 加 'dev-hook'、hook 写规则、localNetwork、SandboxBackend), sandbox/selfcheck.mjs (改：git 目录写探测、未声明端口探测)
  sandbox/hook-wrappers.ts (新：包装 hooks 目录的生成与核对)
  git/worktree.ts (改：commitAll 接收包装目录), delivery/git-push.ts (改：push 同样经包装目录)
  development/dev-jobs.ts (改：提交前准备 hook 沙箱), config.ts (改), projects/project-rules.ts (改：sandbox.localPorts)
  executor/run-agent.ts (改：implement-ticket 守卫), http/app.ts (改：GET /api/sandbox、sensitive)
  acceptance/workspace.ts (核对 / 改：acceptRunBase), main.ts (改：启动日志一行)
  shared: packages/shared/src/ticket-key.ts (新：isTicketKey / TICKET_KEY)
packages/server/test/  hook-sandbox.test.ts (新), local-sandbox.test.ts / worktree.test.ts / development.test.ts / delivery.test.ts / config.test.ts / project-rules.test.ts / http.test.ts / executor.test.ts (改), fixtures/hooks/ (新：假 lint-staged、假 commitlint)
packages/web/src/  pages/SettingsPage.tsx (改：开发分区两个新开关、沙箱状态卡), lib/settings-model.ts, lib/api.ts, i18n/en.ts (改)
docs/spikes/2026-11-phase4-sandbox.md (任务 1), docs/spikes/phase4a-exit.md (任务 8), README.md (改：Security notes / Residual risks)
```

---

### 任务 1：技术验证 — hook 包装、git 目录写规则、loopback 白名单的 SBPL 语义（一次性）

**文件：** `docs/spikes/2026-11-phase4-sandbox.md`（新）；一次性脚本放在 `.superpowers/spikes/phase4a/`（不进产品，不提交脚本以外的产物）。

**要回答的问题（每个给出决定值，回填到任务 2–4）：**

| 决定值 | 问题 | 用于 |
|---|---|---|
| `HOOK_GIT_WRITES` | lint-staged 式 hook 在 linked worktree 中实际写了公共目录与 `worktrees/<name>/` 下的哪些路径（用 `fs_usage` 不可行时，用一个拒绝一切写入的配置逐项放开，记录 `EPERM` 的路径） | 任务 2 |
| `HOOK_ENV_KEEP` | git 为 hook 设置的环境变量（`GIT_INDEX_FILE`、`GIT_DIR`、`GIT_PREFIX`、`GIT_EDITOR`、`GIT_AUTHOR_*`、`GIT_REFLOG_ACTION` 等）中，包装必须原样传给 hook 的集合；包装从环境中去掉哪些（`SSH_AUTH_SOCK`、`GPG_AGENT_INFO` 等 T5-4 的 `AGENT_ENV`、`ANTHROPIC_*`） | 任务 3 |
| `HOOK_STDIN` | pre-push 的 stdin（ref 行）经 `sandbox-exec` 的 `exec` 后是否完整到达 hook；commit-msg 的参数（消息文件路径）在 `GIT_DIR` 下，可写 | 任务 3 |
| `LOOPBACK_ALLOWLIST_SBPL` | `(deny network-outbound (remote tcp "localhost:*"))` 后跟 `(allow network-outbound (remote tcp "localhost:<p>"))` 是否按"后写优先"放行；是否同时覆盖 `127.0.0.1`、`::1`；Tailscale 地址（`*:` 规则）怎么表达 | 任务 4 |
| `LOOPBACK_SELF_BIND` | 沙箱内进程先 `listen(0)` 再连自己的端口，在白名单模式下是否被拒；若被拒，有没有 SBPL 写法只放行"本沙箱绑定的端口"（例如 `network-bind` 与 `local` 过滤器） | 任务 4 |
| `NON_DARWIN_MESSAGE` | Linux 上 `process.platform`、`sandbox-exec` 缺失时现有自检返回的 detail，确认文案 | 任务 5 |

- [ ] **步骤 1：** 在临时目录建一个仓库 + linked worktree（`GIT_CONFIG_GLOBAL=/dev/null`），写 `fixtures/hooks/fake-lint-staged.sh`：`git stash push --keep-index -q`（有改动时）、改写暂存文件内容、`git add`、`git stash pop -q`、在 `$GIT_DIR` 下写并删一个临时文件。用一个只允许写 worktree 的配置运行它，逐条记录被拒路径，得到 `HOOK_GIT_WRITES`。
- [ ] **步骤 2：** 同一仓库测 `HOOK_ENV_KEEP` 与 `HOOK_STDIN`（pre-push 用一个本地 bare 远端）。
- [ ] **步骤 3：** 测 `LOOPBACK_ALLOWLIST_SBPL` 与 `LOOPBACK_SELF_BIND`（测试进程自己在随机端口监听，沙箱内 `node -e` 连接）。
- [ ] **步骤 4（作者）：** 作者在自己一个用 husky + lint-staged + commitlint 的**测试**仓库上，用步骤 1 得到的配置跑一次提交，记录结果。作者未能执行时，在 spike 文档中写明"未核对"，转入任务 8 的出口核对。
- [ ] **步骤 5：** 写 spike 文档（每个决定值一节：方法、证据、结论）；文档中不出现真实路径（用 `/Users/<you>`、`/path/to/test-repo`）。提交：`docs: phase 4a sandbox spike — hook writes, hook env, loopback allowlist`

### 任务 2：`dev-hook` 沙箱配置与自检

**文件：** `sandbox/local-sandbox.ts`、`sandbox/selfcheck.mjs`、`test/local-sandbox.test.ts`、`test/fixtures/hooks/`（任务 1 的假 lint-staged 与一个假 commitlint：读 `$1` 文件、不合格式 exit 1）

**接口（产出）：**
```ts
type SandboxKind = 'dev-command' | 'dev-install' | 'acceptance' | 'acceptance-install' | 'dev-hook'
SandboxScope += {
  /** dev-hook only: the repo's git common dir and this worktree's admin dir (`<common>/worktrees/<name>`), realpaths */
  gitDirs?: { common: string; admin: string };
}
// dev-hook：读拒绝 / 端口拒绝 / unix socket / LaunchServices / 钥匙串规则与 dev-command 完全相同；
// 写允许 = dev-command 的写允许 + HOOK_GIT_WRITES（任务 1）下的 common/admin 路径；
// 写拒绝（放在允许之后，后写优先）：<common>/config、<common>/hooks、<common>/info、<admin>/config.worktree、<worktree>/.git（指针文件）
// gitProtect 对 dev-hook 不适用（必须为空）；gitDirs 缺失 → SandboxUnavailableError
hookScope(home: string, key: string, wt: string, gitDirs: {common: string; admin: string}, extraPorts: readonly number[]): SandboxScope
```
selfcheck 对 `dev-hook` 增加两项：在 `<admin>` 下创建并删除一个文件必须成功；写 `<common>/config` 必须 `EPERM`。

- [ ] **步骤 1：写失败测试（真实 `sandbox-exec`，非 darwin 跳过并注明）：** `sandboxProfile({kind:'dev-hook', …})` 不含绝对路径、含 `COMMON_GIT`、`ADMIN_GIT` 参数；缺 `gitDirs` → `SandboxUnavailableError`；在 `dev-hook` 中运行任务 1 的假 lint-staged → exit 0，暂存内容被改写；写 `<common>/config`、在 `<common>/hooks/` 新建文件、改 worktree 的 `.git` 指针 → `EPERM`；连 `127.0.0.1:4317` → `EPERM`；读注入 `homeDir` 下的 `.ssh/id` → `EPERM`；读 `${home}/slackoff.db` → `EPERM`；`sandboxSelfCheck` 对 `dev-hook` 为 ok 且 detail 含 `gitadmin:OK` 与 `gitconfig:EPERM`；`dev-command` 的 profile 文本与改动前逐字相同（快照）。
- [ ] **步骤 2：** `pnpm -F @slackoff/server test` 预期失败。
- [ ] **步骤 3：** 实现 `dev-hook` 规则与 `hookScope`，规则顺序按 T5-5（拒绝在前、平台自己的目录重新放行在后、git 元数据拒绝放在最后）。
- [ ] **步骤 4：** `pnpm test`、`pnpm typecheck` 通过。
- [ ] **步骤 5：** 提交：`feat(server): dev-hook sandbox profile — git dir writes allowed, config and hooks denied, self-check`

### 任务 3：包装 hooks 目录 — 提交与推送的 hook 在沙箱中运行

**文件：** `sandbox/hook-wrappers.ts`（新）、`git/worktree.ts`（`commitAll`）、`delivery/git-push.ts`、`development/dev-jobs.ts`、`delivery/delivery-jobs.ts`、`config.ts`、`http/app.ts`（`sensitive`）、`test/hook-sandbox.test.ts`（新）、`test/worktree.test.ts`、`test/development.test.ts`、`test/delivery.test.ts`、`test/config.test.ts`

**接口：**
```ts
// sandbox/hook-wrappers.ts
HOOK_NAMES: readonly string[]   // git 平台调用会触发的：pre-commit, prepare-commit-msg, commit-msg, post-commit, pre-push, post-rewrite, reference-transaction
type HookGate = { kind: 'sandboxed'; dir: string } | { kind: 'unsandboxed'; dir: string; reason: string }
prepareHookWrappers(o: {
  home: string; key: string; repo: string; wt: string;
  pin: HooksPin;                       // F2-I1 固定的 hooks 目录与指纹（worktree.ts 已有）
  config: Config;
  check?: (s: SandboxScope) => Promise<SandboxCheck>;
}): Promise<HookGate>
  // 重写 <home>/sandbox/<KEY>/<repo>/hooks/（先删后建，0700；文件 0755）：pin.dir 中每个存在且可执行的 HOOK_NAMES 一项生成一个同名包装，
  // 其他 hook 名不生成（git 不会调用不存在的 hook）。包装：
  //   1. 重新计算 pin.dir 的指纹（hashHooksDir），与 pin.hash 不同 → stderr "Slack Off: hooks changed since they were accepted" exit 1
  //   2. unset AGENT_ENV 与 ANTHROPIC_*；保留 HOOK_ENV_KEEP；TMPDIR 等按 sandboxEnv(hookScope)
  //   3. exec sandbox-exec <dev-hook profile> <pin.dir>/<name> "$@"（stdin 原样）
  // 自检失败：config.development.allowUnsandboxedHooks → 包装直接 exec 原 hook（unsandboxed，仍做第 1 步）；否则抛 SandboxUnavailableError(
  //   `${detail} — git hooks are not run without the sandbox. To run them anyway, turn on Settings → Development → "Run git hooks without the sandbox" on this computer`)
// git/worktree.ts
commitAll(home, wt, message, hookTimeoutMs, opts: { hooksDir?: string }): Promise<CommitOutcome>   // 签名不变；调用方改为传包装目录
// delivery/git-push.ts
pushBranch(…, o += { hooksDir?: string })   // push 前加 -c core.hooksPath=<hooksDir>
Config.development += { allowUnsandboxedHooks: boolean /* 默认 false，仅限本机 */ }
```
dev-jobs：每次 `commitAll` 前（只在仓库配置了 hooks 时，`w.hooks?.hooksPath != null` 或 husky）调用 `prepareHookWrappers`；`SandboxUnavailableError` → `RepoProblem`（`blocked`，原因含仓库名与上述文案），不提交；`unsandboxed` → 审计 `hooks_unsandboxed {repo, reason}`。交付：push 步骤同样准备包装（scope 用该票 worktree），失败 → 步骤 `failed`、票 `blocked`，同阶段 3 的推送失败。没有配置 hooks 的仓库行为不变。

- [ ] **步骤 1：写失败测试：** 临时仓库 + worktree，hooks 目录（`core.hooksPath=.githooks`）有 pre-commit（运行假 lint-staged）、commit-msg（假 commitlint）、pre-push（读 stdin 写到 `$GIT_DIR/../pushed.txt`——在 worktree 内）。经 `prepareHookWrappers` + `commitAll`：提交成功，lint-staged 的改写进入提交；commit-msg 拒绝不合格消息 → `hook_failed` 且输出含 commitlint 的错误；pre-commit 中 `node -e` 连 `127.0.0.1:4317` → 提交失败、输出含 `EPERM`；pre-commit 读注入 HOME 的 `.ssh/id` → `EPERM`；pre-commit 写 `$GIT_COMMON_DIR/config` → `EPERM`；包装生成后改动 `.githooks/pre-commit` → 提交失败且输出含 "hooks changed since they were accepted"；仓库在 worktree 配置里把 `core.hooksPath` 指向另一个目录 → 仍运行包装（`-c` 优先）；包装目录不在 `allowInHome`（agent 可写范围）内；注入失败的自检 + 开关关 → `SandboxUnavailableError` 含 "Run git hooks without the sandbox"、提交未发生（`git rev-parse HEAD` 不变）；开关开 → 提交成功、审计 `hooks_unsandboxed`；pre-push 经 `pushBranch` 到本地 bare 远端，stdin 的 ref 行完整到达；远程会话改 `development.allowUnsandboxedHooks` → 403；fake 模式的 e2e 仓库没有 hooks → 行为不变。
- [ ] **步骤 2：** 预期失败。
- [ ] **步骤 3：** 实现。包装脚本文本用 `shq` 引用全部路径；包装目录路径必须是 realpath 且不含换行。
- [ ] **步骤 4：** `pnpm test`、`pnpm typecheck`、`pnpm e2e` 通过。
- [ ] **步骤 5：** 提交：`feat(server): git hooks run in the dev-hook sandbox through platform hook wrappers; local-only opt-out`

### 任务 4：可选的本机端口白名单

**文件：** `sandbox/local-sandbox.ts`、`sandbox/selfcheck.mjs`、`config.ts`、`projects/project-rules.ts`、`development/dev-jobs.ts`、`acceptance/review-jobs.ts`（scope 带上 `baseUrl` 端口）、`http/app.ts`（`sensitive`）、`test/local-sandbox.test.ts`、`test/project-rules.test.ts`、`test/config.test.ts`

**接口：**
```ts
Config.development += { localNetwork: 'denylist' | 'allowlist' /* 默认 'denylist'，仅限本机 */ }
ProjectRules += { sandbox: { localPorts: number[] } }   // 默认 {localPorts: []}；与 DENIED_PORTS 相交 → ProjectRulesError（含仓库名与字段路径）
SandboxScope += { localNetwork?: { mode: 'allowlist'; allowPorts: readonly number[] } }
  // 缺省 = denylist（阶段 3 行为，profile 文本不变）；allowlist：先 deny localhost:* 与 Tailscale 地址 *:*（按 LOOPBACK_ALLOWLIST_SBPL），
  // 再 allow allowPorts（dev-*：所有受影响仓库 sandbox.localPorts 的并集；acceptance-*：并集 + baseUrl 端口），
  // DENIED_PORTS 的拒绝放在最后（无论如何不放行）；LOOPBACK_SELF_BIND 为可行时加入"本沙箱绑定的端口"放行
```
自检在 allowlist 模式多一项：测试进程在一个未声明的随机端口监听，沙箱内连接必须 `EPERM`。

- [ ] **步骤 1：写失败测试：** 规则文件 `sandbox.localPorts: [4317]` → 报错；`[70000]` → 报错；21 项 → 报错；缺省 → `[]`。denylist 模式 profile 文本与改动前逐字相同。allowlist 模式（真实 `sandbox-exec`）：测试进程在端口 A、B 监听，`allowPorts: [A]` → 连 A 成功、连 B `EPERM`（`127.0.0.1` 与 `::1` 都测）、连 4317 `EPERM`；若 `LOOPBACK_SELF_BIND` 可行：沙箱内 `listen(0)` 后连自己成功；自检 detail 含 `undeclared:EPERM`；验收 scope 的 allowPorts 含 `baseUrl` 端口；远程会话改 `development.localNetwork` → 403。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck`、`pnpm e2e` 通过（e2e 用默认 denylist）。
- [ ] **步骤 5：** 提交：`feat(server): optional local-port allowlist for sandboxed commands (development.localNetwork)`

### 任务 5：非 macOS 的明确行为 — `SandboxBackend`、`GET /api/sandbox`、设置页状态卡

**文件：** `sandbox/local-sandbox.ts`、`http/app.ts`、`main.ts`、`packages/web/src/pages/SettingsPage.tsx`、`lib/api.ts`、`lib/settings-model.ts`（+ `.test.ts`）、`i18n/en.ts`、`test/http.test.ts`、`test/local-sandbox.test.ts`

**接口：**
```ts
// sandbox/local-sandbox.ts
interface SandboxBackend { name: 'sandbox-exec' | 'none'; available: boolean; reason: string | null }
sandboxBackend(o?: { platform?: NodeJS.Platform; exists?: (p: string) => boolean }): SandboxBackend
  // darwin + /usr/bin/sandbox-exec 存在 → {name:'sandbox-exec', available:true, reason:null}；否则 {name:'none', available:false, reason: NON_DARWIN_MESSAGE}
  // sandboxSelfCheck 的平台判断改为调用它（行为不变）
// GET /api/sandbox（任何已配对设备可读，只读）
{ backend: SandboxBackend; selfCheck: { ok: boolean; detail: string; at: string } | null /* 缓存 60 s 的 dev-command 自检，用临时 scope */;
  switches: { allowUnsandboxedCommands: boolean; allowUnsandboxedHooks: boolean; localNetwork: 'denylist'|'allowlist' } }
```
main.ts 启动时若 `available === false` 打印一行 `Command sandbox unavailable: <reason>. Development commands, git hooks and acceptance will not run unless you turn on the opt-outs (README → Security notes).`。设置页"开发"分区顶部显示状态卡（可用：绿色 "Sandbox: on (macOS sandbox-exec)"；不可用：琥珀色原因 + 两个开关的说明），并加两个仅限本机的开关："Run git hooks without the sandbox"（文案："Off (recommended): your pre-commit, commit-msg and pre-push hooks run in a sandbox that cannot reach Slack Off or read your credentials. If the sandbox is unavailable, Slack Off does not commit. On: hooks run with your full user permissions."）与 "Local network: deny listed ports / allow declared ports only"。

- [ ] **步骤 1：写失败测试：** `sandboxBackend({platform:'linux'})` → `available:false`、reason 非空；`{platform:'darwin', exists:() => false}` → 不可用；`GET /api/sandbox` 返回三组字段且远程会话也可读；settings-model：远程会话下两个新开关不可编辑；390px 下状态卡与开关行不溢出（web 模型测试检查文案键存在；布局由任务 8 的 e2e 检查）。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck`、`pnpm -F web build` 通过。
- [ ] **步骤 5：** 提交：`feat: sandbox status (backend, self-check, switches) in Settings; explicit non-macOS behaviour`

### 任务 6：开发 agent Bash 包装的守卫与 shell 包装的环境清理

**文件：** `executor/run-agent.ts`、`sandbox/local-sandbox.ts`（`writeShellPrefix`）、`development/dev-jobs.ts`、`test/executor.test.ts`、`test/development.test.ts`、`test/local-sandbox.test.ts`

**接口：**
```ts
RunAgentRequest += { unsandboxedReason?: string }
  // implement-ticket：allowedTools 中有任一 'Bash(' 开头的规则时，必须有 shellPrefix，或有非空 unsandboxedReason（来自 allowUnsandboxedCommands 的 gate），否则 SandboxPolicyError("implement-ticket: Bash is allowed but its commands are not sandboxed")
  // dev-jobs 的 agentCommands 在 sb.kind === 'unsandboxed' 时返回 unsandboxedReason
// writeShellPrefix：在 `unset ${AGENT_ENV}` 之后再 unset 所有 ANTHROPIC_* 与 CLAUDE_CODE_OAUTH_TOKEN（为 4b 的 API key 做准备；用 `env | sed` 列出 ANTHROPIC_ 前缀的变量名后逐个 unset）
```

- [ ] **步骤 1：写失败测试：** `runAgent` 对 implement-ticket、`allowedTools: ['Bash(cd x && pnpm test)']`、无 `shellPrefix` → `SandboxPolicyError`；同时给 `unsandboxedReason` → 正常运行；没有 Bash 规则 → 正常；dev-jobs 在开关打开、自检失败时传 `unsandboxedReason`；`writeShellPrefix` 生成的包装在环境含 `ANTHROPIC_API_KEY=x`、`ANTHROPIC_FOO=y` 时执行 `env`，输出不含 `ANTHROPIC_`（真实 `sandbox-exec`，非 darwin 跳过）。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`fix(server): refuse an implement-ticket run with unsandboxed Bash; the shell wrapper drops ANTHROPIC_* variables`

### 任务 7：安全相关的遗留小项

**文件：** `sandbox/local-sandbox.ts`、`acceptance/workspace.ts`、`main.ts` / `config.ts`、`packages/shared/src/ticket-key.ts`（新）+ `index.ts`、四处票号正则的使用者（`jira/jira-updater.ts`、`jira/jira-commenter.ts`、`executor/run-agent.ts` 以及 `grep -rn "A-Z0-9_]\*-" packages/server/src` 找到的其余文件）、相应测试

**内容（每项一个测试，全部先红后绿）：**
1. **worktree 根目录不可被移走**（Task 5 minor）：dev-* 配置加 `(deny file-write-unlink (literal (param "WORKTREE_ROOT_<i>")))` 与对 `ticketDir` 本身的 rename 拒绝。测试：沙箱内 `mv <ticketDir>/<repo> <ticketCache>/x` → `EPERM`；worktree 内文件照常可删。
2. **`acceptRunBase()` 与 `/private/tmp/claude-*`**（Task 6 minor）：先写测试——`TMPDIR=/private/tmp/claude-abc` 时 `acceptRunBase()` 不返回该前缀下的目录（改用 `os.tmpdir()` 的 realpath 之外的固定短前缀 `/private/tmp/slackoff-accept-<uid>`，0700，所有者核对）。若阶段 3 任务 9 已修复且测试直接通过，只保留测试，在提交信息中注明。
3. **fake 模式的内存改写不写回磁盘**（Task 17 minor）：fake 模式在内存中改的 `acceptance.claudeConfigDir`、`jira.baseUrl`、`projects.FAKE` 在 `PUT /api/config` 保存时不落盘——`saveConfig` 收到的是"磁盘上的值 + 本次请求改的字段"，内存覆盖项单独保存在 `fakeOverlay`，`applyConfig` 后再叠加。测试：fake 模式下保存一次设置，磁盘上的 `config.json` 不含 fake 路径与 `FAKE` 项目。
4. **票号校验只有一份**（Task 18 minor）：`@slackoff/shared` 导出 `TICKET_KEY = /^[A-Z][A-Z0-9_]*-[0-9]+$/` 与 `isTicketKey(s): boolean`；服务端各处改为导入。测试：`isTicketKey('PROJ-1')` true，`'proj-1'`、`'PROJ-'`、`'PROJ-1\n'`、`'-1'` false；源码守卫测试：`packages/server/src` 中除 shared 之外不再出现该正则字面量。

- [ ] **步骤 1：** 写四组失败测试。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck`、`pnpm e2e` 通过。
- [ ] **步骤 5：** 提交：`fix: phase 3 deferred security minors — worktree root move, accept run base, fake overlay, one ticket-key check`

### 任务 8：e2e、README、出口核对

**文件：** `dev/fake-repo.ts`（`web` 仓库加一个 `.githooks/pre-commit`：运行一个离线的假 lint-staged（仓库内脚本）、`core.hooksPath=.githooks`）、`e2e/phase2.spec.ts` 或新 `e2e/phase4a.spec.ts`（若新增，`playwright.config.ts` 加 project 并加入 `pnpm e2e`）、`README.md`、`docs/spikes/phase4a-exit.md`（新）

- e2e（desktop 1440 与 390×844 各一）：FAKE-1 开发步骤提交时 pre-commit 在 `dev-hook` 沙箱中运行（hook 把 `$$` 与"sandboxed"标记写到一个文件；断言 hook 中连 4317 失败的探测输出出现在步骤输出里）；设置页"开发"分区显示沙箱状态卡与两个新开关，手机视图中它们只读且 `scrollWidth === 390`。
- README "Security notes for development" 与 "Residual risks"：删掉"git hooks 在沙箱外运行"一条，改为 hooks 在 `dev-hook` 沙箱中运行（能做什么 / 不能做什么、需要写别处的 hook 会失败、开关）；"Not sandboxed" 只剩 `claude` 进程本身与 `gh`；新增 `development.localNetwork` 与规则文件 `sandbox.localPorts`；非 macOS 一节改为状态卡与启动日志的说明。
- `docs/spikes/phase4a-exit.md`（同阶段 3 出口文档格式："结果：____ / 日期：____ / 备注：____"，示例只用占位名），作者手工核对：
  0. 真实 husky + lint-staged + commitlint 测试仓库：开发一张票，提交成功；故意让 lint 失败 → `hook_failed`；hook 中 `fetch('http://127.0.0.1:4317/api/status')` → 失败。
  1. 签名提交（若作者使用签名）仍然成功（签名在沙箱外）。
  2. 真实 `claude` 在开发包装下的 Bash：命令 exit 0、cwd 文件写入（阶段 3 出口第 9 项遗留）。
  3. 钥匙串探测（阶段 3 出口第 9 项最后一条，原样搬来：只用一次性条目 `slackoff-probe`，用后删除，绝不探测真实凭证）。
  4. `development.localNetwork: 'allowlist'` 下，一个测试自己起服务器的仓库：未声明端口时失败，声明后通过。
  5. 读一遍新的 "Residual risks"。

- [ ] **步骤 1：** fake 仓库 hook 与 e2e。
- [ ] **步骤 2：** `pnpm test`、`pnpm typecheck`、`pnpm e2e` 全部通过。
- [ ] **步骤 3：** README 与出口文档。
- [ ] **步骤 4：** 提交：`test: phase 4a e2e (hooks sandboxed, desktop + 390px); docs: README sandbox notes and phase 4a exit checklist`

---

## 自审

**1. Spec 覆盖：** §10 阶段 4 "OS 级命令沙箱"剩余三项——开发 agent 经精确规则运行的命令（已由阶段 3 R-LOCAL-3 包装，任务 6 加守卫与环境清理，任务 8 出口核对 2）、git hooks（任务 1–3）、非 macOS（任务 5，裁决 A-5 只做明确行为）。T5-6 的网络隔离（任务 4）。F-2（任务 3、8）。F-3 未探测的钥匙串（任务 8 核对 3）。安全相关 Deferred minors（任务 7）。无缺口；Linux 后端是有意不做，见索引作者问题 6。

**2. 步骤扫描：** 每个实现步骤都给出了签名、文件与测试断言；任务 1 的决定值表把不确定项集中在一处，后续任务引用名字而不重复猜测。

**3. 类型一致性：** `SandboxKind` 的 `'dev-hook'` 与 `SandboxScope.gitDirs`（任务 2 → 3）；`hookScope`（任务 2 → 3）；`HookGate`、`prepareHookWrappers`（任务 3 内）；`pushBranch(o.hooksDir)`（任务 3）；`SandboxScope.localNetwork`、`ProjectRules.sandbox.localPorts`、`Config.development.localNetwork`（任务 4 → 5）；`Config.development.allowUnsandboxedHooks`（任务 3 → 5）；`SandboxBackend`（任务 5）；`RunAgentRequest.unsandboxedReason`（任务 6）；`isTicketKey`（任务 7）。

**4. 审阅重点：** 五条均有测试落在所属任务：lint-staged 写操作（任务 2 步骤 1、任务 3 步骤 1）；绕过包装（任务 3：`-c` 优先、指纹不符）；沙箱不可用时不提交（任务 3）；白名单端口（任务 4）；Bash 漏包（任务 6）。

**5. 比例：** 计划只给签名、规则与断言；包装脚本与 SBPL 规则的具体文本由实现者按任务 1 的决定值写出。
