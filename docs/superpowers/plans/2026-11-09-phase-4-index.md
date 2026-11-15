# 阶段 4 · 可选模式 + 开源发布 — 计划索引

**设计依据（Spec）：** `docs/superpowers/specs/2026-11-06-slack-off-design.md` §10 阶段 4；§9.1、§9.4、§9.6、§9.8；§5.3 第 6 步（命令行工具与库的验收入口"放到第 4 期"）；§2 目标 8、9；§3 合规与开源定位；§7.1 / §7.2。
**输入：** `docs/spikes/phase3-rulings.md`（F-2 git hooks、T5-6 网络隔离、R-LOCAL 非 macOS、Deferred minors）、`docs/spikes/phase3-exit.md`（尚未用真实 `claude` / `gh` / JIRA 核对的项）、README 中的 "phase 4" 提及、阶段 3 计划 `2026-11-08-phase-3-acceptance-delivery.md`（风格与全局约束）。

## 为什么拆成六份

阶段 4 是几块互不依赖的子系统。按 writing-plans 的 Scope Check，每块一份计划，各自产出能独立测试、能独立演示的软件。spec §10 只列了五组；第六份 4f 来自 §5.3 第 6 步（"命令行工具和库放到第 4 期"），§10 漏列了它（裁决 X-6）。

| 计划 | 文件 | 任务数 | 产出 | 主要风险 |
|---|---|---|---|---|
| 4a 沙箱收尾 | `2026-11-09-phase-4a-sandbox.md` | 8 | git hooks 在 `dev-hook` 沙箱里运行；可选的本机端口白名单；非 macOS 的明确行为与状态页；开发 agent Bash 包装的守卫；安全相关的遗留小项 | hook 配置把作者真实使用的 husky / lint-staged / commitlint 弄坏（失败可见，有仅限本机的开关） |
| 4b API 模式 | `2026-11-09-phase-4b-api-modes.md` | 8 | `ApiJiraSource`（JIRA API token）、`ClaudeApiExecutor`（Anthropic API key）、本机 0600 凭证文件、设置页模式切换与对比表 | API key 泄露给 agent 运行的命令、日志或手机 |
| 4c 成本与追踪 | `2026-11-09-phase-4c-cost-telemetry.md` | 6 | §9.1 成本与额度页、阈值暂停；§9.8 OTLP 导出（默认关，每次导出都经确认） | 阈值暂停让票停在 `blocked`，开发者不知道为什么 |
| 4d 偏好与提示词 | `2026-11-09-phase-4d-preferences-prompts.md` | 6 | §9.4 选择偏好（记录、摘要、编辑、清空、注入方案 agent）；§9.6 恢复默认的确认与审计、样例票试运行 | 偏好摘要把仓库或票里的文本带进方案 agent 的提示词 |
| 4f 验收入口：CLI 与库 | `2026-11-09-phase-4f-acceptance-cli-library.md` | 6 | 规则文件 `acceptance.entry: 'cli' \| 'library'`；平台在验收沙箱中运行 agent 写的命令用例 / 调用示例，证据为命令与输出 | 新的运行入口绕过验收隔离 |
| 4e 开源准备 | `2026-11-09-phase-4e-open-source.md` | 7 | README 重写（两张模式对比表、合规提醒）、安装指南、CONTRIBUTING、"只用 skill"、LICENSE（作者决定）、公开内容检查、历史扫描与改写**提案**、全新克隆核对、第三方按 README 跑起来 | 历史中的个人信息随仓库公开（只出提案、不改写、不发布） |

## 推荐顺序与依赖

```
4e 任务 1–2（扫描 + LICENSE 提案，尽早交给作者）
4a ─┐
    ├─ 4b ─ 4c ─ 4d ─ 4f ─ 4e 任务 3–7
    │   （4c 的 OTLP 请求头存在 4b 的凭证文件里；4d 的试运行经过 4c 的额度闸门）
```

