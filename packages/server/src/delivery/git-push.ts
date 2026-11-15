import { changedPaths, assertPlatformWorktree } from "../git/worktree.ts";
import { runGit } from "../git/run.ts";
import { isTicketBranch } from "@slackoff/shared";
import { isSshUrl, SSH_CONFIG } from "../git/net.ts";

// Delivery primitives (Task 11): what the remote is, and a push that is never forced and never fetches. Nothing here
// contacts anything but the repository's own `origin`; the `run` parameters exist so tests can observe argv.

export class DeliveryError extends Error {
  readonly repo: string | null;
  constructor(message: string, repo: string | null = null) {
    super(message);
    this.name = "DeliveryError";
    this.repo = repo;
  }
}

export interface GithubRemote {
  host: string;
  owner: string;
  name: string;
}

type RunGit = typeof runGit;

const LS_REMOTE_TIMEOUT_MS = 60_000;
const SEG = "[A-Za-z0-9][A-Za-z0-9_.-]*";
const HOST = "[A-Za-z0-9][A-Za-z0-9.-]*";

/** `https://<host>/<owner>/<name>(.git)`, `git@<host>:<owner>/<name>(.git)`, `ssh://git@<host>/<owner>/<name>(.git)`; else null. */
export function parseGithubRemote(url: string): GithubRemote | null {
  const u = url.trim();
  const m =
    u.match(new RegExp(`^https://(?:[^/@\\s]+@)?(${HOST})/(${SEG})/(${SEG}?)(?:\\.git)?/?$`)) ??
    u.match(new RegExp(`^git@(${HOST}):(${SEG})/(${SEG}?)(?:\\.git)?$`)) ??
    u.match(new RegExp(`^ssh://git@(${HOST})(?::\\d+)?/(${SEG})/(${SEG}?)(?:\\.git)?/?$`));
  if (!m) return null;
  return { host: m[1]!.toLowerCase(), owner: m[2]!, name: m[3]! };
}

/** A repository on a forge Slack Off opens pull requests on: GitHub (gh) or Azure DevOps (az repos). */
export interface ForgeRemote extends GithubRemote {
  forge: "github" | "azure";
}

const AZ_SEG = "[A-Za-z0-9][A-Za-z0-9_.%-]*";
const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Azure DevOps: `https://[user@]dev.azure.com/<org>/<project>/_git/<repo>`, `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>`,
 * `git` at `ssh.dev.azure.com:v3/<org>/<project>/<repo>`, or the same as an `ssh://` URL with `/v3/…`. owner = "<org>/<project>".
 */
export function parseAzureRemote(url: string): ForgeRemote | null {
  const u = url.trim();
  const at = "(?:[^/@\\s]+@)?";
  const end = "/?$";
  const m =
    u.match(new RegExp("^https://" + at + "dev\\.azure\\.com/(" + AZ_SEG + ")/(" + AZ_SEG + ")/_git/(" + AZ_SEG + ")" + end)) ??
    u.match(new RegExp("^https://" + at + "(" + AZ_SEG + ")\\.visualstudio\\.com/(?:DefaultCollection/)?(" + AZ_SEG + ")/_git/(" + AZ_SEG + ")" + end)) ??
    u.match(new RegExp("^git@ssh\\.dev\\.azure\\.com:v3/(" + AZ_SEG + ")/(" + AZ_SEG + ")/(" + AZ_SEG + ")$")) ??
    u.match(new RegExp("^ssh://git@ssh\\.dev\\.azure\\.com(?::22)?/v3/(" + AZ_SEG + ")/(" + AZ_SEG + ")/(" + AZ_SEG + ")" + end));
  if (!m) return null;
  return { forge: "azure", host: "dev.azure.com", owner: `${dec(m[1]!)}/${dec(m[2]!)}`, name: dec(m[3]!) };
}

/** A GitHub or an Azure DevOps repository, or null. */
export function parseRemote(url: string): ForgeRemote | null {
  const g = parseGithubRemote(url);
  return g ? { forge: "github", ...g } : parseAzureRemote(url);
}

/** credentials in a URL never go into messages */
const redact = (url: string) => url.replace(/\/\/[^/@\s]*@/, "//");
const lastLines = (s: string, n = 12) => s.trim().split("\n").slice(-n).join("\n").trim();
const firstLine = (s: string) => s.trim().split("\n")[0]?.replace(/^fatal:\s*/i, "") ?? "";
const idText = (g: GithubRemote) => `${g.host}/${g.owner}/${g.name}`;
const sameId = (a: ForgeRemote, b: ForgeRemote) =>
  a.forge === b.forge && a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

