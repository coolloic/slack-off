# 阶段 4b · API 模式（ApiJiraSource + ClaudeApiExecutor）执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 实现 spec 目标 8、9 的可选一半：JIRA 可以用 **JIRA API 模式**（Jira Cloud REST v3，邮箱 + API token）代替浏览器模式；agent 可以用 **API 模式**（Anthropic API key）代替 Claude Code 订阅。两种凭证由用户在本机设置页输入，保存在 `${SLACKOFF_HOME}/credentials.json`（0600），绝不进 `config.json`、绝不出现在任何 HTTP 响应或发往手机的数据中、绝不进入 agent 运行的命令的环境。设置页的执行器与 JIRA 分区可以切换模式，并显示两张模式对比表。默认值不变：订阅模式 + 浏览器模式。

**架构：** 都放在已有接口之后，上层流程不改。`TicketSource`（`discover`、`fetchTicket`）、`JiraUpdater`（`setStatus`）、`JiraCommenter`（`postComment`）各增加一个 REST 实现（`jira/api-jira.ts`），由一个按调用读取当前配置的切换层（`jira/jira-clients.ts`）选择浏览器或 API 实现——同 `main.ts` 中执行器"每次调用读取 `claudeBin`"的做法，切换不需要重启。阶段 2、3 的 JIRA 写确认、写后只读核对、审计与重试规则原样适用于 API 实现。`Executor` 增加 `ClaudeApiExecutor`：它运行同一个 `claude` CLI、同一组沙箱参数，只是认证改为环境变量 `ANTHROPIC_API_KEY` 加一个平台专用的 `CLAUDE_CONFIG_DIR`（裁决 B-1）；argv 组装从 `ClaudeCodeExecutor` 中抽出共用，两者在测试中逐字比较。

**技术栈：** 同阶段 1–3。新增依赖：无（JIRA REST 用 Node 内置 `fetch`，测试注入假 `fetch`；不引入 `@anthropic-ai/claude-agent-sdk`，见裁决 B-1）。

**设计依据（Spec）：**
- 设计文档 §2 目标 8、9 与反目标"平台持有或要求用户输入 Claude 账号凭证或 JIRA 密码"（API key 与 JIRA API token 都不是账号密码；设置页文案写明"never your JIRA password"）；§3 Claude 访问、订阅模式的合规方式；§7 架构图；§7.1 两种模式对比表；§7.2 TicketSource；§10 阶段 4 "ApiJiraSource、ClaudeApiExecutor"；§5.3 第 1 步（发现的 JQL、`jira.discoverLimit`、"不完整"）；§9.9（快照含附件与内嵌截图）。
- 代码：`executor/types.ts`（`Executor`、`ExecRequest`、`ExecResult`）、`executor/claude-code.ts`、`executor/run-agent.ts`、`jira/ticket-source.ts`、`jira/browser-jira.ts`、`jira/jira-updater.ts`、`jira/jira-commenter.ts`（`normalizeCommentText`、`commentTextError`）、`jira/jira-write-jobs.ts`、`jira/jira-comment-jobs.ts`、`config.ts`、`http/app.ts`（`GET /api/config` 返回整个配置——所以凭证不能在配置里）、`main.ts`、`packages/web/src/pages/SettingsPage.tsx`、`packages/shared/src/schemas.ts`（`DiscoverResult`、`FetchedTicket`、`JiraUpdateResult`、`JiraCommentResult`）。
- 迁移：不需要（`agent_run.executor` 的 CHECK 已含 `'claude-api'`）。

## 裁决（每条附"错了的代价"）

