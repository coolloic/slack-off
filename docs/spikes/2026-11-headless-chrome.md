# Spike: headless `claude -p` + claude-in-chrome (Task 1)

Date: 2026-11-06. Claude Code CLI 2.1.318, macOS, Claude in Chrome extension connected. Throwaway experiments; raw logs are not committed.
Privacy: this document records mechanics only (no ticket keys, titles, comments, names, hostnames). `<jira>` = the author's JIRA Cloud site.

## 0. Environment caveat (read first)

- The Chrome profile that the extension drives was **not logged in to `<jira>`** during the spike (JIRA showed the anonymous "Log in" state; the headless run was redirected to the identity provider sign-in / email-verification page). No credentials were entered.
- Consequently, **authenticated** JQL result lists, ticket detail pages and attachments on `<jira>` were NOT exercised. Substitute: a public Jira Data Center instance (read-only, anonymous) was used to prove the mechanics of in-page `fetch` and DOM/REST reads. Cloud-specific DOM and REST shapes still need a smoke test once the session is logged in (see Open items).
- Side effect of probing: one pre-existing Chrome tab was navigated by the interactive session and then navigated back to its original site; no state was changed.

## 1. Can headless `claude -p` operate the browser?

Command:
`claude -p '<prompt>' --chrome --allowedTools <tools> --output-format stream-json --verbose < /dev/null`

Result: **Yes.** Exit 0. The agent created its own tab group/tab, navigated, executed page JavaScript, read results and closed its tab, all in `-p` mode. Typical wall time 20-40 s per run (about 7-10 turns), cost about 0.2-0.45 USD of subscription usage per run (mostly prompt cache creation).

Run with no `--allowedTools` and default permission mode: the first browser call (`tabs_context_mcp`) was **denied** (`system` event `subtype:"permission_denied"`, tool result text "Claude in Chrome requires permission."), the agent then reported it could not proceed. So `-p` does not prompt; it silently denies and records `permission_denials` in the `result` event.

Conclusion: the architecture works. Stop rule not triggered.

## 2. Recorded items

### 2.1 Exact browser tool names

All are MCP tools of server `claude-in-chrome`, prefix `mcp__claude-in-chrome__`. They appear in the `system`/`init` event `tools` array only when `--chrome` is passed. They are **deferred tools**: the agent must call `ToolSearch` (`select:<names>`) first, so **`ToolSearch` must also be in `--allowedTools`** (or the tool schemas never load).

Tools (from init): `browser_batch`, `computer`, `file_upload`, `find`, `form_input`, `get_page_text`, `gif_creator`, `javascript_tool`, `list_connected_browsers`, `navigate`, `read_console_messages`, `read_network_requests`, `read_page`, `resize_window`, `select_browser`, `shortcuts_execute`, `shortcuts_list`, `switch_browser`, `tabs_close_mcp`, `tabs_context_mcp`, `tabs_create_mcp`, `upload_image`.

Observed `tool_use` inputs: `tabs_context_mcp {createIfEmpty:true}`, `tabs_create_mcp {}`, `navigate {tabId,url}`, `javascript_tool {action:"javascript_exec",tabId,text}`, `computer {action:"screenshot",tabId,scale}`, `tabs_close_mcp {tabId}`.

Classification for Task 9/10:

