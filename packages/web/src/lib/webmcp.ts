import { TicketKey } from "@slackoff/shared";
import { z } from "zod";
import { t, type MessageKey } from "../i18n/en.ts";
import { paths, type api as realApi, type TicketRow } from "./api.ts";
import { setDraft } from "./drafts.ts";
import { needsMe } from "./jira-filter.ts";
import { COMMENT_MAX_CHARS } from "./requirements-model.ts";
import type { Tab } from "./tabs.ts";

/**
 * Experimental WebMCP tools (task 18). An AI agent running in the browser can READ Slack Off data, fill in DRAFTS and be
 * taken to the card where a decision is made. It can never decide: the only HTTP method reachable from here is GET
 * (the api type below has nothing else), no tool clicks a button, and every decision or outward action (choose, finalize,
 * hand off / reject / confirm, Send to JIRA, Confirm & deliver, comments, git hooks, settings) stays a click by the
 * developer. Inputs are validated (zod), outputs are labelled as untrusted data.
 */

/** The only server access the tools get. */
export type WebMcpApi = Pick<typeof realApi, "get">;

export interface WebMcpDeps {
  api: WebMcpApi;
  navigate: (path: string) => void;
  signal: AbortSignal;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

interface ModelContextTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: unknown) => Promise<ToolResult>;
}

interface ModelContextLike {
  registerTool: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => unknown;
}

/** document.modelContext is the current name; navigator.modelContext is the deprecated one. */
function findModelContext(): ModelContextLike | undefined {
  const doc = (globalThis as { document?: { modelContext?: ModelContextLike } }).document;
  const nav = (globalThis as { navigator?: { modelContext?: ModelContextLike } }).navigator;
  return doc?.modelContext ?? nav?.modelContext ?? undefined;
}

const MAX_OUTPUT_CHARS = 60_000;

function text(data: unknown): ToolResult {
  let body = JSON.stringify({ notice: t("webmcp.untrustedOutput"), data });
  if (body.length > MAX_OUTPUT_CHARS) body = `${body.slice(0, MAX_OUTPUT_CHARS)}${t("webmcp.truncated")}`;
  return { content: [{ type: "text", text: body }] };
}

function plain(message: string): ToolResult {
  return { content: [{ type: "text", text: message }] };
}

// ---- input schemas (one definition: validation and the JSON schema the agent sees) ----

const Key = z.object({ ticketKey: TicketKey }).strict();
const ListInput = z
  .object({ needsMe: z.boolean().optional(), jiraStatus: z.string().min(1).max(100).optional() })
  .strict();
const RulingInput = z
  .object({
    ticketKey: TicketKey,
    rulings: z
      .array(z.object({ commentId: z.string().min(1).max(64), decision: z.enum(["designer", "critic", "custom"]), note: z.string().trim().max(4000) }).strict())
      .min(1)
      .max(50),
  })
  .strict();
const AcEditInput = z
  .object({ ticketKey: TicketKey, acId: z.string().regex(/^AC-\d{1,6}$/, "acId must look like AC-1"), text: z.string().trim().min(1).max(1000) })
  .strict();
const NoteInput = z.object({ ticketKey: TicketKey, text: z.string().trim().min(1).max(COMMENT_MAX_CHARS) }).strict();

export const DECISION_KINDS = ["solution", "design", "review", "delivery", "jira_write", "comment", "hooks"] as const;
type DecisionKind = (typeof DECISION_KINDS)[number];
const DECISION_TAB: Record<DecisionKind, Tab> = {
  solution: "solutions",
  design: "design",
  review: "acceptance",
  delivery: "delivery",
  jira_write: "development",
  comment: "requirements",
  hooks: "development",
};
const OpenDecisionInput = z.object({ ticketKey: TicketKey, kind: z.enum(DECISION_KINDS) }).strict();

const ticketPath = (key: string, tab: Tab) => `/tickets/${key}/${tab}`;

// ---- tools ----

interface Def<S extends z.ZodType> {
  name: string;
  description: string;
  readOnly: boolean;
  schema: S;
  run: (input: z.infer<S>) => Promise<ToolResult>;
}

function def<S extends z.ZodType>(d: Def<S>): Def<S> {
  return d;
}

