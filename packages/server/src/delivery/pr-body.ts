// Task 12: the pull request title and description, the related-PR links section and the JIRA delivery comment.
// Pure functions. Every piece of text that came from JIRA, an agent or a developer is untrusted here: it must not
// mention anyone (`@user`), close an issue ("fixes #12") or smuggle markup (an HTML comment could fake the links
// marker; <details> could hide text). The description never carries a screenshot, an image or a Slack Off URL: the
// evidence stays in Slack Off (JIRA / application data does not leak to GitHub).
import type { Requirement, ReviewReportRecord } from "@slackoff/shared";
import { JIRA_COMMENT_MULTILINE } from "../executor/sandbox.ts";

export const LINKS_START = "<!-- slackoff:links -->";
export const LINKS_END = "<!-- /slackoff:links -->";
const MAX_BODY_TOTAL = 60_000;
/** M4: room kept for the related-PR links section added later (about ten links) */
const LINKS_RESERVE = 3_500;
const MAX_BODY = MAX_BODY_TOTAL - LINKS_RESERVE;
const MAX_TITLE = 256;
const MAX_CELL = 200;

const MENTION = /(^|[^A-Za-z0-9_`])@([A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?)/g;
const CLOSING =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)((?:[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)?#\d+|https?:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+)/gi;
/** Every http(s) URL; `isLocalUrl` decides which ones are defanged. */
const ANY_URL = /(^|[^`\w])(https?):\/\/([^\s'"`]+)/gi;
/** Slack Off's own ports (server, web dev): a URL on them is never a live link, whatever the host */
const OWN_PORTS = new Set(["4317", "5173"]);

/**
 * A URL of this computer, the tailnet or Slack Off itself (R-M2): loopback 127/8, 0.0.0.0, localhost, any bracketed
 * IPv6 address, the Tailscale range 100.64.0.0/10 and *.ts.net names, a bare decimal-integer IPv4 host, or port
 * 4317 / 5173 on any host.
 */
function isLocalUrl(rest: string): boolean {
  const authority = rest.split(/[/?#]/, 1)[0]!.replace(/^[^@]*@/, "");
  const m = authority.match(/^(\[[^\]]*\]|[^:]*)(?::(\d+))?/);
  const host = (m?.[1] ?? "").toLowerCase();
  const port = m?.[2] ?? "";
  if (OWN_PORTS.has(port)) return true;
  if (host.startsWith("[")) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host.endsWith(".ts.net")) return true;
  if (/^\d+$/.test(host)) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 0 || (a === 100 && b >= 64 && b <= 127)) return true;
  }
  return false;
}

/**
 * Untrusted text made inert for GitHub markdown: HTML comments removed, `<` `>` escaped (no tags), backticks replaced
 * (so no code span can be opened that would free a mention), `![` / `](` escaped (no image, no link target), loopback and
 * Tailscale URLs put in backticks as `scheme[:]//…` (no live link), `@mentions` and the reference of a closing keyword
 * (`#n`, `owner/repo#n`, an issue / pull request URL) put in backticks.
 */
export function neutralize(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "'")
    // no image, no link target: `![` and `](` lose their meaning
    .replace(/!\[/g, "!\\[")
    .replace(/\]\(/g, "]\\(")
    .replace(ANY_URL, (m, pre: string, scheme: string, rest: string) => (isLocalUrl(rest) ? `${pre}\`${scheme}[:]//${rest}\`` : m))
    .replace(CLOSING, (_m, kw: string, sep: string, ref: string) => `${kw}${sep}\`${ref}\``)
    .replace(MENTION, (_m, pre: string, name: string) => `${pre}\`@${name}\``);
}

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** A markdown table cell: one line, at most 200 characters of the original text, neutralized, `|` escaped. */
export function tableCell(text: string): string {
  // cut before neutralizing: a cut can never split a backtick pair or an escape
  const flat = text.replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim();
  return neutralize(cut(flat, MAX_CELL)).replace(/\|/g, "\\|");
}

/** M3: a PR title is plain text on GitHub (no mentions, links or markup): control characters stripped, one line, ≤ 256. */
export function prTitle(key: string, title: string): string {
  return cut(`${key}: ${title}`.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "").replace(/\s+/g, " ").trim(), MAX_TITLE);
}

type Related = { repo: string; url: string };

