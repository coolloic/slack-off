// Phase 4d Task 4 (D-6): "Restore default" asks first; Task 5: the trial run's confirmation and result summary.
import { t } from "../i18n/en.ts";

/** The longest part of the current text the confirmation shows. */
export const RESET_PREVIEW_CHARS = 300;

/** What "Restore default" will clear, and what it will do. */
export function resetConfirmation(role: string, current: string, nextVersion: number): { preview: string; truncated: boolean; thisWill: string } {
  return {
    preview: current.slice(0, RESET_PREVIEW_CHARS),
    truncated: current.length > RESET_PREVIEW_CHARS,
    thisWill: t("prompts.resetThisWill", { v: nextVersion, role }),
  };
}

/**
 * An action that runs only after an explicit confirm: request() remembers the arguments, confirm() runs it once,
 * cancel() forgets them. The UI shows the confirmation while `pending`.
 */
export class ConfirmGate<A extends unknown[]> {
  private args: A | null = null;
  private readonly action: (...args: A) => Promise<boolean>;
  /** `action` answers whether it succeeded (useAction's run: false on an error) */
  constructor(action: (...args: A) => Promise<boolean>) {
    this.action = action;
  }
  get pending(): boolean {
    return this.args !== null;
  }
  request(...args: A): void {
    this.args = args;
  }
  cancel(): void {
    this.args = null;
  }
  /** F4D-1 (M1): true only when the action ran and succeeded */
  async confirm(): Promise<boolean> {
    const args = this.args;
    if (args === null) return false;
    this.args = null;
    return (await this.action(...args)) === true;
  }
}

/**
 * F4D-1 (M1): Confirm on a confirmation bar. The bar stays open (showing it is busy) while the request runs and closes
 * afterwards; `onSuccess` (empty the editor) runs only when the action succeeded, so a failed restore keeps the text.
 */
export async function confirmAndClose<A extends unknown[]>(gate: ConfirmGate<A>, close: () => void, onSuccess: () => void): Promise<boolean> {
  try {
    const ok = await gate.confirm();
    if (ok) onSuccess();
    return ok;
  } finally {
    close();
  }
}

// ---- Task 5: try a draft on the sample ticket ----

const TRIAL_ROLE_SET: readonly string[] = ["refine-ticket", "propose-solutions", "design-solution", "critique-design"];

/** D-7: the four read-only roles, on this computer only (D-8); the other roles say why. */
export function trialAvailability(role: string, local: boolean): { enabled: boolean; reason: string | null } {
  if (!TRIAL_ROLE_SET.includes(role)) return { enabled: false, reason: t("prompts.trialNotForRole") };
  if (!local) return { enabled: false, reason: t("settings.promptsOnMac") };
  return { enabled: true, reason: null };
}

/** D-8: what the confirmation says. */
export const trialThisWill = (role: string): string => t("prompts.trialThisWill", { role });

export type TrialSummary =
  | { kind: "refine"; acs: string[]; unclear: string[] }
  | { kind: "propose"; solutions: string[] }
  | { kind: "design"; lines: string[]; more: boolean }
  | { kind: "critique"; blocking: number; nonBlocking: number; first: string[] };

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null) as Record<string, unknown>[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const field = (o: unknown, k: string): unknown => (typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined);

/** The result panel's summary of a trial's output, per role (never throws on an unexpected shape). */
export function trialSummary(role: string, output: unknown): TrialSummary {
  switch (role) {
    case "refine-ticket":
      return {
        kind: "refine",
        acs: arr(field(output, "acceptanceCriteria")).map((a) => `${str(a.id)} ${str(a.text)}`.trim()),
        unclear: arr(field(output, "openQuestions")).map((q) => str(q.text)),
      };
    case "design-solution": {
      const all = str(field(output, "contentMd")).split("\n");
      return { kind: "design", lines: all.slice(0, 40), more: all.length > 40 };
    }
    case "critique-design": {
      const comments = arr(field(output, "comments"));
      const blocking = comments.filter((c) => c.blocking === true).length;
      return {
        kind: "critique",
        blocking,
        nonBlocking: comments.length - blocking,
        first: comments.slice(0, 5).map((c) => `${str(c.id)}${c.blocking === true ? " (blocking)" : ""} ${str(c.text)}`),
      };
    }
    default:
      return { kind: "propose", solutions: arr(field(output, "solutions")).map((s) => `${str(s.title)} (${str(s.complexity)})`) };
  }
}
