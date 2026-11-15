import { accessSync, constants, createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { driftNeedsAck, jiraImageSources, Requirement, Ruling, type AgentRole } from "@slackoff/shared";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { appendAudit, verifyAuditChain } from "../audit/audit-log.ts";
import { canonicalJson } from "../audit/canonical-json.ts";
import { SERVER_PORT, WEB_DEV_PORT } from "../ports.ts";
import { changedConfigPaths, ConfigValidationError, loadConfig, parseConfig, saveConfig, type Config } from "../config.ts";
import { budgetProgress, usageSummary } from "../cost/usage-repo.ts";
import { currentPause, pauseUsage, resumeUsage, UsagePausedError } from "../cost/budget-gate.ts";
import { isTrialRole, PREFERENCE_TEXT_MAX, PROMPT_TEXT_MAX, USAGE_WINDOWS, type UsageWindow } from "@slackoff/shared";
import { latestDrift } from "../drift/drift-repo.ts";
import { JiraNotConfiguredError } from "../jira/ticket-source.ts";
import { currentPrompt, listPromptVersions, resetPrompt, savePrompt } from "../prompts/prompt-store.ts";
import { clearSummary, editSummary, preferenceState, rederive } from "../preferences/preference-repo.ts";
import { runTrial, type TrialDeps } from "../prompts/trial-run.ts";
import { currentChoice, getRequirement, latestRequirement, listSolutions } from "../requirements/requirement-repo.ts";
import type { ConnectedBrowser } from "../jira/browser-jira.ts";
import { listJiraWrites } from "../jira/jira-write-repo.ts";
import { listComments } from "../jira/jira-comment-repo.ts";
import { DeliveryError } from "../delivery/git-push.ts";
import { listDeliveries, ticketsWithFailedJiraSteps } from "../delivery/delivery-repo.ts";
import { createHandOffCache, designDoc, designView, developmentView, evidenceFile, handOffState, repoDiff, reportView, reviewView } from "./views.ts";
import { loadSkill } from "../skills/skill-loader.ts";
import { getSnapshot, listSnapshots } from "../snapshots/snapshot-store.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../tickets/errors.ts";
import { getTicket, lastDiscoveryRun, listTickets, setReviewAc, type Ticket } from "../tickets/ticket-repo.ts";
import { isLocalRequest, sessionCookie, sessionToken } from "../remote/auth.ts";
import { createPairing } from "../remote/pairing.ts";
import { detectTailscale as detectTailscaleDefault, type TailscaleAddress } from "../remote/tailscale.ts";
import { webUi } from "./static.ts";
import type { Workflow } from "../workflow/jobs.ts";
import type { EventBus } from "./events.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../executor/types.ts";
import { applyFakeOverlay, withoutFakeOverlay, type FakeOverlay } from "../dev/fake-overlay.ts";
import {
  CredentialFileError, credentialStatus, otlpHeadersIssue, readCredentials, redactDeep, redactorFor, redactStored, validateAnthropicInput, validateJiraInput, validateOtlpHeadersInput,
  writeCredentials, type CredentialKind, type Credentials, type InputIssue, type Validated,
} from "../credentials/credential-store.ts";
import { buildOtlpPayload, endpointHost, otlpEndpointIssue, rawLogReader, sendOtlp, type SendResult } from "../telemetry/otlp.ts";
import { exportableRuns, exportHash, exportRunning, finishExport, getExport, hashUsed, lastExportId, MAX_DETAIL_CHARS, MAX_EXPORT_RUNS, previewExport, startExport } from "../telemetry/export-repo.ts";
import { logError } from "../log.ts";
import { localNetworkFor, sandboxBackend as sandboxBackendDefault, sandboxSelfCheck, type SandboxBackend, type SandboxCheck, type SandboxScope } from "../sandbox/local-sandbox.ts";

export interface AppDeps {
  db: DatabaseSync;
  home: string;
  repoRoot: string;
  workflow: Workflow;
  bus: EventBus;
  /** Live config holder: PUT /api/config mutates it in place so the running workflow and source see the change. */
  config: Config;
  /** Concurrency of the running job queue (defaults to config.concurrency when the app is created). */
  queueConcurrency?: number;
  /** The Tailscale address this server is actually listening on (null/omitted = loopback only). */
  remote?: TailscaleAddress | null;
  /** remoteAccess the running listeners were started with (defaults to config.remoteAccess when the app is created). */
  runningRemoteAccess?: Config["remoteAccess"];
  /** Detects the local Tailscale address for the Settings page (injected in tests). */
  detectTailscale?: () => Promise<TailscaleAddress | null>;
  /** Built web UI to serve for non-API paths (packages/web/dist), or null. */
  webDist?: string | null;
  /** Clock for pairing codes and sessions (tests). */
  now?: () => number;
  /** Settings "Detect browsers" (S-2, A-1): the connected Chrome browsers, read by a jira-browser run. Omitted → 501. */
  listBrowsers?: () => Promise<ConnectedBrowser[]>;
  /** phase 4a Task 5: this computer's command sandbox (tests) */
  sandboxBackend?: () => SandboxBackend;
  /** phase 4a Task 5: the self-check GET /api/sandbox runs (default sandboxSelfCheck) */
  sandboxCheck?: (scope: SandboxScope) => Promise<SandboxCheck>;
  /** fake mode (phase 4a Task 7): the in-memory settings that are never saved to config.json */
  fakeOverlay?: FakeOverlay;
  /** phase 4c Task 5: the fetch an OTLP export is sent with (tests inject a fake; default: the global fetch) */
  otlpFetch?: typeof fetch;
  /** phase 4c Task 5: the time limit of one export request (default 30 s) */
  otlpTimeoutMs?: number;
  /**
   * phase 4d Task 5: trial runs — the server's own agent runner (usage gate, policy, file guard, redaction; the fake
   * one in fake mode) and the parent of the scratch copy. Absent: POST /api/prompts/:role/trial answers 409.
   */
  trial?: { run: TrialDeps["run"]; tmpRoot: string };
}

/** service.version of the exported spans: the server package version. */
const SERVICE_VERSION = (() => {
  try {
    return String((JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

const ROLES: readonly AgentRole[] = [
  "jira-browser", "jira-update", "refine-ticket", "propose-solutions",
  "design-solution", "critique-design", "implement-ticket", "acceptance-review", "jira-comment",
];
const NEEDS_YOU = [
  "awaiting_ac_review", "awaiting_drift_ack", "awaiting_choice", "blocked",
  // phase 2: a debate to rule, a changed JIRA ticket to acknowledge, a finished development to accept or change
  "awaiting_debate_ruling", "awaiting_snapshot_ack", "dev_done",
  // phase 3: a drift to acknowledge before acceptance, an acceptance report to decide on
  "awaiting_review_ack", "awaiting_confirmation",
] as const;
const AVAILABILITY_TTL_MS = 60_000;
const PING_MS = 25_000;
const PORT = SERVER_PORT;
const LOCAL_HOSTS = [SERVER_PORT, WEB_DEV_PORT].flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]);
const DETECT_TTL_MS = 30_000;
const MAX_BODY_BYTES = 256 * 1024;
/** Longest developer note / comment text accepted by the phase-3 routes. */
const MAX_TEXT_CHARS = 4000;
/** Reachable without a session from a non-loopback address (everything else under /api needs a paired device). */
const REDEEM_PATH = "/api/pair/redeem";
/** Only callable from this machine, even by a paired device (R21; browser detection: A-1). */
const LOCAL_ONLY = /^\/api\/(pair\/(start|status)|devices|jira\/browsers|tickets\/[^/]+\/development\/accept-hooks)(\/|$)/;
const isApi = (path: string) => path === "/api" || path.startsWith("/api/");
const INLINE_MIME = /^(image\/|application\/pdf$)/;

/** 4B-6 (M1): "field: rule" per issue, a record's key (projects.<key>…) replaced so a supplied key is never echoed. */
function maskedIssues(err: ConfigValidationError): string[] {
  return err.issues.map((i) => {
    const parts = i.field.split(".");
    if (parts[0] === "projects" && parts.length > 1) parts[1] = "<key>";
    return `${parts.join(".")}: ${i.rule}`;
  });
}

const WINDOW_ORDER = { "5h": 0, day: 1, week: 2 } as const;

/** 4C-1 M3: a budget change that lets more consumption through: disabled, a limit raised or cleared, the window or the warning changed upward. */
function loosensBudget(before: Config["budget"], after: Config["budget"]): boolean {
  if (before.enabled && !after.enabled) return true;
  for (const k of ["maxRuns", "maxRunMinutes", "maxUsd"] as const) {
    if (before[k] !== null && (after[k] === null || after[k] > before[k])) return true;
  }
  return WINDOW_ORDER[after.window] !== WINDOW_ORDER[before.window] || after.warnAt > before.warnAt;
}

class BadRequestError extends ValidationError {
  readonly issues?: unknown[];
  constructor(message: string, issues?: unknown[]) {
    super(message);
    this.issues = issues;
  }
}

/** Replace the contents of `target` with `next`, keeping object identity of the config and its `jira` section. */
export function applyConfig(target: Config, next: Config): void {
  Object.assign(target.jira, next.jira);
  Object.assign(target, { ...next, jira: target.jira });
}

function resolvesOnPath(bin: string): boolean {
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequestError("request body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError("invalid request body", parsed.error.issues);
  return parsed.data;
}

function role(raw: string): AgentRole {
  // 4B-3 (M1): the requested name is not echoed
  if (!(ROLES as readonly string[]).includes(raw)) throw new BadRequestError("unknown role");
  return raw as AgentRole;
}

const intParam = (raw: string, what: string): number => {
  if (!/^\d+$/.test(raw)) throw new BadRequestError(`${what} must be an integer`);
  return Number(raw);
};

export function createApp(deps: AppDeps): Hono {
  const { db, home, repoRoot, workflow, bus, config } = deps;
  const app = new Hono();
  const remote = deps.remote ?? null;
  const now = deps.now ?? Date.now;
  const pairing = createPairing(db, now);
  const runningConcurrency = deps.queueConcurrency ?? config.concurrency;
  const runningRemote = canonicalJson(deps.runningRemoteAccess ?? config.remoteAccess);
  const restartRequired = (): boolean => config.concurrency !== runningConcurrency || canonicalJson(config.remoteAccess) !== runningRemote;
  const phoneUrl = remote ? `http://${remote.ip}:${PORT}` : null;

  // Host/Origin allowlists (R15), extended with the Tailscale address and MagicDNS name while remote access is active.
  const allowedHosts = new Set([...LOCAL_HOSTS, ...(remote ? [`${remote.ip}:${PORT}`, ...(remote.dnsName ? [`${remote.dnsName}:${PORT}`] : [])] : [])]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const remoteHosts = new Set([...allowedHosts].filter((h) => !LOCAL_HOSTS.includes(h)));

  // Block DNS rebinding (Host), cross-site writes (Origin) and CSRF-able content types — for the API and the hosted UI.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (!host || !allowedHosts.has(host)) return c.json({ error: "forbidden host" }, 403);
    // R22: a loopback socket addressed by the Tailscale name/IP means a local proxy (e.g. `tailscale serve`) is
    // forwarding tailnet traffic — it would otherwise bypass pairing.
    if (remoteHosts.has(host) && isLocalRequest(c)) return c.json({ error: "proxied tailnet requests are not allowed" }, 403);
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin !== undefined && !allowedOrigins.has(origin)) return c.json({ error: "forbidden origin" }, 403);
      const type = c.req.header("content-type");
      const length = c.req.header("content-length");
      const hasBody = (length !== undefined && length !== "0") || c.req.header("transfer-encoding") !== undefined;
      if ((hasBody || type !== undefined) && !(type ?? "").toLowerCase().startsWith("application/json")) {
        return c.json({ error: "content-type must be application/json" }, 415);
      }
    }
    await next();
  });

  // No API request needs a large body (the biggest is an edited requirement): cap them before anything parses JSON.
  app.use("/api/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request body too large" }, 413) }));

  // Authentication: loopback sockets are trusted; anything else needs a paired device's session cookie. The hosted UI's
  // static files (GET, outside /api) carry no data and stay reachable so a phone can open the pairing page.
  app.use("*", async (c, next) => {
    if (isLocalRequest(c)) return next();
    const path = c.req.path;
    if (LOCAL_ONLY.test(path)) return c.json({ error: "only available on this computer" }, 403);
    if (!isApi(path) && (c.req.method === "GET" || c.req.method === "HEAD")) return next();
    if (path === REDEEM_PATH && c.req.method === "POST") return next();
    if (!pairing.authenticate(sessionToken(c.req.header("cookie")))) return c.json({ error: "pairing required" }, 401);
    return next();
  });
  /** Who made a decision: 'local' on this computer, `device:<id>` for a paired device's session. */
  const decidedBy = (c: Context): string => {
    if (isLocalRequest(c)) return "local";
    const device = pairing.authenticate(sessionToken(c.req.header("cookie")));
    if (!device) throw new Error("unauthenticated request reached a decision route");
    return `device:${device.id}`;
  };
  const localOnly = (c: Context): Response | null => (isLocalRequest(c) ? null : c.json({ error: "only available on this computer" }, 403));

  const mustTicket = (key: string): Ticket => {
    const t = getTicket(db, key);
    if (!t) throw new NotFoundError(`unknown ticket ${key}`);
    return t;
  };

  const driftOf = (key: string) => {
    const d = latestDrift(db, key);
    return d ? { ...d, needsAck: driftNeedsAck(d.result) } : null;
  };

  // phase 4b (Task 2, 4B-2): every error text is redacted with the credentials file as it is now plus every value this
  // process has read or written (a replaced or removed key, or one in a file now refused, stays hidden)
  const redact = (text: string): string => redactStored(home, text);
  const redactIssues = (issues: unknown[] | undefined): unknown[] | undefined => {
    if (issues === undefined) return undefined;
    try {
      return JSON.parse(redact(JSON.stringify(issues))) as unknown[];
    } catch {
      return [];
    }
  };

  app.onError((err, c) => {
    const message = redact(err instanceof Error ? err.message : String(err));
    if (err instanceof InvalidTransitionError) return c.json({ error: message }, 409);
    // 4B-3 (M1): a 404 never echoes the request's path or query (no redaction oracle; nothing to guess against)
    if (err instanceof NotFoundError) return c.json({ error: "not found" }, 404);
    if (err instanceof DeliveryError) return c.json({ error: message }, 409);
    if (err instanceof UsagePausedError) return c.json({ error: message }, 409);
    if (err instanceof JiraNotConfiguredError) return c.json({ error: message }, 409);
    if (err instanceof CredentialFileError) return c.json({ error: message }, 409);
    if (err instanceof BadRequestError) return c.json({ error: message, issues: redactIssues(err.issues) }, 400);
    if (err instanceof ValidationError) return c.json({ error: message }, 400);
    if (err instanceof z.ZodError) return c.json({ error: message, issues: redactIssues(err.issues) }, 400);
    return c.json({ error: message }, 500);
  });

  // ---- status & config ----

  let availability: { bin: string; at: number; available: boolean } | null = null;
  const executorAvailable = (): boolean => {
    const bin = config.executor.claudeBin;
    const now = Date.now();
    if (!availability || availability.bin !== bin || now - availability.at > AVAILABILITY_TTL_MS) {
      availability = { bin, at: now, available: resolvesOnPath(bin) };
    }
    return availability.available;
  };

  /** 4B-11 (4): why the configured executor cannot run, or null (the CLI on PATH; the API key set and readable) */
  const executorUnavailable = (): string | null => {
    if (!executorAvailable()) return `"${config.executor.claudeBin}" was not found on PATH`;
    if (config.executor.kind !== "claude-api") return null;
    try {
      return readCredentials(home).anthropic === null ? "Set your Anthropic API key in Settings → Executor" : null;
    } catch (err) {
      return `The Anthropic API key cannot be read: ${redact((err as Error).message)}`;
    }
  };

  app.get("/api/status", (c) => {
    const reason = executorUnavailable();
    const available = reason === null;
    const marks = NEEDS_YOU.map(() => "?").join(",");
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ticket WHERE state IN (${marks})`).get(...NEEDS_YOU) as { n: number };
    const failedSteps = ticketsWithFailedJiraSteps(db).length;
    const budget = budgetProgress(db, { now: new Date(), executor: config.executor.kind, budget: config.budget, acceptanceRunTimeoutMs: config.acceptance.runTimeoutMs });
    return c.json({
      executor: {
        kind: config.executor.kind,
        label: config.executor.kind === "claude-api" ? "Claude Code (API key)" : "Claude Code (subscription)",
        available,
        ...(reason === null ? {} : { reason }),
      },
      jira: { configured: config.jira.baseUrl !== "", baseUrl: config.jira.baseUrl, source: config.jira.source },
      concurrency: runningConcurrency,
      restartRequired: restartRequired(),
      needsYou: row.n + failedSteps,
      // JIRA writes waiting for "Send to JIRA" are counted on their own (the ticket keeps its state)
      // (abandoned tickets never send anything: F2-I3)
      pendingJiraWrites: (
        db
          .prepare("SELECT COUNT(*) AS n FROM jira_write w JOIN ticket t ON t.key = w.ticket_key WHERE w.state = 'pending' AND t.state <> 'abandoned'")
          .get() as { n: number }
      ).n,
      usage: {
        paused: currentPause(db),
        budgetState: budget?.state ?? null,
        budgetRatio: budget?.ratio ?? null,
        budgetWindow: budget?.window ?? null,
        // tickets the usage gate stopped: blocked with a "Paused:" reason (they need Retry after a resume)
        waitingTickets: (db.prepare("SELECT COUNT(*) AS n FROM ticket WHERE state = 'blocked' AND blocked_reason LIKE 'Paused:%'").get() as { n: number }).n,
      },
      local: isLocalRequest(c),
      remoteAccess: { active: remote !== null, url: phoneUrl },
    });
  });

  // phase 4c: consumption by ticket, role and day — read only, any paired device
  app.get("/api/usage", (c) => {
    const window = c.req.query("window") ?? "5h";
    if (!(USAGE_WINDOWS as readonly string[]).includes(window)) throw new BadRequestError("window must be 5h, day, week or 30d");
    return c.json(usageSummary(db, { window: window as UsageWindow, now: new Date(), executor: config.executor.kind, budget: config.budget, paused: currentPause(db), acceptanceRunTimeoutMs: config.acceptance.runTimeoutMs }));
  });

  // pausing or resuming only changes the developer's own consumption: any paired device may (decidedBy is the request's)
  app.post("/api/usage/pause", async (c) => {
    let note = "";
    try {
      const body = (await c.req.json()) as { note?: unknown };
      if (typeof body?.note === "string") note = body.note.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, 200);
    } catch {
      // no body: no note
    }
    return c.json({ paused: pauseUsage(db, "manual", note === "" ? "paused by hand" : note, decidedBy(c), bus) });
  });
  app.post("/api/usage/resume", (c) => {
    // 4C-1 M3, F4C-1 M-4: with the API key a phone may resume a manual or a usage-limit pause, but a threshold pause (the
    // developer's own spending limit) only on this computer; on the subscription a phone may resume any pause
    if (config.executor.kind === "claude-api" && !isLocalRequest(c) && currentPause(db)?.reason === "threshold") {
      return c.json({ error: "with the API key, a threshold pause can only be resumed on this computer" }, 403);
    }
    resumeUsage(db, decidedBy(c), bus);
    return c.json({ paused: null });
  });

  app.get("/api/config", (c) => c.json(config));

  // phase 4a Task 5: the command sandbox's state for Settings (read only; a paired phone may read it). The self-check
  // runs on a scratch dev-command scope in the configured local-network mode, at most once a minute; concurrent
  // requests share the one in flight (4A-15 M-2). A paired phone gets a coarse status and a fixed text, never the
  // check's detail (paths, stderr; 4A-15 M-1).
  const SANDBOX_CHECK_TTL_MS = 60_000;
  let sandboxChecked: { at: number; result: Promise<SandboxCheck> } | null = null;
  const COARSE = { ok: "The sandbox self-check passed.", failed: "The sandbox self-check failed. Open Settings on this computer for details." } as const;
  app.get("/api/sandbox", async (c) => {
    const backend = (deps.sandboxBackend ?? sandboxBackendDefault)();
    const local = isLocalRequest(c);
    let selfCheck: { ok: boolean; status: "ok" | "failed"; detail: string; at: string } | null = null;
    if (backend.available) {
      const t = now();
      if (sandboxChecked === null || t - sandboxChecked.at > SANDBOX_CHECK_TTL_MS) {
        // 4A-15 (M-5): the scope's own dirs: <home>/sandbox/status-check (its "ticket dir", allowed and listed by the
        // check) and <home>/cache/status-check (its ticket cache and TMPDIR); never a ticket key, so never a ticket's
        const allowInHome = join(home, "sandbox", "status-check");
        sandboxChecked = { at: t, result: (async (): Promise<SandboxCheck> => {
        try {
          mkdirSync(allowInHome, { recursive: true, mode: 0o700 });
          const scope: SandboxScope = {
            kind: "dev-command", home, allowInHome, repos: [],
            ...(config.development.deniedLocalPorts.length > 0 ? { extraPorts: config.development.deniedLocalPorts } : {}),
            ...localNetworkFor(config.development.localNetwork, []),
            ...(deps.remote ? { remoteHosts: [deps.remote.ip] } : {}),
          };
          return await (deps.sandboxCheck ?? sandboxSelfCheck)(scope);
        } catch (err) {
          return { ok: false, detail: `sandbox self-check could not start: ${(err as Error).message}` };
        }
        })() };
      }
      const at = sandboxChecked.at;
      const result = await sandboxChecked.result;
      const status = result.ok ? "ok" : "failed";
      selfCheck = { ok: result.ok, status, detail: local ? result.detail : COARSE[status], at: new Date(at).toISOString() };
    }
    const d = config.development;
    return c.json({
      backend, status: backend.available ? (selfCheck?.ok === false ? "failed" : "ok") : "unavailable", selfCheck,
      switches: { allowUnsandboxedCommands: d.allowUnsandboxedCommands, allowUnsandboxedHooks: d.allowUnsandboxedHooks, localNetwork: d.localNetwork },
    });
  });

  app.put("/api/config", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new BadRequestError("request body is not valid JSON");
    }
    // R21: what runs on this machine, on which repositories, against which JIRA, and who can reach it —
    // only changed from this machine
    // F-I2: the ready-for-dev status (Tickets-list default filter) and the discovery limit (inserted into the browser
    // agent's prompt) are loopback-only too
    // 4B-6 (M1): checked on the raw body first, so a phone's request is refused before validation could echo anything
    // it sent (a guessed project key)
    const sensitiveFields = (cfg: unknown): Record<string, unknown> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the raw body has any shape
      const x = cfg as any;
      return {
        remoteAccess: x?.remoteAccess, executor: x?.executor, projects: x?.projects, jiraBaseUrl: x?.jira?.baseUrl,
        readyForDevStatus: x?.jira?.readyForDevStatus, discoverLimit: x?.jira?.discoverLimit,
        // phase 2: whether and to what JIRA is written, and which Chrome browser the JIRA agents drive (S-2);
        // debate / development limits stay phone-editable (P-phone)
        syncStatus: x?.jira?.syncStatus, inProgressStatus: x?.jira?.inProgressStatus, browser: x?.jira?.browser,
        // phase 3: which status delivery writes, which gh pushes PRs, the acceptance agent's config folder and the
        // command-sandbox opt-out (R-LOCAL); review.maxAttempts and the acceptance timeouts stay phone-editable
        reviewStatus: x?.jira?.reviewStatus, ghBin: x?.delivery?.ghBin, azBin: x?.delivery?.azBin, acceptConfigDir: x?.acceptance?.claudeConfigDir,
        allowUnsandboxedCommands: x?.development?.allowUnsandboxedCommands, deniedLocalPorts: x?.development?.deniedLocalPorts,
        // phase 4a (A-3): the git-hooks sandbox opt-out
        allowUnsandboxedHooks: x?.development?.allowUnsandboxedHooks,
        // phase 4a Task 4: the local-network mode of the command sandbox
        localNetwork: x?.development?.localNetwork,
        // phase 4b: the JIRA mode (browser or REST API); the executor kind is inside executor above
        jiraSource: x?.jira?.source,
        // phase 4c (C-8): where agent runs are exported to, and whether prompts and outputs go too
        telemetry: x?.telemetry,
      };
    };
    const sensitive = (cfg: unknown) => canonicalJson(sensitiveFields(cfg));
    // the raw body: every sensitive field it carries must equal the current value (a missing one takes its default,
    // which the check after validation compares)
    const rawChanges = (body: unknown): boolean => {
      const now = sensitiveFields(config);
      return Object.entries(sensitiveFields(body)).some(([k, v]) => v !== undefined && canonicalJson(v) !== canonicalJson(now[k]));
    };
    const localOnlyFields = () =>
      c.json({ error: "remote access, executor, repositories, the JIRA URL, the JIRA mode, statuses, status sync, the JIRA browser, the discovery limit, the GitHub CLI, the acceptance config folder, the sandbox switch and run tracing can only be changed on this computer" }, 403);
    if (!isLocalRequest(c) && rawChanges(raw)) return localOnlyFields();
    let next: Config;
    try {
      next = parseConfig(raw);
    } catch (err) {
      // 4B-6 (M1): field paths with record keys masked (projects.<key>…), never a key the request supplied
      if (err instanceof ConfigValidationError) throw new BadRequestError(`Invalid config: ${maskedIssues(err).join("; ")}`);
      throw err;
    }
    if (!isLocalRequest(c) && sensitive(next) !== sensitive(config)) return localOnlyFields();
    // 4C-1 M3: with the API key (real money) a phone may tighten the budget but not loosen it; on the subscription it may do both
    if (!isLocalRequest(c) && config.executor.kind === "claude-api" && loosensBudget(config.budget, next.budget)) {
      return c.json({ error: "with the API key, raising or clearing a limit or turning the budget off can only be done on this computer" }, 403);
    }
    // F4C-1 (M-3): more agents at once is more runs in the same time: with the API key, raising it is loosening too
    if (!isLocalRequest(c) && config.executor.kind === "claude-api" && next.concurrency > config.concurrency) {
      return c.json({ error: "with the API key, raising concurrency can only be done on this computer" }, 403);
    }
    const before = structuredClone(config);
    // phase 4a Task 7: fake mode's overlay stays in memory — saved is what is on disk plus what this request changed
    saveConfig(home, deps.fakeOverlay ? withoutFakeOverlay(next, loadConfig(home), deps.fakeOverlay) : next);
    applyConfig(config, loadConfig(home));
    if (deps.fakeOverlay) applyFakeOverlay(config, deps.fakeOverlay);
    // H6: which fields changed, never their values (paths, URLs and hosts stay out of the log)
    const changed = changedConfigPaths(before, config);
    if (changed.length > 0) appendAudit(db, { actor: "developer", type: "config_changed", payload: { changed } });
    // 4C-1: every budget change from any client, with who made it (paths only, never values)
    const budgetChanged = changed.filter((p) => p.startsWith("budget."));
    if (budgetChanged.length > 0) appendAudit(db, { actor: "developer", type: "budget_changed", payload: { changed: budgetChanged, decidedBy: decidedBy(c) } });
    availability = null;
    return c.json({ config, restartRequired: restartRequired() });
  });

  // ---- phase 4b Task 2: credentials (X-4, B-9) — status for any device, set / remove on this computer only ----

  app.get("/api/credentials", (c) => c.json(credentialStatus(readCredentials(home), isLocalRequest(c))));

  /** The request body checked by a credential rule; the 400 names fields and rules only, never a value. */
  const credentialBody = async <T>(c: Context, check: (input: unknown) => Validated<T>): Promise<T> => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new BadRequestError("request body is not valid JSON");
    }
    const r = check(raw);
    if (!r.ok) throw new BadRequestError(`invalid credential: ${r.issues.map((i: InputIssue) => `${i.field}: ${i.rule}`).join("; ")}`, r.issues);
    return r.value;
  };
  const changeCredential = (which: CredentialKind, value: Credentials[CredentialKind]): void => {
    const current = readCredentials(home);
    if (value === null && current[which] === null) return;
    writeCredentials(home, { ...current, [which]: value });
    // the kind and the action only, never a value
    appendAudit(db, { actor: "developer", type: "credentials_changed", payload: { which, action: value === null ? "removed" : "set" } });
  };
  const credentialsResponse = (c: Context) => c.json(credentialStatus(readCredentials(home), isLocalRequest(c)));

  app.put("/api/credentials/jira", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const { email, apiToken } = await credentialBody(c, validateJiraInput);
    changeCredential("jira", { email, apiToken, updatedAt: new Date(now()).toISOString() });
    return credentialsResponse(c);
  });

  app.put("/api/credentials/anthropic", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const { apiKey } = await credentialBody(c, validateAnthropicInput);
    changeCredential("anthropic", { apiKey, updatedAt: new Date(now()).toISOString() });
    return credentialsResponse(c);
  });

  app.put("/api/credentials/otlp-headers", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const { headers } = await credentialBody(c, validateOtlpHeadersInput);
    changeCredential("otlpHeaders", { headers, updatedAt: new Date(now()).toISOString() });
    return credentialsResponse(c);
  });

  const CREDENTIAL_PATHS: Record<string, CredentialKind> = { jira: "jira", anthropic: "anthropic", "otlp-headers": "otlpHeaders" };
  app.delete("/api/credentials/:which", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const which = Object.hasOwn(CREDENTIAL_PATHS, c.req.param("which")) ? CREDENTIAL_PATHS[c.req.param("which")] : undefined;
    if (which === undefined) throw new NotFoundError("unknown credential");
    changeCredential(which, null);
    return credentialsResponse(c);
  });

  // ---- phase 4c Task 5: run tracing (C-7, X-7) — no background export; each export is one confirmation of exactly
  // the runs its preview listed (the hash binds them, the endpoint and the content switch). Any paired device may
  // preview and confirm (like a delivery); the endpoint, the content switch and the headers are set on this computer.

  const otlpFetch = deps.otlpFetch ?? fetch;
  let exporting = false;

  app.get("/api/telemetry/preview", (c) => c.json(previewExport(db, config)));

  app.post("/api/telemetry/export", async (c) => {
    const { runIdsHash } = await body(c, z.object({ runIdsHash: z.string().regex(/^[0-9a-f]{64}$/, "must be the preview's hash") }));
    const by = decidedBy(c);
    const { endpoint, includeContent } = config.telemetry;
    if (endpoint === "") return c.json({ error: "run tracing is off: set an OTLP endpoint in Settings → Run tracing on this computer" }, 409);
    // validated when the config is loaded or saved; checked again before anything leaves this computer
    if (otlpEndpointIssue(endpoint) !== null) return c.json({ error: "the OTLP endpoint is not allowed: fix it in Settings → Run tracing" }, 409);
    if (exporting || exportRunning(db)) return c.json({ error: "an export is already being sent" }, 409);
    const runs = exportableRuns(db, { limit: MAX_EXPORT_RUNS });
    const runIds = runs.map((r) => r.id);
    // 4C-2 (NR3): a preview is used up by its export, whatever the outcome (a stale tab or a second device must preview again)
    if (hashUsed(db, runIdsHash) || exportHash(runIds, endpoint, includeContent, lastExportId(db)) !== runIdsHash) {
      return c.json({ error: "the runs to export changed — preview again" }, 409);
    }
    if (runs.length === 0) return c.json({ error: "there are no runs to export" }, 409);
    exporting = true;
    try {
      // the auth headers come only from credentials.json; an unreadable file refuses the export (409), it never sends without
      const headers = readCredentials(home).otlpHeaders?.headers ?? {};
      // 4C-2 (M-2): a hand-edited credentials.json is checked like a PUT; nothing is sent with a forbidden header
      const headerIssue = otlpHeadersIssue(headers);
      if (headerIssue !== null) return c.json({ error: `the stored OTLP headers cannot be sent (${headerIssue}): replace them in Settings → Run tracing` }, 409);
      const payload = await buildOtlpPayload(runs, { includeContent, readRawLog: rawLogReader(home), serviceVersion: SERVICE_VERSION, redact: redactorFor(home) });
      const host = endpointHost(endpoint);
      const id = startExport(db, { endpointHost: host, runIds, hash: runIdsHash, includeContent, spanCount: runs.length, decidedBy: by });
      let result: SendResult;
      try {
        result = await sendOtlp(endpoint, headers, payload, { fetch: otlpFetch, ...(deps.otlpTimeoutMs ? { timeoutMs: deps.otlpTimeoutMs } : {}) });
      } catch {
        result = { ok: false, httpStatus: null, detail: "could not reach the collector" };
      }
      // 4C-2 (I-1): a fixed text per class, never the collector's answer (redacted anyway, as a second line of defence)
      let detail = result.detail === null ? null : redact(result.detail).slice(0, MAX_DETAIL_CHARS);
      let status: "done" | "failed" = result.ok ? "done" : "failed";
      try {
        finishExport(db, id, { status, httpStatus: result.httpStatus, detail, runIds });
      } catch (err) {
        // 4C-2 (M-4): never left running (it would block every later export): closed as failed, runs not marked
        logError(`Run tracing: the outcome of export ${id} could not be recorded: ${redact(err instanceof Error ? err.message : String(err))}`);
        status = "failed";
        detail = `${result.ok ? "sent, but " : ""}the outcome could not be recorded; preview and export again`;
        finishExport(db, id, { status, httpStatus: result.httpStatus, detail, runIds: [] });
      }
      appendAudit(db, {
        actor: "developer", type: "telemetry_exported",
        payload: { exportId: id, endpointHost: host, runCount: runs.length, includeContent, status, httpStatus: result.httpStatus, decidedBy: by },
      });
      bus.emit({ type: "usage_changed" });
      const record = getExport(db, id);
      if (status === "failed") return c.json({ error: `Export failed: ${detail ?? "unknown error"}`, export: record }, 502);
      return c.json({ export: record });
    } finally {
      exporting = false;
    }
  });

  // ---- remote access & pairing ----

  const detect = deps.detectTailscale ?? (() => detectTailscaleDefault());
  let detected: { at: number; value: TailscaleAddress | null } | null = null;
  const detectCached = async (): Promise<TailscaleAddress | null> => {
    const t = now();
    if (!detected || t - detected.at > DETECT_TTL_MS) detected = { at: t, value: await detect().catch(() => null) };
    return detected.value;
  };

  app.get("/api/remote", async (c) =>
    c.json({
      local: isLocalRequest(c),
      active: remote && { ip: remote.ip, dnsName: remote.dnsName, url: phoneUrl },
      detected: await detectCached(),
      restartRequired: canonicalJson(config.remoteAccess) !== runningRemote,
    }),
  );

  app.post("/api/pair/start", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    if (!remote) return c.json({ error: "remote access is not active: turn it on and restart Slack Off" }, 409);
    const { code, expiresAt } = pairing.start();
    return c.json({ code, url: `${phoneUrl}/pair?code=${code}`, expiresAt });
  });

  app.post(REDEEM_PATH, async (c) => {
    const { code, deviceName } = await body(
      c,
      z.object({
        code: z.string().max(32).transform((v) => v.replace(/[\s-]/g, "")),
        deviceName: z.string().transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, "").trim()).pipe(z.string().min(1, "device name is required").max(64)),
      }),
    );
    const r = pairing.redeem(code, deviceName);
    if (!r.ok) {
      return r.reason === "locked"
        ? c.json({ error: "too many wrong codes: start a new pairing on your computer" }, 429)
        : c.json({ error: "invalid or expired pairing code" }, 400);
    }
    c.header("set-cookie", sessionCookie(r.token));
    c.header("cache-control", "no-store");
    return c.json({ device: r.device });
  });

  app.get("/api/pair/status", (c) => localOnly(c) ?? c.json(pairing.status()));

  app.get("/api/devices", (c) => localOnly(c) ?? c.json(pairing.listDevices()));

  app.delete("/api/devices/:id", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    if (!pairing.revoke(intParam(c.req.param("id"), "device id"))) throw new NotFoundError(`unknown device ${c.req.param("id")}`);
    return c.json({ revoked: true });
  });

  // ---- tickets ----

  app.get("/api/tickets", (c) => {
    const pendingWrites = new Set(
      (
        db
          .prepare("SELECT DISTINCT w.ticket_key FROM jira_write w JOIN ticket t ON t.key = w.ticket_key WHERE w.state = 'pending' AND t.state <> 'abandoned'")
          .all() as Array<{ ticket_key: string }>
      ).map((r) => r.ticket_key),
    );
    const failedSteps = new Set(ticketsWithFailedJiraSteps(db));
    return c.json(
      listTickets(db).map((t) => {
        const d = latestDrift(db, t.key);
        return {
          key: t.key,
          title: t.title,
          url: t.url,
          jiraStatus: t.jiraStatus,
          jiraOpen: t.jiraOpen,
          state: t.state,
          // the state before `blocked` (null otherwise): the list opens a blocked ticket where it stopped
          prevState: t.prevState,
          blockedReason: t.blockedReason,
          reviewAc: t.reviewAc,
          driftNeedsAction: d !== null && driftNeedsAck(d.result) && !d.acknowledged,
          // F2-I2: a JIRA write waits for "Send to JIRA" (shown on the row and under Needs me)
          jiraWritePending: pendingWrites.has(t.key),
          // R11: a delivery JIRA step failed and waits for a retry
          deliveryStepFailed: failedSteps.has(t.key),
          updatedAt: t.updatedAt,
        };
      }),
    );
  });

  /** The last successful discovery (returned of total open tickets, complete or not), for the Tickets list. */
  app.get("/api/discovery", (c) => c.json({ lastRun: lastDiscoveryRun(db) }));

  app.get("/api/tickets/:key", (c) => {
    const key = c.req.param("key");
    const ticket = mustTicket(key);
    // the current choice with its locked affected repos (Task 3 carry)
    const choice = currentChoice(db, key);
    return c.json({
      ticket,
      requirement: latestRequirement(db, key),
      solutions: listSolutions(db, key),
      choice,
      drift: driftOf(key),
    });
  });

  app.get("/api/tickets/:key/requirements", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    const rows = db.prepare("SELECT id FROM requirement WHERE ticket_key = ? ORDER BY version").all(key) as Array<{ id: number }>;
    return c.json(rows.map((r) => getRequirement(db, r.id)));
  });

  app.get("/api/tickets/:key/drift", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    const rows = db.prepare("SELECT * FROM drift_check WHERE ticket_key = ? ORDER BY id DESC").all(key) as Array<Record<string, unknown>>;
    return c.json(
      rows.map((d) => {
        const result = JSON.parse(d.result_json as string);
        return {
          id: d.id, ticketKey: d.ticket_key, requirementId: d.requirement_id, baselineSnapshotId: d.baseline_snapshot_id,
          latestSnapshotId: d.latest_snapshot_id, trigger: d.trigger, result, needsAck: driftNeedsAck(result),
          acknowledged: d.acknowledged === 1, createdAt: d.created_at,
        };
      }),
    );
  });

  app.get("/api/tickets/:key/snapshots", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    return c.json(listSnapshots(db, key));
  });

  const snapshotOf = (key: string, rawId: string) => {
    mustTicket(key);
    const s = getSnapshot(db, intParam(rawId, "snapshot id"));
    if (!s || s.ticketKey !== key) throw new NotFoundError(`unknown snapshot ${rawId} for ${key}`);
    return s;
  };

  app.get("/api/tickets/:key/snapshots/:id", (c) => c.json(snapshotOf(c.req.param("key"), c.req.param("id"))));

  app.get("/api/tickets/:key/snapshots/:id/attachments/:aid", (c) => {
    const s = snapshotOf(c.req.param("key"), c.req.param("id"));
    const aid = intParam(c.req.param("aid"), "attachment id");
    const a = s.attachments.find((x) => x.id === aid);
    if (!a) throw new NotFoundError(`unknown attachment ${aid}`);
    if (!a.localPath || !existsSync(a.localPath)) return c.json({ error: "metadata only", url: a.url }, 404);
    const stream = Readable.toWeb(createReadStream(a.localPath)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "content-type": a.mime || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "content-disposition": `${INLINE_MIME.test(a.mime ?? "") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename ?? "attachment")}`,
      },
    });
  });

  // ---- actions ----

  app.post("/api/discover", (c) => {
    if (config.jira.baseUrl === "") throw new JiraNotConfiguredError();
    workflow.discover();
    return c.json({ accepted: true }, 202);
  });

  app.post("/api/tickets/:key/refine", (c) => {
    workflow.refine(c.req.param("key"), decidedBy(c));
    return c.json({ accepted: true }, 202);
  });

  // the base branch per ticket and repo (develop for a feature, a release branch for a fix), until its ticket branch exists
  // the ticket branch's conventional type (feat/, fix/, docs/…), until the branch exists
  app.get("/api/tickets/:key/dev-question", (c) => c.json({ question: workflow.devQuestion(c.req.param("key")) }));
  // an untouched ticket branch (no commits, clean worktrees) is removed so the next development names it afresh
  app.post("/api/tickets/:key/reset-branch", async (c) => {
    const key = c.req.param("key");
    await workflow.resetBranch(key, decidedBy(c));
    return c.json(workflow.branchType(key));
  });
  app.get("/api/tickets/:key/branch-type", (c) => c.json(workflow.branchType(c.req.param("key"))));
  app.put("/api/tickets/:key/branch-type", async (c) => {
    const key = c.req.param("key");
    const { type } = await body(c, z.object({ type: z.string().max(20).nullable() }));
    workflow.setBranchType(key, type as never, decidedBy(c));
    return c.json(workflow.branchType(key));
  });
  app.get("/api/tickets/:key/base-branches", async (c) => c.json({ repos: await workflow.baseBranches(c.req.param("key")) }));
  app.put("/api/tickets/:key/base-branches/:repo", async (c) => {
    const key = c.req.param("key");
    const { branch } = await body(c, z.object({ branch: z.string().min(1).max(200).nullable() }));
    await workflow.setBaseBranch(key, c.req.param("repo"), branch, decidedBy(c));
    return c.json({ repos: await workflow.baseBranches(key) });
  });

  // a ticket read from JIRA (read-only) into a snapshot, without refining or any other step; failures arrive as source_error
  app.post("/api/tickets/:key/read-jira", (c) => {
    workflow.readSnapshot(c.req.param("key"));
    return c.json({ accepted: true }, 202);
  });

  app.patch("/api/tickets/:key", async (c) => {
    const key = c.req.param("key");
    const { reviewAc } = await body(c, z.object({ reviewAc: z.boolean() }));
    setReviewAc(db, key, reviewAc, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.put("/api/tickets/:key/requirement", async (c) => {
    const key = c.req.param("key");
    const r = await body(c, Requirement);
    workflow.editRequirement(key, r, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.post("/api/tickets/:key/confirm-requirement", (c) => {
    const key = c.req.param("key");
    workflow.confirmRequirement(key, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.post("/api/tickets/:key/drift/ack", async (c) => {
    const key = c.req.param("key");
    const { note } = await body(c, z.object({ note: z.string().trim().min(1, "note is required") }));
    // a paired phone may acknowledge (R16); the audit names the device. Never taken from the body.
    workflow.acknowledgeDrift(key, note, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.post("/api/tickets/:key/back-to-editing", (c) => {
    const key = c.req.param("key");
    workflow.backToEditing(key, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.post("/api/tickets/:key/choose", async (c) => {
    const key = c.req.param("key");
    const { solutionId, note, affectedRepos, skipDebate } = await body(
      c,
      z.object({ solutionId: z.number().int(), note: z.string().default(""), affectedRepos: z.array(z.string()).optional(), skipDebate: z.boolean().default(false) }),
    );
    // a paired phone may decide (R16); the audit names the device. Never taken from the body.
    workflow.choose(key, solutionId, note, affectedRepos, decidedBy(c), skipDebate);
    return c.json(mustTicket(key));
  });

  app.post("/api/tickets/:key/retry", async (c) => {
    const key = c.req.param("key");
    // an optional answer for the developer agent; no body (or an empty one) is a plain Retry
    let note: string | undefined;
    const text = await c.req.text();
    if (text.trim() !== "") {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new BadRequestError("request body is not valid JSON");
      }
      const parsed = z.object({ note: z.string().max(2000).optional() }).safeParse(raw);
      if (!parsed.success) throw new BadRequestError("note must be text of at most 2000 characters");
      note = parsed.data.note;
    }
    workflow.retry(key, decidedBy(c), note);
    return c.json(mustTicket(key));
  });

  // ---- phase 2: design debate ----

  app.get("/api/tickets/:key/design", async (c) => c.json(await designView(db, config, mustTicket(c.req.param("key")))));

  app.get("/api/tickets/:key/design/docs/:version", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    return c.json(designDoc(db, key, intParam(c.req.param("version"), "version")));
  });

  app.post("/api/tickets/:key/debate/rulings", async (c) => {
    const key = c.req.param("key");
    const { rulings } = await body(c, z.object({ rulings: z.array(Ruling) }));
    workflow.ruleDebate(key, rulings, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.post("/api/tickets/:key/rechoose", (c) => {
    const key = c.req.param("key");
    workflow.rechoose(key, decidedBy(c));
    return c.json(mustTicket(key));
  });

  // ---- phase 2: the JIRA ticket changed before development ----

  app.post("/api/tickets/:key/snapshot-ack", async (c) => {
    const key = c.req.param("key");
    const { note } = await body(c, z.object({ note: z.string().trim().min(1, "note is required") }));
    workflow.ackSnapshot(key, note, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.post("/api/tickets/:key/replan", (c) => {
    const key = c.req.param("key");
    workflow.replan(key, decidedBy(c));
    return c.json(mustTicket(key));
  });

  // ---- phase 2: development ----

  const handOffOf = createHandOffCache(db, home);
  app.get("/api/tickets/:key/development", async (c) => {
    const t = mustTicket(c.req.param("key"));
    return c.json({ ...(await developmentView(db, home, config, t)), handOff: await handOffOf(t) });
  });

  app.get("/api/tickets/:key/diff", async (c) => {
    const t = mustTicket(c.req.param("key"));
    const repo = c.req.query("repo");
    if (!repo) throw new BadRequestError("repo is required");
    const { text, truncated } = await repoDiff(db, home, config, t, repo);
    return new Response(text, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        ...(truncated ? { "x-truncated": "1" } : {}),
      },
    });
  });

  app.post("/api/tickets/:key/development/request-changes", async (c) => {
    const key = c.req.param("key");
    const { note } = await body(c, z.object({ note: z.string().trim().min(1, "note is required") }));
    workflow.requestChanges(key, note, decidedBy(c));
    return c.json(mustTicket(key));
  });

  // F2-R1: trusting new git hooks changes what runs on commit — this computer only (R21); decidedBy from the request
  app.post("/api/tickets/:key/development/accept-hooks", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const key = c.req.param("key");
    const { repo } = await body(c, z.object({ repo: z.string().trim().min(1, "repo is required") }));
    await workflow.acceptHooks(key, repo, decidedBy(c));
    return c.json(mustTicket(key));
  });

  // ---- phase 2: JIRA write decisions (a paired phone may decide; the audit names the device) ----

  const jiraWriteAction = (action: "confirm" | "skip" | "retry") =>
    app.post(`/api/tickets/:key/jira-writes/:id/${action}`, (c) => {
      const key = c.req.param("key");
      mustTicket(key);
      const id = intParam(c.req.param("id"), "JIRA write id");
      const by = decidedBy(c);
      if (action === "confirm") workflow.confirmJiraWrite(key, id, by);
      else if (action === "skip") workflow.skipJiraWrite(key, id, by);
      else workflow.retryJiraWrite(key, id, by);
      return c.json({ jiraWrites: listJiraWrites(db, key) });
    });
  jiraWriteAction("confirm");
  jiraWriteAction("skip");
  jiraWriteAction("retry");

  // ---- phase 3: acceptance review (a paired phone may decide; decidedBy is the server's, never the body's) ----

  const noteBody = (c: Context) => body(c, z.object({ note: z.string().trim().min(1, "note is required").max(MAX_TEXT_CHARS) }));

  app.post("/api/tickets/:key/review/handoff", async (c) => {
    const key = c.req.param("key");
    const t = mustTicket(key);
    if (t.state !== "dev_done") throw new InvalidTransitionError(`${key} is ${t.state}: only a finished development (dev_done) is handed over`);
    // the cached "can hand over" is for display; the route looks again (worktree changes between requests)
    const now = await handOffState(db, home, t);
    if (!now.enabled) throw new InvalidTransitionError(now.reason ?? "cannot hand over");
    workflow.handOff(key, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.get("/api/tickets/:key/review", (c) => c.json(reviewView(db, config, mustTicket(c.req.param("key")))));

  app.get("/api/tickets/:key/review/reports/:id", (c) => c.json(reportView(db, mustTicket(c.req.param("key")), intParam(c.req.param("id"), "report id"))));

  app.get("/api/tickets/:key/review/evidence/:evidenceId", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    const { data, contentType } = evidenceFile(db, home, key, intParam(c.req.param("evidenceId"), "evidence id"));
    return new Response(data, {
      headers: {
        "content-type": contentType,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
        "cache-control": "private",
      },
    });
  });

  const reviewAction = (path: "ack" | "reject" | "re-review") =>
    app.post(`/api/tickets/:key/review/${path}`, async (c) => {
      const key = c.req.param("key");
      mustTicket(key);
      const { note } = await noteBody(c);
      const by = decidedBy(c);
      if (path === "ack") workflow.ackReview(key, note, by);
      else if (path === "reject") workflow.rejectReview(key, note, by);
      else workflow.reReview(key, note, by);
      return c.json(mustTicket(key));
    });
  reviewAction("ack");
  reviewAction("reject");
  reviewAction("re-review");

  // ---- phase 3: delivery (the plan hash binds what the developer saw; nothing is sent without "Confirm and deliver") ----

  app.get("/api/tickets/:key/delivery/preview", async (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    return c.json(await workflow.previewDelivery(key));
  });

  app.post("/api/tickets/:key/delivery/confirm", async (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    const { planHash, ackNote } = await body(c, z.object({ planHash: z.string().min(1).max(64), ackNote: z.string().trim().max(MAX_TEXT_CHARS).optional() }));
    await workflow.confirmDelivery(key, planHash, ackNote ? ackNote : null, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.post("/api/tickets/:key/delivery/preview-again", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    workflow.previewAgain(key, decidedBy(c));
    return c.json(mustTicket(key));
  });

  app.get("/api/tickets/:key/delivery", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    const deliveries = listDeliveries(db, key);
    // the opened pull requests: a repo's newest done `pr` step
    const prs = new Map<string, { repo: string; number: number; url: string }>();
    for (const d of deliveries) {
      for (const s of d.steps) {
        const r = s.result as { number?: unknown; url?: unknown } | null;
        if (s.kind === "pr" && s.state === "done" && s.repo !== null && typeof r?.number === "number" && typeof r.url === "string") {
          prs.set(s.repo, { repo: s.repo, number: r.number, url: r.url });
        }
      }
    }
    return c.json({ deliveries, prs: [...prs.values()] });
  });

  app.post("/api/tickets/:key/delivery/steps/:id/retry", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    workflow.retryDeliveryStep(key, intParam(c.req.param("id"), "delivery step id"), decidedBy(c));
    return c.json({ deliveries: listDeliveries(db, key) });
  });

  // ---- phase 3: JIRA comments (clarification questions) ----

  app.get("/api/tickets/:key/jira-comments", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    return c.json(listComments(db, key));
  });

  app.post("/api/tickets/:key/jira-comments", async (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    const { text } = await body(c, z.object({ text: z.string().trim().min(1, "text is required").max(MAX_TEXT_CHARS) }));
    return c.json(workflow.sendClarification(key, text, decidedBy(c)), 202);
  });

  app.post("/api/tickets/:key/jira-comments/:id/retry", (c) => {
    const key = c.req.param("key");
    mustTicket(key);
    return c.json(workflow.retryComment(key, intParam(c.req.param("id"), "comment id"), decidedBy(c)), 202);
  });

  // ---- phase 2: Chrome browser detection (S-2, A-1: this computer only) ----

  app.post("/api/jira/browsers/detect", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    // phase 4b Task 5: the JIRA API mode never drives Chrome
    if (config.jira.source === "api") return c.json({ error: "the JIRA API mode does not use Chrome" }, 409);
    if (!deps.listBrowsers) return c.json({ error: "browser detection is not available" }, 501);
    try {
      return c.json({ browsers: await deps.listBrowsers() });
    } catch (err) {
      return c.json({ error: redact(`Could not list the connected Chrome browsers: ${err instanceof Error ? err.message : String(err)}`) }, 502);
    }
  });

  app.post("/api/tickets/:key/abandon", (c) => {
    const key = c.req.param("key");
    workflow.abandon(key, decidedBy(c));
    return c.json(mustTicket(key));
  });

  // ---- prompts ----

  app.get("/api/prompts/:role", (c) => {
    const r = role(c.req.param("role"));
    let skill;
    try {
      skill = loadSkill(repoRoot, r);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundError(`no skill for role ${r}`);
      throw err;
    }
    const cur = currentPrompt(db, r);
    return c.json({ role: r, skill: { name: skill.name, version: skill.version }, current: cur ? { version: cur.version, text: cur.text } : null });
  });

  // F-I2 (R21): prompts steer what the agents do on this machine, so only this computer may change them
  app.put("/api/prompts/:role", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const r = role(c.req.param("role"));
    const { text } = await body(c, z.object({ text: z.string() }));
    // phase 4d: the same limit as a trial draft (never echoed)
    if (text.length > PROMPT_TEXT_MAX) throw new ValidationError(`the prompt is longer than ${PROMPT_TEXT_MAX} characters`);
    return c.json(savePrompt(db, r, text));
  });

  // phase 4d (D-6): the built-in instructions (skill body and version), read-only on any device
  app.get("/api/prompts/:role/default", (c) => {
    const raw = c.req.param("role");
    // 4B-3: an unknown role is a plain 404, never echoed
    if (!(ROLES as readonly string[]).includes(raw)) throw new NotFoundError("unknown role");
    let skill;
    try {
      skill = loadSkill(repoRoot, raw as AgentRole);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundError("no skill for this role");
      throw err;
    }
    return c.json({ name: skill.name, version: skill.version, body: skill.body });
  });

  app.get("/api/prompts/:role/versions", (c) => c.json(listPromptVersions(db, role(c.req.param("role")))));

  // phase 4d Task 5 (D-7, D-8): try the editor's unsaved draft on the sample ticket. This computer only (like prompt
  // edits), one at a time, read-only roles only; it uses the agent quota through the usage gate. Nothing is saved: no
  // prompt version, ticket, requirement, solution, design or snapshot; no JIRA, no real repository.
  let trialRunning = false;
  app.post("/api/prompts/:role/trial", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const r = role(c.req.param("role"));
    if (!isTrialRole(r)) throw new ValidationError("Not available for this role: it changes code, runs the app or uses JIRA");
    const { text } = await body(c, z.object({ text: z.string() }));
    if (text.length > PROMPT_TEXT_MAX) throw new ValidationError(`the draft is longer than ${PROMPT_TEXT_MAX} characters`);
    if (!deps.trial) return c.json({ error: "trial runs are not available on this server" }, 409);
    // F4D-1 (M6): a trial has no retry and the default agent timeout, so the slot frees within that time
    if (trialRunning) return c.json({ error: `A trial is already running; it ends within ${Math.ceil(DEFAULT_AGENT_TIMEOUT_MS / 60_000)} minutes.` }, 409);
    trialRunning = true;
    try {
      const costOf = (id: string) => (db.prepare("SELECT cost_usd FROM agent_run WHERE id = ?").get(id) as { cost_usd: number | null } | undefined)?.cost_usd ?? null;
      // 4B-2: a credential in the draft never reaches the agent; the result (agent output, error) is redacted too
      const result = await runTrial({ ...deps.trial, repoRoot, costOf }, r, redact(text));
      // F4D-1 (M8): each string of the result on its own, never the JSON text (a quote, a backslash or an escape next
      // to a credential would hide it or break the JSON)
      return c.json(redactDeep(result, redact));
    } finally {
      trialRunning = false;
    }
  });

  app.post("/api/prompts/:role/reset", (c) => localOnly(c) ?? c.json(resetPrompt(db, role(c.req.param("role")))));

  // ---- preferences (phase 4d, §9.4) ----

  app.get("/api/preferences", (c) => c.json(preferenceState(db)));

  // D-5: the summary reaches the propose-solutions agent's prompt, so like prompts it changes only on this computer
  app.put("/api/preferences", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const { text } = await body(c, z.object({ text: z.string() }));
    // the limit is on what the developer typed (4B-3: the text is never echoed)
    if (text.length > PREFERENCE_TEXT_MAX) throw new ValidationError(`the preference text is longer than ${PREFERENCE_TEXT_MAX} characters`);
    // phase 4b (4B-2): a credential pasted into the text is never stored nor sent to an agent
    editSummary(db, redact(text), decidedBy(c));
    bus.emit({ type: "preferences_changed" });
    return c.json(preferenceState(db));
  });

  app.post("/api/preferences/clear", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    clearSummary(db, decidedBy(c));
    bus.emit({ type: "preferences_changed" });
    return c.json(preferenceState(db));
  });

  app.post("/api/preferences/rederive", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    rederive(db, decidedBy(c));
    bus.emit({ type: "preferences_changed" });
    return c.json(preferenceState(db));
  });

  // ---- audit ----

  app.get("/api/audit", (c) => {
    const key = c.req.query("ticketKey");
    const rows = (
      key
        ? db.prepare("SELECT id, ts, actor, type, ticket_key, payload_json, hash FROM audit_event WHERE ticket_key = ? ORDER BY id").all(key)
        : db.prepare("SELECT id, ts, actor, type, ticket_key, payload_json, hash FROM audit_event ORDER BY id").all()
    ) as Array<{ id: number; ts: string; actor: string; type: string; ticket_key: string | null; payload_json: string; hash: string }>;
    return c.json({
      events: rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, type: r.type, ticketKey: r.ticket_key, payload: JSON.parse(r.payload_json), hash: r.hash })),
      chain: verifyAuditChain(db),
    });
  });

  // ---- SSE ----

  app.get("/api/events", (c) => {
    // a paired device's stream lives only as long as its session: closed on revoke, re-checked on every ping (expiry)
    const token = isLocalRequest(c) ? null : sessionToken(c.req.header("cookie"));
    const device = token === null ? null : pairing.authenticate(token);
    return streamSSE(c, async (stream) => {
      let end!: () => void;
      const closed = new Promise<void>((resolve) => (end = resolve));
      stream.onAbort(end);
      const unsubscribe = bus.subscribe((e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
      });
      const offRevoke = pairing.onRevoke((id) => {
        if (device && id === device.id) end();
      });
      const timer = setInterval(() => {
        if (token !== null && !pairing.authenticate(token)) return end();
        void stream.write(": ping\n\n").catch(() => {});
      }, PING_MS);
      await stream.write(": connected\n\n");
      await closed;
      clearInterval(timer);
      offRevoke();
      unsubscribe();
    });
  });

  // ---- hosted web UI (non-API paths) ----

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  // the configured JIRA is read on every page load, so a Settings change applies without a restart
  const ui = deps.webDist && existsSync(deps.webDist) ? webUi(deps.webDist, { imgSources: () => jiraImageSources(config.jira.baseUrl) }) : null;
  app.all("*", (c) => (ui ? ui(c) : c.text("Not found", 404)));

  return app;
}
