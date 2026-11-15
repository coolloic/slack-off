# UI 设计（Google Stitch 产出）

| 路径 | 内容 |
|---|---|
| `prompts/` | 交给 Stitch 的英文提示词：`00-global.md` 是每次都附带的全局设计要求，其余按页面编号；`*-fix.md` 是修改指令 |
| `DESIGN.md` | Stitch 生成的设计系统（配色 token、字体、组件规范） |
| `screens/<NN-page>.png` | 各页面设计稿（1280×1024 视口，1.25 倍） |
| `code/<NN-page>.html` | Stitch 导出的页面代码（Tailwind，仅作实现参考） |

依据：`docs/ba/functional-spec.md`。Stitch 项目：Slack Off Developer Tool（经典模式）。

## 导出方式
Stitch 的 `.zip` 导出只有第一次能落盘，之后 Chrome 会静默拦截后续下载。所以改为：
1. Stitch → Export → **Code to Clipboard** → `pbpaste > design/code/<page>.html`
2. 用无界面 Chrome 渲染截图（独立临时 profile，不碰个人配置）：
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --user-data-dir=<临时目录> --window-size=1280,1024 --force-device-scale-factor=1.25 --virtual-time-budget=8000 --screenshot=<输出.png> file://<html 绝对路径>`

## 本地修改记录
Stitch 有时在编辑后导出的代码仍是旧版本（画布已更新、代码未更新），这时直接修改导出的 HTML，并记录在此：
- `05-solutions`：Executor 改为 Claude Code (subscription)；AC coverage 页签改为 ✓ acknowledged；确认按钮改为橙色；方案卡片头部允许换行，避免 Select 被截断。Stitch 画布上的版本与此不完全一致。
- `06-design-debate`："Escalated to tech lead" 改为 "Escalated to you"；"Tech Lead Arbitration" 改为 "Developer ruling (you)"（裁决人是开发者本人）。
- `07-development`：Model "Claude 3.7 Sonnet" 改为 "set by your Claude Code"（模型由用户的 Claude Code 决定）。
- `09-audit-log`：Merkle/RFC-8785 措辞改为哈希链 + 排序键 canonical JSON；agent 行的 prompt_updated 改为 debate_round_recorded（只有开发者能改提示词）；architect ruling 改为 developer ruling。