- **裁决 B-1（ClaudeApiExecutor 运行同一个 CLI）：** spec §7.1 写"Claude Agent SDK + API key"。Agent SDK 是打包成库的 Claude Code 引擎；阶段 1–3 的全部隔离（`--restricted`、精确 Bash 规则、`--settings` 中的守卫 hook、`CLAUDE_CODE_SHELL_PREFIX` 沙箱包装、隔离环境、`--setting-sources ""`）都以 CLI 参数实现并经过实测。所以 `ClaudeApiExecutor` 调起同一个 `claude`，argv 与订阅模式逐字相同，只换认证。代价：偏离 spec 原文；若作者坚持用 SDK，只需在同一 `Executor` 接口后换实现，并重新证明每个隔离参数有对应选项（索引作者问题 3）。任务 8 把 spec §7.1 的这一句改为"以 API key 认证运行同一个 Claude Code CLI"。
- **裁决 B-2（API 模式的 Claude 配置目录）：** API 模式的运行使用平台专用 `CLAUDE_CONFIG_DIR = ${SLACKOFF_HOME}/claude-api-config`（0700），不碰用户的 `~/.claude`、不读钥匙串中的订阅登录；验收角色仍用 `acceptance.claudeConfigDir`（API 模式下不需要 `/login`）。代价：该目录中的会话记录同订阅模式一样由 `--no-session-persistence`（验收）或平台清理规则管理；不清理时会占磁盘。
- **裁决 B-3（凭证文件）：** 同索引裁决 X-4。文件格式 `{version: 1, jira: {email, apiToken, updatedAt} | null, anthropic: {apiKey, updatedAt} | null, otlpHeaders: {headers: Record<string,string>, updatedAt} | null}`（`otlpHeaders` 供 4c 使用）。权限比 0600 宽、是符号链接、所有者不是当前用户 → 拒绝读取并报错"credentials.json must be a regular file with mode 600 owned by you"，不自动修复。代价：用户手工改过权限时要自己 `chmod 600`。
- **裁决 B-4（API key 下的浏览器能力）：** claude-in-chrome 是否能在 API key 认证下工作由任务 1 实测（`API_CHROME`）。若不能：配置校验要求 `executor.kind === 'claude-api'` 时 `jira.source === 'api'`（设置页同时提示）；若能：两者独立。代价：若不能，API 执行器的用户必须同时配置 JIRA API token（索引作者问题 4）。
- **裁决 B-5（API key 不进命令环境）：** `ANTHROPIC_API_KEY` 只在 `claude` 进程的环境中；4a 任务 6 已让 shell 包装去掉 `ANTHROPIC_*`；没有 shell 包装的角色（没有 Bash）不运行命令；验收的隔离环境显式加入该键（只有 API 模式）。平台自己运行的 `runCommand`、hooks、目标应用的环境本来就不含它（阶段 3 白名单 / `sandboxEnv`），测试再钉一次。代价：无。
- **裁决 B-6（只支持 Jira Cloud）：** REST v3、`Authorization: Basic base64(email:token)`、发现用 `POST /rest/api/3/search/jql`（`nextPageToken` 分页）。Data Center / Server（REST v2 + PAT）不做（索引作者问题 7）。`jira.baseUrl` 已强制 `https://`。代价：自建 JIRA 的用户只能用浏览器模式。
- **裁决 B-7（请求只发往配置的主机）：** 所有带凭证的请求都必须是 `${jira.baseUrl}/rest/api/3/…`（同 origin）；`fetch` 用 `redirect: 'manual'`。唯一例外是附件内容：`/rest/api/3/attachment/content/{id}` 返回 3xx 时，最多跟随一次、只跟 `https://`、**不带** `Authorization` 头（签名 URL）。代价：需要鉴权才能取的跨主机附件在快照中只有元数据（`base64: null`），快照仍记录文件名与类型。
- **裁决 B-8（REST 写不经 agent）：** API 模式的状态变更与评论直接调 REST，不运行 `jira-update` / `jira-comment` 角色，因此没有 `agent_run`；确认、写后只读核对（状态读回、评论原样出现且评论数 +1）、审计、"失败从不自动重试、重启时执行中的写记为 failed"全部沿用阶段 2、3 的 jobs。代价：无。
- **裁决 B-9（凭证只能在本机设置）：** `PUT` / `DELETE /api/credentials/*` 仅限本机（同 R21 的 `localOnly`）；`GET /api/credentials` 任何设备可读，只返回 `{jira: {set, emailHint, updatedAt}, anthropic: {set, updatedAt}, otlpHeaders: {set, names, updatedAt}}`（`emailHint` 只在本机请求时返回，形如 `a…@example.com`；远程请求为 null）。代价：手机上不能换 token（需要回到电脑）。

## 全局约束