| Class | Tools |
|---|---|
| Read-only (allow) | `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `get_page_text`, `read_page`, `find`, `read_console_messages`, `read_network_requests` |
| Write-capable (exclude) | `computer` (click/type/key/drag), `form_input`, `file_upload`, `upload_image`, `browser_batch` (wraps arbitrary actions), `shortcuts_execute`, `javascript_tool` (arbitrary JS incl. POST/PUT), `gif_creator`, `switch_browser`, `select_browser`, `resize_window`, `shortcuts_list`, `list_connected_browsers` (last three harmless but unneeded; keep excluded for a minimal list) |

Note: `navigate` is a GET navigation; it is treated as read-only (JIRA URLs used are `/issues/?jql=` and `/browse/KEY`). `javascript_tool` is the only way to fetch attachment bytes, and it can perform writes, so it is excluded by default (see 2.7). Allowlist is a permission convenience, not a sandbox: `--allowedTools` does not stop other tools unless the mode denies them (see 2.3).

### 2.2 `--chrome` required?

Command: same prompt without `--chrome`, `--allowedTools mcp__claude-in-chrome__tabs_context_mcp ToolSearch`.
Result: init `tools` has no chrome tools, `mcp_servers` lacks `claude-in-chrome`, `ToolSearch` finds nothing; agent answered UNAVAILABLE. Exit 0.
Conclusion: **`--chrome` is required** in `-p` mode.

### 2.3 Permissions in `-p`

- default mode, no allow: browser tools denied silently (see section 1).
- default mode + `--allowedTools <explicit list>`: works, `permission_denials: []`. A tool not in the list (e.g. `javascript_tool`, `computer`) was denied with `permission_denied` events, which confirms the allowlist gates tools.
- `--permission-mode acceptEdits` and `dontAsk` with only `ToolSearch` allowed: `tabs_context_mcp` was allowed in these runs (observed once each; behaviour differs from default mode, so do not rely on it).
- `bypassPermissions` was deliberately NOT tested (would disable the read-only guarantee).
Conclusion: use default mode + explicit `--allowedTools` (space-separated list after the flag, then end the list with another flag). Always add `< /dev/null` / stdio `ignore` for stdin, otherwise the CLI waits 3 s ("no stdin data received") .

### 2.4 `type:"result"` event fields

Keys: `type, subtype ("success"), is_error, result (final text), terminal_reason ("completed"|"api_error"), stop_reason, api_error_status, num_turns, duration_ms, duration_api_ms, total_cost_usd, session_id, uuid, permission_denials[{tool_name,tool_use_id,tool_input}], usage{...}, modelUsage{...}, ...`.
Parse: `result` (string; the JSON block lives in it), `is_error`, `subtype`, `permission_denials`, `total_cost_usd`/`usage` as `ExecResult.usage`. Other event types seen: `system` (`init`, `hook_started`, `hook_response`, `permission_denied`, `commands_changed`, `thinking_tokens`), `assistant` (content blocks `text` / `tool_use`), `user` (`tool_result`). Do not surface `modelUsage` model names in the UI.

### 2.5 Not logged in to Claude

Command: `CLAUDE_CONFIG_DIR=$(mktemp -d) claude -p "hi" --output-format stream-json --verbose < /dev/null`
Result: **exit code 1**, stderr empty. stdout still carries stream-json: `init` (no mcp servers), an `assistant` event with `error:"authentication_failed"` and text `Not logged in · Please run /login`, then `result` with `is_error:true`, `terminal_reason:"api_error"`, `result:"Not logged in · Please run /login"`, `total_cost_usd:0`. Plain text mode: stdout `Not logged in · Please run /login`, exit 1.
Detection rule: exit code 1 AND (`assistant.error === "authentication_failed"` OR `result.result` contains `Not logged in`).

### 2.6 `--append-system-prompt` >= 8 KB

Command: `--append-system-prompt "$(cat 9301-byte file)"` containing an instruction (answer with a codeword) plus filler.
Result: exit 0, answer followed the instruction. Conclusion: works at 9.3 KB passed as argv (macOS ARG_MAX is far larger). Not tested above ~10 KB; larger sizes are unverified.

### 2.7 JQL list, ticket detail, comments, attachments

Against `<jira>`: not exercised (not logged in). Observed login behaviour: navigating to a JIRA page redirected to the identity-provider sign-in page; the agent, told to return `{"loginRequired": true}` on login pages, did so correctly (final `result` = that JSON). That is the basis for the `loginRequired` flag.

Against a public Jira DC instance (mechanics only):
- The rendered issue navigator list loads asynchronously; `get_page_text` right after navigation returned only chrome, not rows. The reliable route was in-page `fetch('/rest/api/2/search?jql=...&fields=key,attachment,comment')` via `javascript_tool` (200, keys + counts). On Cloud the equivalent is `/rest/api/3/search/jql`; the page route needs a wait/retry.
- Comment IDs: DOM elements `id="comment-<numeric>"` on DC; REST `fields.comment.comments[].id` on both. Prefer REST for IDs and ADF/rendered bodies.
- Attachment bytes: in `-p` mode with `javascript_tool` allowed, the agent ran same-origin `fetch(attachmentHref, {credentials:'include'})`, got 200 `image/png`, 26 395 bytes, base64 prefix `iVBORw0KGgo` (PNG magic) — **feasible**. Gotchas: the tool needs `await` at top level (a bare async IIFE returns `{}`); tool output blocks strings that look like URLs/query strings or cookies (`[BLOCKED: Cookie/query string data]`), so return only ids, sizes and base64; check `size` from metadata first and skip > 2 MB (the 12 MB / 39 MB attachments seen are not returnable through a tool result); on Cloud, attachment URLs redirect to a media host, so `fetch` may be cross-origin and fail CORS — **untested**.

Conclusion: feasible on DC; Cloud untested. Because the only byte-fetching tool (`javascript_tool`) is write-capable, phase 1 recommendation is metadata-only (see section 3).

### 2.8 Reading with ONLY the Task 10 read-only tools (follow-up)

Tool set (exact): `ToolSearch` + `mcp__claude-in-chrome__{tabs_context_mcp,tabs_create_mcp,tabs_close_mcp,navigate,get_page_text,read_page,find}`. No `javascript_tool`, no `computer`. Target: a public Jira Data Center instance, anonymous (not the author's Cloud).
Command: `claude -p '<prompt>' --chrome --allowedTools <set above> --output-format stream-json --verbose < /dev/null`. Both runs: exit 0, `permission_denials: []`, 12-16 turns, 32-42 s, about 0.46-0.52 USD.

(a) JQL result list: `tabs_create_mcp` -> `navigate` -> ONE `get_page_text` returned the fully rendered list (no wait/retry needed this time; the earlier empty result was from a page read before the async render finished, so keep a retry). Rows with key, title and URL (`<base>/browse/KEY`) were read. LIMITATION: on this DC list view the status is shown only for the selected issue; the agent read each other row's status by navigating to its ticket and using `find` ("main issue status lozenge"). Cost: 1 extra navigation per row. On Cloud the list layout differs (columns can include Status); verify. Recommended: put Status in the JQL `ORDER BY`/filter side (query already filters by status) and treat status as known from the query; otherwise read it from the ticket page.
(b) Ticket detail: `get_page_text` returned the description, comment author names and timestamps (as displayed, e.g. `DD/Mon/YYYY HH:MM AM`). Comment IDs were NOT in the text: `find` ("comment permalink links or comment containers") returned element refs, then `read_page {ref_id}` on the permalink returned the href containing `focusedId=<numeric id>` (DC). Only one comment existed on the sampled ticket, so multi-comment extraction is unverified; long comment threads may be collapsed ("N older comments") and need expanding, which requires a click (not allowed) or navigating to a URL variant (untested).
(c) Attachments: `get_page_text` gave filenames; `find` ("attachment file links") + `read_page {ref_id}` returned the exact hrefs (`/secure/attachment/<id>/<name>` on DC). Filenames and URLs: feasible. Bytes: still require `javascript_tool` (section 2.7).

Working technique: `get_page_text` for text/metadata; `find` with a natural-language query to get element refs; `read_page {ref_id}` to read hrefs/ids of those refs. Conclusion: the read-only set is sufficient for list rows (key/title/url), description, comment author/timestamp/ID, and attachment filename/URL on DC. Not shown: collapsed-comment expansion, per-row status in list view, and anything on Cloud. If expansion of collapsed comments is needed, the minimal safe addition would be a URL-only variant (e.g. a `?focusedId=` or full-activity query) via `navigate`, not `computer`.

## 3. Decisions for Task 9 / Task 10

**argv template** (spawn with `stdio: ['ignore','pipe','pipe']`, no shell):
```
<claudeBin> -p <prompt> --output-format stream-json --verbose --chrome
  --append-system-prompt <systemPrompt>
  --allowedTools ToolSearch mcp__claude-in-chrome__tabs_context_mcp mcp__claude-in-chrome__tabs_create_mcp mcp__claude-in-chrome__tabs_close_mcp mcp__claude-in-chrome__navigate mcp__claude-in-chrome__get_page_text mcp__claude-in-chrome__read_page mcp__claude-in-chrome__find
