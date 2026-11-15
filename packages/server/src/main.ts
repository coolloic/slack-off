import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { ConfigValidationError, DEFAULT_ACCEPT_CLAUDE_CONFIG_DIR, formatConfigFileError, loadConfig, type Config } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { AgentProcesses } from "./executor/claude-code.ts";
import { configuredExecutor } from "./executor/claude-api.ts";
import { runAgent, type RunAgentRequest } from "./executor/run-agent.ts";
import { budgetGate } from "./cost/budget-gate.ts";
import type { Executor } from "./executor/types.ts";
import type { TicketSource } from "./jira/ticket-source.ts";
import type { Server } from "node:http";
import { createApp } from "./http/app.ts";
import { EventBus } from "./http/events.ts";
import { BrowserJiraSource } from "./jira/browser-jira.ts";
import { BrowserJiraUpdater } from "./jira/jira-updater.ts";
import { BrowserJiraCommenter } from "./jira/jira-commenter.ts";
import { ApiJiraCommenter, ApiJiraSource, ApiJiraUpdater } from "./jira/api-jira.ts";
import { jiraClients } from "./jira/jira-clients.ts";
import { createWorkflow } from "./workflow/jobs.ts";
import { PlatformProcesses } from "./acceptance/app-runner.ts";
import { JobQueue } from "./workflow/queue.ts";
import { recoverOnStartup } from "./workflow/recovery.ts";
import { SERVER_PORT } from "./ports.ts";
import { listenHosts, resolveRemote, type TailscaleAddress } from "./remote/tailscale.ts";
import { sandboxBackend, sandboxUnavailableNotice } from "./sandbox/local-sandbox.ts";
import { applyFakeOverlay, type FakeOverlay } from "./dev/fake-overlay.ts";
import { readCredentials } from "./credentials/credential-store.ts";

const PORT = SERVER_PORT;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const home = process.env.SLACKOFF_HOME ?? join(homedir(), ".slackoff");
mkdirSync(home, { recursive: true });

let config: Config;
try {
  config = loadConfig(home);
} catch (err) {
  // H3: one clear message and a non-zero exit, no stack trace
  if (!(err instanceof ConfigValidationError)) throw err;
  console.error(formatConfigFileError(err));
  process.exit(1);
}

// Remote access (Tailscale): resolved once at startup — changing it needs a restart (restartRequired).
const runningRemoteAccess = { ...config.remoteAccess };
let remote: TailscaleAddress | null = await resolveRemote(runningRemoteAccess);
if (runningRemoteAccess.enabled && !remote) console.warn("Remote access is on, but no Tailscale address was found: listening on 127.0.0.1 only.");

let app: ReturnType<typeof createApp> | undefined;
const fetchApp = (req: Request, env: unknown) => (app ? app.fetch(req, env) : new Response("starting", { status: 503 }));

/** Listen on one address (never a wildcard: listenHosts refuses those); resolves the error when it cannot be bound. */
const listen = (hostname: string): Promise<ServerType | NodeJS.ErrnoException> =>
  new Promise((resolve) => {
    const s = serve({ fetch: fetchApp, hostname, port: PORT });
    s.once("listening", () => resolve(s));
    s.once("error", (err) => resolve(err as NodeJS.ErrnoException));
  });
const isError = (v: ServerType | NodeJS.ErrnoException): v is NodeJS.ErrnoException => v instanceof Error;

// The loopback port doubles as the single-instance lock: bind it BEFORE opening the database, recovering runs
// or starting any job, so a second instance started by mistake changes nothing.
const servers: ServerType[] = [];
const [loopbackHost, remoteHost] = listenHosts(remote);
const loopback = await listen(loopbackHost!);
if (isError(loopback)) {
  console.error(
    loopback.code === "EADDRINUSE"
      ? `Slack Off is already running (or another program uses ${loopbackHost}:${PORT}). Open http://${loopbackHost}:${PORT}, or stop the other process first.`
      : `Could not listen on ${loopbackHost}:${PORT}: ${loopback.message}`,
  );
  process.exit(1);
}
servers.push(loopback);