- 阶段 1–3 的全局约束全部继续有效；4a 的 shell 包装环境清理（4a 任务 6）是本计划的前提（未完成时，本计划任务 6 先完成那一步）。
- **Node 26**（裁决 N-1）。
- **移动优先**：新 UI 在 390px 宽无横向滚动，可点目标 ≥44px，凭证输入框在手机上只读显示"Set on this computer / Not set"。
- **公开内容**：仓库中不出现公司主机名、真实人名或邮箱；示例一律用 `https://your-company.atlassian.net`、`example-org`、`you@example.com`；测试中的 token 与 key 用明显的假值（`test-token-123`、`sk-ant-test-000`），并有一个测试断言源码与快照中没有形如真实 key 的字符串（`sk-ant-api` 前缀后跟 20 位以上）。
- **对外写入逐次经开发者确认**：REST 状态变更与评论只在开发者确认后由已有 jobs 发出（裁决 B-8）；发现与读取票是只读请求，不需要确认。
- **测试与探测不碰宿主状态**：不读写剪贴板、LaunchServices、钥匙串、rc 文件、`~/.gitconfig`、`~/.claude`、`~/.nvm`；测试不联网——JIRA REST 一律注入假 `fetch`，`claude` 一律用测试中的假 CLI 脚本（已有 `ClaudeCodeExecutor` 的 `[node, script]` 前缀方式）。任务 1 的真实核对只由作者执行。
- **凭证**：只在 `credentials.json`；任何日志、审计 payload、`agent_run.error`、HTTP 错误体、SSE 事件中不得出现凭证值（任务 2 的 `redactSecrets` 统一处理，测试覆盖）。
- **提交信息**以下面两行结尾：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Q3ZdR36s9c6TU4rsfHiJ3Z
  ```
- **新配置键**：`executor.kind: 'claude-code' | 'claude-api'`（默认 `'claude-code'`）、`jira.source: 'browser' | 'api'`（默认 `'browser'`）。两者都已在 `sensitive()` 覆盖的对象中（`executor` 整体；`jira.source` 需要加入）。
- **新审计事件**：`credentials_changed`（payload `{which: 'jira'|'anthropic'|'otlpHeaders', action: 'set'|'removed'}`，不含值）。

## 审阅重点

1. **API key / token 泄露**：经 agent 的 Bash 命令（`env`、`printenv`、读 `/proc` 不适用于 macOS 但 `ps -E` 可以看到别的进程环境——sandbox 内 `ps -E` 能否读到 claude 进程的环境？）、经 hooks / `runCommand` / 目标应用的环境、经原始运行日志（stream-json 的 `system init` 事件只含 `apiKeySource`）、经错误消息（401 响应体回显、`fetch` 异常中带 URL 与头）、经 `GET /api/config` / `GET /api/credentials` / SSE、经审计。期望：只有 `claude` 进程与平台内存持有；所有输出位置经 `redactSecrets`；任务 6 测试 `ps -E -p <claude pid>` 在开发沙箱中被拒或看不到该变量（若能看到，在 README 残余风险中写明并把 `ANTHROPIC_API_KEY` 改为经 `apiKeyHelper` 脚本提供——任务 1 决定值 `API_KEY_DELIVERY`）。（任务 1、2、6）
2. **JIRA REST 的分页与上限**：发现结果超过 `discoverLimit`、某一页 5xx / 超时、`nextPageToken` 缺失、`isLast` 与条数不符、同一票出现两次 → `complete` 只在读完全部页时为 true；部分失败时不改"JIRA 中已不再打开"标记（spec §5.3 第 1 步）；`total` 为已知总数（v3 新接口不返回 total 时，读完为条数，未读完为 `null` 改不了 schema → 取已读条数且 `complete: false`）。（任务 4）
3. **带凭证的请求被引到别处**：`baseUrl` 之外的 URL（票描述里的链接、附件 `content` 字段指向别的主机、3xx 到别的主机、`self` 字段）→ 绝不带 `Authorization` 请求；附件重定向只跟一次、只 https、去掉凭证；票号 / 状态名进入 URL 路径前经 `isTicketKey` 与 `encodeURIComponent`。（任务 4）
4. **状态转换的歧义**：目标状态名在 transitions 中出现多次、只有大小写不同、需要必填字段的 transition（`hasScreen` / `fields.required`）、已是目标状态 → 与浏览器模式相同的四种结果：`changed`、`already_in_status`、`transition_unavailable`（不挑相似的状态）、`failed`（需要填字段时不提交）；写后用 `fetchTicket` 读回核对。（任务 4）
5. **模式切换的中途状态**：一张票的发现在浏览器模式进行中时切到 API 模式、执行器切换时有 agent 在运行、凭证被删除后有排队的写 → 正在运行的继续用开始时的实现；新的调用用新配置；凭证缺失时 API 实现抛 `JiraNotConfiguredError` / `ExecutorUnavailableError`（`isSourceError` 横幅、票 `blocked` 原因明确），绝不回退到另一种模式。（任务 5、6）

---

## 文件结构

```
packages/server/src/
  credentials/credential-store.ts (新：读写 0600 文件、状态、redactSecrets)
  jira/api-jira.ts (新：ApiJiraSource、ApiJiraUpdater、ApiJiraCommenter), jira/adf.ts (新：ADF ↔ 纯文本), jira/jira-clients.ts (新：按调用切换)
  executor/claude-args.ts (新：从 claude-code.ts 抽出的 argv 组装), executor/claude-code.ts (改), executor/claude-api.ts (新), executor/types.ts (改)
  config.ts (改), http/app.ts (改：/api/credentials、sensitive、status.jira.source), main.ts (改), sandbox/local-sandbox.ts (改：credentialPaths 加凭证文件)
  dev/fake-jira-api.ts (新：fake 模式的 REST 假 fetch)
