# 阶段 4e · 开源准备（README、安装指南、贡献指南、LICENSE、公开内容与历史检查、第三方运行核对）执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让一个从没见过本项目的人，只看 README，就能在自己的 Mac 上把 Slack Off 跑起来（spec §10 阶段 4 出口："第三方按 README 能在自己机器上跑起来"）。为此：重写 README（两张模式对比表、合规提醒、"只用 skill、不装平台"）、写安装指南与 CONTRIBUTING、提出 LICENSE（由作者决定）、加一个防止公司主机名 / 人名 / 邮箱进入仓库的自动检查、扫描 git 历史并写出改写**提案**（不执行）、做一次全新克隆核对，并把所有发布动作留给作者。

**架构：** 文档与少量脚本。`scripts/public-content-check.mjs`（检查当前已跟踪文件，进 `pnpm test`）与 `scripts/scan-history.mjs`（扫描全部历史，报告写到仓库之外）；`scripts/fresh-clone-check.sh`（克隆到临时目录、安装、类型检查、单元测试、fake 模式启动探测）。README 的结构由一个文档测试钉住（必须出现的章节与两张表、相对链接都能解析）。

**技术栈：** 同阶段 1–3。新增依赖：无。

**设计依据（Spec）：**
- 设计文档 §10 阶段 4（"README 增加'只用 skill、不装平台'的用法"；"README（含两张模式对比表、合规提醒）、安装指南、贡献指南、LICENSE"；出口）；§3 开源定位（浏览器模式写作"无需 API token，使用你自己的浏览器登录状态"，不使用"绕过 governance"一类表述；提醒使用者自行判断是否符合公司政策）；§7.1 模式对比表；§9.7 skill 独立使用方式；§13 "README 的措辞和合规提醒"。
- 4a–4d、4f 各自写入 README 的内容（本计划在最后统一重排，不改其含义）；阶段 1–3 出口文档 `docs/spikes/phase{1,2,3}-exit.md`；`docs/spikes/phase3-rulings.md` 中的非安全遗留小项（草稿无 TTL、e2e 选择器 `exact:true`）。
- 现状：仓库没有 `LICENSE`、`CONTRIBUTING.md`；`package.json` 为 `"private": true`；git 提交元数据中有作者的邮箱；当前工作树里的 JIRA 主机名都是占位名（`your-company`、`acme`、`jira`），历史中至少有一处不是。

## 裁决（每条附"错了的代价"）

- **裁决 E-1（发布全部归作者）：** 本计划的任何步骤都不 push、不改变仓库可见性、不打 tag、不建 release、不 `npm publish`、不改写历史。需要这些的地方，计划写出检查清单后**停下**，等作者。代价：作者手工完成最后几步。
- **裁决 E-2（LICENSE）：** 提议 MIT；任务 2 写出对比（MIT / Apache-2.0）后停下。作者批准前不创建 `LICENSE`，`package.json` 不加 `license` 字段，README 的 License 一节写 "License: to be decided by the author"。代价：批准前的公开仓库在法律上不可使用。
- **裁决 E-3（历史：提议无历史的公开初始提交）：** 提案给出两种做法：(A) `git filter-repo` 用仓库外的 mailmap 与 replace-text 文件改写全部历史；(B) 公开仓库从一个无历史的初始提交开始（当前树经公开内容检查后），私有仓库保留完整历史。提议 B：A 可能漏掉二进制或导出的 HTML 中的字符串，且会让已有克隆失效。两者都由作者执行。代价：B 让公开仓库失去开发历史（阶段计划、裁决与 spike 文档仍在树中）。
- **裁决 E-4（扫描报告放在仓库之外）：** 历史扫描会读到它要找的敏感值；报告只写到作者指定的仓库外路径（脚本拒绝仓库内路径），提交进仓库的只有不含任何命中值的提案。作者自己的人名等私有词放在仓库外的文件中，经环境变量 `SLACKOFF_PRIVATE_TERMS` 传入。代价：作者要自己保管该文件。
- **裁决 E-5（不做 npm 发布）：** 阶段 4 的"安装"是 `git clone` + `pnpm install`；`package.json` 保持 `"private": true`。代价：没有 `npx slack-off`；以后要发布需另做打包。
- **裁决 E-6（第三方核对由作者找人）：** 出口条件需要一个真正的第三方。本计划提供全新克隆脚本（自动化的最近似）与第三方检查清单；结果由作者填写。代价：出口取决于作者能找到一位测试者。

