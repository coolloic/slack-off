import {
  disagreements as sharedDisagreements, isCritique, type ChecklistGroup, type ChecklistItem, type DebateRoundRecord, type DesignDoc, type Disagreement, type Ruling, type RulingRecord,
} from "@slackoff/shared";
import { t } from "../i18n/en.ts";

// ---------------------------------------------------------------- Solutions: affected repositories

/**
 * The affected-repositories picker. `picked` null = untouched: the solution's own set (a phase-1 solution without repos
 * in a one-repo project gets that repo, as the server does). Repos keep the project's mapped order; names that are not
 * mapped are dropped. `edited` = differs from the solution's set.
 */
/** Short list for the phone bar caption: two names, then "+n", so the "(edited…)" suffix is never cut off. */
export function reposCaption(repos: readonly string[], edited: boolean): string {
  const shown = repos.length > 2 ? `${repos.slice(0, 2).join(", ")} +${repos.length - 2}` : repos.join(", ") || "—";
  return t(edited ? "sol.confirmReposEditedThisWill" : "sol.confirmReposThisWill", { repos: shown });
}

export function affectedDraft(
  solution: { affectedRepos: string[] },
  mapped: string[],
  picked: string[] | null,
): { repos: string[]; edited: boolean; error: string | null } {
  const proposed = solution.affectedRepos.length === 0 && mapped.length === 1 ? [...mapped] : solution.affectedRepos;
  const chosen = new Set(picked ?? proposed);
  const repos = mapped.filter((r) => chosen.has(r));
  const edited = picked !== null && (repos.length !== proposed.length || repos.some((r) => !proposed.includes(r)));
  return { repos, edited, error: repos.length === 0 ? t("sol.reposNone") : null };
}

// ---------------------------------------------------------------- Design & debate

export type ChecklistStatus = "considered" | "not_applicable" | "missing";

export interface ChecklistPanelGroup {
  group: ChecklistGroup;
  items: Array<{ id: string; label: string; status: ChecklistStatus; conclusion: string; comments: number; disputed: boolean }>;
  disputed: number;
}

/** The latest critic round (highest round number), or undefined. */
function lastCritic(rounds: readonly DebateRoundRecord[]): DebateRoundRecord | undefined {
  let c: DebateRoundRecord | undefined;
  for (const r of rounds) if (r.role === "critic" && (!c || r.round >= c.round)) c = r;
  return c;
}

/** The highest critic round so far (0 before the first critique). */
export function currentRound(rounds: readonly DebateRoundRecord[]): number {
  return lastCritic(rounds)?.round ?? 0;
}

/**
 * The quality checklist grouped as the server resolved it (order kept), with the shown doc's answers.
 * comments = critic comments on the item over all rounds. disputed = a blocking comment of the latest critic round on
 * the item that the developer has not ruled on — even one the designer accepted: the critic has not confirmed the fix
 * (the same set the server escalates as disagreements).
 */
export function checklistPanel(
  checklist: ChecklistItem[],
  doc: Pick<DesignDoc, "checklist"> | null,
  rounds: DebateRoundRecord[],
  rulings: RulingRecord[] = [],
): ChecklistPanelGroup[] {
  const comments = new Map<string, number>();
  for (const r of rounds) {
    if (r.role !== "critic" || !isCritique(r.content)) continue;
    for (const c of r.content.comments) comments.set(c.checklistItem, (comments.get(c.checklistItem) ?? 0) + 1);
  }
  // the server's disagreements (all blocking comments of the latest critic round) minus the ones already ruled on
  const disputed = new Set(
    sharedDisagreements(rounds)
      .filter((d) => !rulings.some((x) => x.debateRoundId === d.roundId && x.commentId === d.commentId))
      .map((d) => d.checklistItem),
  );
  const groups: ChecklistPanelGroup[] = [];
  for (const item of checklist) {
    let g = groups.find((x) => x.group === item.group);
    if (!g) groups.push((g = { group: item.group, items: [], disputed: 0 }));
    const answer = doc?.checklist.find((e) => e.item === item.id);
    const isDisputed = disputed.has(item.id);
    g.items.push({
      id: item.id,
      label: item.label,
      status: answer ? answer.status : "missing",
      conclusion: answer?.conclusion ?? "",
      comments: comments.get(item.id) ?? 0,
      disputed: isDisputed,
    });
    if (isDisputed) g.disputed++;
  }
  return groups;
}

