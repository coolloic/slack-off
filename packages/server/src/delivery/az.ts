import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runProcess } from "../git/run.ts";
import { DeliveryError } from "./git-push.ts";
import type { OpenPr } from "./gh.ts";
import { LINKS_START } from "./pr-body.ts";
import type { PrClient } from "./pr-client.ts";

// Azure DevOps through the Azure CLI's devops extension (`az repos …`), the way GitHub goes through gh: runProcess (no
// shell, stdin closed), nothing interactive, errors only. Descriptions only from a file (`@file`). Never complete,
// merge, auto-complete, bypass policies, reviewers or work items.

const DEFAULT_TIMEOUT_MS = 90_000;
/** Azure DevOps keeps at most 4000 characters of a pull request description. */
export const AZURE_DESCRIPTION_MAX = 4000;

const SETUP = "install the Azure CLI (brew install azure-cli), add its extension (az extension add --name azure-devops) and sign in (az login, or az devops login with a personal access token)";
const lastLines = (s: string, n = 4) => s.trim().split("\n").slice(-n).join("\n").trim();

/**
 * Fit a description in Azure DevOps' limit: the part before Slack Off's links section is shortened (with a note), the
 * links section stays whole so linking pull requests keeps working.
 */
export function fitAzureDescription(body: string): string {
  if (body.length <= AZURE_DESCRIPTION_MAX) return body;
  const at = body.indexOf(LINKS_START);
  const tail = at >= 0 ? body.slice(at) : "";
  const head = at >= 0 ? body.slice(0, at) : body;
  const note = "\n\n… (shortened: Azure DevOps keeps 4000 characters; the full text is in Slack Off)\n\n";
  return head.slice(0, Math.max(0, AZURE_DESCRIPTION_MAX - tail.length - note.length)).trimEnd() + note + tail;
}

