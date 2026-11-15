// JIRA navigation guard (NAV_GUARD = 'hook', docs/spikes/2026-11-dev-sandbox.md §4.3).
//
// Two layers:
// 1. nav-guard-hook.mjs, a Claude Code PreToolUse hook passed with `--settings` (navGuardSettings), blocks `navigate` /
//    `tabs_create_mcp` to a URL outside the allow list, `select_browser` to any device but the pinned one, and
//    `switch_browser`. The server self-checks the exact hook command before every guarded run (navGuardSelfCheck, T6-1).
// 2. A click can navigate without a `navigate` call, and no hook sees it. After every chrome run the server scans the
//    raw log (navViolations / browserViolations), including tool RESULTS: the "Tab Context" `("<url>")` entries and the
//    `URL:` line in get_page_text's header.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { navAllowed } from "./nav-guard-hook.mjs";
import { SandboxPolicyError } from "./sandbox.ts";

export { navAllowed };

/** The executed hook: plain JavaScript, node: built-ins only (T6-2). */
export const NAV_GUARD_SCRIPT: string = fileURLToPath(new URL("./nav-guard-hook.mjs", import.meta.url));

const CHROME_PREFIX = "mcp__claude-in-chrome__";
const NAV_TOOLS = ["navigate", "tabs_create_mcp"];
const GUARDED_TOOLS = [...NAV_TOOLS, "select_browser", "switch_browser"];
/** what a freshly created tab shows before its first navigation */
const BLANK_PAGES = new Set(["about:blank", "chrome://newtab/", "chrome://new-tab-page/"]);
const MULTIPLE_BROWSERS = "Multiple Chrome browsers are connected";

const shortName = (name: unknown): string | null =>
  typeof name === "string" && name.startsWith(CHROME_PREFIX) ? name.slice(CHROME_PREFIX.length) : null;

type Json = Record<string, unknown>;

interface LogItems {
  uses: Array<{ name: string; input: Json }>;
  /** one entry per text block of a tool_result, with the tool that produced it (null when unknown) */
  results: Array<{ tool: string | null; text: string }>;
}

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v !== null && typeof v === "object") {
    const o = v as Json;
    if (typeof o.text === "string") out.push(o.text);
    else if ("content" in o) collectStrings(o.content, out);
  }
}