## 全局约束

- 阶段 1–3 的全局约束全部继续有效。
- **Node 26**（裁决 N-1）：安装指南写明 Node 26 与 pnpm 版本（`packageManager` 字段的值）。
- **移动优先**：本计划改动的 UI（任务 5 的草稿 TTL）在 390px 宽无横向滚动；README 的手机使用一节保留。
- **公开内容**：仓库中不出现公司主机名、真实人名或邮箱；示例一律 `https://your-company.atlassian.net`、`example-org`、`you@example.com`、`/Users/<you>`。任务 1 的检查把这条规则变成测试。
- **对外写入逐次经开发者确认**：README 必须写明这一点，以及哪些动作是对外写入（push、PR、JIRA 状态、JIRA 评论、OTLP 导出）。本计划自身没有对外写入，且明确不执行任何发布动作（裁决 E-1）。
- **测试与探测不碰宿主状态**：不读写剪贴板、LaunchServices、钥匙串、rc 文件、`~/.gitconfig`、`~/.claude`、`~/.nvm`；全新克隆脚本用临时目录与临时 `SLACKOFF_HOME`，不改用户的 Node / pnpm 安装，不登录任何服务。
- **提交信息**以下面两行结尾：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Q3ZdR36s9c6TU4rsfHiJ3Z
  ```
- **作者停止点**：任务 1 步骤 5、任务 2 步骤 3、任务 6 步骤 4、任务 7 全部——执行者到这里停下，向作者报告，不继续。

## 审阅重点

1. **敏感值从别的通道进入公开内容**：导出的 Stitch HTML、PNG 截图中的文字（无法 grep）、`pnpm-lock.yaml` 中的私有源地址、测试 fixture、spike 文档、提交信息与分支名、`docs/ba/` 的 Excalidraw 文件（JSON 内嵌文本）→ 检查覆盖所有已跟踪的文本文件（含 `.html`、`.json`、`.mmd`、`.excalidraw`、`.yaml`）；二进制文件（PNG）列入"需人工查看"清单；锁文件中的 registry 只允许 `registry.npmjs.org`。（任务 1）
2. **README 照着做却跑不起来**：缺少的前置条件（Chrome 的 Claude 扩展、`gh auth login`、`npx playwright install chromium`、Tailscale 可选）、端口 4317 / 5173 被占用、Node 版本不对、`pnpm` 版本不对（corepack）、第一次启动没有配置时的页面、fake 模式（不需要 JIRA 与 Claude 就能看到界面）→ 安装指南按顺序列出，每步有"如何确认成功"；全新克隆脚本验证其中可自动化的部分。（任务 4、6）
3. **对比表与实际行为不一致**：表中说 API 模式"不消耗订阅额度"、浏览器模式"支持 Data Center"等，必须与 4b 的实现与裁决一致；表格由一个文档测试与 `ModeComparison` 组件共用同一份数据源（`packages/shared/src/mode-comparison.ts`），避免两处漂移。（任务 3）
4. **合规与措辞**：README 不出现"绕过 governance / bypass"一类表述（文档测试断言）；浏览器模式的描述原文对应 spec §3；合规提醒放在 README 前部（安装之前），不只在末尾。（任务 3）
5. **"只用 skill"的用法误导**：单独安装 skill 时，平台的硬性约束（schema 校验、对外操作前确认、验收隔离、沙箱）全都不存在——README 与 `skills/README.md` 必须写明；复制 skill 的命令不能覆盖用户已有的同名 skill（用 `cp -Rn` 并提示冲突，或建议放进项目级 `.claude/skills/`）；文档不得建议修改 `~/.claude` 以外的任何用户配置。（任务 4）

---

## 文件结构

```
scripts/public-content-check.mjs, scripts/scan-history.mjs, scripts/fresh-clone-check.sh (新)
packages/server/test/public-content.test.ts (新：调用检查脚本的纯函数), packages/server/test/docs.test.ts (新：README 结构、链接、措辞)
packages/shared/src/mode-comparison.ts (新：两张对比表的数据)  (4b 的 ModeComparison 改为读取它)
README.md (重写), docs/install.md (新), CONTRIBUTING.md (新), skills/README.md (新)
docs/release/history-rewrite-proposal.md, docs/release/license-decision.md, docs/release/release-checklist.md (新)
docs/spikes/phase4-exit.md (新：阶段 4 总出口，含第三方核对)
packages/web/src/lib/drafts.ts / use-draft.ts (改：TTL), e2e/mobile-phase3.spec.ts (改：exact:true)
LICENSE —— 只在作者批准后创建（任务 2 步骤 4）
```

---

### 任务 1：公开内容检查（当前树）与历史扫描 + 改写提案

**文件：** `scripts/public-content-check.mjs`、`scripts/scan-history.mjs`（新）、`packages/server/test/public-content.test.ts`（新）、`docs/release/history-rewrite-proposal.md`（新）、`package.json`（脚本 `check:public`）

**接口：**
```ts
// scripts/public-content-check.mjs（导出纯函数供测试，直接运行时检查 git ls-files 的全部文件）
ALLOWED_JIRA_HOSTS = ['your-company.atlassian.net', 'your-jira.atlassian.net', 'acme.atlassian.net', 'jira.atlassian.net', 'example.atlassian.net']
ALLOWED_EMAIL = /^git@github\.com$|@([a-z0-9-]+\.)*example\.(com|org|net)$|@anthropic\.com$|\.invalid$/   // noreply@anthropic.com 出现在提交尾注说明中；当前树里已有 git@github.com、*.example.com 与 .invalid 形式的占位
checkText(path: string, text: string, privateTerms: readonly string[]): Finding[]
  // Finding = {path, line, rule: 'jira-host'|'email'|'user-path'|'private-term'|'registry', excerpt /* 命中值替换为 *** */}
  // jira-host：/[a-z0-9-]+\.atlassian\.net/ 不在白名单；email：RFC 宽松匹配且不满足 ALLOWED_EMAIL；user-path：/\/Users\/(?!<you>|(you|me|u|o|runner)\b)[A-Za-z0-9._-]+/（`me`、`u`、`o` 是当前测试中已有的占位）；
  // private-term：SLACKOFF_PRIVATE_TERMS 文件中的每一行（不区分大小写、按词边界）；registry：pnpm-lock.yaml 中非 registry.npmjs.org 的 tarball 主机
