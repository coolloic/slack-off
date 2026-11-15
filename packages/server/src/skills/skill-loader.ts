import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole } from "@slackoff/shared";

export interface LoadedSkill {
  name: string;
  body: string;
  /** First 12 hex chars of sha256 over the whole SKILL.md file. */
  version: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Loads `<repoRoot>/skills/<role>/SKILL.md`; `repoRoot` is the Slack Off repo root. */
export function loadSkill(repoRoot: string, role: AgentRole): LoadedSkill {
  const raw = readFileSync(join(repoRoot, "skills", role, "SKILL.md"), "utf8");
  const m = FRONTMATTER.exec(raw);
  if (!m) throw new Error(`skills/${role}/SKILL.md: missing frontmatter`);
  const name = /^name:\s*(.+?)\s*$/m.exec(m[1]!)?.[1];
  if (!name) throw new Error(`skills/${role}/SKILL.md: frontmatter has no name`);
  return {
    name,
    body: raw.slice(m[0].length).trim(),
    version: createHash("sha256").update(raw).digest("hex").slice(0, 12),
  };
}