- **4a 先做**：4b 的 API key 必须从 4a 之后的 shell 包装里剥掉（4b 任务 6 修改 `writeShellPrefix`；4a 任务 6 先给这个包装加守卫）。两者都改 `sandbox/local-sandbox.ts`，串行做避免冲突。
- **4b 在 4c 之前**：4c 任务 5 的 OTLP 鉴权头存放在 4b 任务 2 的 `credentials.json`。如果 4c 先做，任务 5 要先完成 4b 任务 2（凭证文件本身不依赖 4b 其余任务）。
- **4c 在 4d 之前**：4d 任务 5 的试运行要消耗额度，应经过 4c 任务 2 的 `budgetGate`；4c 未做时试运行照常运行，少了闸门。
- **4f 独立**：只依赖阶段 3 的验收模块；放在 4e 之前，好让 README 写进它的规则字段。
- **4e 最后**（任务 1–2 除外）：README 要描述 4a–4f 的最终行为；任务 1–2 需要作者回答，提前交给作者。
- **迁移编号**：按推荐顺序，4c 用 m13、m14，4d 用 m15。不按这个顺序执行时，每份计划取当时下一个空闲编号；测试断言 `migrations.length >= N`，不写死总数（同阶段 3 裁决 R2）。
- 每份计划完成后 `pnpm test`、`pnpm typecheck`、`pnpm e2e` 全绿（裁决 B-1 继续有效）。

## 需要作者参与的步骤（执行者在这些步骤停下等作者，不代为决定）

| 计划 · 任务 | 作者要做的 |
|---|---|
| 4a 任务 1 | 在自己的一个用 husky + lint-staged + commitlint 的测试仓库上，跑一次带 `dev-hook` 沙箱的提交（spike 的真实核对项） |
| 4a 任务 8 | 出口核对：真实 `claude` 在新包装下的 Bash、钥匙串探测（阶段 3 出口第 9 项的遗留）、真实 hooks |
| 4b 任务 1 | 提供一个**测试用的** Anthropic API key 和测试 JIRA 的 API token，运行 spike 的手工项；决定 `--chrome` 在 API key 下不可用时怎么办 |
| 4b 任务 8 | 出口核对：真实 JIRA REST 读写（只用测试票）、真实 API 模式跑一张票 |
| 4c 任务 6 | 出口核对：向自己的 Langfuse / LangSmith 测试项目导出一次 |
| 4e 任务 1 | 阅读历史扫描报告（存放在仓库之外），决定是否改写历史；改写由作者亲自执行 |
| 4e 任务 2 | 选择 LICENSE（提议 MIT，未经批准不写入） |
| 4e 任务 6 | 找一位第三方按 README 在其机器上跑起来（阶段 4 出口条件） |
| 4e 任务 7 | 一切发布动作：push、把仓库设为公开、打 tag、发 release。**计划中没有任何步骤会执行它们**；npm publish 不在阶段 4 范围内 |

## 跨计划裁决（每条附"错了的代价"）

- **裁决 X-1（拆分）：** 阶段 4 拆成 4a–4f 六份计划，每份可单独执行、单独验收。代价：跨计划的接口（凭证文件、额度闸门、shell 包装）要在各自的"接口"块中对齐；本索引列出依赖。
- **裁决 X-2（发布全部归作者）：** 没有任何计划步骤会 push、把仓库设为公开、发布 npm 包或改写 git 历史。4e 只产出提案与检查清单，然后停下。代价：作者要手工做最后几步。
- **裁决 X-3（LICENSE 归作者）：** 4e 提议 MIT（最短、最常见，与 Claude Code skill 生态一致）；Apache-2.0 是备选（带专利授权）。作者批准前不创建 `LICENSE`，`package.json` 不写 `license` 字段。代价：批准前仓库没有许可证，别人在法律上不能使用它。
- **裁决 X-4（凭证位置）：** JIRA token、Anthropic API key、OTLP 鉴权头只存在 `${SLACKOFF_HOME}/credentials.json`（文件 0600、目录 0700），绝不进 `config.json`，绝不出现在任何 HTTP 响应里（只返回"已设置 / 未设置"与时间）。`SLACKOFF_HOME` 已在所有沙箱配置中被拒绝读取，凭证文件另外作为字面路径拒绝。代价：用户换数据目录要重新输入凭证。
- **裁决 X-5（迁移编号）：** 见上文"迁移编号"。代价：无。
- **裁决 X-6（新增 4f）：** spec §5.3 第 6 步把命令行工具和库的验收入口推到第 4 期，§10 漏列；单列为 4f。代价：如果作者认为它不属于阶段 4，删掉 4f 即可，其他计划不依赖它。
- **裁决 X-7（对外写入的确认）：** "对外写入逐次经开发者确认"在阶段 4 新增两种对外写入：JIRA REST 写（沿用阶段 2、3 的确认流程，换一个执行方式）和 OTLP 导出（4c：每次导出是一次确认，显示目标地址、条数和包含哪些字段；不做后台自动导出）。代价：想要持续自动导出的用户要反复点；如果作者接受"一次开启即授权"，4c 任务 4 改为后台定时导出（见作者问题 5）。