## 移动端（390×844，`code/mobile/`、`screens/mobile/`）
截图用 CDP 移动端仿真（390 宽、DPR 2）；`*-viewport.png` 是首屏（固定顶栏/底栏位置正确），无后缀的是整页长图（长图中 fixed 元素会出现在页面中部，属截图方式所致）。
- `m01-tickets`：执行器显示改为 "Claude Code · ready"（完整的 "(subscription)" 放在 title 提示和设置页，避免小屏换行溢出顶栏背景）；状态行单行 + truncate，JIRA 项不收缩；Blocked 卡片说明改为 "retry the failed step (log in to JIRA in Chrome first) — or abandon the ticket"；底部导航只保留 Tickets / Settings；顶栏和底栏改为不透明（半透明时卡片文字透出）；"Deselect all" 在深色底上改为浅色下划线，提高对比度。
- `m02-ac-coverage`：删除 Stitch 多生成的第二个底栏（"Reject / Approve Diff"，与规格不符且盖住正确底栏）；顶栏票号 DEV-4092 改为 PROJ-142、徽章改为橙色 "Awaiting drift ack"（与 m01 一致）；顶栏和底栏改为不透明。
- `m03-requirements`：同 m02 删除多余底栏（Reject / Approve / ⌘⏎）；DEV-4092 改为 PROJ-128，徽章改为 "Reviewing AC"；顶栏/底栏不透明；"Confirm requirements" 改为与 m02 一致的橙色主按钮。
- `m04-solutions`：删除多余底栏（Request Diff / Approve Solution）；Stitch 把 "Choose Option B" 放在页面末尾而非吸底，改为固定吸底栏（次按钮在左、橙色主按钮在右，说明文字在下），body 加底部留白；选中的 "Solutions" 标签字号与其他标签统一。
- 以上通用修补（删多余底栏、改票号、去半透明）已整理成 `design/fix-mobile-export.py`：`python3 design/fix-mobile-export.py <html> <票号>`。
- `m05-snapshot`：底部导航去掉 Usage / Audit；"You (@dev-alex)" 改为 "You"（不出现个人账号）；附件区 "Offline cached" 改为 "Not downloaded in phase 1"（第一期附件只存元数据）；版本下拉文字缩短为 "v2 · 2h ago"，避免小屏截断。
- `m06-settings`：补上 JetBrains Mono 字体链接（Stitch 漏了，等宽文字退化成衬线体）；删除虚构的 "Context cache: 82%"；"Telemetry" 改为 "Status"；"Read through Chrome" 说明改为只读、使用已有 JIRA 登录（不读 cookie）；JIRA 地址改为占位符。截图两张：`m06-settings.png`（抽屉关闭）和 `m06-settings-drawer.png`（抽屉打开）。
- `06-design-debate`（桌面）：底部 JIRA 说明改为 "JIRA is not changed. If JIRA status sync is on, you will be asked separately before Slack Off sets the ticket to In Progress."；"Automated sequence upon finalization" 改为实际流程（记录裁决 → 定稿 → 只读重读 JIRA → 按仓库 worktree 开发）。
- `07-development`（桌面）：分支 / worktree 区改为按仓库分组（api、web），路径改为 `~/.slackoff/worktrees/PROJ-128/<repo>`。
- `m07-design-debate`：删除 Stitch 多加的一行页签（Execution Diff / Live Terminal / LLM Telemetry / Agent Tool）和重复的页内顶栏；ENG-4091 改为 PROJ-128；顶栏徽章改为橙色 "Awaiting ruling"；左侧按钮文案改为 "Choose a different solution"。
- `m08-development`：同 m07 删除多余页签行；徽章改为蓝色 "Developing"；worktree 路径改为 `~/.slackoff/worktrees/PROJ-128/web`；删除虚构的 "initial worktree scaffold" 提交（平台不做脚手架提交），作者统一为 "dev agent"；主按钮文案 "Hand off to acceptance"，说明 "Available in phase 3"；"Send to JIRA" 改为橙色主按钮。`awaiting_snapshot_ack` 变体未单独出图，实现按任务 10/16 的文案。
- `08-acceptance` (desktop): the decision card button "Confirm & open PR" is now "Confirm & deliver". The description now reads "This will: show the exact list of actions (push, pull requests, and — if status sync is on — the JIRA status and comment) for you to confirm". The screenshot was retaken.
- `m09-acceptance` / `m10-delivery` (phase 3): only screenshots of the Stitch canvas are kept (`*-stitch.png`). There is no HTML export, because the code export goes only through the clipboard or a `.zip` download, and the controller is not allowed to use the clipboard or download files on the author's machine. To get the code, do Export → Code to Clipboard on the author's side. **The implementation follows `prompts/mobile/m09-acceptance.md` and `m10-delivery.md` plus the functional spec §10, not the Stitch output.** Where m09 differs from the spec, the implementation ignores the Stitch version:
  - the top bar shows a "Running" badge, which should be the orange "Awaiting confirmation";
  - the isolation note reads "Zero-Bleed Sandbox Enforced …", which should be the wording from the prompt;
  - the run history diagnostics invent a "Config Note";
  - the screenshot thumbnails use stock photos, and the lightbox adds "Copy Hash", "Download Artifact" and a fabricated URL and transaction id;
  - the sticky bar at the bottom is missing from the first screen of the long screenshot.
  m10 deviations the implementation ignores:
  - top bar: "Ticket Inspector" / "RUNNING", which should be the ticket's real state;
  - the invented subtitle "Automated release dispatch & issue tracker handoff";
  - the step-status words ("Verified / Pushed / PR Created / Cross-linked"), which should show the step state and nothing more;
  - "Autonomous Agent v2.4" (no model or version names);
  - "HTTP 401: Unauthorized";
  - "Retry Push", which should be just "Retry", since Retry continues from the first step that is not done;
  - "3 commits" / "ready for testing".
  The "JIRA is not changed" and blocker variants were not drawn separately; implement them from the prompt.
