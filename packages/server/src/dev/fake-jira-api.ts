// Dev/e2e only (phase 4b Task 8): fake mode's JIRA API mode. A fake `fetch` answering the Jira Cloud REST v3 paths that
// ApiJiraSource / ApiJiraUpdater / ApiJiraCommenter use, from the fake source's tickets (the same data as the browser
// mode's fakes), so the real REST code runs end to end without any network. Only FAKE_BASE_URL is answered; any other
// URL is refused (thrown), never fetched. Every answered request is appended to <home>/fake-jira-api/requests.jsonl as
// {method, path, body} — a write's body only, and never a header (no token, no Basic value).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isTicketKey, type FetchedTicket } from "@slackoff/shared";
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { appendAudit } from "../audit/audit-log.ts";
import type { RunAgentRequest } from "../executor/run-agent.ts";
import { adfToText, textToAdf } from "../jira/adf.ts";
import { FAKE_BASE_URL, fakeRun } from "./fake-mode.ts";
import { UsageLimitError } from "../executor/types.ts";
import { pauseUsage } from "../cost/budget-gate.ts";
import type { EventBus } from "../http/events.ts";

/** The CLI's own wording when the subscription's usage limit is reached (matches USAGE_LIMIT_RE). */
export const FAKE_USAGE_LIMIT_TEXT = "Claude usage limit reached · resets 5pm (fake mode)";

/** Synthetic usage and cost for a fake run, from the prompt's size (deterministic, never zero). */
function fakeUsage(prompt: string): { usage: Record<string, number>; costUsd: number } {
  const input = 800 + Math.min(prompt.length, 20_000);
  const output = 150 + (prompt.length % 400);
  const usage = { input_tokens: input, output_tokens: output, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 };
  return { usage, costUsd: Math.round(((input * 3 + output * 15 + 2000 * 0.3) / 1_000_000) * 10_000) / 10_000 };
}
import type { FakeTicketSource } from "./fake-source.ts";

const API = "/rest/api/3";
/** The statuses every fake ticket can move to (one transition each). */
const STATUSES = ["Ready for Dev", "In Progress", "Ready for Human Review", "Done"];

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export interface FakeJiraApi {
  fetch: typeof globalThis.fetch;
}

export function createFakeJiraApi(o: { source: FakeTicketSource; home: string }): FakeJiraApi {
  const { source } = o;
  const dir = join(o.home, "fake-jira-api");
  const record = (method: string, path: string, body?: unknown) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "requests.jsonl"), `${JSON.stringify(body === undefined ? { method, path } : { method, path, body })}\n`);
  };
  /** Every version of a ticket (now and the later reads): a write changes them all, like the fake jira-update. */
  const versions = (key: string): FetchedTicket[] =>
    [source.tickets[key], ...(source.laterReads[key] ?? [])].filter((t): t is FetchedTicket => t !== undefined && !(t instanceof Error));
  const commentJson = (c: FetchedTicket["comments"][number]) => ({ id: c.jiraCommentId ?? "", author: { displayName: c.author ?? "" }, created: c.created ?? "", body: textToAdf(c.body ?? "") });
  const issueJson = (t: FetchedTicket) => ({
    key: t.key,
    fields: {
      summary: t.title,
      status: t.status === null ? null : { name: t.status },
      updated: t.jiraUpdatedAt,
      description: t.description ? textToAdf(t.description) : null,
      attachment: t.attachments.map((a, i) => ({ id: String(i + 1), filename: a.filename, mimeType: a.mime, size: 1024 })),
      comment: { total: t.comments.length, startAt: 0, maxResults: t.comments.length, comments: t.comments.map(commentJson) },
    },
  });

  const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // fake mode never reaches a real JIRA: only the fake base is answered
    if (url.origin !== FAKE_BASE_URL) throw new TypeError("fake JIRA API: only the fake JIRA base URL is answered");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    record(method, path, method === "GET" ? undefined : body);
    // the credentials typed in Settings must be on every request (their value is never looked at or logged)
    if (auth === null || !auth.startsWith("Basic ")) return json({ errorMessages: ["unauthorized"] }, 401);

    if (method === "POST" && path === `${API}/search/jql`) {
      const d = await source.discover();
      return json({ issues: d.tickets.map((t) => ({ key: t.key, fields: { summary: t.title, status: { name: t.status }, updated: null } })), isLast: true });
    }
    const m = /^\/rest\/api\/3\/issue\/([^/]+)(\/transitions|\/comment)?$/.exec(path);
    const key = m?.[1] !== undefined && isTicketKey(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : undefined;
    const now = key === undefined ? undefined : source.tickets[key];
    if (key === undefined || now === undefined || now instanceof Error) return json({ errorMessages: ["Issue does not exist"] }, 404);
    const sub = m![2];
    if (sub === undefined && method === "GET") {
      // a status-only read (the updater's) does not count as a read of the ticket (later reads stay where they are)
      if (url.searchParams.get("fields") === "status") return json({ key, fields: { status: now.status === null ? null : { name: now.status } } });
      return json(issueJson(await source.fetchTicket(key)));
    }
    if (sub === "/comment" && method === "GET") {
      const startAt = Number(url.searchParams.get("startAt") ?? "0");
      return json({ total: now.comments.length, startAt, comments: now.comments.slice(startAt).map(commentJson) });
    }
    if (sub === "/transitions" && method === "GET") {
      return json({ transitions: STATUSES.filter((s) => s !== now.status).map((s, i) => ({ id: String(11 + i), name: s, to: { name: s }, fields: {} })) });
    }
    if (sub === "/transitions" && method === "POST") {
      const id = (body?.transition as { id?: unknown } | undefined)?.id;
      const target = STATUSES.filter((s) => s !== now.status)[Number(id) - 11];
      if (target === undefined) return json({ errorMessages: ["Transition id is not valid"] }, 400);
      for (const t of versions(key)) t.status = target;
      return new Response(null, { status: 204 });
    }
    if (sub === "/comment" && method === "POST") {
      const text = adfToText(body?.body);
      for (const t of versions(key)) {
        t.comments = [...t.comments, { jiraCommentId: `fake-api-${t.comments.length + 1}`, author: "me", created: new Date().toISOString(), body: text }];
      }
      return json({ id: `fake-api-${now.comments.length}` }, 201);
    }
    return json({ errorMessages: ["not found"] }, 404);
  }) as typeof globalThis.fetch;
  return { fetch };
}