async function gitText(wt: string, args: string[], what: string, run: RunGit = runGit): Promise<string> {
  const r = await run(wt, args);
  if (r.code !== 0) throw new DeliveryError(`${what}: ${firstLine(r.stderr) || `git exited with ${r.code}`}`);
  return r.stdout.trim();
}

export async function remoteInfo(
  wt: string,
  run: RunGit = runGit,
): Promise<{ url: string; github: GithubRemote | null; remote: ForgeRemote | null; pushUrlMismatch: string | null; pushTarget: string }> {
  const u = await run(wt, ["config", "--get", "remote.origin.url"]);
  const url = u.stdout.trim();
  if (u.code !== 0 || url === "") throw new DeliveryError("this repository has no remote named origin — add one, then Retry");
  const remote = parseRemote(url);
  const github = remote?.forge === "github" ? { host: remote.host, owner: remote.owner, name: remote.name } : null;
  const pushTarget = redact(await gitText(wt, ["remote", "get-url", "--push", "origin"], "cannot read the push URL of origin", run));
  let pushUrlMismatch: string | null = null;
  if (remote) {
    const p = await run(wt, ["config", "--get-all", "remote.origin.pushurl"]);
    for (const pu of p.code === 0 ? p.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : []) {
      const id = parseRemote(pu);
      if (!id || !sameId(id, remote)) {
        pushUrlMismatch = `remote.origin.pushurl (${redact(pu)}) points to a different repository than origin (${idText(remote)}) — make them agree, then Retry`;
        break;
      }
    }
    // a pushInsteadOf redirect: the real push target is GitHub-shaped but names another repository (file:// stays allowed)
    const target = parseRemote(pushTarget);
    if (pushUrlMismatch === null && target && !sameId(target, remote)) {
      pushUrlMismatch = `pushes from origin (${idText(remote)}) go to ${idText(target)} (a url.*.pushInsteadOf rewrite) — make them agree, then Retry`;
    }
    // R-M1: any other push target that is not GitHub-shaped (a plain path, http://, another host's layout); only
    // file:// stays allowed (fake mode and tests map GitHub names onto local bare repositories)
    if (pushUrlMismatch === null && !target && !pushTarget.startsWith("file://")) {
      pushUrlMismatch = `pushes from origin (${idText(remote)}) go to ${pushTarget}, which is not that repository (a pushurl or url.*.pushInsteadOf rewrite) — make them agree, then Retry`;
    }
  }
  return { url: redact(url), github, remote, pushUrlMismatch, pushTarget };
}

/** `-c core.sshCommand=…` when origin (or its push target) is reached over ssh: no prompt can hang the run. */
async function netConfig(wt: string, run: RunGit): Promise<string[]> {
  const url = (await run(wt, ["config", "--get", "remote.origin.url"])).stdout.trim();
  const push = (await run(wt, ["remote", "get-url", "--push", "origin"])).stdout.trim();
  return isSshUrl(url) || isSshUrl(push) ? [...SSH_CONFIG] : [];
}

async function lsRemote(wt: string, args: string[], run: RunGit): Promise<string> {
  const r = await run(wt, [...(await netConfig(wt, run)), "ls-remote", ...args], { timeoutMs: LS_REMOTE_TIMEOUT_MS });
  if (r.timedOut) throw new DeliveryError("the remote did not answer in time (git ls-remote) — check the network, then Retry");
  if (r.code !== 0) throw new DeliveryError(`cannot read the remote: ${lastLines(r.stderr, 3) || `git exited with ${r.code}`}`);
  return r.stdout;
}

/** The sha of `refs/heads/<branch>` on origin, or null when it does not exist there. */
export async function remoteBranchSha(wt: string, branch: string, run: RunGit = runGit): Promise<string | null> {
  const out = await lsRemote(wt, ["origin", `refs/heads/${branch}`], run);
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (ref === `refs/heads/${branch}` && /^[0-9a-f]{40,64}$/.test(sha ?? "")) return sha!;
  }
  return null;
}

/** origin's default branch (`ls-remote --symref origin HEAD`), or null when it cannot be told (empty remote). */
export async function remoteDefaultBranch(wt: string, run: RunGit = runGit): Promise<string | null> {
  const out = await lsRemote(wt, ["--symref", "origin", "HEAD"], run);
  const m = out.match(/^ref:\s*refs\/heads\/(\S+)\s+HEAD$/m);
  return m ? m[1]! : null;
}

export type PushCheck = { kind: "ready" } | { kind: "already_pushed" } | { kind: "diverged"; remoteSha: string };

