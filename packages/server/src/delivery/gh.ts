import { runProcess } from "../git/run.ts";
import { DeliveryError } from "./git-push.ts";

// The only way Slack Off talks to GitHub: `gh`, through runProcess (no shell, stdin closed — an open stdin pipe makes gh
// hang, Task 1). Descriptions only via --body-file. Never merge, api, --admin, --fill, --web, --editor, --dry-run, --draft.

const DEFAULT_TIMEOUT_MS = 60_000;

export type OpenPr = { kind: "none" } | { kind: "reusable"; number: number; url: string } | { kind: "conflict"; detail: string };

interface ListedPr {
  number?: unknown;
  url?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  isCrossRepository?: unknown;
  headRepositoryOwner?: unknown;
}

const lastLines = (s: string, n = 6) => s.trim().split("\n").slice(-n).join("\n").trim();

export class GhClient {
  private readonly bin: string;
  private readonly timeoutMs: number;
  constructor(bin: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
  }

  private async gh(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let r;
    try {
      r = await runProcess(this.bin, args, {
        timeoutMs: this.timeoutMs,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
      });
    } catch (e) {
      throw new DeliveryError(`cannot run gh (${this.bin}): ${(e as NodeJS.ErrnoException).code ?? (e as Error).message} — set delivery.ghBin in Settings`);
    }
    if (r.timedOut) throw new DeliveryError(`gh ${args.slice(0, 2).join(" ")} timed out after ${Math.round(this.timeoutMs / 1000)} s`);
    return r;
  }

  private async ok(args: string[]): Promise<string> {
    const r = await this.gh(args);
    if (r.code !== 0) throw new DeliveryError(`gh ${args.slice(0, 2).join(" ")} failed: ${lastLines(r.stderr || r.stdout) || `exit ${r.code}`}`);
    return r.stdout;
  }

  /** Exit code only (gh has no --json for it); never --show-token. */
  async authStatus(host: string): Promise<{ ok: boolean; detail: string }> {
    // --active: only the account gh uses counts (another, expired login on the same host fails the plain check);
    // a gh older than 2.40 has no --active and gets the plain check
    let r = await this.gh(["auth", "status", "--hostname", host, "--active"]);
    if (r.code !== 0 && /unknown flag: --active/.test(r.stderr)) r = await this.gh(["auth", "status", "--hostname", host]);
    if (r.code === 0) return { ok: true, detail: `gh is logged in to ${host}` };
    return { ok: false, detail: lastLines(r.stderr || r.stdout, 2) || `gh is not logged in to ${host}` };
  }

  /** No --base filter: gh filters by base on the server, which would hide a same-head PR for another base; the check below decides. */
  async findOpenPr(repo: string, head: string, base: string): Promise<OpenPr> {
    const out = await this.ok([
      "pr", "list", "--repo", repo, "--head", head, "--state", "open",
      "--json", "number,url,state,headRefName,baseRefName,isCrossRepository,headRepositoryOwner",
    ]);
    let list: ListedPr[];
    try {
      list = JSON.parse(out);
      if (!Array.isArray(list)) throw new Error("not a list");
    } catch {
      throw new DeliveryError("gh pr list returned something unreadable");
    }
    if (list.length === 0) return { kind: "none" };
    const owner = repo.split("/")[1] ?? "";
    const loginOf = (v: unknown) => (typeof v === "string" ? v : typeof v === "object" && v !== null ? String((v as { login?: unknown }).login ?? "") : "");
    const ok = (p: ListedPr) =>
      p.isCrossRepository === false && loginOf(p.headRepositoryOwner).toLowerCase() === owner.toLowerCase() &&
      p.headRefName === head && p.baseRefName === base && typeof p.number === "number" && typeof p.url === "string";
    const good = list.filter(ok);
    if (list.length === 1 && good.length === 1) return { kind: "reusable", number: good[0]!.number as number, url: good[0]!.url as string };
    const bad = list.find((p) => !ok(p)) ?? list[0]!;
    const why = bad.isCrossRepository !== false ? "comes from a fork" : bad.baseRefName !== base ? `targets ${String(bad.baseRefName)}, not ${base}` : "does not match";
    return { kind: "conflict", detail: `an open pull request #${String(bad.number)} for ${head} ${why}${list.length > 1 ? ` (${list.length} open pull requests use this branch)` : ""} — close or fix it on GitHub, then Retry` };
  }

  /** `isPrivate` of the repository (true = private, false = public); null when it cannot be told. */
  async repoVisibility(repo: string): Promise<boolean | null> {
    const r = await this.gh(["repo", "view", repo, "--json", "isPrivate"]);
    if (r.code !== 0) return null;
    try {
      const v = JSON.parse(r.stdout) as { isPrivate?: unknown };
      return typeof v.isPrivate === "boolean" ? v.isPrivate : null;
    } catch {
      return null;
    }
  }

  async createPr(o: { repo: string; base: string; head: string; title: string; bodyFile: string }): Promise<{ number: number; url: string }> {
    const out = await this.ok(["pr", "create", "--repo", o.repo, "--base", o.base, "--head", o.head, "--title", o.title, "--body-file", o.bodyFile]);
    const url = out.trim().split("\n").pop()?.trim() ?? "";
    const m = url.match(/^https:\/\/\S+\/pull\/(\d+)$/);
    if (!m) throw new DeliveryError(`gh pr create did not print the pull request URL (last line: ${url.slice(0, 200)})`);
    return { number: Number(m[1]), url };
  }

  async getPrBody(repo: string, number: number): Promise<string> {
    const out = await this.ok(["pr", "view", String(number), "--repo", repo, "--json", "body"]);
    try {
      const b = (JSON.parse(out) as { body?: unknown }).body;
      return typeof b === "string" ? b : "";
    } catch {
      throw new DeliveryError("gh pr view returned something unreadable");
    }
  }

  async editPrBody(repo: string, number: number, bodyFile: string): Promise<void> {
    await this.ok(["pr", "edit", String(number), "--repo", repo, "--body-file", bodyFile]);
  }
}