checkTree(repoDir: string, privateTerms): { findings: Finding[]; binaries: string[] /* 需要人工查看的二进制文件 */ }
// scripts/scan-history.mjs
//   node scripts/scan-history.mjs --out <仓库外的目录>   （--out 位于仓库内 → exit 2 "the report must be written outside the repository"）
//   扫描：git log --all 的作者 / 提交者名与邮箱、提交信息；git rev-list --all --objects 的每个文本 blob（按 checkText 规则）；分支与 tag 名
//   输出 <out>/history-scan.md：每类命中的数量、命中的提交 sha 与路径、命中值（只在这个仓库外的文件里）；stdout 只打印每类数量
```

- [ ] **步骤 1：写失败测试：** （测试文件自己也会被检查，所以应命中的样本一律在测试中用字符串拼接构造，例如 `'https://big' + 'co.atlassian' + '.net'`；本计划正文同样不写出它们的完整形式）`checkText` 对拼接出的非白名单 JIRA 主机命中且 excerpt 中不含其子域名；对 `your-company.atlassian.net` 不命中；拼接出的 `a@b` + `.io` 命中、`you@example.com` 与 `noreply@anthropic.com` 不命中；`/Users/<you>/x` 不命中、拼接出的 `/Us` + `ers/alice/x` 命中；私有词表 `['Alice Example']` 对 "alice example" 命中；lock 文件中 `https://npm.internal.example/x.tgz` 命中；`scan-history.mjs --out <repo>/tmp` → exit 2；`checkTree` 对当前仓库运行：零命中（若有命中，本任务先修正这些文件——全部是改成占位名——再继续），PNG 列在 `binaries` 中。
- [ ] **步骤 2–4：** 失败 → 实现 → `pnpm test` 通过；`pnpm check:public` 加入 `pnpm test`（server 包测试调用它）。
- [ ] **步骤 5（作者停止点）：** 运行 `SLACKOFF_PRIVATE_TERMS=<作者提供的仓库外文件> node scripts/scan-history.mjs --out <仓库外目录>`——若作者尚未提供私有词文件，不带它运行并在报告中注明。写 `docs/release/history-rewrite-proposal.md`：扫描了什么、每类**数量**（不写值）、做法 A 与 B 的步骤（A 的 `git filter-repo --mailmap <仓库外文件> --replace-text <仓库外文件>` 命令只写占位路径；B 的 `git checkout --orphan public-main && git commit` 流程）、各自对已有克隆与 PR 链接的影响、提议 B（裁决 E-3）、"这些命令不会由 Slack Off 的计划执行"。**停下，把报告路径与提案交给作者；不执行任何改写。**
- [ ] **步骤 6：** 提交（只含脚本、测试、提案；报告不在仓库中）：`chore: public-content check for tracked files; history scan (report outside the repo) and a rewrite proposal`