/** No fetch (Task 1): a remote tip the local repository does not have cannot be an ancestor of the local commit. */
export async function checkPush(wt: string, branch: string, localSha: string, run: RunGit = runGit): Promise<PushCheck> {
  const remoteSha = await remoteBranchSha(wt, branch, run);
  if (remoteSha === null) return { kind: "ready" };
  if (remoteSha === localSha) return { kind: "already_pushed" };
  if ((await run(wt, ["cat-file", "-e", `${remoteSha}^{commit}`])).code !== 0) return { kind: "diverged", remoteSha };
  const anc = await run(wt, ["merge-base", "--is-ancestor", remoteSha, localSha]);
  if (anc.code === 0) return { kind: "ready" };
  if (anc.code === 1) return { kind: "diverged", remoteSha };
  throw new DeliveryError(`cannot compare the remote branch with the local one: ${firstLine(anc.stderr)}`);
}


/**
 * Push exactly `refs/heads/<branch>` to origin, never forced. Only the commit recorded at acceptance is pushed.
 * `pushed: false` means the remote already had it.
 */
export async function pushBranch(o: {
  home: string;
  repo: string;
  wt: string;
  branch: string;
  baseBranch: string;
  localSha: string;
  hookTimeoutMs: number;
  /**
   * phase 4a: the platform's hook wrapper dir (`-c core.hooksPath=<dir>`): pre-push runs in the dev-hook sandbox. Required
   * (4A-4): without it the platform's git runs no hook at all (NO_HOOKS_DIR).
   */
  hooksDir: string;
  /** 4A-3 / 4A-8: the mapped repository; the worktree's git common dir must be its own */
  repoPath: string;
  run?: RunGit;
}): Promise<{ pushed: boolean; detail: string }> {
  const { repo, branch } = o;
  const run = o.run ?? runGit;
  const fail = (m: string) => new DeliveryError(`${repo}: ${m}`, repo);
  let wt: string;
  try {
    wt = assertPlatformWorktree(o.home, o.wt, o.repoPath);
  } catch (e) {
    throw fail((e as Error).message);
  }
  if (!isTicketBranch(branch)) throw fail(`branch "${branch}" is not a Slack Off ticket branch (<type>/<KEY>-…) — only those are pushed`);
  if (branch === o.baseBranch) throw fail(`branch ${branch} is the base branch — it is never pushed`);
  const def = await remoteDefaultBranch(wt, run);
  if (def === branch) throw fail(`branch ${branch} is the remote's default branch — it is never pushed`);

  const head = (await run(wt, ["rev-parse", "HEAD"])).stdout.trim();
  const ref = (await run(wt, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).stdout.trim();
  if (head !== o.localSha || ref !== o.localSha) throw fail(`HEAD of the worktree is not the recorded commit ${o.localSha.slice(0, 12)} — nothing was pushed`);
  if ((await changedPaths(wt)).length > 0) throw fail("the worktree has uncommitted changes — nothing was pushed");

  const c = await checkPush(wt, branch, o.localSha, run);
  if (c.kind === "already_pushed") return { pushed: false, detail: `${branch} already pushed (${o.localSha.slice(0, 12)})` };
  if (c.kind === "diverged") {
    throw fail(`remote branch ${branch} has commits that are not in ${repo}'s local branch — resolve it in the repository, then Retry`);
  }
  const hooks = ["-c", `core.hooksPath=${o.hooksDir}`];
  const r = await run(
    wt,
    [...hooks, ...(await netConfig(wt, run)), "push", "-u", "--no-follow-tags", "--recurse-submodules=no", "origin", `${o.localSha}:refs/heads/${branch}`],
    { timeoutMs: o.hookTimeoutMs, tailBytes: 4000 },
  );
  if (r.code !== 0) {
    const why = r.timedOut ? `timed out after ${Math.round(o.hookTimeoutMs / 1000)} s` : `git push exited with ${r.code}`;
    throw fail(`push failed (${why}): ${lastLines(r.tail || r.stderr || r.stdout)}`);
  }
  // `-u` cannot name an upstream when the source is a sha: record it the way -u would
  for (const [k, v] of [[`branch.${branch}.remote`, "origin"], [`branch.${branch}.merge`, `refs/heads/${branch}`]] as const) {
    const c = await run(wt, ["config", k, v]);
    if (c.code !== 0) throw fail(`pushed, but cannot record the upstream: ${firstLine(c.stderr)}`);
  }
  return { pushed: true, detail: `pushed ${branch} (${o.localSha.slice(0, 12)})` };
}
