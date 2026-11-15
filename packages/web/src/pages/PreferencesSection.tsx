import { RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { AsyncView, ErrorBox } from "../components/AsyncView.tsx";
import { ConfirmBar } from "../components/ConfirmBar.tsx";
import { ThisWill } from "../components/ThisWill.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardHeader } from "../components/ui/card.tsx";
import { Textarea } from "../components/ui/input.tsx";
import { t } from "../i18n/en.ts";
import { api, paths, type PreferenceState } from "../lib/api.ts";
import { useAction, useApi } from "../lib/hooks.ts";
import {
  canSavePreference, clearThisWill, editPrefEditor, INITIAL_PREF_EDITOR, markPrefEditorClean, notEnoughText, rederiveThisWill, reloadPrefEditor, sinceEditText,
  sourceText, syncPrefEditor,
} from "../lib/preferences-model.ts";
import { formatTime, timeAgo } from "../lib/utils.ts";

/**
 * Phase 4d (§9.4, D-3, D-5): the preference summary the propose-solutions agent sees. Everyone may read it; editing,
 * clearing and re-deriving happen on this computer only (`readOnly` elsewhere and in the phone layout), each after a
 * confirmation.
 */
export function PreferencesSection({ readOnly, onMacNote }: { readOnly: boolean; onMacNote: boolean }) {
  const prefs = useApi<PreferenceState>(paths.preferences);
  const saved = prefs.data?.current?.source === "edited" ? prefs.data.current.text : "";
  // F4D-1 (M10): a changed summary replaces the editor's text only when nothing is being edited; otherwise the text is
  // kept and a note offers Reload
  const [editor, setEditor] = useState(INITIAL_PREF_EDITOR);
  const text = editor.text;
  const summary = prefs.data === undefined ? undefined : (prefs.data.current?.text ?? null);
  const clean = editor.text === editor.base;
  useEffect(() => {
    if (summary !== undefined) setEditor((e) => syncPrefEditor(e, summary));
  }, [summary, prefs.data?.current?.version, clean]);
  // F4D-1 (M1, as for Restore default): the bar closes once the request has answered
  const confirmThen = async (action: () => Promise<boolean>) => {
    try {
      if (await action()) setEditor(markPrefEditorClean);
    } finally {
      setAsk(null);
    }
  };
  const save = useAction(api.editPreferences);
  const clear = useAction(api.clearPreferences);
  const rederive = useAction(api.rederivePreferences);
  const [ask, setAsk] = useState<"clear" | "rederive" | null>(null);
  const error = save.error ?? clear.error ?? rederive.error;

  return (
    <Card data-testid="preferences-section" className="flex min-w-0 flex-col max-md:rounded-lg max-md:border-0 max-md:shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
      <CardHeader title={t("prefs.title")} />
      <AsyncView state={prefs}>
        {(p) => {
          const cur = p.current;
          const notEnough = notEnoughText(p);
          const sinceEdit = sinceEditText(p);
          return (
            <div className="flex min-w-0 flex-col gap-3 p-3">
              <p className="flex items-start gap-2 text-body-sm text-on-surface-variant">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>{t("prefs.caption")}</span>
              </p>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-headline-sm">{t("prefs.current")}</span>
                {cur && cur.text !== "" ? (
                  <p data-testid="preferences-current" className="whitespace-pre-wrap break-words rounded bg-surface-container p-2 text-body-md">
                    {cur.text}
                  </p>
                ) : (
                  <p className="text-body-sm text-slate-500">{t("prefs.empty")}</p>
                )}
                {cur && (
                  <span className="font-mono text-code-sm text-slate-500" title={formatTime(cur.createdAt)}>
                    {t("prefs.version", { v: cur.version, source: sourceText(cur), when: timeAgo(cur.createdAt) })}
                  </span>
                )}
                {notEnough && <span data-testid="preferences-not-enough" className="text-body-sm text-amber-800">{notEnough}</span>}
                {sinceEdit && <span data-testid="preferences-since-edit" className="text-body-sm text-amber-800">{sinceEdit}</span>}
              </div>
              {onMacNote && (
                <p role="note" className="text-body-sm text-amber-800">
                  {t("prefs.onMac")}
                </p>
              )}
              {!readOnly && (
                <>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <span className="text-headline-sm">{t("prefs.editLabel")}</span>
                      <span className="font-mono text-code-sm text-slate-500">{t("settings.chars", { n: text.length })}</span>
                    </div>
                    <Textarea rows={4} value={text} maxLength={2000} onChange={(e) => setEditor((s) => editPrefEditor(s, e.target.value))} aria-label={t("prefs.editLabel")} />
                    {editor.changed && (
                      <p role="status" data-testid="preferences-changed" className="flex flex-wrap items-center gap-2 text-body-sm text-amber-800">
                        <span>{t("prefs.changed")}</span>
                        <Button onClick={() => setEditor(reloadPrefEditor(summary ?? null))}>{t("prefs.reload")}</Button>
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="blue" disabled={save.pending || !canSavePreference(text, saved)} onClick={() => void save.run(text)}>
                      <Save className="size-3.5" />
                      {t("prefs.save")}
                    </Button>
                    <Button disabled={rederive.pending} onClick={() => setAsk("rederive")}>
                      <RefreshCw className="size-3.5" />
                      {t("prefs.rederive")}
                    </Button>
                    <Button variant="destructive" disabled={clear.pending || !cur || (cur.source === "cleared" && p.counted === 0)} onClick={() => setAsk("clear")}>
                      <Trash2 className="size-3.5" />
                      {t("prefs.clear")}
                    </Button>
                  </div>
                  <ThisWill>{t("prefs.saveThisWill")}</ThisWill>
                </>
              )}
              {error && <ErrorBox error={error} />}
              {ask === "clear" && !readOnly && (
                <ConfirmBar
                  title={t("prefs.clearTitle")}
                  thisWill={clearThisWill()}
                  confirmLabel={t("prefs.clear")}
                  pending={clear.pending}
                  onCancel={() => setAsk(null)}
                  onConfirm={() => void confirmThen(clear.run)}
                  testId="preferences-clear-confirm"
                />
              )}
              {ask === "rederive" && !readOnly && (
                <ConfirmBar
                  title={t("prefs.rederiveTitle")}
                  thisWill={rederiveThisWill(p.counted)}
                  confirmLabel={t("prefs.rederive")}
                  pending={rederive.pending}
                  onCancel={() => setAsk(null)}
                  onConfirm={() => void confirmThen(rederive.run)}
                  testId="preferences-rederive-confirm"
                >
                  <span className="text-body-sm text-on-surface-variant">{t("prefs.derivedPreview")}</span>
                  <p className="whitespace-pre-wrap break-words rounded bg-surface-container p-2 text-body-sm">{p.derivedPreview || t("prefs.empty")}</p>
                </ConfirmBar>
              )}
            </div>
          );
        }}
      </AsyncView>
    </Card>
  );
}