### 任务 2：LICENSE 提案（作者决定）

**文件：** `docs/release/license-decision.md`（新）；作者批准后：`LICENSE`、`package.json`（`"license"`）、README License 一节

- [ ] **步骤 1：** 写 `license-decision.md`：MIT（提议：最短、最宽松、Claude Code skill 与 Node 生态最常见；只要求保留版权声明）与 Apache-2.0（多一条明确的专利授权与 NOTICE 要求）的对比表；依赖许可证清单（`pnpm licenses list --prod` 的汇总：只列许可证名与数量，确认没有与所选许可证冲突的依赖）；版权行的形式 "Copyright (c) 2026 <author name as the author wants it shown>"——**名字留空，由作者填写**。
- [ ] **步骤 2：** 提交：`docs: license options for the author (MIT proposed)`
- [ ] **步骤 3（作者停止点）：** 把文件交给作者，**停下**。不创建 `LICENSE`。
- [ ] **步骤 4（仅在作者明确批准后）：** 按作者选择创建 `LICENSE`（标准全文，版权行用作者给的名字）、`package.json` 加 `"license"`、README License 一节；提交：`chore: add the <SPDX id> license chosen by the author`。

### 任务 3：README 重写（两张对比表、合规提醒）

**文件：** `README.md`、`packages/shared/src/mode-comparison.ts`（新，4b 的 `ModeComparison` 改为读取它）、`packages/server/test/docs.test.ts`（新）、`docs/superpowers/specs/2026-11-06-slack-off-design.md`（§10 阶段 4 各项标注完成情况，一行一项）