packages/server/test/  credential-store.test.ts, api-jira.test.ts, adf.test.ts, claude-api.test.ts (新), executor.test.ts / config.test.ts / http.test.ts / local-sandbox.test.ts (改), fixtures/jira-rest/*.json (新)
packages/web/src/  pages/SettingsPage.tsx (改：执行器与 JIRA 分区), components/CredentialField.tsx (新), components/ModeComparison.tsx (新), lib/settings-model.ts (+ test), lib/api.ts, i18n/en.ts (改)
e2e/phase4b.spec.ts (新), playwright.config.ts, package.json
docs/spikes/2026-11-api-modes.md (任务 1), docs/spikes/phase4b-exit.md (任务 8), README.md, spec §7.1 一句
```

---

### 任务 1：技术验证 — API key 下的 CLI、JIRA REST 的真实形状（作者参与）

**文件：** `docs/spikes/2026-11-api-modes.md`（新）

| 决定值 | 问题 | 默认（作者未能核对时） | 用于 |
|---|---|---|---|
| `API_AUTH_EVIDENCE` | `ANTHROPIC_API_KEY=<测试 key> CLAUDE_CONFIG_DIR=<空目录> claude -p 'Reply OK' --output-format stream-json --verbose --setting-sources ""` 的 init 事件 `apiKeySource` 值；无需 `/login`；`result.total_cost_usd` 与 `usage` 字段存在 | 期望 `apiKeySource: "ANTHROPIC_API_KEY"` | 任务 6 |
| `API_CHROME` | 同样条件下加 `--chrome` 能否列出 claude-in-chrome 工具 | `'unavailable'`（裁决 B-4 的保守分支） | 任务 3、6 |
| `API_KEY_DELIVERY` | 开发沙箱内 `ps -E -o command -p <claude pid>` 能否看到 `ANTHROPIC_API_KEY`；若能，改用 `--settings` 中的 `apiKeyHelper`（脚本从凭证文件读取，路径在沙箱拒绝列表中）是否可行 | `'env'`，并在 README 残余风险写明 | 任务 6 |
| `API_AUTH_ERROR` | key 无效时的退出码与 `result` 文本 | 退出非 0，文本含 "Invalid API key" | 任务 6 |
| `JIRA_SEARCH_SHAPE` | 测试 JIRA 上 `POST /rest/api/3/search/jql`（`jql`、`fields`、`maxResults`、`nextPageToken`）的响应字段：`issues[]`、`nextPageToken`、`isLast`，有无 `total` | 按 Atlassian 文档：无 `total`，有 `isLast` | 任务 4 |
| `JIRA_ATTACHMENT_REDIRECT` | 附件 `content` 是 200 还是 3xx 到别的主机 | 3xx 到 Atlassian 媒体主机 | 任务 4 |
| `JIRA_COMMENT_ADF` | 多行文本（含 `- ` 行与 URL）以每行一个 paragraph 的 ADF 发出后，读回经 `normalizeCommentText` 是否相等 | 相等 | 任务 4 |

- [ ] **步骤 1（作者）：** 用**测试** API key 与测试 JIRA（`https://your-company.atlassian.net` 只是占位，作者用自己的测试站点）运行上表命令；只把字段名、退出码与结论写进文档，绝不写入 key、token、邮箱、主机名、票的真实内容。
- [ ] **步骤 2：** 作者未能执行的项按"默认"列采用，并在文档中标"未核对 → 出口核对"。
- [ ] **步骤 3：** 提交：`docs: API mode spike — claude with an API key, JIRA REST shapes`

### 任务 2：凭证文件 `credentials.json`

**文件：** `credentials/credential-store.ts`（新）、`sandbox/local-sandbox.ts`（`credentialPaths` 加 `SLACKOFF_CREDENTIALS` 字面路径）、`http/app.ts`、`test/credential-store.test.ts`（新）、`test/http.test.ts`、`test/local-sandbox.test.ts`

**接口：**
```ts
CREDENTIALS_FILE = 'credentials.json'   // 在 SLACKOFF_HOME 下
interface Credentials { jira: {email: string; apiToken: string; updatedAt: string} | null; anthropic: {apiKey: string; updatedAt: string} | null;
                        otlpHeaders: {headers: Record<string, string>; updatedAt: string} | null }
interface CredentialStatus { jira: {set: boolean; emailHint: string | null; updatedAt: string | null}; anthropic: {set: boolean; updatedAt: string | null};
                             otlpHeaders: {set: boolean; names: string[]; updatedAt: string | null} }
class CredentialFileError extends Error {}
readCredentials(home: string): Credentials        // 文件不存在 → 全 null；lstat 非普通文件 / 符号链接 / (mode & 0o077) !== 0 / uid 不符 → CredentialFileError；JSON 无效 → CredentialFileError（不回显内容）
writeCredentials(home: string, next: Credentials): void
  // 目录 0700（已存在且更宽 → 收紧到 0700 前先确认所有者）；写 <file>.tmp-<pid>（open 'wx', mode 0o600）→ fsync → rename；校验同 read
credentialStatus(c: Credentials, local: boolean): CredentialStatus
redactSecrets(text: string, c: Credentials): string   // 把每个非空凭证值（以及 base64(email:token)）替换为 "[redacted]"
// 校验：email 为单行、含 '@'、≤254；apiToken 1–512 可见 ASCII；apiKey 1–512 可见 ASCII；otlp 头名 ^[A-Za-z0-9-]{1,64}$、值单行 ≤1024、最多 10 个
// HTTP
GET    /api/credentials                    → CredentialStatus（远程请求 emailHint 为 null）
PUT    /api/credentials/jira               {email, apiToken}     仅本机；审计 credentials_changed
PUT    /api/credentials/anthropic          {apiKey}              仅本机
PUT    /api/credentials/otlp-headers       {headers}             仅本机（4c 使用）
DELETE /api/credentials/:which                                   仅本机
```
所有 HTTP 错误处理器在返回前对消息调用 `redactSecrets`；`runAgent` 写 `agent_run.error` 前同样处理。

- [ ] **步骤 1：写失败测试：** 写入后文件 mode 为 `0o600`、目录 `0o700`；把文件 chmod 644 → `readCredentials` 抛 `CredentialFileError`；文件是符号链接 → 抛错；写入中途抛错（注入）→ 原文件不变、没有遗留 `.tmp-*`；`GET /api/credentials` 的响应体中不含 token、key、完整邮箱（对远程请求连 `emailHint` 也为 null）；`GET /api/config` 不含任何凭证字段；远程会话 `PUT /api/credentials/jira` → 403；本机 `PUT` 后审计 payload 只有 `{which, action}`；`redactSecrets('Basic ' + b64('a@b.c:tok'), creds)` 不含 `tok` 与其 base64；错误处理器对含 key 的异常消息返回 `[redacted]`；`dev-command` 沙箱读 `${home}/credentials.json` → `EPERM`（已被 `SLACKOFF_HOME` 拒绝，字面规则再钉一次，profile 文本含 `SLACKOFF_CREDENTIALS`）。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck` 通过。
- [ ] **步骤 5：** 提交：`feat(server): credentials.json (0600, outside config) with status-only API and secret redaction`

### 任务 3：配置 — `executor.kind` 与 `jira.source`

**文件：** `config.ts`、`http/app.ts`（`sensitive` 加 `jira.source`；`/api/status` 的 `jira.source` 与 `executor.kind` 取配置值）、`test/config.test.ts`、`test/http.test.ts`

**接口：**
```ts
Config.executor.kind: 'claude-code' | 'claude-api'   // 默认 'claude-code'；旧配置照常加载
Config.jira.source: 'browser' | 'api'                // 默认 'browser'
// 若 API_CHROME === 'unavailable'：superRefine — kind 'claude-api' 且 source 'browser' → issue {field: 'jira.source', rule: 'the API executor cannot drive Chrome: use the JIRA API mode'}
// source 'api' 且 baseUrl 为空 → 允许保存（同浏览器模式，使用时报 JiraNotConfiguredError）
```

- [ ] **步骤 1：写失败测试：** 缺省值；旧 `config.json` 无新键照常加载；`kind: 'other'` 报错；（`API_CHROME` 为 unavailable 时）`{kind:'claude-api', source:'browser'}` 报错且字段为 `jira.source`；远程会话改 `jira.source` 或 `executor.kind` → 403；`/api/status` 返回当前 `jira.source`。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): executor.kind and jira.source settings (this computer only)`

### 任务 4：`ApiJiraSource`、`ApiJiraUpdater`、`ApiJiraCommenter` 与 ADF

**文件：** `jira/api-jira.ts`、`jira/adf.ts`（新）、`test/api-jira.test.ts`、`test/adf.test.ts`（新）、`test/fixtures/jira-rest/`（新：按 `JIRA_SEARCH_SHAPE` 写的搜索页 1/2、issue、comments 页、transitions、附件元数据；全部用 `PROJ-1`、`you@example.com` 等占位）

**接口：**
```ts
type Fetch = typeof fetch
interface ApiJiraDeps { fetch: Fetch; config: () => Config['jira']; credentials: () => Credentials['jira']; now?: () => number }
class ApiJiraSource implements TicketSource {
  constructor(deps: ApiJiraDeps)
  discover(): Promise<DiscoverResult>
    // POST /rest/api/3/search/jql {jql: DISCOVER_JQL, fields: ['summary','status','updated'], maxResults: min(100, 剩余)}，按 nextPageToken 翻页直到 isLast 或达到 discoverLimit；
    // 重复的 key 只保留第一次；某页失败 → 已读结果 + complete:false（不抛错），第一页就失败 → 抛错；
    // TicketSummary.url = `${base}/browse/${key}`；total = 读完时为条数，否则为已读条数（complete:false）
  fetchTicket(key: string): Promise<FetchedTicket>
    // GET /rest/api/3/issue/{key}?fields=summary,description,status,updated,attachment,comment&expand=renderedFields
    // 评论超过 issue 中内嵌的那一页 → GET /rest/api/3/issue/{key}/comment?startAt=… 读完；comment.body (ADF) → adfToText；
    // 附件：image/* 且 ≤ 5 MB → 下载为 base64（裁决 B-7 的重定向规则）；其他 → base64 null；ADF 中的 media 节点 → kind 'inline_image'
}
class ApiJiraUpdater implements JiraUpdater {
  setStatus(key: string, targetStatus: string): Promise<JiraUpdateResult>
    // GET issue status → 已是目标（忽略大小写）→ already_in_status；GET transitions → to.name 与目标忽略大小写相等的恰一个 → POST transition；
    // 零个 → transition_unavailable；多于一个 → failed（"ambiguous transition"）；transition 有必填字段（expand=transitions.fields 中 required:true）→ failed，不提交；
    // 2xx 后再 GET 一次状态填 observedStatus；loginRequired 恒为 false（401/403 抛 JiraLoginRequiredError，见下）
}
class ApiJiraCommenter implements JiraCommenter {
  postComment(key: string, text: string): Promise<JiraCommentResult>   // commentTextError 先校验；POST /rest/api/3/issue/{key}/comment {body: textToAdf(text)}
}
// 共同规则：只请求 `${base}/rest/api/3/…`；redirect:'manual'（3xx → 抛错 "JIRA answered with a redirect; check the JIRA URL"）；
// 401/403 → JiraLoginRequiredError("The JIRA API token was rejected — update it in Settings → JIRA")；凭证缺失 → JiraNotConfiguredError；
// 429 → 按 Retry-After（≤30 s）重试一次，写操作不重试（返回 failed）；超时 30 s（AbortSignal.timeout）；错误消息经 redactSecrets；
// key 必须 isTicketKey，路径段 encodeURIComponent
// jira/adf.ts
adfToText(doc: unknown): string     // paragraph / heading / bulletList / orderedList / codeBlock / hardBreak / mention(取 attrs.text) / inlineCard(取 url) / media(→ "[image: <alt|id>]")；未知节点取其文本子节点
textToAdf(text: string): object     // 每行一个 paragraph；空行 → 空 paragraph；不解析 Markdown（"- " 原样保留，由 normalizeCommentText 比较）
```

- [ ] **步骤 1：写失败测试（全部用假 `fetch`，记录每次请求的 URL、方法、头）：** 两页搜索结果 + `discoverLimit: 150` → 两页都读、`complete: true`；`discoverLimit: 50` → 只请求一次、`maxResults: 50`、`complete: false`；第二页 500 → `complete: false` 且返回第一页的票；第一页 500 → 抛错；重复 key 只出现一次；每个请求的 URL 都以 `https://your-company.atlassian.net/rest/api/3/` 开头且带 `Authorization: Basic …`；附件 content 302 到 `https://media.example.net/x` → 第二个请求**不带** `Authorization`；302 到 `http://` → 不跟随、`base64: null`；6 MB 图片 → 不下载；issue 的 `self` 指向别的主机 → 不请求；401 → `JiraLoginRequiredError` 且 `isSourceError` 为 true，错误消息不含 token；凭证缺失 → `JiraNotConfiguredError`；key `'PROJ-1/../x'` → 抛错且没有请求；评论 25 条（内嵌 20 + 一页 5）→ 25 条且顺序正确；`setStatus` 四种结果各一个用例 + "两个同名 transition" → `failed` + "需要必填字段" → `failed` 且没有 POST；`postComment` 的请求体经 `adfToText(textToAdf(t))` 往返后 `normalizeCommentText` 相等；429 + `Retry-After: 1` 读请求重试一次，写请求不重试；`adfToText` 对 fixture 的描述输出预期文本（含列表、代码块、mention）。
- [ ] **步骤 2–4：** 失败 → 实现 → 通过。
- [ ] **步骤 5：** 提交：`feat(server): JIRA API mode — REST v3 discovery, ticket read, status transition and comment`

### 任务 5：按调用切换 JIRA 实现，接入 main 与 jobs

**文件：** `jira/jira-clients.ts`（新）、`main.ts`、`http/app.ts`（"Detect browsers" 在 API 模式下返回 409 "the JIRA API mode does not use Chrome"）、`test/workflow.test.ts` 或新 `test/jira-clients.test.ts`、`test/jira-update.test.ts`、`test/jira-comment.test.ts`

**接口：**
```ts
jiraClients(o: { config: Config; browser: {source: TicketSource; updater: JiraUpdater; commenter: JiraCommenter}; api: {source: TicketSource; updater: JiraUpdater; commenter: JiraCommenter} }):
  { source: TicketSource; updater: JiraUpdater; commenter: JiraCommenter }
  // 返回的三个对象每次方法调用时读 config.jira.source 选择实现（调用开始时决定，进行中的调用不受切换影响）
```
`jira-write-jobs.ts` / `jira-comment-jobs.ts` 不改：它们只依赖接口；API 实现返回的 `JiraUpdateResult` / `JiraCommentResult` 走同一核对路径。fake 模式两者都换成假的（任务 7）。

- [ ] **步骤 1：写失败测试：** `jira.source` 从 `'browser'` 切到 `'api'` 后，下一次 `discover` 调用 API 实现、正在进行的浏览器调用照常完成；一次 API 模式的 Ready for Human Review 写：确认后调用 `ApiJiraUpdater`、读回核对、审计 `jira_write_*` 与浏览器模式相同；API 模式的评论发送：`done` 且审计相同；凭证缺失时写 → `failed`（`JiraNotConfiguredError` 文案），不回退到浏览器；API 模式下 `POST /api/jira/browsers/detect` → 409。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test`、`pnpm typecheck`、`pnpm e2e` 通过。
- [ ] **步骤 5：** 提交：`feat(server): choose the JIRA browser or API implementation on every call`

### 任务 6：`ClaudeApiExecutor`

**文件：** `executor/claude-args.ts`（新）、`executor/claude-code.ts`、`executor/claude-api.ts`（新）、`executor/types.ts`、`executor/run-agent.ts`（`agent_run.executor` 取 `executor.kind`；验收隔离环境）、`main.ts`、`test/claude-api.test.ts`（新）、`test/executor.test.ts`

**接口：**
```ts
// executor/types.ts
interface Executor { readonly kind: 'claude-code' | 'claude-api'; exec(req: ExecRequest, onEvent: (e: AgentEvent) => void): Promise<ExecResult> }
// executor/claude-args.ts —— 从 ClaudeCodeExecutor.exec 中原样抽出，行为不变
buildClaudeArgs(req: ExecRequest, model: string): { args: string[] } | { error: SandboxPolicyError }
// executor/claude-api.ts
class ClaudeApiExecutor implements Executor {
  readonly kind = 'claude-api'
  constructor(claudeBin: string | readonly string[], o: { home: string; apiKey: () => string | null; processes?: AgentProcesses; model?: string })
  // 与 ClaudeCodeExecutor 共用 spawn / 流解析 / 超时 / 中止逻辑（抽成 runClaudeProcess(file, args, env, req, processes, onEvent)）；差别只在环境：
  //   非隔离：process.env 去掉 ANTHROPIC_*、CLAUDE_CODE_OAUTH_TOKEN、CLAUDE_CODE_SHELL_PREFIX、CLAUDE_CODE_TMPDIR，
  //           加 ANTHROPIC_API_KEY=<key>、CLAUDE_CONFIG_DIR=<home>/claude-api-config（0700，按需创建）
  //   隔离（acceptance）：isolatedEnv 的结果再加 ANTHROPIC_API_KEY（CLAUDE_CONFIG_DIR 仍为验收专用目录）
  //   key 为 null → ExecutorUnavailableError("Set your Anthropic API key in Settings → Executor")
  //   退出码非 0 且 result 文本匹配 API_AUTH_ERROR → ExecutorUnavailableError("The Anthropic API key was rejected — update it in Settings")
  //   API_KEY_DELIVERY === 'helper' 时改为 --settings 合并 {apiKeyHelper: <平台脚本>}（脚本读 credentials.json 输出 key），环境中不放 key
}
```
main.ts：`executor` 对象的 `kind` 改为 getter（读 `config.executor.kind`），`exec` 每次按当前配置构造 `ClaudeCodeExecutor` 或 `ClaudeApiExecutor`。

- [ ] **步骤 1：写失败测试（假 CLI：一个 node 脚本，把 argv 与 `process.env` 中 `ANTHROPIC_*` / `CLAUDE_CONFIG_DIR` 写到文件后输出一条 result 事件）：** 同一个 `ExecRequest`（含 chrome、restricted、addDirs、settingsJson、shellPrefix、extraArgs 各一例）在两个执行器下 argv 逐字相同；API 执行器的子进程环境有 `ANTHROPIC_API_KEY=sk-ant-test-000` 与 `CLAUDE_CONFIG_DIR=<home>/claude-api-config`、没有 `CLAUDE_CODE_OAUTH_TOKEN`；订阅执行器的子进程环境没有 `ANTHROPIC_API_KEY`（即使服务进程有）；隔离请求的环境恰为 `ACCEPT_ENV_KEYS` + `CLAUDE_CONFIG_DIR` + `ANTHROPIC_API_KEY`（API 模式）；key 为 null → `ExecutorUnavailableError` 且没有进程被启动；鉴权失败的 result → 相应错误且消息不含 key；`agent_run.executor` 为 `'claude-api'`；`result.total_cost_usd` 进入 `agent_run.cost_usd`；开发包装（4a 任务 6）下 Bash 的 `env` 不含 `ANTHROPIC_`（真实 `sandbox-exec`，非 darwin 跳过）；（`API_KEY_DELIVERY === 'env'` 时）开发沙箱内 `ps -E -p <假 CLI pid>` 的结果记录在测试输出中，若可见则测试注释链接 README 残余风险条目。
- [ ] **步骤 2–4：** 失败 → 实现（先做纯重构 `buildClaudeArgs` / `runClaudeProcess` 并让现有 `executor.test.ts` 不改通过，再加 API 执行器）→ 通过。
- [ ] **步骤 5：** 提交：`feat(server): ClaudeApiExecutor — the same Claude Code CLI and sandbox flags, authenticated with your API key`

### 任务 7：设置页 — 模式切换、凭证输入、对比表

**文件：** `packages/web/src/pages/SettingsPage.tsx`、`components/CredentialField.tsx`、`components/ModeComparison.tsx`（新）、`lib/settings-model.ts`（+ `.test.ts`）、`lib/api.ts`、`i18n/en.ts`

UI（移动优先，390px 下单列）：
- **执行器分区**：单选 "Claude Code subscription (default)" / "Anthropic API key"（仅本机可改；手机只读）；选 API 时显示 Anthropic API key 字段：`CredentialField`（`type=password`、`autocomplete=off`、从不预填；状态 "Set · updated 3 days ago" / "Not set"；按钮 "Replace" / "Remove"，"Remove" 经确认；保存只发 `PUT /api/credentials/anthropic`）；下方 `ModeComparison kind="executor"`（spec §7.1 的表，英文；手机上每行一张卡片而不是横向表格）；`API_CHROME` 为 unavailable 时提示 "The API key mode cannot drive Chrome: switch JIRA to the API mode too."。
- **JIRA 分区**：单选 "Browser (default) — no API token needed, uses your own browser login" / "JIRA API — email and API token"；API 时显示邮箱与 token 字段（同上，`PUT /api/credentials/jira`），说明 "An API token from your Atlassian account settings — never your JIRA password. Stored in credentials.json on this computer (mode 600), never sent to your phone."；"Detect browsers" 在 API 模式隐藏；下方 `ModeComparison kind="jira"`：

  | | Browser (default) | JIRA API |
  |---|---|---|
  | Needs | Chrome with Claude in Chrome, logged in to JIRA | An Atlassian API token and your email |
  | Credentials | Your browser session; never read or stored | Stored on this computer (credentials.json, mode 600) |
  | Speed and cost | One agent run per read (uses your Claude quota) | Direct HTTP calls, no agent run, no quota |
  | Robustness | Reads the page as a person would; page layout changes can confuse it | Structured data; needs API access to be allowed by your JIRA admins |
  | Supported | Jira Cloud, Data Center (any page you can open) | Jira Cloud (REST v3) |
  | Good for | Trying it out; no admin approval needed | Daily use; many tickets |

- [ ] **步骤 1：写失败测试（settings-model / 组件模型）：** 远程会话下两个单选与三个凭证字段不可编辑、显示 "Set on this computer" / "Not set"；凭证字段的值从不出现在 draft 配置中（保存配置的请求体不含 `apiToken` / `apiKey`）；`API_CHROME` unavailable 时选 API 执行器 + 浏览器 JIRA → 校验错误文案；对比表两张的行数与列标题。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm -F web test`、`pnpm -F web build` 通过。
- [ ] **步骤 5：** 提交：`feat(web): choose subscription or API key, browser or JIRA API; credentials entered on this computer only; mode comparison tables`

### 任务 8：fake 模式、e2e、README、出口核对

**文件：** `dev/fake-jira-api.ts`（新：一个假 `fetch`，用 fake source 的同一份票数据回应 REST 路径，记录写入）、`dev/fake-mode.ts`、`main.ts`、`e2e/phase4b.spec.ts`（新，desktop 与 390×844 各一个 project，加入 `pnpm e2e`）、`playwright.config.ts`、`package.json`、`README.md`、`docs/superpowers/specs/2026-11-06-slack-off-design.md`（§7.1 一句，裁决 B-1）、`docs/spikes/phase4b-exit.md`（新）

- fake 模式：`jira.source: 'api'` 时用 `ApiJiraSource` / `Updater` / `Commenter` + 假 `fetch`（真实 REST 代码路径被 e2e 覆盖）；凭证在 fake 模式下也必须先在设置页输入（e2e 输入假值）；`executor.kind: 'claude-api'` 在 fake 模式下仍走 `fakeRun`，但 `agent_run.executor` 记为 `'claude-api'`。
- e2e（desktop）：设置页切到 JIRA API → 输入 `you@example.com` 与 `test-token-123` → 状态显示 "Set" → `GET /api/config` 与 `GET /api/credentials` 的响应体不含 `test-token-123` → 发现票（经假 REST）→ FAKE-1 走到 `dev_done`（复用阶段 2 的 API 快速路径）→ 打开 JIRA 同步，确认一次 In Progress 写 → 假 REST 记录恰一次 transition POST。（390px）：设置页执行器与 JIRA 分区只读、对比表为卡片、`scrollWidth === 390`。
- README：新增 "Subscription vs API key" 与 "Browser vs JIRA API" 两张对比表（任务 7 的文案；4e 会整体重排 README，这里先写对内容）、凭证存放位置与权限、"never your JIRA password"、API 模式不运行 `jira-browser` 等角色、残余风险（若 `API_KEY_DELIVERY` 为 env 且 `ps -E` 可见）。spec §7.1"用 Claude Agent SDK 和用户提供的 API key 实现同一接口"改为"以用户提供的 API key 认证运行同一个 Claude Code CLI（同一组沙箱参数），实现同一接口（裁决 B-1，2026-11-09）"。
- `docs/spikes/phase4b-exit.md`（格式同阶段 3 出口文档），作者手工核对：0. 任务 1 未核对的决定值；1. 测试 JIRA 的 API 模式发现（>1 页）、读取一张带图片与多条评论的票，快照中图片可见；2. 只用测试票：API 模式改状态（含"已是目标状态"与"不存在的状态名"两种）、发一条多行评论并核对原样；3. 一个错误的 token → 横幅文案正确、日志中无 token；4. 用测试 API key 跑一张票从整理到方案，`agent_run` 中 `executor = claude-api` 且有费用；5. 打开 `~/.slackoff/credentials.json` 的权限（`ls -l` 显示 `-rw-------`）；6. 手机上设置页看不到任何凭证值。7. 文件工具守卫（裁决 4B-6、4B-7）：Claude Code 自身如何处理文件工具路径中的 `..`、开头的 `~` 与花括号（守卫一律拒绝），以及 Grep / Glob 在目录内是否跟随符号链接；结论写进出口文档。8. E1（裁决 4B-12）：真实 CLI 是否经 `CLAUDE_CODE_SHELL_PREFIX` 运行 `apiKeyHelper`（期望：不经过，helper 在沙箱外读 `credentials.json`；若经过，API 运行会以"The Anthropic API key was rejected"失败）；9. E2（裁决 4B-12）：真实 CLI 是否把从 `apiKeyHelper` 得到的 key 复制进子进程环境（Bash 命令、hooks、MCP 服务器）——在开发与验收沙箱中用任务 6 的 procargs 探针与 `env` 核对，期望都看不到。

- [ ] **步骤 1：** fake 模式与 e2e；`pnpm test`、`pnpm typecheck`、`pnpm e2e` 全部通过。
- [ ] **步骤 2：** README、spec 一句、出口文档。
- [ ] **步骤 3：** 提交：`test: phase 4b e2e (JIRA API mode, credentials never echoed, 390px); docs: mode tables, spec §7.1, phase 4b exit checklist`

---

## 自审

**1. Spec 覆盖：** 目标 8（任务 3、4、5、7）；目标 9（任务 3、6、7）；§7.1 对比表进 README 与设置页（任务 7、8）；§7.2 统一接口（任务 4、5）；§5.3 第 1 步的 JQL、上限、不完整（任务 4）；§9.9 附件与内嵌图片（任务 4，裁决 B-7 说明的缺口）；反目标"不要求 JIRA 密码 / Claude 账号凭证"（任务 7 文案、裁决 B-1 不碰订阅登录）；对外写入经确认（裁决 B-8，任务 5 测试）。偏离：§7.1 的"Agent SDK"（裁决 B-1，任务 8 改 spec，索引作者问题 3）。

**2. 步骤扫描：** 每个任务给出文件、签名、具体断言；任务 1 的未知项都有默认值，后续任务不被作者阻塞。

**3. 类型一致性：** `Credentials` / `CredentialStatus` / `readCredentials` / `redactSecrets`（任务 2 → 4、6、7，及 4c）；`Config.executor.kind`、`Config.jira.source`（任务 3 → 5、6、7）；`ApiJiraDeps`、三个 API 类（任务 4 → 5、8）；`jiraClients`（任务 5 → 8）；`Executor.kind` 联合类型、`buildClaudeArgs`、`runClaudeProcess`、`ClaudeApiExecutor`（任务 6 → 8）；决定值 `API_CHROME`、`API_KEY_DELIVERY`、`API_AUTH_ERROR`、`JIRA_SEARCH_SHAPE`、`JIRA_ATTACHMENT_REDIRECT`（任务 1 → 3、4、6）。

**4. 审阅重点：** 泄露（任务 2 redact 与权限、任务 6 环境与 `ps -E`）；分页与上限（任务 4）；带凭证的请求去向（任务 4）；transition 歧义（任务 4）；模式切换中途（任务 5、6）。

**5. 比例：** REST 路径与字段名是实现者无法自行决定的部分，所以写出；函数体留给实现者。