```
Omit `--chrome` and the `mcp__claude-in-chrome__*` entries for non-browser roles (use e.g. `Read Grep Glob` for repo roles). No `--permission-mode` (default; unlisted tools are denied in `-p`). Never `bypassPermissions`. Set `cwd` per request. Prompt for `jira-browser` must say: open a NEW tab via `tabs_create_mcp`, never click or type, close the tab, and on any sign-in page output `{"loginRequired": true}`.

**allowedTools (browser, read-only):** `ToolSearch`, `mcp__claude-in-chrome__{tabs_context_mcp,tabs_create_mcp,tabs_close_mcp,navigate,get_page_text,read_page,find}`. Optionally add `read_console_messages` / `read_network_requests` (read-only) if needed.

**Exclude, assert in tests:** the rule is "anything not in the allowlist". Full known set of excluded `mcp__claude-in-chrome__*` tools: `computer, form_input, file_upload, upload_image, browser_batch, shortcuts_execute, shortcuts_list, javascript_tool, gif_creator, switch_browser, select_browser, list_connected_browsers, resize_window` (the last four plus `shortcuts_list` are harmless but unneeded). Tests should assert both that no entry outside the allowlist is present and that each name above is absent.

**Result parsing:** read the last `type:"result"` line: `is_error`, `subtype`, `result` (text; take first ```json block else whole text), `permission_denials` (non-empty means a tool was blocked: log as a warning/failure), `usage`/`total_cost_usd`. Write every raw stdout line to `rawLogPath`. Emit `AgentEvent` from `assistant` text blocks (`text`), `tool_use` blocks (`tool`: name), and `system` subtypes (`status`).