function buildTools({ api, navigate }: Pick<WebMcpDeps, "api" | "navigate">) {
  const untrusted = ` ${t("webmcp.untrustedData")}`;
  const read = <S extends z.ZodType>(name: string, desc: MessageKey, schema: S, run: (i: z.infer<S>) => Promise<unknown>) =>
    def({ name, description: t(desc) + untrusted, readOnly: true, schema, run: async (i) => text(await run(i)) });

  return [
    read("slackoff_list_tickets", "webmcp.desc.listTickets", ListInput, async (i) => {
      const rows = await api.get<TicketRow[]>(paths.tickets);
      const picked = rows
        .filter((r) => (i.needsMe ? needsMe(r) : true))
        .filter((r) => (i.jiraStatus === undefined ? true : r.jiraStatus === i.jiraStatus))
        .map((r) => ({
          key: r.key, title: r.title, jiraStatus: r.jiraStatus, jiraOpen: r.jiraOpen, state: r.state, blockedReason: r.blockedReason,
          driftNeedsAction: r.driftNeedsAction, jiraWritePending: r.jiraWritePending, deliveryStepFailed: r.deliveryStepFailed, updatedAt: r.updatedAt,
        }));
      return { tickets: picked };
    }),
    read("slackoff_get_ticket", "webmcp.desc.getTicket", Key, async (i) => {
      const d = await api.get<import("./api.ts").TicketDetail>(paths.ticket(i.ticketKey));
      return {
        ticket: { key: d.ticket.key, title: d.ticket.title, jiraStatus: d.ticket.jiraStatus, state: d.ticket.state, blockedReason: d.ticket.blockedReason, branch: d.ticket.branch },
        requirement: d.requirement && { version: d.requirement.version, source: d.requirement.source, content: d.requirement.content },
        choice: d.choice,
      };
    }),
    read("slackoff_get_drift", "webmcp.desc.getDrift", Key, (i) => api.get(paths.drift(i.ticketKey))),
    read("slackoff_get_solutions", "webmcp.desc.getSolutions", Key, async (i) => {
      const d = await api.get<import("./api.ts").TicketDetail>(paths.ticket(i.ticketKey));
      return { solutions: d.solutions, choice: d.choice };
    }),
    read("slackoff_get_design", "webmcp.desc.getDesign", Key, (i) => api.get(paths.design(i.ticketKey))),
    read("slackoff_get_development", "webmcp.desc.getDevelopment", Key, (i) => api.get(paths.development(i.ticketKey))),
    read("slackoff_get_acceptance", "webmcp.desc.getAcceptance", Key, (i) => api.get(paths.review(i.ticketKey))),
    read("slackoff_get_delivery_preview", "webmcp.desc.getDeliveryPreview", Key, (i) => api.get(paths.deliveryPreview(i.ticketKey))),

    // drafting: local, in-memory state the page reads; nothing is submitted
    def({
      name: "slackoff_draft_ruling", description: t("webmcp.desc.draftRuling"), readOnly: false, schema: RulingInput,
      run: async (i) => {
        setDraft({ kind: "ruling", ticketKey: i.ticketKey, rulings: i.rulings });
        navigate(ticketPath(i.ticketKey, "design"));
        return plain(t("webmcp.drafted", { key: i.ticketKey }));
      },
    }),
    def({
      name: "slackoff_draft_ac_edit", description: t("webmcp.desc.draftAcEdit"), readOnly: false, schema: AcEditInput,
      run: async (i) => {
        setDraft({ kind: "ac_edit", ticketKey: i.ticketKey, acId: i.acId, text: i.text });
        navigate(ticketPath(i.ticketKey, "requirements"));
        return plain(t("webmcp.drafted", { key: i.ticketKey }));
      },
    }),
    def({
      name: "slackoff_draft_note", description: t("webmcp.desc.draftNote"), readOnly: false, schema: NoteInput,
      run: async (i) => {
        setDraft({ kind: "note", ticketKey: i.ticketKey, text: i.text });
        navigate(ticketPath(i.ticketKey, "requirements"));
        return plain(t("webmcp.drafted", { key: i.ticketKey }));
      },
    }),
    // decisions are never tools: this only navigates to the card
    def({
      name: "slackoff_open_decision", description: t("webmcp.desc.openDecision"), readOnly: false, schema: OpenDecisionInput,
      run: async (i) => {
        navigate(ticketPath(i.ticketKey, DECISION_TAB[i.kind]));
        return plain(t("webmcp.needsDeveloper", { what: t(`webmcp.decision.${i.kind}` as MessageKey), key: i.ticketKey }));
      },
    }),
  ];
}

export function registerWebMcpTools(deps: WebMcpDeps): { registered: string[] } {
  const ctx = findModelContext();
  if (!ctx || typeof ctx.registerTool !== "function") return { registered: [] };
  const registered: string[] = [];
  for (const d of buildTools(deps)) {
    const schema = d.schema as z.ZodType;
    ctx.registerTool(
      {
        name: d.name,
        description: d.description,
        inputSchema: z.toJSONSchema(schema, { io: "input" }),
        ...(d.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        // inputs from the agent are untrusted: parse (throws on anything unexpected) before touching anything
        execute: async (input: unknown) => (d.run as (i: unknown) => Promise<ToolResult>)(schema.parse(input ?? {})),
      },
      { signal: deps.signal },
    );
    registered.push(d.name);
  }
  return { registered };
}
