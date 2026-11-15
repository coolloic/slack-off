import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, paths, type AgentRole, type BusEvent, type Status } from "./api.ts";
import type { JiraMode } from "./jira-mode.ts";
import type { DiscoverPhase } from "./discover-model.ts";
import { EventBuffer, type AgentEventEntry } from "./event-buffer.ts";

// ---- invalidation: SSE events tell every mounted useApi to refetch ----

const reloaders = new Set<() => void>();

export function invalidateAll(): void {
  for (const fn of [...reloaders]) fn();
}

export interface ApiState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** GET `path` (null = skip) and refetch whenever the server reports a change. */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);

  const load = useCallback(() => {
    if (path === null) return;
    const mine = ++seq.current;
    setLoading(true);
    api
      .get<T>(path)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [path]);

  useEffect(() => {
    setData(undefined);
    setError(undefined);
    load();
    reloaders.add(load);
    return () => {
      reloaders.delete(load);
      seq.current++;
    };
  }, [load]);

  return { data, error, loading, reload: load };
}

/** Run an action, track pending/error, refetch everything afterwards. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const run = useCallback(
    async (...args: A): Promise<boolean> => {
      setPending(true);
      setError(undefined);
      try {
        await fn(...args);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setPending(false);
        invalidateAll();
      }
    },
    [fn],
  );
  return { run, pending, error };
}

// ---- live store fed by SSE ----

interface LiveState {
  connected: boolean;
  sourceError: string | null;
  /** ticketKey -> role of the agent currently streaming for it */
  running: Record<string, string>;
  /** F-I3: the discovery job, from "Fetch new tickets" until the server's discover_finished event */
  discover: DiscoverPhase;
}

let live: LiveState = { connected: false, sourceError: null, running: {}, discover: { phase: "idle" } };
const liveSubs = new Set<() => void>();
const setLive = (next: Partial<LiveState>): void => {
  live = { ...live, ...next };
  for (const fn of liveSubs) fn();
};

export function dismissSourceError(): void {
  setLive({ sourceError: null });
}

/** Longest a discovery may show as running without hearing back (the browser agent times out after 5 min). */
const DISCOVER_STALE_MS = 6 * 60_000;
let discoverTimer: ReturnType<typeof setTimeout> | undefined;

/** Start discovery: running until discover_finished arrives over SSE (set before the POST so a fast finish is never missed). */
export async function startDiscover(): Promise<void> {
  clearTimeout(discoverTimer);
  setLive({ discover: { phase: "running" } });
  discoverTimer = setTimeout(() => {
    if (live.discover.phase === "running") setLive({ discover: { phase: "idle" } });
  }, DISCOVER_STALE_MS);
  try {
    await api.discover();
  } catch (e) {
    clearTimeout(discoverTimer);
    setLive({ discover: { phase: "idle" } });
    throw e;
  }
}

export function useLive(): LiveState {
  return useSyncExternalStore(
    (fn) => {
      liveSubs.add(fn);
      return () => liveSubs.delete(fn);
    },
    () => live,
  );
}

// ---- live agent events per ticket (P-C10): the last 500 of each ticket, for LiveLog ----

const agentEvents = new EventBuffer(500);
/** phase 4d: the live log key of trial runs (never a ticket key: it has no dash-number) */
export const TRIAL_EVENTS_KEY = "trial";
export const clearTrialEvents = (): void => agentEvents.clear(TRIAL_EVENTS_KEY);

/** The ticket's buffered agent events (oldest first), optionally only these roles' events. */
export function useAgentEvents(key: string, roles?: readonly AgentRole[]): AgentEventEntry[] {
  const all = useSyncExternalStore(
    (fn) => agentEvents.subscribe(fn),
    () => agentEvents.get(key),
  );
  const roleKey = roles ? roles.join(",") : null;
  return useMemo(() => {
    if (roleKey === null) return [...all];
    const keep = roleKey.split(",");
    return all.filter((e) => keep.includes(e.role));
  }, [all, roleKey]);
}

/** Subscribe once (in the app shell) to /api/events; refetch affected data on state changes. */
export function useEvents(): void {
  useEffect(() => {
    const es = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refetchSoon = (): void => {
      clearTimeout(timer);
      timer = setTimeout(invalidateAll, 100);
    };
    es.onopen = () => {
      setLive({ connected: true });
      refetchSoon(); // catch up on anything missed while disconnected
    };
    es.onerror = () => setLive({ connected: false });
    es.addEventListener("state_changed", (m) => {
      const e = JSON.parse((m as MessageEvent<string>).data) as Extract<BusEvent, { type: "state_changed" }>;
      const running = { ...live.running };
      delete running[e.ticketKey];
      setLive({ running });
      refetchSoon();
    });
    es.addEventListener("agent_event", (m) => {
      const e = JSON.parse((m as MessageEvent<string>).data) as Extract<BusEvent, { type: "agent_event" }>;
      if (e.ticketKey && live.running[e.ticketKey] !== e.role) setLive({ running: { ...live.running, [e.ticketKey]: e.role } });
      if (e.ticketKey) agentEvents.push({ ticketKey: e.ticketKey, role: e.role, runId: e.runId, kind: e.event.kind, text: e.event.text });
      // phase 4d: a trial run has no ticket; its events are kept under TRIAL_EVENTS_KEY for the prompt editor
      else if (e.trial) agentEvents.push({ ticketKey: TRIAL_EVENTS_KEY, role: e.role, runId: e.runId, kind: e.event.kind, text: e.event.text });
    });
    // phase 2: the ticket's debate, development steps, JIRA writes or snapshot changed — refetch (no polling)
    for (const type of ["debate_updated", "dev_step", "jira_write_updated", "snapshot_changed", "review_updated", "delivery_updated", "jira_comment_updated", "usage_changed", "preferences_changed"] as const) {
      es.addEventListener(type, () => refetchSoon());
    }
    es.addEventListener("ticket_discovered", () => refetchSoon());
    // a read-only "Read from JIRA" changes no state: its end clears the ticket's running agent
    es.addEventListener("ticket_read", (m) => {
      const e = JSON.parse((m as MessageEvent<string>).data) as Extract<BusEvent, { type: "ticket_read" }>;
      if (live.running[e.ticketKey] !== undefined) {
        const running = { ...live.running };
        delete running[e.ticketKey];
        setLive({ running });
      }
      refetchSoon();
    });
    es.addEventListener("discover_finished", (m) => {
      const { type: _type, ...result } = JSON.parse((m as MessageEvent<string>).data) as Extract<BusEvent, { type: "discover_finished" }>;
      clearTimeout(discoverTimer);
      setLive({ discover: { phase: "finished", result } });
      refetchSoon();
    });
    es.addEventListener("source_error", (m) => {
      const e = JSON.parse((m as MessageEvent<string>).data) as Extract<BusEvent, { type: "source_error" }>;
      setLive({ sourceError: e.message });
      refetchSoon();
    });
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, []);
}

/** F4B-4: the JIRA mode set now (undefined while /api/status loads): the wording of what has not been sent yet. */
export function useJiraMode(): JiraMode | undefined {
  return useApi<Status>(paths.status).data?.jira.source;
}