export type RulingDraft = Record<string, { decision?: Ruling["decision"]; note: string }>;

/** Every disagreement needs a decision; "my own decision" needs a non-blank note. */
export function rulingDraftValid(disagreements: Disagreement[], draft: RulingDraft): { ok: boolean; missing: string[] } {
  const missing = disagreements
    .map((d) => d.commentId)
    .filter((id) => {
      const r = draft[id];
      return !r?.decision || (r.decision === "custom" && r.note.trim() === "");
    });
  return { ok: missing.length === 0, missing };
}

/** The rulings to send, one per disagreement; the note goes only with "my own decision" (a stale note is never audited). */
export function rulingsPayload(disagreements: Disagreement[], draft: RulingDraft): Ruling[] {
  return disagreements.map((d) => {
    const r = draft[d.commentId];
    if (!r?.decision) throw new Error(`no ruling for ${d.commentId}`);
    return { commentId: d.commentId, decision: r.decision, note: r.decision === "custom" ? r.note.trim() : "" };
  });
}

/** What finalizing does: as is when every ruling sides with the designer, else the designer applies them first. */
export function finalizeCaption(draft: RulingDraft, version: number): string {
  const all = Object.values(draft);
  return all.length > 0 && all.every((r) => r.decision === "designer") ? t("design.finalizeAsIs", { v: version }) : t("design.finalizeApply");
}

/** One design doc version as a single Markdown file: the overall design, then one `## <repo>` section per repo. */
export function docMarkdown(doc: Pick<DesignDoc, "contentMd" | "repos">): string {
  const parts = [doc.contentMd.trimEnd(), ...doc.repos.map((r) => `## ${r.repo}\n\n${r.contentMd.trimEnd()}`)];
  return parts.join("\n\n") + "\n";
}

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** Line diff (LCS) from `a` to `b`. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  // lcs[i][j] = LCS length of x[i..] and y[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: "same", text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "del", text: x[i++]! });
    else out.push({ kind: "add", text: y[j++]! });
  }
  while (i < n) out.push({ kind: "del", text: x[i++]! });
  while (j < m) out.push({ kind: "add", text: y[j++]! });
  return out;
}

export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string }
  /** a Markdown table, kept as its preformatted lines */
  | { kind: "table"; text: string };

export type InlineSpan = { kind: "text" | "code" | "bold"; text: string };

/** `code` and **bold** spans; everything else (HTML, links) stays literal text. */
export function inlineSpans(text: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  const re = /`([^`]+)`|\*\*([^*]+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { kind: "code", text: m[1] } : { kind: "bold", text: m[2]! });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** One table row's cells: split on "|" outside `code` spans, "\\|" kept as a literal "|". */
function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cur += ch;
    } else if (ch === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * A table block (mdBlocks) as header and rows, every row as wide as the header; null when it has no separator row
 * under the header (then it is shown as it is). Cells are text: rendered with inlineSpans, never as HTML.
 */
export function parseTable(text: string): { header: string[]; rows: string[][] } | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2 || !TABLE_SEPARATOR.test(lines[1]!)) return null;
  const header = tableCells(lines[0]!);
  const rows = lines.slice(2).filter((l) => !TABLE_SEPARATOR.test(l)).map((l) => {
    const c = tableCells(l);
    return header.map((_, i) => c[i] ?? "");
  });
  return { header, rows };
}

/**
 * A small Markdown subset as plain-text blocks (headings, paragraphs, lists, fenced code) — rendered as React text
 * nodes, never as HTML (agent-written text, Task 13 carry).
 */
export function mdBlocks(md: string): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "paragraph", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows: string[] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]!); i++) rows.push(lines[i]!.trim());
      i--;
      out.push({ kind: "table", text: rows.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ kind: "heading", level: h[1]!.length, text: h[2]!.trim() });
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = li[2] !== undefined;
      const prev = out.at(-1);
      if (prev?.kind === "list" && prev.ordered === ordered && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i - 1] ?? "")) prev.items.push(li[3]!);
      else out.push({ kind: "list", ordered, items: [li[3]!] });
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line.trim());
  }
  flush();
  return out;
}
