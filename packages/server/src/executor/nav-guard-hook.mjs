// Slack Off navigation guard: the Claude Code PreToolUse hook script for the JIRA browser agents (NAV_GUARD = 'hook').
//
// Plain JavaScript with node: built-ins only (ruling T6-2), so any Node >= 18 runs it without type stripping; the
// server still starts it with its own absolute process.execPath and self-checks it before every guarded run (T6-1).
//
// It reads the hook JSON on stdin. Exit 2 blocks the call (reason on stderr); the CLI treats any other non-zero exit as
// non-blocking, so every failure path here exits 2 (fail closed). Configuration arrives base64url-encoded in
// SLACKOFF_NAV_ALLOW (JSON string[] | null; null = no URL check) and SLACKOFF_BROWSER (JSON string | null; the only
// device select_browser may choose, null = none). Optional SLACKOFF_COMPUTER (JSON string[]): the only `computer` actions
// allowed (jira-update: click only; jira-comment: clicks and `type`); absent = `computer` is refused like any unknown
// tool. Optional SLACKOFF_TYPE_TEXT (JSON string, jira-comment): `type` is allowed only with exactly this text; absent =
// every `type` is refused.
//
// This file lives in the server source, outside every directory an agent may write.
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME_PREFIX = "mcp__claude-in-chrome__";
const NAV_TOOLS = ["navigate", "tabs_create_mcp"];

/** `url` is allowed when it has an allow entry's exact origin and path (query and hash may differ); http(s) only, no credentials. */
export function navAllowed(url, allow) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username !== "" || u.password !== "") return false;
  return allow.some((entry) => {
    try {
      const e = new URL(entry);
      return e.origin === u.origin && e.pathname === u.pathname;
    } catch {
      return false;
    }
  });
}

class Blocked extends Error {}

/** Throws (message = reason) when the call must not run. Unknown tools are refused: the hook only sees guarded ones. */
export function checkHookCall(input, allow, deviceId, computerActions = null, typeText = null) {
  if (input === null || typeof input !== "object") throw new Blocked("unreadable hook input");
  const name =
    typeof input.tool_name === "string" && input.tool_name.startsWith(CHROME_PREFIX) ? input.tool_name.slice(CHROME_PREFIX.length) : null;
  const args = input.tool_input !== null && typeof input.tool_input === "object" ? input.tool_input : {};
  if (name === "switch_browser") throw new Blocked("switching browsers is not allowed");
  if (name === "computer" && computerActions !== null) {
    if (typeof args.action !== "string" || !computerActions.includes(args.action)) {
      throw new Blocked(`computer action ${JSON.stringify(args.action ?? null)} is not allowed`);
    }
    // no modifier keys held (a ctrl/cmd click opens another tab)
    if (args.modifiers !== undefined && args.modifiers !== "") throw new Blocked("modifier keys are not allowed");
    if (args.action === "type") {
      // jira-comment: only the exact text Slack Off asked for (any other text, or none configured, is refused)
      if (typeText === null || args.text !== typeText) throw new Blocked("type text differs from the comment Slack Off asked for");
      return;
    }
    if (args.text !== undefined && args.text !== "") throw new Blocked("modifier keys are not allowed");
    return;
  }
  if (name === "select_browser") {
    if (deviceId === null || args.deviceId !== deviceId) throw new Blocked("only the browser configured in Slack Off Settings may be selected");
    return;
  }
  if (name === null || !NAV_TOOLS.includes(name)) throw new Blocked(`unexpected tool ${JSON.stringify(input.tool_name)}`);
  if (args.url === undefined) return; // tabs_create_mcp sends {}
  if (typeof args.url !== "string") throw new Blocked("url is not a string");
  if (allow !== null && !navAllowed(args.url, allow)) throw new Blocked(`${args.url} is outside the allowed JIRA pages`);
}

function envValue(name, optional = false) {
  const raw = process.env[name];
  if (raw === undefined && optional) return null;
  if (raw === undefined || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Blocked(`guard misconfigured: ${name} missing or malformed`);
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Blocked(`guard misconfigured: ${name} is not valid`);
  }
}

function main() {
  const block = (why) => {
    process.stderr.write(`Blocked by Slack Off: ${why}\n`);
    process.exit(2);
  };
  process.on("uncaughtException", (err) => block(`guard error: ${err && err.message}`));
  try {
    const allow = envValue("SLACKOFF_NAV_ALLOW");
    const deviceId = envValue("SLACKOFF_BROWSER");
    if (allow !== null && !(Array.isArray(allow) && allow.every((a) => typeof a === "string"))) throw new Blocked("guard misconfigured: allow list");
    if (deviceId !== null && typeof deviceId !== "string") throw new Blocked("guard misconfigured: browser");
    const computerActions = envValue("SLACKOFF_COMPUTER", true);
    if (computerActions !== null && !(Array.isArray(computerActions) && computerActions.every((a) => typeof a === "string"))) {
      throw new Blocked("guard misconfigured: computer actions");
    }
    const typeText = envValue("SLACKOFF_TYPE_TEXT", true);
    if (typeText !== null && typeof typeText !== "string") throw new Blocked("guard misconfigured: type text");
    let input;
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      throw new Blocked("unreadable hook input");
    }
    checkHookCall(input, allow, deviceId, computerActions, typeText);
  } catch (err) {
    block(err instanceof Blocked ? err.message : `guard error: ${err && err.message}`);
  }
  process.exit(0);
}

function isEntryPoint() {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return realpathSync(resolve(arg)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