/** Every tool_use (name + input) and every tool_result text block in a stream-json log; unparsable lines are skipped. */
function readLog(rawLogPath: string): LogItems {
  const items: LogItems = { uses: [], results: [] };
  if (!existsSync(rawLogPath)) return items;
  const toolById = new Map<string, string>();
  for (const line of readFileSync(rawLogPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: Json;
    try {
      ev = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const content = (ev.message as Json | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Json[]) {
      if (b?.type === "tool_use" && typeof b.name === "string") {
        const input = b.input !== null && typeof b.input === "object" ? (b.input as Json) : {};
        items.uses.push({ name: b.name, input });
        if (typeof b.id === "string") toolById.set(b.id, b.name);
      } else if (b?.type === "tool_result") {
        const tool = typeof b.tool_use_id === "string" ? (toolById.get(b.tool_use_id) ?? null) : null;
        const texts: string[] = [];
        collectStrings(b.content, texts);
        for (const text of texts) items.results.push({ tool, text });
      }
    }
  }
  return items;
}

const TAB_LINE = /^\s*[•*-]\s*tabId\s+\d+\s*:/;
const KNOWN_TAB_CONTEXT_LINE = /^\s*(-\s*Executed on tabId:\s*\d+|-\s*Available tabs:)\s*$/;
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:[^\s"]*$/i;
/** Longer Tab Context lines are reported unparsed without being matched (fail closed, linear time). */
const MAX_TAB_LINE = 4096;
/** Tools whose result body is page content (ticket text): never parsed as Tab Context, except a separate block that
 * starts with it. The real tool results put Tab Context in its own text block (observed in the Task 12 run, see
 * docs/spikes/2026-11-dev-sandbox.md), so a section inside the same block as such a body is page text and ignored; a
 * click escape is still caught by the mandatory final get_page_text `URL:` header and the next tool's Tab Context. */
const PAGE_CONTENT_TOOLS = new Set(["get_page_text", "find", "read_page"]);
/** Tools whose result never carries a page header: a `URL:` line there is not the page URL. */
const KNOWN_TOOLS = new Set([...PAGE_CONTENT_TOOLS, "tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "navigate", "computer", "select_browser", "switch_browser", "list_connected_browsers"]);

type Found = { url: string } | { unparsed: string };

/** The URL at the end of a tab line: `("<url>")` or a bare `(<scheme>:...)`; null when there is none. Linear. */
export function tabLineUrl(line: string): string | null {
  const t = line.trimEnd();
  if (t.endsWith('")')) {
    const at = t.lastIndexOf('("');
    if (at < 0) return null;
    const url = t.slice(at + 2, -2);
    return url.includes('"') ? null : url;
  }
  if (t.endsWith(")")) {
    let start = t.length;
    while (start > 0 && !/\s/.test(t[start - 1]!)) start--; // the last whitespace-free token, scanned once from the end
    const token = t.slice(start);
    if (!token.startsWith("(")) return null;
    const url = token.slice(1, -1);
    return SCHEME_URL.test(url) ? url : null;
  }
  return null;
}

/** The "Tab Context" section of a result block, from a line that is exactly `Tab Context:` (none → no section); every
 * tab line must end with its URL, any other unknown line is unparsed. `startOnly`: the section must open the block. */
function tabContextUrls(text: string, startOnly: boolean): Found[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === "Tab Context:");
  if (at < 0) return [];
  if (startOnly && lines.slice(0, at).some((l) => l.trim() !== "")) return [];
  const out: Found[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.length > MAX_TAB_LINE) {
      out.push({ unparsed: `${line.trim().slice(0, 200)}… (${line.length} characters)` });
      continue;
    }
    if (line.trim() === "" || KNOWN_TAB_CONTEXT_LINE.test(line)) continue;
    const url = TAB_LINE.test(line) ? tabLineUrl(line) : null;
    out.push(url !== null ? { url } : { unparsed: line.trim() });
  }
  return out;
}

/** get_page_text's `URL:` line, read from its header only (before the `---` separator; the whole text if there is none). */
function pageTextUrls(text: string): string[] {
  const lines = text.split("\n");
  const sep = lines.findIndex((l) => l.trim() === "---");
  const header = sep >= 0 ? lines.slice(0, sep) : lines;
  return header.flatMap((l) => {
    const m = /^\s*URL:\s*(\S+)/.exec(l);
    return m ? [m[1] as string] : [];
  });
}

/** Every URL the run navigated to or ended up on (tool inputs and tool results) that is outside `allow`, deduplicated.
 * A Tab Context line that cannot be parsed is reported as a violation too (fail closed). */
export function navViolations(rawLogPath: string, allow: readonly string[]): string[] {
  const { uses, results } = readLog(rawLogPath);
  const seen: string[] = [];
  const push = (v: string) => {
    if (!seen.includes(v)) seen.push(v);
  };
  const add = (url: string) => {
    if (!navAllowed(url, allow)) push(url);
  };
  for (const u of uses) {
    const n = shortName(u.name);
    if (n !== null && NAV_TOOLS.includes(n) && u.input.url !== undefined) add(typeof u.input.url === "string" ? u.input.url : JSON.stringify(u.input.url));
  }
  for (const r of results) {
    const n = shortName(r.tool);
    // get_page_text's header, and any result of a tool we cannot name or a browser tool we do not know (fail closed)
    if (n === "get_page_text" || r.tool === null || (n !== null && !KNOWN_TOOLS.has(n))) for (const url of pageTextUrls(r.text)) add(url);
    for (const f of tabContextUrls(r.text, n !== null && PAGE_CONTENT_TOOLS.has(n))) {
      if ("unparsed" in f) push(`unparsed Tab Context line: ${f.unparsed}`);
      else if (!BLANK_PAGES.has(f.url)) add(f.url);
    }
  }
  return seen;
}

/** A `select_browser` to any device but `deviceId`, or any `switch_browser`. */
export function browserViolations(rawLogPath: string, deviceId: string): string[] {
  const out: string[] = [];
  for (const u of readLog(rawLogPath).uses) {
    const n = shortName(u.name);
    if (n === "switch_browser") out.push("switch_browser was called");
    else if (n === "select_browser" && u.input.deviceId !== deviceId) out.push(`select_browser chose device ${JSON.stringify(u.input.deviceId)}`);
  }
  return out;
}

/** Every `computer` call the hook would have refused: an action not in `actions`, modifier keys, text on anything but
 * a `type`, and a `type` whose text is not exactly `o.typeText` (none configured = every type). Mirrors the hook. */
export function computerViolations(rawLogPath: string, actions: readonly string[], o: { typeText?: string | null } = {}): string[] {
  const typeText = o.typeText ?? null;
  const out: string[] = [];
  for (const u of readLog(rawLogPath).uses) {
    if (shortName(u.name) !== "computer") continue;
    const a = u.input.action;
    const set = (f: "text" | "modifiers") => u.input[f] !== undefined && u.input[f] !== "";
    const v =
      typeof a !== "string" || !actions.includes(a) ? `computer action ${JSON.stringify(a ?? null)} is not allowed`
      : set("modifiers") ? `computer ${a} with modifiers is not allowed (no modifier keys)`
      : a === "type" ? (typeText === null || u.input.text !== typeText ? "computer type with a text other than the comment Slack Off asked for" : null)
      : set("text") ? `computer ${a} with text is not allowed (no typing or modifier keys)`
      : null;
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The text of every `computer` `type` call, in order (a non-string text as its JSON). */
export function typedTexts(rawLogPath: string): string[] {
  return readLog(rawLogPath)
    .uses.filter((u) => shortName(u.name) === "computer" && u.input.action === "type")
    .map((u) => (typeof u.input.text === "string" ? u.input.text : JSON.stringify(u.input.text ?? null)));
}

/** A tool reported that several browsers are connected and none is selected (S-2). */
export function multipleBrowsersReported(rawLogPath: string): boolean {
  return readLog(rawLogPath).results.some((r) => r.text.includes(MULTIPLE_BROWSERS));
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface NavGuardOptions {
  allow: readonly string[] | null;
  deviceId: string | null;
  /** the role's `computer` actions (jira-update: click only; jira-comment: clicks and type); null/absent = computer is
   * not guarded (and the hook refuses it as an unknown tool if it is ever called) */
  computerActions?: readonly string[] | null;
  /** jira-comment: `type` is allowed only with exactly this text; unset = every `type` is refused */
  typeText?: string | null;
}

/** `--settings` JSON installing the guard as the PreToolUse hook, run by the server's own absolute Node (never a bare
 * `node` from PATH). `allow` null = no URL check (jira-browser); `deviceId` null = no browser may be selected.
 * `paths` exists for the self-check tests. */
export function navGuardSettings(o: NavGuardOptions, paths: { node?: string; script?: string } = {}): string {
  const actions = o.computerActions ?? null;
  const command = [
    `SLACKOFF_NAV_ALLOW=${b64(o.allow)}`,
    `SLACKOFF_BROWSER=${b64(o.deviceId)}`,
    ...(actions !== null ? [`SLACKOFF_COMPUTER=${b64(actions)}`] : []),
    ...(actions !== null && (o.typeText ?? null) !== null ? [`SLACKOFF_TYPE_TEXT=${b64(o.typeText)}`] : []),
    shQuote(paths.node ?? process.execPath),
    "--disable-sigusr1",
    shQuote(paths.script ?? NAV_GUARD_SCRIPT),
  ].join(" ");
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: [...GUARDED_TOOLS, ...(actions !== null ? ["computer"] : [])].map((t) => CHROME_PREFIX + t).join("|"), hooks: [{ type: "command", command, timeout: 30 }] }],
    },
  });
}

/** Runs a hook command through /bin/sh as the CLI does, `input` on stdin (15 s limit). */
export function runHookShell(command: string, input: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** T6-1: runs the exact hook command from `settingsJson` with calls it must block; throws unless each exits 2. */
export async function navGuardSelfCheck(settingsJson: string, o: NavGuardOptions): Promise<void> {
  const fail = (why: string): never => {
    throw new SandboxPolicyError(`Navigation guard self-check failed: ${why}`);
  };
  let command: unknown;
  try {
    command = (JSON.parse(settingsJson) as { hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: unknown }> }> } }).hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  } catch {
    fail("settings are not JSON");
  }
  if (typeof command !== "string" || command === "") return fail("no hook command");
  const probes: Array<{ tool: string; input: Json }> = [];
  if (o.allow !== null) probes.push({ tool: "navigate", input: { tabId: 1, url: "https://slackoff-guard-selfcheck.invalid/" } });
  if (o.deviceId !== null) probes.push({ tool: "select_browser", input: { deviceId: `${o.deviceId}-selfcheck-other` } });
  if ((o.computerActions ?? null) !== null) {
    // a text that differs from the one jira-comment may type, and a key press
    const other = (o.typeText ?? null) === "selfcheck" ? "selfcheck-other" : "selfcheck";
    probes.push({ tool: "computer", input: { tabId: 1, action: "type", text: other } });
    probes.push({ tool: "computer", input: { tabId: 1, action: "key", text: "Return" } });
  }
  if (probes.length === 0) probes.push({ tool: "switch_browser", input: {} });
  for (const p of probes) {
    const r = await runHookShell(command, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: CHROME_PREFIX + p.tool, tool_input: p.input }));
    if (r.code !== 2) fail(`a disallowed ${p.tool} call exited ${r.code} instead of 2${r.stderr.trim() ? ` (${r.stderr.trim().split("\n")[0]})` : ""}`);
  }
}