README 结构（英文；"phase N" 字样从标题中去掉，改按功能组织）：
1. 一句话介绍 + 截图一张（`design/screens/01-tickets.png` 或实际运行截图，确认无真实数据）。
2. **Before you start: is this allowed at your company?**（合规提醒，原文对应 spec §3："Whether sending code and ticket content to an AI complies with your company's policy is your own call."；浏览器模式写作 "No API token needed: uses your own browser login."）
3. What it does（流程：发现 → 需求与 AC → 方案 → 设计辩论 → 开发 → 独立验收 → 确认交付；每个拍板点；"Every outward action — push, pull request, JIRA status, JIRA comment, trace export — happens only after you confirm it."）。
4. Quick start（指向 `docs/install.md`；含 "Try it without JIRA or Claude: fake mode"）。
5. **Choosing how Slack Off talks to Claude**（表 1：订阅 vs API key，数据来自 `mode-comparison.ts`，即 spec §7.1 的六行 + 4b 的凭证行）。
6. **Choosing how Slack Off reads JIRA**（表 2：浏览器 vs JIRA API，同一数据源）。
7. Configure（设置项、仓库映射、规则文件 `.slackoff/config.json` 与 `rules.md`，含 `acceptance` 四种 entry 与 `sandbox.localPorts`）。
8. Use it from your phone（Tailscale）。
9. Cost & quota；Run tracing（含导出警告，原样保留 4c 的文字）；Preferences 与 Agent prompts。
10. Security model and residual risks（合并原 "Security notes for development" 与 "Residual risks"，按 4a 后的状态）。
11. **Use the skills without the platform**（见任务 4）。
12. Tests、Contributing、License（任务 2 之前为 "to be decided by the author"）。

- [ ] **步骤 1：写失败测试（`docs.test.ts`）：** README 含上面 12 个二级标题（按文本匹配）；两张表的每一行都与 `mode-comparison.ts` 的数据逐字相同；README 中所有相对链接（`](docs/…)`、`](skills/…)` 等）指向存在的文件；README 不含 `bypass`、`governance`、`circumvent`（不区分大小写）；合规一节出现在 Quick start 之前；`docs/install.md`、`CONTRIBUTING.md`、`skills/README.md` 存在（任务 4 之前为红）。
- [ ] **步骤 2–4：** 失败 → 写 `mode-comparison.ts` 并让 4b 的组件读取它 → 重写 README → 除任务 4 的文件存在性外通过。
- [ ] **步骤 5：** spec §10 阶段 4 每项后注明完成于哪个子计划（例如"（4b）"）。提交：`docs: README rewritten for first-time users — two mode tables, compliance first, security model`

### 任务 4：安装指南、CONTRIBUTING、"只用 skill"

**文件：** `docs/install.md`、`CONTRIBUTING.md`、`skills/README.md`（新）、`README.md`（第 11 节）、`packages/server/test/docs.test.ts`

- `docs/install.md`（macOS；每步给出"Check:"命令与预期输出）：Node 26（任何安装方式；`node --version` 以 `v26.` 开头）→ corepack 启用 pnpm（`packageManager` 的版本）→ `git clone` 与 `pnpm install` → `pnpm -F web build` → 第一次启动 `pnpm start`、打开 `http://127.0.0.1:4317`（端口被占用时怎么办）→ 不连 JIRA 与 Claude 先看一眼：`SLACKOFF_FAKE_EXECUTOR=1`（说明它只用于试看与测试）→ Claude Code 安装与 `claude` 登录（订阅模式）或 API key（API 模式）→ JIRA：Chrome + Claude in Chrome 扩展并登录 JIRA（浏览器模式）或 API token（API 模式）→ `npx playwright install chromium`（验收）→ `gh auth login`（交付）→ 可选 Tailscale → 仓库映射与第一张票 → 非 macOS 的说明（沙箱不可用，见 4a）→ 卸载（删除 `~/.slackoff`、`~/.slackoff-acceptance`；**不**涉及任何其他用户目录）。
- `CONTRIBUTING.md`：开发环境、`pnpm test` / `pnpm typecheck` / `pnpm e2e`（e2e 需要 macOS、已安装的 Google Chrome 与 Playwright Chromium、空闲的 4317 / 5173）、fake 模式的作用、计划与 spike 文档的位置、代码约定（可擦除语法、`@slackoff/shared` 是跨包类型唯一来源、文案在 `i18n/en.ts`、移动优先 390px）、安全规则（不加 `--no-verify` / `bypassPermissions`、任何新的子进程走沙箱、对外写入必须经确认）、**公开内容规则**（只用占位名；`pnpm check:public`）、测试不得触碰用户的剪贴板 / 钥匙串 / rc 文件 / `~/.gitconfig` / `~/.claude`、提交信息格式（约定式前缀；不要求 AI 尾注）。
- `skills/README.md` 与 README 第 11 节：每个 skill 一行用途；安装到项目级 `.claude/skills/`（推荐，`mkdir -p .claude/skills && cp -Rn <clone>/skills/<name> .claude/skills/`）或用户级 `~/.claude/skills/`（同样 `cp -Rn`，不覆盖同名 skill，冲突时提示改名）；示例对话；**平台之外不存在的保护**（schema 校验与重试、对外操作前确认、验收隔离、命令沙箱、审计日志）——写操作 skill（`jira-update`、`jira-comment`）单独使用时会直接改 JIRA，README 建议只在平台中使用它们。