## 只有作者能回答的问题

1. **LICENSE**：MIT（提议）、Apache-2.0，还是别的？
2. **历史改写**：4e 任务 1 的扫描会列出提交元数据中的作者邮箱，以及历史中出现过的非占位 JIRA 主机名（当前工作树里只有占位名，历史中至少有一处不是）。是否改写历史（`git filter-repo`，所有已有克隆都会失效），还是以一个新的、无历史的初始提交公开？
3. **ClaudeApiExecutor 的实现方式**：spec §7.1 写的是"Claude Agent SDK + API key"。Agent SDK 就是打包成库的 Claude Code 引擎，所以 4b 裁决 B-1 改为用同一个 `claude` CLI、以 API key 认证运行，复用阶段 3 全部沙箱参数，不新增依赖。是否接受，还是必须用 `@anthropic-ai/claude-agent-sdk`？
4. **API 模式下的浏览器能力**：如果 4b 任务 1 证实 claude-in-chrome 在 API key 认证下不可用，接受"API 执行器必须搭配 JIRA API 模式"（裁决 B-4），还是希望 JIRA 浏览器角色在 API 模式下仍走订阅登录（混合模式）？
5. **OTLP 导出**：每次导出逐次确认（裁决 X-7 的默认），还是一次开启后自动定时导出？
6. **非 macOS**：阶段 4 对 Linux 只做"明确拒绝 + 状态页 + 文档"（裁决 A-5），不实现 bubblewrap / landlock 后端。是否接受？要实现的话，需要一台 Linux 机器做核对。
7. **JIRA Data Center / Server**：4b 只支持 Jira Cloud（REST v3 + 邮箱 + API token，裁决 B-6）。是否需要 Data Center（REST v2 + 个人访问令牌）？
8. **4f 是否属于阶段 4**（裁决 X-6）。

## 作者答复与执行者裁决（2026-11-07）

- **问题 1 · LICENSE**：作者选 **MIT**。4e 任务 2 直接创建 `LICENSE`（MIT，版权人写 "Slack Off contributors"，不写个人姓名），`package.json` 写 `"license": "MIT"`。
- **问题 2 · 历史**：作者选**以全新的、无历史的初始提交公开**，不改写本地历史。4e 任务 1 仍做扫描（报告在仓库外），用于确认公开的那一个提交的树里没有个人信息；任务 7 产出"从当前树生成单一初始提交"的步骤说明，执行与 push 仍归作者（裁决 X-2 不变）。
- 作者对问题 3–8 的答复是"carry on with phase 4"，未逐条回答；执行者按各计划的默认推荐裁决，作者可随时推翻：
  - **裁决 Q-3**：采用 B-1（同一个 `claude` CLI + API key，不引入 Agent SDK）。代价：若作者坚持用 SDK，4b 的执行器要换实现，沙箱参数要重新对齐。
  - **裁决 Q-4**：采用 B-4（chrome 在 API key 下不可用时，API 执行器要求 JIRA API 模式）。代价：想混用的用户需要等后续版本。
  - **裁决 Q-5**：采用 X-7（每次 OTLP 导出逐次确认）。代价：持续导出要反复确认。
  - **裁决 Q-6**：采用 A-5（Linux 只做明确拒绝 + 状态页 + 文档）。代价：Linux 用户只能在关闭沙箱后使用开发命令，或不用开发步骤。
  - **裁决 Q-7**：只支持 Jira Cloud（B-6）。代价：Data Center 用户只能用浏览器模式。
  - **裁决 Q-8**：4f 保留在阶段 4。代价：多 6 个任务。
- 作者需要提供的测试材料（测试 API key、JIRA token、husky 测试仓库、私有名单文件、第三方测试者）尚未提供：依赖它们的步骤用假实现完成并写进出口核对清单，执行时不停下等待；真实核对留给作者。
