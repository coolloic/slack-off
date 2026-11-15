// Test helper: small real git repositories (branch main, one commit) for code that reads a repo's base branch.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tmpDir } from "../helpers/tmp.ts";

/** git for test setup only: per-repo identity via -c, never global config */
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A fresh repo named `name` (the directory's basename) on branch main with `files` committed. */
export function gitRepo(name: string, files: Record<string, string> = { "README.md": `# ${name}\n` }, parent = tmpDir("repo")): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "commit.gpgsign", "false");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}