- [ ] **步骤 1：** `docs.test.ts` 加断言：`install.md` 含 "Node 26"、`SLACKOFF_FAKE_EXECUTOR=1`、`npx playwright install chromium`、`gh auth login` 且每个二级标题下有 "Check:"；`skills/README.md` 列出 `skills/` 下每个目录名、含 `cp -Rn`、含 "jira-update" 的警告；`CONTRIBUTING.md` 含 `pnpm check:public`。
- [ ] **步骤 2–4：** 失败 → 写三份文档 → `pnpm test` 通过（任务 3 的存在性断言此时转绿）。
- [ ] **步骤 5：** 提交：`docs: install guide, contributing guide, using the skills without the platform`

### 任务 5：非安全的遗留小项与发布前的整理

**文件：** `packages/web/src/lib/drafts.ts`、`lib/use-draft.ts`（+ 测试）、`e2e/mobile-phase3.spec.ts`、`package.json`（`description`；`repository` / `homepage` 不加，等作者决定公开地址）、`.gitignore`（确认 `test-results/`、`.superpowers/` 中的临时产物不被跟踪）

- 草稿 TTL（Task 18 minor）：页面未挂载时保留的草稿超过 24 小时即丢弃（`drafts.ts` 记录写入时间）。测试：25 小时前的草稿在挂载时不被应用；1 小时前的被应用。
- e2e 选择器（Task 17 minor）：`mobile-phase3.spec.ts` 的 "Confirm" 按钮选择器加 `exact: true`。
- `git ls-files` 中不应出现的产物：`test-results/` 若被跟踪 → 移出并加入 `.gitignore`。

- [ ] **步骤 1：** 草稿 TTL 失败测试。
- [ ] **步骤 2–4：** 实现 → `pnpm test`、`pnpm e2e` 通过。
- [ ] **步骤 5：** 提交：`chore: draft TTL, exact e2e selector, untracked test artifacts, package description`

### 任务 6：全新克隆核对与阶段 4 出口文档

**文件：** `scripts/fresh-clone-check.sh`（新）、`docs/spikes/phase4-exit.md`（新）

`fresh-clone-check.sh`：`set -eu`；`tmp=$(mktemp -d)`、`trap 'rm -rf "$tmp"' EXIT`；`git clone --no-local "$(git rev-parse --show-toplevel)" "$tmp/slack-off"`（克隆**已提交**的内容，不带工作区改动）；`cd` 进去；检查 `node --version` 为 v26；`corepack pnpm install --frozen-lockfile`；`pnpm typecheck`；`pnpm test`；`pnpm -F web build`；`SLACKOFF_HOME="$tmp/home" SLACKOFF_FAKE_EXECUTOR=1 node --disable-sigusr1 packages/server/src/main.ts &`，轮询 `http://127.0.0.1:4317/api/status` 至多 30 秒、断言 JSON 中有 `jira`；杀掉服务进程；打印 "fresh clone check: OK"。不改全局配置、不登录任何服务；4317 被占用时立即失败并说明。

