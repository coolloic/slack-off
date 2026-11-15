// Task 12: the delivery plan — exactly what one "Confirm and deliver" authorizes. Read-only: it reads the stored
// report, the worktrees, the remotes (ls-remote, never fetch) and GitHub through `gh` (auth, open PRs, visibility),
// and changes nothing. The hash binds the listed actions and the full PR descriptions (not the warnings, not the
// developer's ack note — ruling R10): confirm recomputes the plan and refuses when the hash differs.
import { createHash } from "node:crypto";
import { isTicketBranch } from "@slackoff/shared";
import type { DatabaseSync } from "node:sqlite";
import type { DeliveryAction, DeliveryPlan, DeliveryPrBody, ReviewReportRecord } from "@slackoff/shared";
import { canonicalJson } from "../audit/canonical-json.ts";
import type { Config } from "../config.ts";
import { changedPaths, git } from "../git/worktree.ts";
import { listReports } from "../acceptance/review-repo.ts";
import { statusTarget } from "../jira/jira-write-jobs.ts";
import { affectedRepos, loadProjectRules, type RepoContext } from "../projects/project-rules.ts";
import { currentChoice, getRequirement, getSolution } from "../requirements/requirement-repo.ts";
import { getTicket, listRepoWorkspaces, type RepoWorkspace } from "../tickets/ticket-repo.ts";
import { ticketBases } from "../tickets/base-branch-repo.ts";
import type { GhClient, OpenPr } from "./gh.ts";
import { AzClient } from "./az.ts";
import { isAzureId, type PrClient } from "./pr-client.ts";
import { checkPush, remoteBranchSha, remoteDefaultBranch, remoteInfo, type GithubRemote, type PushCheck } from "./git-push.ts";
import { prBody, prTitle } from "./pr-body.ts";

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** `<host>/<owner>/<name>`; Azure DevOps: `dev.azure.com/<org>/<project>/<repo>` (owner is "<org>/<project>") */
export const repoId = (g: GithubRemote): string => `${g.host}/${g.owner}/${g.name}`;

/** first 16 hex chars of sha256(canonicalJson({actions, prBodies})) */
export function planHash(actions: DeliveryAction[], prBodies: DeliveryPrBody[]): string {
  return createHash("sha256").update(canonicalJson({ actions, prBodies })).digest("hex").slice(0, 16);
}

/** The ticket's affected repos (the locked choice against today's mapping) with their rules. */
export async function deliveryRepos(db: DatabaseSync, config: Config, key: string): Promise<RepoContext[]> {
  const choice = currentChoice(db, key);
  if (!choice) throw new Error(`${key}: no solution has been chosen`);
  const out: RepoContext[] = [];
  for (const r of affectedRepos({ key }, choice, config, ticketBases(db, key))) out.push({ ...r, rules: await loadProjectRules(r.path, r.baseBranch, r.name, r.commands) });
  return out;
}

/** The push action's text (the plan's and, at execution, the check against what was confirmed, T12-1). F-4 (M-1): it
 * names the commit and the acceptance report it comes from, so the plan hash binds both. */
export const pushActionText = (repo: string, branch: string, id: string, sha: string | null, reportId: number, alreadyPushed: boolean): string =>
  `Push branch ${branch} of ${repo} to origin (${id}) — commit ${sha === null ? "(none)" : sha.slice(0, 7)} from acceptance report #${reportId} — never forced${alreadyPushed ? " (already pushed — nothing to send)" : ""}`;
/** The pr action's text: reuse open PR #n, or open one titled `title`. */
export const prActionText = (reuse: number | null, id: string, branch: string, base: string, title: string): string =>
  reuse !== null ? `Reuse the open pull request #${reuse} in ${id}: ${branch} → ${base}` : `Open a pull request in ${id}: ${branch} → ${base}, titled "${title}"`;
/** T12-3: what the preview shows (and the hash covers) for a reused PR: its own description is kept */
export const REUSED_PR_BODY = "The existing description is kept; only the links section is added";