/** `dev.azure.com/<org>/<project>/<repo>` → its parts; anything else is refused. */
function parts(id: string): { org: string; project: string; repo: string; orgUrl: string; repoUrl: string } {
  const m = id.match(/^dev\.azure\.com\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (!m) throw new DeliveryError(`${id} is not an Azure DevOps repository id`);
  const [, org, project, repo] = m as unknown as [string, string, string, string];
  const orgUrl = `https://dev.azure.com/${encodeURIComponent(org)}`;
  return { org, project, repo, orgUrl, repoUrl: `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}` };
}

interface ListedPr {
  pullRequestId?: unknown;
  sourceRefName?: unknown;
  targetRefName?: unknown;
  forkSource?: unknown;
}

export class AzClient implements PrClient {
  private readonly bin: string;
  private readonly timeoutMs: number;
  constructor(bin: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
  }

  private async az(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let r;
    try {
      r = await runProcess(this.bin, [...args, "--output", "json"], {
        timeoutMs: this.timeoutMs,
        env: { ...process.env, AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_CORE_NO_COLOR: "true", AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no", AZURE_CORE_COLLECT_TELEMETRY: "false" },
      });
    } catch (e) {
      throw new DeliveryError(`cannot run az (${this.bin}): ${(e as NodeJS.ErrnoException).code ?? (e as Error).message} — ${SETUP}, or set delivery.azBin in Settings`);
    }
    if (r.timedOut) throw new DeliveryError(`az ${args.slice(0, 3).join(" ")} timed out after ${Math.round(this.timeoutMs / 1000)} s`);
    return r;
  }

  private async json<T>(args: string[]): Promise<T> {
    const r = await this.az(args);
    if (r.code !== 0) throw new DeliveryError(`az ${args.slice(0, 3).join(" ")} failed: ${lastLines(r.stderr || r.stdout) || `exit ${r.code}`}`);
    try {
      return JSON.parse(r.stdout || "null") as T;
    } catch {
      throw new DeliveryError(`az ${args.slice(0, 3).join(" ")} returned something unreadable`);
    }
  }

  /** Signed in and allowed to read the project (also what visibility comes from). */
  async authStatus(id: string): Promise<{ ok: boolean; detail: string }> {
    const p = parts(id);
    const r = await this.az(["devops", "project", "show", "--project", p.project, "--organization", p.orgUrl]);
    if (r.code === 0) return { ok: true, detail: `az can read ${p.org}/${p.project}` };
    return { ok: false, detail: `${lastLines(r.stderr || r.stdout, 2) || "az cannot read the project"} — ${SETUP}` };
  }

  async repoVisibility(id: string): Promise<boolean | null> {
    const p = parts(id);
    const r = await this.az(["devops", "project", "show", "--project", p.project, "--organization", p.orgUrl]);
    if (r.code !== 0) return null;
    try {
      const v = (JSON.parse(r.stdout) as { visibility?: unknown }).visibility;
      return v === "private" ? true : v === "public" ? false : null;
    } catch {
      return null;
    }
  }

  async findOpenPr(id: string, head: string, base: string): Promise<OpenPr> {
    const p = parts(id);
    const list = await this.json<ListedPr[]>([
      "repos", "pr", "list", "--organization", p.orgUrl, "--project", p.project, "--repository", p.repo, "--source-branch", head, "--status", "active",
    ]);
    if (!Array.isArray(list)) throw new DeliveryError("az repos pr list returned something unreadable");
    if (list.length === 0) return { kind: "none" };
    const ok = (x: ListedPr) =>
      (x.forkSource === undefined || x.forkSource === null) && x.sourceRefName === `refs/heads/${head}` && x.targetRefName === `refs/heads/${base}` && typeof x.pullRequestId === "number";
    const good = list.filter(ok);
    if (list.length === 1 && good.length === 1) {
      const n = good[0]!.pullRequestId as number;
      return { kind: "reusable", number: n, url: `${p.repoUrl}/pullrequest/${n}` };
    }
    const bad = list.find((x) => !ok(x)) ?? list[0]!;
    const why = bad.forkSource ? "comes from a fork" : bad.targetRefName !== `refs/heads/${base}` ? `targets ${String(bad.targetRefName).replace(/^refs\/heads\//, "")}, not ${base}` : "does not match";
    return { kind: "conflict", detail: `an active pull request !${String(bad.pullRequestId)} for ${head} ${why}${list.length > 1 ? ` (${list.length} active pull requests use this branch)` : ""} — abandon or fix it in Azure DevOps, then Retry` };
  }

  /** The description goes in from a file (\`@file\`), fitted to Azure DevOps' 4000 characters. */
  private async fitted<T>(bodyFile: string, use: (file: string) => Promise<T>): Promise<T> {
    const body = readFileSync(bodyFile, "utf8");
    const fit = fitAzureDescription(body);
    if (fit === body) return use(bodyFile);
    const tmp = mkdtempSync(join(dirname(bodyFile), "az-body-"));
    try {
      const f = join(tmp, "body.md");
      writeFileSync(f, fit, { mode: 0o600 });
      return await use(f);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async createPr(o: { repo: string; base: string; head: string; title: string; bodyFile: string }): Promise<{ number: number; url: string }> {
    const p = parts(o.repo);
    const made = await this.fitted(o.bodyFile, (file) =>
      this.json<{ pullRequestId?: unknown }>([
        "repos", "pr", "create", "--organization", p.orgUrl, "--project", p.project, "--repository", p.repo,
        "--source-branch", o.head, "--target-branch", o.base, "--title", o.title, "--description", `@${file}`,
      ]),
    );
    if (typeof made?.pullRequestId !== "number") throw new DeliveryError("az repos pr create did not return the pull request id");
    return { number: made.pullRequestId, url: `${p.repoUrl}/pullrequest/${made.pullRequestId}` };
  }

  async getPrBody(id: string, number: number): Promise<string> {
    const p = parts(id);
    const pr = await this.json<{ description?: unknown }>(["repos", "pr", "show", "--id", String(number), "--organization", p.orgUrl]);
    return typeof pr?.description === "string" ? pr.description : "";
  }

  async editPrBody(id: string, number: number, bodyFile: string): Promise<void> {
    const p = parts(id);
    await this.fitted(bodyFile, (file) => this.json(["repos", "pr", "update", "--id", String(number), "--organization", p.orgUrl, "--description", `@${file}`]));
  }
}