**Not-logged-in (Claude):** exit code 1 with `assistant.error==="authentication_failed"` or result text `Not logged in` -> `ExecutorUnavailableError`. ENOENT on spawn -> same.

**Not-logged-in (JIRA):** agent returns `{"loginRequired": true}` as the final JSON (schema field `loginRequired`), `BrowserJiraSource` throws `JiraLoginRequiredError`. Note: the JIRA session may be in a "verify your email" interstitial rather than a plain login form; the prompt should treat any `id.atlassian.com`-style page as login required.

**Attachments:** phase 1 = **metadata only** (filename, URL, size/mime if visible, `sha256=null`). Reason: base64 fetch is verified feasible only through `javascript_tool`, which can also write to JIRA and cannot be restricted by the allowlist; Cloud cross-origin behaviour is untested. If the author later accepts it, add a separate role run with `javascript_tool` allowed, a prompt limited to GET fetch, skip `size > 2 MB`, return `{name, mime, size, base64}`.

**Open items before relying on this:** (1) log in to `<jira>` in that Chrome profile and smoke test `/issues/?jql=` and `/browse/KEY` reads (rows via `get_page_text`/`read_page`, comment IDs, attachment links) with the read-only list; (2) per-run cost/latency (20-40 s, 7-10 turns, ~0.2-0.45 USD) means discovery should not poll aggressively; (3) the tab-group behaviour: each `-p` run opens its own tab group/window in the author's real Chrome.