/**
 * Fake mode's agent runs (no claude): fakeRun, recorded in agent_run like a real run, with the executor kind the
 * Settings name when it starts — so the API-key mode shows as `claude-api` even though nothing is spawned.
 */
/**
 * Phase 4c task 6: each run also gets synthetic usage_json and cost_usd (the Cost & quota page has numbers in fake
 * mode); a ticket in `usageLimitOnce` hits the usage limit on its first propose-solutions run, like the real runAgent:
 * the run fails, new agent runs are paused (limit_reached) and the ticket blocks with the CLI's wording.
 */
export function fakeRunRecorded(db: DatabaseSync, kind: () => "claude-code" | "claude-api", o: { usageLimitOnce?: ReadonlySet<string>; bus?: EventBus } = {}) {
  const limited = new Set<string>();
  return async <T>(req: RunAgentRequest<T>): Promise<T> => {
    const id = randomUUID();
    // phase 4d: a trial is recorded like a real one (purpose, the draft's hash, its own audit event)
    const trial = req.purpose === "trial";
    const draftHash = trial ? createHash("sha256").update(req.additionsOverride ?? "").digest("hex").slice(0, 12) : null;
    db.prepare("INSERT INTO agent_run (id, ticket_key, role, executor, status, started_at, purpose, draft_hash) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)").run(
      id, req.ticketKey ?? null, req.role, kind(), new Date().toISOString(), req.purpose ?? "ticket", draftHash,
    );
    if (trial) appendAudit(db, { actor: "developer", type: "prompt_trial_run", payload: { role: req.role, runId: id, draftLength: (req.additionsOverride ?? "").length } });
    req.onRunStart?.(id);
    const { usage, costUsd } = fakeUsage(req.prompt);
    const end = (status: "ok" | "error", error: string | null) =>
      db.prepare("UPDATE agent_run SET status = ?, error = ?, usage_json = ?, cost_usd = ?, ended_at = ? WHERE id = ?").run(
        status, error, status === "ok" ? JSON.stringify(usage) : null, status === "ok" ? costUsd : null, new Date().toISOString(), id,
      );
    const key = req.ticketKey;
    if (req.role === "propose-solutions" && key !== undefined && o.usageLimitOnce?.has(key) && !limited.has(key)) {
      limited.add(key);
      end("error", FAKE_USAGE_LIMIT_TEXT);
      pauseUsage(db, "limit_reached", FAKE_USAGE_LIMIT_TEXT, "system", o.bus);
      throw new UsageLimitError(`claude reported its usage limit: ${FAKE_USAGE_LIMIT_TEXT}`, FAKE_USAGE_LIMIT_TEXT);
    }
    try {
      const out = await fakeRun(req);
      end("ok", null);
      return out;
    } catch (err) {
      end("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
}
