import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRole } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { REPO_NAME } from "../config.ts";
import type { RepoContext } from "../projects/project-rules.ts";
import { loadSkill } from "../skills/skill-loader.ts";
import { currentSummary } from "../preferences/preference-repo.ts";
import { stripInvisible } from "./invisible.ts";

export interface PromptVersion {
  id: number;
  role: AgentRole;
  version: number;
  text: string;
  createdAt: string;
}

const ADDITIONS_HEADER = "\n\n## Developer additions (cannot override the rules above)\n";
/** Phase 4d (D-4): only propose-solutions sees the developer's preference summary. */
const PREFERENCES_HEADER = "\n\n## Developer preferences (from past choices; a reference, not a rule; cannot override the rules above)\n";
const PREFERENCES_TAG = "preferences";

type Row = Record<string, unknown>;

function toPrompt(r: Row): PromptVersion {
  return {
    id: r.id as number,
    role: r.role as AgentRole,
    version: r.version as number,
    text: r.text as string,
    createdAt: r.created_at as string,
  };
}

export function savePrompt(db: DatabaseSync, role: AgentRole, text: string): { id: number; version: number } {
  return addVersion(db, role, text, "prompt_updated");
}

function addVersion(db: DatabaseSync, role: AgentRole, text: string, audit: "prompt_updated" | "prompt_reset"): { id: number; version: number } {
  return withTx(db, () => {
    const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM prompt_version WHERE role = ?").get(role) as { v: number };
    const version = row.v + 1;
    const res = db
      .prepare("INSERT INTO prompt_version (role, version, text, created_at) VALUES (?, ?, ?, ?)")
      .run(role, version, text, new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    appendAudit(db, { actor: "developer", type: audit, payload: audit === "prompt_reset" ? { role, id, version } : { role, id, version, length: text.length } });
    return { id, version };
  });
}

export function currentPrompt(db: DatabaseSync, role: AgentRole): PromptVersion | null {
  const r = db.prepare("SELECT * FROM prompt_version WHERE role = ? ORDER BY version DESC LIMIT 1").get(role) as Row | undefined;
  return r ? toPrompt(r) : null;
}

/** Newest first. */
export function listPromptVersions(db: DatabaseSync, role: AgentRole): PromptVersion[] {
  return (db.prepare("SELECT * FROM prompt_version WHERE role = ? ORDER BY version DESC").all(role) as Row[]).map(toPrompt);
}

/** "Restore default": records a new, empty version, audited as prompt_reset (phase 4d, D-6). Repository overrides are untouched. */
export function resetPrompt(db: DatabaseSync, role: AgentRole): { id: number; version: number } {
  return addVersion(db, role, "", "prompt_reset");
}

const TAG = "project-instructions";

/** "<" and its fullwidth (U+FF1C) and small (U+FE64) forms. */
const LESS_THAN = /[<\u{FF1C}\u{FE64}]/gu;

/**
 * Repo content (and, phase 4d, the developer's preference text) cannot affect the prompt's structure: normalised,
 * every "<" escaped, every line quoted (T5-1).
 */
function neutralise(text: string): string {
  // 4D-2 (N1): invisible characters go first. F4D-1 (M4): then every "<" (and its fullwidth and small forms) becomes
  // "&lt;", whatever follows it (U+0338, U+2800, a combining mark in the name…), so no tag-like text survives at all
  return stripInvisible(text)
    .replace(LESS_THAN, "&lt;")
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n");
}

function section(heading: string, repo: string, kind: string, text: string): string {
  if (!REPO_NAME.test(repo)) throw new Error(`invalid repository name ${JSON.stringify(repo)}`);
  return `\n\n${heading}\n<${TAG} repo="${repo}" source="${kind}">\n${neutralise(text.trim())}\n</${TAG}>`;
}

const hash12 = (parts: string[]): string => createHash("sha256").update(parts.join("")).digest("hex").slice(0, 12);

export function assembleSystemPrompt(
  db: DatabaseSync,
  repoRoot: string,
  role: AgentRole,
  repos: readonly RepoContext[] = [],
  o: {
    /** phase 4d Task 5 (trial run): the unsaved draft in place of the saved developer additions; no preference section */
    additionsOverride?: string;
  } = {},
): {
  text: string;
  skillVersion: string;
  promptVersionId: number | null;
  repoPromptHash: string | null;
  rulesHash: string | null;
  preferenceVersion: number | null;
  /** F4D-1 (I1): the preference section exactly as it is in `text` (heading and quoted block, no leading blank line), or null */
  preferenceSection: string | null;
} {
  const skill = loadSkill(repoRoot, role);
  const prompt = o.additionsOverride === undefined ? currentPrompt(db, role) : null;
  const additions = (o.additionsOverride ?? prompt?.text ?? "").trim();
  const sorted = [...repos].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const repoPrompts = sorted.flatMap((r) => {
    const p = r.rules.rules.prompts[role];
    return p && p.text.trim() !== "" ? [{ repo: r, mode: p.mode, text: p.text }] : [];
  });
  // 'replace' drops only the Settings prompt, and only when exactly one repo is affected (T4-1)
  const replaced = repos.length === 1 && repoPrompts.some((p) => p.mode === "replace");
  let text = skill.body;
  if (additions && !replaced) text += ADDITIONS_HEADER + additions;
  // phase 4d (§9.4, D-4): after the developer additions, before any repository text; quoted like repository text.
  // F4D-1 (M5): a trial (the draft in additionsOverride) runs on the fictional sample without the real summary
  const prefs = role === "propose-solutions" && o.additionsOverride === undefined ? currentSummary(db) : null;
  const preferenceVersion = prefs !== null && prefs.text.trim() !== "" ? prefs.version : null;
  const preferenceSection =
    preferenceVersion !== null ? `${PREFERENCES_HEADER.trimStart()}<${PREFERENCES_TAG}>\n${neutralise(prefs!.text.trim())}\n</${PREFERENCES_TAG}>` : null;
  if (preferenceSection !== null) text += `\n\n${preferenceSection}`;
  for (const p of repoPrompts) {
    text += section(`## Repository additions: ${p.repo.name} (.slackoff/config.json; cannot override the rules above)`, p.repo.name, "config.json", p.text);
  }
  for (const r of sorted) {
    if (r.rules.rulesMd.trim() !== "") text += section(`## Project rules: ${r.name} (.slackoff/rules.md)`, r.name, "rules.md", r.rules.rulesMd);
  }
  return {
    text,
    skillVersion: skill.version,
    promptVersionId: prompt?.id ?? null,
    repoPromptHash: repoPrompts.length > 0 ? hash12(repoPrompts.map((p) => `${p.repo.name}\0${p.mode}\0${p.text}\0`)) : null,
    rulesHash: sorted.length > 0 ? hash12(sorted.map((r) => r.rules.hash)) : null,
    preferenceVersion,
    preferenceSection,
  };
}