function linksSection(related: Related[]): string {
  if (related.length === 0) return `${LINKS_START}\n${LINKS_END}`;
  const lines = related.map((r) => `- ${neutralize(r.repo)}: ${r.url.replace(/[\s<>`]/g, "")}`);
  return `${LINKS_START}\n**Related pull requests**\n\n${lines.join("\n")}\n${LINKS_END}`;
}

/**
 * Only the platform's marked section is replaced (a human's text in a reused PR stays). A body without the section
 * (a human removed it) gets one appended at the end.
 */
export function withLinks(body: string, related: Related[]): string {
  const start = body.indexOf(LINKS_START);
  const end = start < 0 ? -1 : body.indexOf(LINKS_END, start + LINKS_START.length);
  if (start < 0 || end < 0) return `${body.replace(/\s+$/, "")}\n\n${linksSection(related)}\n`;
  return body.slice(0, start) + linksSection(related) + body.slice(end + LINKS_END.length);
}

const resultLabel = (v: string) => (v === "not_tested" ? "not tested" : v);

export function prBody(i: {
  key: string;
  title: string;
  jiraUrl: string | null;
  requirement: Requirement;
  solution: { title: string; approach: string };
  report: ReviewReportRecord;
  maxAttempts: number;
  repo: string;
  related: Related[];
}): string {
  const { report: rec } = i;
  const r = rec.report;
  const date = rec.createdAt.slice(0, 10);
  const verdict = r.verdict === "not_executed" ? "not executed" : r.verdict;
  // only an https JIRA link (never a local or loopback address)
  const jira = i.jiraUrl !== null && /^https:\/\/[^\s<>`]+$/.test(i.jiraUrl) && !/^https:\/\/(localhost|127\.|\[?::1)/i.test(i.jiraUrl) ? i.jiraUrl : null;

  const head = [
    `## Summary`,
    "",
    `${neutralize(i.key)}: ${neutralize(i.title)}${jira ? ` (${jira})` : ""}`,
    "",
    neutralize(i.requirement.background.trim()),
    "",
    ...(i.requirement.functional.length > 0
      ? ["**Functional requirements**", "", ...i.requirement.functional.map((f) => `- ${tableCell(f.id)}: ${neutralize(f.text.replace(/\s+/g, " ").trim())}`), ""]
      : []),
    `## Chosen solution`,
    "",
    `**${neutralize(i.solution.title.replace(/\s+/g, " ").trim())}**`,
    "",
    neutralize(i.solution.approach.trim()),
    "",
    `## Acceptance`,
    "",
    `Result: **${verdict}** — attempt ${rec.attempt} of ${i.maxAttempts}, ${date}.`,
    ...(r.verdict === "not_executed" ? ["", `E2E not executed: ${neutralize((r.notExecutedReason ?? "no reason recorded").replace(/\s+/g, " ").trim())}`] : []),
    "",
    `## AC results`,
    "",
    `| AC | Result | Flows tested |`,
    `| --- | --- | --- |`,
  ];
  const rows = r.acs.map((a) => {
    const flows = a.flows.length === 0 ? "—" : a.flows.map((f) => `${f.kind}: ${f.title}`).join("; ");
    return `| ${tableCell(`${a.acId}: ${a.text}`)} | ${resultLabel(a.verdict)} | ${tableCell(flows)} |`;
  });
  const tail = [
    "",
    `Screenshots and evidence are in Slack Off (ticket ${neutralize(i.key)}, acceptance report #${rec.id}).`,
    "",
    linksSection(i.related),
    "",
  ];
  const assemble = (kept: string[], more: number) =>
    [...head, ...kept, ...(more > 0 ? ["", `(${more} more ACs — see Slack Off)`] : []), ...tail].join("\n");
  let body = assemble(rows, 0);
  if (body.length <= MAX_BODY) return body;
  // too long: drop table rows from the end until it fits
  let keep = rows.length;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (assemble(rows.slice(0, mid), rows.length - mid).length <= MAX_BODY) lo = mid;
    else hi = mid - 1;
  }
  keep = lo;
  body = assemble(rows.slice(0, keep), rows.length - keep);
  // the head alone (requirement / solution text) is too long: cut it, keeping the evidence note and the links section
  if (body.length > MAX_BODY) {
    const end = [...(keep < rows.length ? ["", `(${rows.length - keep} more ACs — see Slack Off)`] : []), ...tail].join("\n");
    body = `${cut([...head, ...rows.slice(0, keep)].join("\n"), MAX_BODY - end.length - 1)}\n${end}`;
  }
  return body;
}

/** The JIRA comment of a delivery: plain text, no list markers or formatting characters. */
export function deliveryCommentText(prs: Related[]): string {
  const lines = prs.map((p) => `${p.repo} pull request: ${p.url}`);
  return JIRA_COMMENT_MULTILINE ? ["Pull requests ready for review:", ...lines].join("\n") : ["Pull requests ready for review:", ...lines].join(" · ");
}
