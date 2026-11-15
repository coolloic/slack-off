// Phase 4d Task 6 (§9.4): the preference summary — Settings → Preferences and the hint on the Solutions tab.
import { PREFERENCE_TEXT_MAX, type PreferenceState, type PreferenceSummary } from "@slackoff/shared";
import { t } from "../i18n/en.ts";

/** Each fixed sentence of a derived summary (server: preferences/derive.ts) and its short form for the hint. */
const PHRASES: Array<[RegExp, string]> = [
  [/you picked the simplest option/, "pick the simplest option"],
  [/you picked the most complex option/, "pick the most complex option"],
  [/^You avoided new dependencies/, "avoid new dependencies"],
  [/^You chose an option that adds a new dependency/, "accept new dependencies"],
  [/fewest repositories/, "change the fewest repositories"],
  [/smallest change scope/, "keep the change scope small"],
];

const joinAnd = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const HINT_MAX = 120;

/** One line above the solution cards, or null (no summary, cleared, empty). */
export function preferenceHint(s: PreferenceState): string | null {
  const text = s.current?.text.trim() ?? "";
  if (text === "") return null;
  if (s.current!.source === "derived") {
    const phrases = text.split("\n").flatMap((line) => PHRASES.filter(([re]) => re.test(line)).map(([, p]) => p));
    if (phrases.length > 0) return t("prefs.hintDerived", { phrases: joinAnd(phrases) });
  }
  const first = text.split("\n")[0]!.trim();
  return t("prefs.hintEdited", { text: first.length > HINT_MAX ? `${first.slice(0, HINT_MAX)}…` : first });
}

export const notEnoughText = (s: PreferenceState): string | null => (s.counted < s.needed ? t("prefs.notEnough", { n: s.counted, needed: s.needed }) : null);

export const sinceEditText = (s: PreferenceState): string | null =>
  s.current?.source === "edited" && s.signalsSinceEdit > 0 ? t("prefs.sinceEdit", { n: s.signalsSinceEdit }) : null;

export function sourceText(c: PreferenceSummary): string {
  return c.source === "edited" ? t("prefs.sourceEdited") : c.source === "cleared" ? t("prefs.sourceCleared") : t("prefs.sourceDerived");
}

export const clearThisWill = (): string => t("prefs.clearThisWill");
export const rederiveThisWill = (counted: number): string => t("prefs.rederiveThisWill", { n: counted });

/** The editor's Save: non-blank, at most 2000 characters, changed. */
export const canSavePreference = (text: string, saved: string): boolean => text.trim() !== "" && text.length <= PREFERENCE_TEXT_MAX && text !== saved;

// ---- F4D-1 (M10): the editor keeps what you typed when the summary changes ----

/** The Preferences editor: its text, the summary text it was loaded from (null before the first load), and whether
 * the summary has changed since while the text was being edited. */
export interface PrefEditor {
  text: string;
  base: string | null;
  changed: boolean;
}

export const INITIAL_PREF_EDITOR: PrefEditor = { text: "", base: null, changed: false };

/** The summary as it is now loaded from the server: followed when nothing is being edited; else the text is kept and
 * `changed` set. */
export function syncPrefEditor(e: PrefEditor, summary: string | null): PrefEditor {
  const s = summary ?? "";
  if (e.base === null || e.text === e.base || e.text === s) return { text: s, base: s, changed: false };
  // back to the text the edit started from: nothing changed after all
  if (s === e.base) return e.changed ? { ...e, changed: false } : e;
  return { ...e, changed: true };
}

export const editPrefEditor = (e: PrefEditor, text: string): PrefEditor => ({ ...e, text });

/** Reload: the summary as it is now, edits dropped. */
export const reloadPrefEditor = (summary: string | null): PrefEditor => ({ text: summary ?? "", base: summary ?? "", changed: false });

/** After your own Clear or Re-derive: nothing is being edited any more, so the next summary is followed. */
export const markPrefEditorClean = (e: PrefEditor): PrefEditor => ({ text: e.base ?? "", base: e.base, changed: false });