const db = openDatabase(join(home, "slackoff.db"));
const bus = new EventBus();
// phase 4b (4B-2): the stored credential values join the redaction set at startup (a bad file is reported on use)
try {
  readCredentials(home);
} catch {
  // GET /api/credentials and the API modes report it
}
const fake = process.env.SLACKOFF_FAKE_EXECUTOR === "1";

// Every agent child process, so shutdown can stop them (H2).
const agents = new AgentProcesses();
// Task 9: the target apps of acceptance runs (their own process groups, sandboxed): stopped on shutdown and exit
const platformProcesses = new PlatformProcesses();
process.on("exit", () => {
  // last resort, e.g. an uncaught exception
  agents.killAllSync();
  platformProcesses.killAll();
});

// kind, claudeBin and model are read per call so a config change applies without a restart (phase 4b task 6: the
// subscription login or the same CLI with the API key from credentials.json, read on every run)
const executor: Executor = configuredExecutor({
  config: () => config.executor,
  home,
  apiKey: () => readCredentials(home).anthropic?.apiKey ?? null,
  processes: agents,
});
// T7-5: an acceptance agent's sandbox must deny every mapped repository (read from the config on each call)
const mappedRepos = (): string[] => Object.values(config.projects).flatMap((p) => p.repos.map((r) => r.path));
// phase 4c: the usage gate before every agent run (config read per call, so a Settings change applies at once)
const gate = budgetGate({ db, config: () => config, bus });
const realRun = <T>(req: RunAgentRequest<T>): Promise<T> => runAgent({ db, repoRoot, executor, home, bus, mappedRepos, gate }, req);

let run: <T>(req: RunAgentRequest<T>) => Promise<T> = realRun;
let source: TicketSource = new BrowserJiraSource(realRun, config.jira, home);
/** fake mode only (Task 17): the fake gh, resolved on every call, and the check before every push */
let fakeDelivery: Pick<Parameters<typeof createWorkflow>[0], "gh" | "beforePush"> = {};
const fakeOverlay: FakeOverlay = {};
/** fake mode only (phase 4b Task 8): the fake Jira Cloud REST answering from the fake source (never a real JIRA) */
let fakeJiraFetch: typeof globalThis.fetch | null = null;
if (fake) {
  const mode = await import("./dev/fake-mode.ts");
  const fakeApi = await import("./dev/fake-jira-api.ts");
  // recorded in agent_run with the executor kind of the Settings (claude-api too), still never a real claude
  const recorded = fakeApi.fakeRunRecorded(db, () => config.executor.kind, { usageLimitOnce: mode.FAKE_SWITCHES.usageLimitOnce, bus });
  // phase 4c: the usage gate applies to the fake agent too (the pause and thresholds can be tried without a real claude)
  run = (req) => {
    gate.check(req.role);
    return recorded(req);
  };
  const fakeSource = mode.createFakeSource();
  source = fakeSource;
  fakeJiraFetch = fakeApi.createFakeJiraApi({ source: fakeSource, home }).fetch;
  mode.installFakeGh(home);
  fakeDelivery = { gh: mode.fakeGh, beforePush: mode.fakeBeforePush(home) };
  // in memory only (phase 4a Task 7: an overlay a Settings save never writes to config.json):
  // the acceptance config dir next to the data dir (e2e: inside its scratch dir), never the user's own
  if (config.acceptance.claudeConfigDir === DEFAULT_ACCEPT_CLAUDE_CONFIG_DIR) {
    fakeOverlay.claudeConfigDir = join(dirname(home), `${basename(home)}-acceptance`, "claude-config");
  }
  if (config.jira.baseUrl === "") fakeOverlay.jiraBaseUrl = mode.FAKE_BASE_URL;
  // the FAKE project needs repos to propose over (P-C19): two local fake repos
  if (!config.projects.FAKE?.repos.length) {
    const { createFakeRepos } = await import("./dev/fake-repo.ts");
    fakeOverlay.projects = { FAKE: { repos: await createFakeRepos(home, { cli: mode.FAKE_CLI }) } };
  }
  applyFakeOverlay(config, fakeOverlay);
}