`docs/spikes/phase4-exit.md`（格式同阶段 3 出口文档；只用占位名）：
- 自动化结果表：`pnpm test`、`pnpm typecheck`、`pnpm e2e`（列出 4a–4d、4f 新增的 project）、`pnpm check:public`、`scripts/fresh-clone-check.sh`。
- 各子计划出口文档的链接与"已核对 / 未核对"汇总（`phase4a-exit.md` … `phase4f-exit.md`）。
- **第三方核对（出口条件）**：一位没参与过本项目的人，在其自己的 Mac 上，只看 README 与 `docs/install.md`：0. 记录 macOS 版本、Node 版本、是否已有 Claude Code；1. 跑起 fake 模式并看到票列表；2. 接上自己的 Claude（订阅或 API key 任一）与测试 JIRA（浏览器或 API 任一），对一张测试票走到"选方案"；3. 记录每一处卡住的地方（README 哪一节、卡了多久、怎么解决的）；4. 用手机打开（可选）。结果栏："结果：____ / 日期：____ / 备注：____"。
- 发布前作者确认项：LICENSE 已选定（任务 2）、历史处理已决定（任务 1）、`docs/release/release-checklist.md` 已读（任务 7）。

- [ ] **步骤 1：** 写脚本；在本机运行一次，结果填入出口文档的自动化表（需要网络安装依赖时，若执行环境不允许联网，改用 `--offline` 并在表中注明）。
- [ ] **步骤 2：** 写出口文档。
- [ ] **步骤 3：** 提交：`test: fresh-clone check; docs: phase 4 exit checklist with the third-party run`
- [ ] **步骤 4（作者停止点）：** 第三方核对由作者安排；**停下**等结果。按结果修 README / 安装指南属于后续工作，按同样的提交规则进行。

### 任务 7：发布检查清单（只写，不执行）

**文件：** `docs/release/release-checklist.md`（新）

内容（每项一个复选框，全部由作者执行）：LICENSE 已提交；历史处理已执行（A 或 B）并在新的克隆上重跑 `pnpm check:public` 与 `scan-history.mjs`（零命中）；`package.json` 的 `repository` / `homepage` 按公开地址填写；GitHub 仓库设置（默认分支、分支保护、Issues、Security policy、关闭 Actions 中会用到私有密钥的工作流）；README 中的截图再看一遍无真实数据；阶段 4 出口（第三方核对）已通过；推送到公开远端；把仓库设为公开；（可选）打 tag 与 release。末尾一行："Slack Off's plans never perform these steps; the author does."

- [ ] **步骤 1：** 写清单。
- [ ] **步骤 2：** 提交：`docs: release checklist for the author (nothing here is executed by the plan)`
- [ ] **步骤 3（作者停止点）：** 向作者报告阶段 4 完成情况与清单位置，**停下**。不 push、不改变可见性、不发布。

---

## 自审

**1. Spec 覆盖：** §10 阶段 4 "README 增加'只用 skill、不装平台'的用法"（任务 4）；"README（含两张模式对比表、合规提醒）"（任务 3）；"安装指南、贡献指南"（任务 4）；"LICENSE"（任务 2，作者决定）；出口"第三方按 README 能在自己机器上跑起来"（任务 6，作者安排第三方）；§3 开源定位措辞（任务 3 测试）；§9.7 独立使用方式（任务 4）；"公开内容不含公司主机名、人名、邮箱"（任务 1）；历史扫描与改写提案（任务 1）；发布由作者执行（任务 7）。

**2. 步骤扫描：** 每个作者停止点都明确写了"停下"与交付物；脚本给出行为与边界（拒绝仓库内报告路径、只克隆已提交内容）。

**3. 类型一致性：** `checkText` / `checkTree` / `Finding`（任务 1 内）；`mode-comparison.ts` 的数据（任务 3 → 4b 的 `ModeComparison` 与 `docs.test.ts`）。

**4. 审阅重点：** 敏感值通道（任务 1 覆盖的文件类型与二进制清单）；照着做跑不起来（任务 4 的 Check: 与任务 6 的脚本）；对比表漂移（任务 3 单一数据源）；措辞（任务 3 测试）；只用 skill 的误导（任务 4 的警告与 `cp -Rn`）。

**5. 比例：** 文档任务给出章节与必须出现的内容，正文由执行者写。