interface RepoFacts {
  repo: string;
  branch: string;
  base: string;
  id: string;
  /** the commit the acceptance report recorded for this repo */
  sha: string | null;
  push: PushCheck | null;
  pr: OpenPr | null;
}

export async function buildDeliveryPlan(db: DatabaseSync, home: string, config: Config, deps: { gh: GhClient; az?: PrClient }, key: string): Promise<DeliveryPlan> {
  void home;
  const { gh } = deps;
  // the pull request client of a repository: GitHub through gh, Azure DevOps through az repos
  const clientFor = (id: string): PrClient => (isAzureId(id) ? (deps.az ?? new AzClient(config.delivery.azBin)) : gh);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const empty = (): DeliveryPlan => ({ actions: [], prBodies: [], blockers, warnings, hash: planHash([], []) });

  const t = getTicket(db, key);
  if (!t) {
    blockers.push(`unknown ticket ${key}`);
    return empty();
  }
  if (t.state !== "awaiting_confirmation") blockers.push(`${key} is ${t.state}: only a ticket waiting for confirmation can be delivered`);
  const report: ReviewReportRecord | undefined = listReports(db, key).at(-1);
  if (!report) {
    blockers.push(`${key} has no acceptance report`);
    return empty();
  }
  const choice = currentChoice(db, key);
  const requirement = choice ? getRequirement(db, choice.requirementId) : null;
  const solution = choice ? getSolution(db, choice.solutionId) : null;
  if (!choice || !requirement || !solution) {
    blockers.push(`${key} has no chosen solution`);
    return empty();
  }
  let repos: RepoContext[];
  try {
    repos = await deliveryRepos(db, config, key);
  } catch (err) {
    blockers.push(errMessage(err));
    return empty();
  }
  if (report.verdict === "not_executed") warnings.push(`E2E was not executed: ${report.report.notExecutedReason ?? "no reason recorded"}`);

  const workspaces = listRepoWorkspaces(db, key);
  const facts: RepoFacts[] = [];
  const prBodies: DeliveryPrBody[] = [];
  const authChecked = new Map<string, boolean>();
  const title = prTitle(key, t.title);
  const jiraUrl = config.jira.baseUrl === "" ? null : `${config.jira.baseUrl.replace(/\/+$/, "")}/browse/${key}`;

  for (const r of repos) {
    const w: RepoWorkspace | undefined = workspaces.find((x) => x.repo === r.name);
    const f: RepoFacts = { repo: r.name, branch: w?.branch ?? "(no branch)", base: w?.baseBranch ?? r.baseBranch, id: "origin", sha: null, push: null, pr: null };
    facts.push(f);
    const block = (m: string) => blockers.push(`${r.name}: ${m}`);
    if (!w) {
      block(`no worktree for ${key} — development has not run in this repository`);
      continue;
    }
    if (!isTicketBranch(w.branch) || w.branch === w.baseBranch) block(`branch ${w.branch} is not a Slack Off ticket branch (<type>/<KEY>-…) distinct from the base branch — it is never pushed`);
    const sha = report.report.commits.find((c) => c.repo === r.name)?.sha ?? null;
    f.sha = sha;
    if (sha === null) block("the acceptance report recorded no commit for this repository — run acceptance again");
    try {
      const dirty = await changedPaths(w.worktreePath);
      if (dirty.length > 0) block(`the worktree has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? "…" : ""}) — commit or discard them, then run acceptance again`);
      const head = (await git(w.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
      if (sha !== null && head !== sha) block(`the worktree is at ${head.slice(0, 12)}, not the accepted commit ${sha.slice(0, 12)} — run acceptance again`);
    } catch (err) {
      block(`cannot read the worktree: ${errMessage(err)}`);
      continue;
    }
    let info;
    try {
      info = await remoteInfo(w.worktreePath);
    } catch (err) {
      block(errMessage(err));
      continue;
    }
    if (!info.remote) {
      block(`origin (${info.url}) is not a GitHub or Azure DevOps repository — Slack Off opens pull requests on those only`);
      continue;
    }
    if (info.pushUrlMismatch) block(info.pushUrlMismatch);
    f.id = repoId(info.remote);
    const client = clientFor(f.id);
    // one sign-in check per GitHub host, per Azure DevOps organization
    const host = info.remote.forge === "azure" ? `azure:${info.remote.owner.split("/")[0]!.toLowerCase()}` : info.remote.host;
    if (!authChecked.has(host)) {
      const a = await client.authStatus(info.remote.forge === "azure" ? f.id : info.remote.host).catch((err: unknown) => ({ ok: false, detail: errMessage(err) }));
      authChecked.set(host, a.ok);
      if (!a.ok) {
        blockers.push(
          info.remote.forge === "azure"
            ? `az cannot reach ${info.remote.owner} in Azure DevOps — ${a.detail}, then preview again`
            : `gh is not logged in to ${info.remote.host} — run "gh auth login" in a terminal, then preview again (${a.detail})`,
        );
      }
    }
    try {
      if ((await remoteBranchSha(w.worktreePath, w.baseBranch)) === null) block(`origin (${f.id}) has no base branch ${w.baseBranch} — push it first, then preview again`);
      const def = await remoteDefaultBranch(w.worktreePath);
      if (def !== null && def === w.branch) block(`branch ${w.branch} is the remote's default branch — it is never pushed`);
      if (sha !== null) {
        f.push = await checkPush(w.worktreePath, w.branch, sha);
        if (f.push.kind === "diverged") block(`remote branch ${w.branch} has commits that are not in ${r.name}'s local branch — resolve it in the repository, then preview again`);
      }
    } catch (err) {
      block(errMessage(err));
    }
    if (authChecked.get(host)) {
      try {
        f.pr = await client.findOpenPr(f.id, w.branch, w.baseBranch);
        if (f.pr.kind === "conflict") block(f.pr.detail);
      } catch (err) {
        block(errMessage(err));
      }
    }
    const isPrivate = authChecked.get(host) ? await client.repoVisibility(f.id).catch(() => null) : null;
    if (isPrivate !== true) warnings.push(`${f.id} is public (or its visibility is unknown): the description shows the requirement and AC text`);
    prBodies.push({
      repo: r.name,
      title,
      body:
        f.pr?.kind === "reusable"
          ? REUSED_PR_BODY
          : prBody({
              key, title: t.title, jiraUrl, requirement: requirement.content, solution: { title: solution.content.title, approach: solution.content.approach },
              report, maxAttempts: config.review.maxAttempts, repo: r.name, related: [],
            }),
      isPrivate,
    });
  }

  const actions: Omit<DeliveryAction, "seq">[] = [
    { kind: "snapshot", repo: null, text: `Re-read ${key} from JIRA (read only) and check the ACs against any change` },
  ];
  for (const f of facts) {
    actions.push({ kind: "push", repo: f.repo, text: pushActionText(f.repo, f.branch, f.id, f.sha, report.id, f.push?.kind === "already_pushed") });
  }
  for (const f of facts) {
    actions.push({ kind: "pr", repo: f.repo, text: prActionText(f.pr?.kind === "reusable" ? f.pr.number : null, f.id, f.branch, f.base, title) });
  }
  if (facts.length > 1) actions.push({ kind: "pr_links", repo: null, text: `Edit the ${facts.length} pull request descriptions to link to each other` });
  if (config.jira.syncStatus) {
    const target = statusTarget(repos, config, "readyForReview");
    if (target.note) warnings.push(target.note);
    // F4B-4: the action names how JIRA is changed (hashed: a mode switch asks for a new confirmation)
    const how = config.jira.source === "api" ? "through the JIRA API, with your API token" : "your Chrome";
    actions.push({ kind: "jira_status", repo: null, text: `Set ${key} to "${target.status}" in JIRA (${how})` });
    actions.push({ kind: "jira_comment", repo: null, text: `Comment on ${key} in JIRA with the pull request links` });
  } else {
    warnings.push("JIRA is not changed (status sync is off in Settings)");
  }
  const numbered: DeliveryAction[] = actions.map((a, i) => ({ seq: i + 1, ...a }));
  return { actions: numbered, prBodies, blockers, warnings, hash: planHash(numbered, prBodies) };
}