// the only JIRA write (Task 12): off unless jira.syncStatus, each write confirmed by the developer
// the JIRA comment write (phase 3 Task 10): each comment confirmed by the developer
const browserJira = { source, updater: new BrowserJiraUpdater(run, config.jira, home), commenter: new BrowserJiraCommenter(run, config.jira, home) };
// phase 4b (B-6, Task 5): the JIRA API mode — Jira Cloud REST with the token from credentials.json, read on every call.
// Fake mode never reaches a real JIRA: the real REST code runs against the fake REST fetch (task 8), with the credentials
// typed in Settings like the real mode
const apiDeps = { fetch: fakeJiraFetch ?? globalThis.fetch, config: () => config.jira, credentials: () => readCredentials(home).jira };
const apiJira = { source: new ApiJiraSource(apiDeps), updater: new ApiJiraUpdater(apiDeps), commenter: new ApiJiraCommenter(apiDeps) };
// chosen on every call from jira.source (a call in progress keeps its implementation; never a fallback)
const { source: jiraSource, updater, commenter, pinned, mode: jiraMode } = jiraClients({ config, browser: browserJira, api: apiJira });
// 4B-9 (M3): every job runs with the JIRA mode it started with
const queue = new JobQueue(config.concurrency, { around: pinned });
// F-4 (M-3): sandbox self-checks also probe the Tailscale listener (read at each check: null when it could not bind)
const remoteHosts = () => (remote ? [remote.ip] : []);
const workflow = createWorkflow({ db, home, queue, source: jiraSource, run, config, bus, updater, commenter, jiraMode, processes: platformProcesses, repoRoot, remoteHosts, ...fakeDelivery });
recoverOnStartup(db, workflow);

if (remoteHost) {
  const s = await listen(remoteHost);
  if (isError(s)) {
    console.error(`Could not listen on ${remoteHost}:${PORT}: ${s.message}`);
    remote = null;
  } else servers.push(s);
}

const webDist = join(repoRoot, "packages", "web", "dist");
// Settings "Detect browsers" (S-2, A-1): a jira-browser run limited to list_connected_browsers (fake run in fake mode)
const listBrowsers = () => new BrowserJiraSource(run, config.jira, home).listBrowsers();
// phase 4d Task 5: trial runs use the same runner as real ones (the usage gate; the fake agent in fake mode); the sample
// repository is copied under the system temp dir (realpath), outside SLACKOFF_HOME and every mapped repository
const trial = { run, tmpRoot: realpathSync(tmpdir()) };
app = createApp({ db, home, repoRoot, workflow, bus, config, queueConcurrency: config.concurrency, remote, runningRemoteAccess, webDist, listBrowsers, trial, ...(fake ? { fakeOverlay } : {}) });
console.log(`Slack Off listening on http://${loopbackHost}:${PORT}`);
if (remote) console.log(`Remote access (Tailscale): http://${remote.ip}:${PORT}${remote.dnsName ? ` · http://${remote.dnsName}:${PORT}` : ""} — paired devices only`);
// phase 4a Task 5: say once, at startup, when there is no command sandbox (and what will therefore not run)
{
  const notice = sandboxUnavailableNotice(sandboxBackend());
  if (notice !== null) console.log(notice);
}

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) {
    // a second Ctrl-C: stop waiting
    agents.killAllSync();
    platformProcesses.killAll();
    process.exit(1);
  }
  closing = true;
  if (agents.size > 0) console.log(`Stopping ${agents.size} running agent(s)…`);
  // SIGTERM each agent's process group, SIGKILL after the grace period; interrupted runs are closed and
  // their tickets resumed on the next start (recoverOnStartup).
  await agents.stopAll();
  // Task 9: then every target app an acceptance run started (an interrupted run is recovered on the next start)
  platformProcesses.killAll();
  let open = servers.length;
  for (const s of servers) {
    s.close(() => {
      if (--open > 0) return;
      db.close();
      process.exit(0);
    });
    (s as Server).closeAllConnections(); // SSE streams would otherwise keep close() waiting
  }
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// The terminal running `pnpm start` was closed: agents run in their own session and would not get the hangup.
process.on("SIGHUP", () => void shutdown());
