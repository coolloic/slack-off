import { Activity, BookOpen, Bot, Sparkles, ChevronLeft, Gauge, ChevronRight, FolderGit2, GitPullRequest, Play, ShieldCheck, RadioTower, RotateCcw, Save, Shield, SquareTerminal, Ticket, Workflow } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { AsyncView, ErrorBox } from "../components/AsyncView.tsx";
import { CredentialField } from "../components/CredentialField.tsx";
import { OtlpHeadersField } from "../components/OtlpHeadersField.tsx";
import { ModeComparison } from "../components/ModeComparison.tsx";
import { ThisWill } from "../components/ThisWill.tsx";
import { ConfirmBar } from "../components/ConfirmBar.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardHeader } from "../components/ui/card.tsx";
import { Input, Select, Textarea } from "../components/ui/input.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { Tooltip } from "../components/ui/tooltip.tsx";
import { t, type MessageKey } from "../i18n/en.ts";
import { api, ApiError, paths, REPO_COMMANDS, type AgentRole, type Config, type CredentialStatus, type BuiltInPrompt, type TrialResult as TrialOutcome, type PromptInfo, type PromptVersion, type SandboxStatus, type Status } from "../lib/api.ts";
import { useAction, useApi, type ApiState } from "../lib/hooks.ts";
import { jiraText } from "../lib/jira-mode.ts";
import { canonicalJson } from "../lib/canonical.ts";
import { browserChoice } from "../lib/dev-model.ts";
import { buildConfig, editable, isConfigDirty, isValidBrowserName, legacyRepoName, modeError, rowsOf, sandboxStatusView, shellQuote, shouldScrollActivePill, type RepoRow } from "../lib/settings-model.ts";
import { cn, formatTime, timeAgo } from "../lib/utils.ts";
import { ConfirmGate, confirmAndClose, resetConfirmation, trialAvailability, trialThisWill } from "../lib/prompt-model.ts";
import { TrialResult } from "../components/TrialResult.tsx";
import { LiveLog } from "../components/LiveLog.tsx";
import { clearTrialEvents, TRIAL_EVENTS_KEY } from "../lib/hooks.ts";
import { RemoteAccessSection } from "./RemoteAccessSection.tsx";
import { PreferencesSection } from "./PreferencesSection.tsx";
import { settingsSectionFromHash, type SettingsSection } from "../lib/settings-link.ts";

const ROLES: readonly AgentRole[] = [
  "refine-ticket", "propose-solutions", "jira-browser", "design-solution",
  "critique-design", "implement-ticket", "acceptance-review", "jira-update", "jira-comment",
];

type Section = SettingsSection;
const SECTIONS: ReadonlyArray<{ id: Section; label: string; icon: ReactNode }> = [
  { id: "executor", label: t("settings.executor"), icon: <SquareTerminal className="size-4" /> },
  { id: "jira", label: t("settings.jira"), icon: <Ticket className="size-4" /> },
  { id: "repos", label: t("settings.repos"), icon: <FolderGit2 className="size-4" /> },
  { id: "prompts", label: t("settings.prompts"), icon: <Bot className="size-4" /> },
  { id: "preferences", label: t("settings.preferences"), icon: <Sparkles className="size-4" /> },
  { id: "workflow", label: t("settings.workflow"), icon: <Workflow className="size-4" /> },
  { id: "budget", label: t("settings.budget"), icon: <Gauge className="size-4" /> },
  { id: "tracing", label: t("settings.tracing"), icon: <Activity className="size-4" /> },
  { id: "acceptance", label: t("settings.acceptance"), icon: <ShieldCheck className="size-4" /> },
  { id: "delivery", label: t("settings.delivery"), icon: <GitPullRequest className="size-4" /> },
  { id: "remote", label: t("settings.remoteAccess"), icon: <RadioTower className="size-4" /> },
];

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-label-md text-slate-700">{label}</span>
      {children}
      {help && <span className="text-body-sm text-slate-500">{help}</span>}
    </label>
  );
}

/** A threshold that may be empty (no limit): empty text = null, a typed non-number stays NaN so Save reports it. */
function LimitField({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number | null; onChange: (n: number | null) => void }) {
  return (
    <Field label={label}>
      <Input
        placeholder={t("settings.budgetNoLimit")}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        className="h-11 w-32 font-mono md:h-7"
        value={value === null || Number.isNaN(value) ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    </Field>
  );
}

/** Phase 4a Task 5: the command sandbox's state (GET /api/sandbox), at the top of the development settings. */
function SandboxStatusCard() {
  const s = useApi<SandboxStatus>(paths.sandbox);
  if (s.data === undefined) return null;
  const v = sandboxStatusView(s.data);
  return (
    <div
      data-testid="sandbox-status"
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded border px-3 py-2 text-body-sm",
        v.tone === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-900",
      )}
    >
      <span className="flex items-center gap-2 font-semibold">
        <Shield className="size-4 shrink-0" />
        {t(v.title)}
      </span>
      {v.reason !== null && <span className="break-words">{v.reason}</span>}
      {v.notes.map((n) => (
        <span key={n} className="break-words">
          {t(n)}
        </span>
      ))}
    </div>
  );
}

/** A whole-number input; an empty box is NaN so the save shows the range error. */
function NumberField({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (n: number) => void }) {
  return (
    <Field label={label}>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        className="w-28 font-mono"
        value={Number.isNaN(value) ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
      />
    </Field>
  );
}

const BROWSER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * "Chrome browser for JIRA" (S-2): detection runs on this computer only (A-1); a manual device id when detection
 * is unavailable or fails. Applies to the next JIRA run without a restart (the server reads it per run).
 */
function BrowserField({ value, readOnly, onChange }: { value: Config["jira"]["browser"]; readOnly: boolean; onChange: (b: Config["jira"]["browser"]) => void }) {
  const [detected, setDetected] = useState<Array<{ deviceId: string; name: string }> | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const choice = browserChoice(value, detected);
  const current = value ? (value.name ? `${value.name} (${value.deviceId})` : value.deviceId) : t("settings.browserNone");
  const detect = () => {
    setDetecting(true);
    setDetectError(null);
    api.detectBrowsers().then(
      (r) => {
        setDetected(r.browsers.length > 0 ? r.browsers : null);
        if (r.browsers.length === 0) setDetectError(t("settings.browserDetectedNone"));
      },
      (e: unknown) => {
        setDetected(null);
        setDetectError(t("settings.browserDetectFailed", { error: e instanceof Error ? e.message : String(e) }));
      },
    ).finally(() => setDetecting(false));
  };
  const manualNameOk = manualName.trim() === "" || isValidBrowserName(manualName.trim());
  const manualOk = BROWSER_ID.test(manualId.trim()) && manualNameOk;
  const radio = "flex min-h-11 cursor-pointer items-center gap-2.5 rounded border border-slate-200 px-2.5 py-1.5 text-body-md";
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 border-t border-slate-200 pt-3" data-testid="jira-browser">
      <legend className="sr-only">{t("settings.browser")}</legend>
      <span className="text-label-md text-slate-700">{t("settings.browser")}</span>
      <span className="text-body-sm text-slate-500">{t("settings.browserHelp")}</span>
      <span className="break-words font-mono text-code-md">{t("settings.browserCurrent", { label: current })}</span>
      {readOnly ? (
        <OnMacNote show />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={detecting} onClick={detect}>
              {detecting ? t("settings.browserDetecting") : t("settings.browserDetect")}
            </Button>
            <ThisWill>{t("settings.browserDetectThisWill")}</ThisWill>
          </div>
          {detectError && <p className="text-body-sm text-amber-800">{detectError}</p>}
          {detected !== null && (
            <div role="radiogroup" aria-label={t("settings.browser")} className="flex flex-col gap-1.5">
              <label className={cn(radio, choice.selected === null && "border-primary")}>
                <input type="radio" className="size-5 accent-primary" checked={choice.selected === null} onChange={() => onChange(null)} />
                {t("settings.browserNone")}
              </label>
              {choice.options.map((o) => (
                <label key={o.deviceId} className={cn(radio, "break-words", choice.selected === o.deviceId && "border-primary")}>
                  <input
                    type="radio"
                    className="size-5 shrink-0 accent-primary"
                    checked={choice.selected === o.deviceId}
                    onChange={() => {
                      const d = detected.find((x) => x.deviceId === o.deviceId);
                      onChange({ deviceId: o.deviceId, name: (d?.name || value?.name || o.deviceId).slice(0, 80) });
                    }}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          )}
          {choice.manual && (detectError !== null || value === null) && (
            <div className="flex min-w-0 flex-col gap-2 rounded border border-slate-200 p-2">
              <Field label={t("settings.browserManualId")}>
                <Input className="font-mono" value={manualId} onChange={(e) => setManualId(e.target.value)} aria-invalid={manualId !== "" && !manualOk} />
              </Field>
              <Field label={t("settings.browserManualName")}>
                <Input value={manualName} onChange={(e) => setManualName(e.target.value)} />
              </Field>
              {manualId !== "" && !BROWSER_ID.test(manualId.trim()) && <span className="text-body-sm text-rose-600">{t("settings.browserManualInvalid")}</span>}
              {!manualNameOk && <span className="text-body-sm text-rose-600">{t("settings.browserManualNameInvalid")}</span>}
              <Button className="w-fit" disabled={!manualOk} onClick={() => onChange({ deviceId: manualId.trim(), name: (manualName.trim() || manualId.trim()).slice(0, 80) })}>
                {t("settings.browserManualUse")}
              </Button>
            </div>
          )}
          {value !== null && detected === null && (
            <Button variant="ghost" className="w-fit" onClick={() => onChange(null)}>
              {t("settings.browserNone")}
            </Button>
          )}
          <span className="text-body-sm text-slate-500">{t("settings.browserAppliesNow")}</span>
        </>
      )}
    </fieldset>
  );
}

/**
 * Phase 4b Task 7: a two-way mode switch (executor or JIRA). Read-only on a paired phone (R21 / B-9). Each option is a
 * full-width row of at least 44px; the choice is saved with "Save settings".
 */
function ModeRadios<V extends string>({ name, label, value, options, readOnly, onChange }: {
  name: string; label: string; value: V; options: ReadonlyArray<{ value: V; label: string; thisWill: string }>; readOnly: boolean; onChange: (v: V) => void;
}) {
  const current = options.find((o) => o.value === value);
  // the phone and desktop editors are both mounted: each needs its own radio group
  const group = `${name}-${useId()}`;
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" data-testid={`mode-${name}`}>
      <legend className="pb-1 text-label-md text-slate-700">{label}</legend>
      <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex min-h-11 items-center gap-2.5 rounded border px-2.5 py-1.5 text-body-md",
              readOnly ? "cursor-not-allowed text-slate-500" : "cursor-pointer",
              value === o.value ? "border-primary" : "border-slate-200",
            )}
          >
            <input type="radio" name={group} className="size-5 shrink-0 accent-primary" checked={value === o.value} disabled={readOnly} onChange={() => onChange(o.value)} />
            <span className="min-w-0 break-words">{o.label}</span>
          </label>
        ))}
      </div>
      {current && <ThisWill>{current.thisWill}</ThisWill>}
      <OnMacNote show={readOnly} />
    </fieldset>
  );
}

// ---- config sections (one shared draft, one save) ----

/** Form state of the config editor (draft, repo rows, concurrency text, save). */
interface ConfigDraft {
  draft: Config;
  rows: RepoRow[];
  concurrencyText: string;
  /** development.deniedLocalPorts as typed ("8080, 9000") */
  portsText: string;
}

/**
 * ONE config draft for the whole Settings page: the phone and desktop editors both read and write it, so crossing
 * the md breakpoint (rotating a tablet) never shows a stale or different draft. Re-syncs only when the saved
 * config really changes (canonical JSON); SSE refetches must not wipe edits.
 */
function useConfigDraft(config: Config | undefined) {
  const configJson = config ? canonicalJson(config) : null;
  const [synced, setSynced] = useState<string | null>(null);
  const [form, setForm] = useState<ConfigDraft | null>(null);
  if (configJson !== synced) {
    // adjust state while rendering (React's documented pattern for syncing from props)
    setSynced(configJson);
    const c = configJson === null ? null : (JSON.parse(configJson) as Config);
    setForm(c && { draft: c, rows: rowsOf(c), concurrencyText: String(c.concurrency), portsText: c.development.deniedLocalPorts.join(", ") });
  }
  const [saved, setSaved] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const save = useAction(async (c: Config) => {
    await api.saveConfig(c);
  });
  return { form, setForm, saved, setSaved, invalid, setInvalid, save };
}
type ConfigDraftState = ReturnType<typeof useConfigDraft>;

/** Config editor. Desktop: one section (from the sub-nav) in a card. Phone (Stitch m06): several sections as stacked cards, one save. */
/** "Change this on the Mac" under fields a paired phone may not change (R21; the server enforces it too). */
function OnMacNote({ show }: { show: boolean }) {
  return show ? <span className="text-body-sm text-amber-800">{t("settings.changeOnMac")}</span> : null;
}

function ConfigSections({ section, config, state, phoneSections, remoteClient = false }: { section: Section; config: Config; state: ConfigDraftState; phoneSections?: Section[]; remoteClient?: boolean }) {
  const { saved, setSaved, invalid, setInvalid, save } = state;
  const form = state.form!;
  const { draft, rows, concurrencyText, portsText } = form;
  const setDraft = (d: Config) => state.setForm((f) => f && { ...f, draft: d });
  const setRows = (r: RepoRow[]) => state.setForm((f) => f && { ...f, rows: r });
  const setConcurrencyText = (c: string) => state.setForm((f) => f && { ...f, concurrencyText: c });
  const setPortsText = (p: string) => state.setForm((f) => f && { ...f, portsText: p });
  const built = buildConfig(draft, rows, concurrencyText, portsText);
  const dirty = isConfigDirty(config, built);
  // phase 4b: whether each credential is set (never a value)
  const creds = useApi<CredentialStatus>(paths.credentials);
  const comboError = modeError(draft);
  const comboAlert = comboError && (
    <p role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-body-sm text-amber-900" data-testid="mode-combo-error">
      {comboError}
    </p>
  );
  const modeChanged = draft.executor.kind !== config.executor.kind || draft.jira.source !== config.jira.source;
  const modeSaveNote = modeChanged && <span className="text-body-sm text-slate-500">{t("settings.modeSaveNote")}</span>;
  const credentialField = (kind: "jira" | "anthropic") =>
    creds.data && <CredentialField kind={kind} status={creds.data} remoteClient={remoteClient} help={t(kind === "jira" ? "settings.jiraTokenHelp" : "settings.anthropicKeyHelp")} />;
  const setRow = (i: number, patch: Partial<RepoRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const onSave = () => {
    setInvalid(built.error);
    if (built.error) return;
    void save.run(built.config).then(setSaved);
  };

  /** Executor model (loopback-only like the rest of `executor`, R21): read-only on a paired phone. */
  const modelField = (
    <Field label={t("settings.executorModel")}>
      <Input
        value={draft.executor.model ?? ""}
        disabled={remoteClient}
        placeholder="claude-opus-5-5"
        className="max-w-sm font-mono"
        onChange={(e) => setDraft({ ...draft, executor: { ...draft.executor, model: e.target.value } })}
      />
      <ThisWill>{t("settings.executorModelThisWill")}</ThisWill>
      <OnMacNote show={remoteClient} />
    </Field>
  );

  const bodyOf = (section: Section) => {
    switch (section) {
      case "executor":
        return (
          <div className="flex max-w-xl flex-col gap-3">
            <ModeRadios
              name="executor-kind"
              label={t("settings.executorMode")}
              value={draft.executor.kind}
              readOnly={!editable("executor.kind", remoteClient)}
              options={[
                { value: "claude-code", label: t("settings.executorSubscription"), thisWill: t("settings.executorThisWill") },
                { value: "claude-api", label: t("settings.executorApi"), thisWill: t("settings.executorApiThisWill") },
              ]}
              onChange={(kind) => setDraft({ ...draft, executor: { ...draft.executor, kind } })}
            />
            {comboAlert}
            {modeSaveNote}
            {draft.executor.kind === "claude-api" && credentialField("anthropic")}
            <p className="text-body-md text-slate-600">{t("settings.executorHelp")}</p>
            <Field label={t("settings.executorBin")}>
              <Input value={draft.executor.claudeBin} disabled className="max-w-sm font-mono" />
              <OnMacNote show={remoteClient} />
            </Field>
            {modelField}
            <ModeComparison kind="executor" />
          </div>
        );
      case "jira":
        return (
          <div className="flex max-w-xl flex-col gap-3">
            <ModeRadios
              name="jira-source"
              label={t("settings.jiraMode")}
              value={draft.jira.source}
              readOnly={!editable("jira.source", remoteClient)}
              options={[
                { value: "browser", label: t("settings.jiraBrowserMode"), thisWill: t("settings.jiraBrowserModeThisWill") },
                { value: "api", label: t("settings.jiraApiMode"), thisWill: t("settings.jiraApiModeThisWill") },
              ]}
              onChange={(source) => setDraft({ ...draft, jira: { ...draft.jira, source } })}
            />
            {comboAlert}
            {modeSaveNote}
            {draft.jira.source === "api" && credentialField("jira")}
            <Field label={t("settings.jiraBaseUrl")} help={t("settings.jiraBaseUrlHelp")}>
              <Input
                className="font-mono"
                placeholder={t("settings.jiraBaseUrlPlaceholder")}
                value={draft.jira.baseUrl}
                disabled={remoteClient}
                onChange={(e) => setDraft({ ...draft, jira: { ...draft.jira, baseUrl: e.target.value } })}
              />
              <OnMacNote show={remoteClient} />
            </Field>
            <Field label={t("settings.jiraReadyStatus")} help={t("settings.jiraReadyStatusHelp")}>
              <Input value={draft.jira.readyForDevStatus} disabled={remoteClient} onChange={(e) => setDraft({ ...draft, jira: { ...draft.jira, readyForDevStatus: e.target.value } })} />
              <OnMacNote show={remoteClient} />
            </Field>
            <Field label={t("settings.jiraDiscoverLimit")} help={t("settings.jiraDiscoverLimitHelp")}>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={500}
                step={1}
                className="max-w-32"
                value={Number.isNaN(draft.jira.discoverLimit) ? "" : draft.jira.discoverLimit}
                disabled={remoteClient}
                onChange={(e) => setDraft({ ...draft, jira: { ...draft.jira, discoverLimit: e.target.value === "" ? Number.NaN : Number(e.target.value) } })}
              />
              <OnMacNote show={remoteClient} />
            </Field>
            <label className="flex items-start justify-between gap-3 border-t border-slate-200 pt-3">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body-md">{t("settings.syncStatus")}</span>
                {draft.jira.syncStatus ? <ThisWill>{jiraText("settings.syncStatusThisWill", draft.jira.source)}</ThisWill> : <span className="text-body-sm text-slate-500">{t("settings.syncStatusOff")}</span>}
                <OnMacNote show={!editable("jira.syncStatus", remoteClient)} />
              </span>
              <Switch
                checked={draft.jira.syncStatus}
                disabled={!editable("jira.syncStatus", remoteClient)}
                aria-label={t("settings.syncStatus")}
                onCheckedChange={(v) => setDraft({ ...draft, jira: { ...draft.jira, syncStatus: v } })}
              />
            </label>
            <Field label={t("settings.inProgressStatus")} help={t("settings.inProgressStatusHelp")}>
              <Input
                value={draft.jira.inProgressStatus}
                disabled={!editable("jira.inProgressStatus", remoteClient)}
                onChange={(e) => setDraft({ ...draft, jira: { ...draft.jira, inProgressStatus: e.target.value } })}
              />
              <OnMacNote show={!editable("jira.inProgressStatus", remoteClient)} />
            </Field>
            <Field label={t("settings.reviewStatus")} help={t("settings.reviewStatusHelp")}>
              <Input
                value={draft.jira.reviewStatus}
                disabled={!editable("jira.reviewStatus", remoteClient)}
                onChange={(e) => setDraft({ ...draft, jira: { ...draft.jira, reviewStatus: e.target.value } })}
              />
              <OnMacNote show={!editable("jira.reviewStatus", remoteClient)} />
            </Field>
            {/* the API mode does not use Chrome: no browser to choose or detect */}
            {draft.jira.source === "browser" && (
              <BrowserField value={draft.jira.browser} readOnly={!editable("jira.browser", remoteClient)} onChange={(b) => setDraft({ ...draft, jira: { ...draft.jira, browser: b } })} />
            )}
            <ModeComparison kind="jira" />
          </div>
        );
      case "repos": {
        const ro = !editable("projects", remoteClient);
        return (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-body-sm text-slate-500">{t("settings.repoHelp")}</p>
            {/* below md each mapping is a card (table semantics kept, rows laid out as grids) */}
            <table className="block w-full text-left text-body-sm md:table">
              <thead className="hidden font-mono text-[10.5px] uppercase tracking-wide text-slate-500 md:table-header-group">
                <tr className="border-b border-slate-200">
                  <th className="py-1.5 pr-2 font-medium">{t("settings.repoProject")}</th>
                  <th className="pr-2 font-medium">{t("settings.repoName")}</th>
                  <th className="pr-2 font-medium">{t("settings.repoPath")}</th>
                  <th className="pr-2 font-medium">{t("settings.repoBranch")}</th>
                  <th />
                </tr>
              </thead>
              <tbody className="flex flex-col gap-2 md:table-row-group">
                {rows.length === 0 && (
                  <tr className="block md:table-row">
                    <td colSpan={5} className="py-4 text-center text-slate-500">
                      {t("settings.repoEmpty")}
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => (
                  <tr key={i} className="grid grid-cols-2 gap-2 rounded border border-slate-200 p-3 md:table-row md:border-0 md:border-b md:border-slate-100 md:p-0" data-testid="repo-row">
                    <td className="flex min-w-0 flex-col gap-1 md:table-cell md:py-1 md:pr-2">
                      <span className="text-label-sm text-slate-500 md:hidden">{t("settings.repoProject")}</span>
                      <Input aria-label={t("settings.repoProject")} className="w-full font-mono md:w-24" value={r.key} disabled={ro} onChange={(e) => setRow(i, { key: e.target.value.toUpperCase() })} />
                    </td>
                    <td className="flex min-w-0 flex-col gap-1 md:table-cell md:pr-2">
                      <span className="text-label-sm text-slate-500 md:hidden">{t("settings.repoName")}</span>
                      <Input
                        aria-label={t("settings.repoName")}
                        className="w-full font-mono md:w-32"
                        value={r.name}
                        placeholder={r.path.trim() ? legacyRepoName(r.path) : t("settings.repoNamePlaceholder")}
                        disabled={ro}
                        onChange={(e) => setRow(i, { name: e.target.value.toLowerCase() })}
                      />
                    </td>
                    <td className="col-span-2 flex min-w-0 flex-col gap-1 md:table-cell md:w-1/2 md:pr-2">
                      <span className="text-label-sm text-slate-500 md:hidden">{t("settings.repoPath")}</span>
                      <Input aria-label={t("settings.repoPath")} className="w-full font-mono" value={r.path} disabled={ro} onChange={(e) => setRow(i, { path: e.target.value })} />
                      {/* the repository's commands on this computer (its .slackoff/config.json wins for what it names) */}
                      <details className="group mt-1" data-testid="repo-commands">
                        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-body-sm text-primary md:min-h-7 [&::-webkit-details-marker]:hidden">
                          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
                          {t("settings.repoCommands")}
                          {REPO_COMMANDS.some((k) => (r.commands?.[k] ?? "").trim() !== "") && (
                            <span className="font-mono text-code-sm text-slate-500">({REPO_COMMANDS.filter((k) => (r.commands?.[k] ?? "").trim() !== "").length})</span>
                          )}
                        </summary>
                        <div className="mt-1 grid grid-cols-1 gap-1.5 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
                          {REPO_COMMANDS.map((k) => (
                            <label key={k} className="contents">
                              <span className="text-label-sm text-slate-500">{t(`settings.repoCmd.${k}` as MessageKey)}</span>
                              <Input
                                aria-label={`${t(`settings.repoCmd.${k}` as MessageKey)} — ${r.name || legacyRepoName(r.path)}`}
                                className="w-full font-mono"
                                value={r.commands?.[k] ?? ""}
                                placeholder={k === "install" ? "npm ci" : k === "test" ? "npm test" : k === "lint" ? "npm run lint" : "npm run build"}
                                disabled={ro}
                                onChange={(e) => setRow(i, { commands: { install: "", build: "", lint: "", test: "", ...r.commands, [k]: e.target.value } })}
                              />
                            </label>
                          ))}
                          <span className="text-body-sm text-slate-500 md:col-span-2">{t("settings.repoCommandsHelp")}</span>
                        </div>
                      </details>
                    </td>
                    <td className="flex min-w-0 flex-col gap-1 md:table-cell md:pr-2">
                      <span className="text-label-sm text-slate-500 md:hidden">{t("settings.repoBranch")}</span>
                      <Input aria-label={t("settings.repoBranch")} className="w-full font-mono md:w-28" value={r.baseBranch} disabled={ro} onChange={(e) => setRow(i, { baseBranch: e.target.value })} />
                    </td>
                    <td className="flex items-end md:table-cell">
                      <Button variant="destructive" className="w-full md:w-auto" disabled={ro} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                        {t("settings.repoRemove")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button className="w-fit" disabled={ro} onClick={() => setRows([...rows, { key: rows.at(-1)?.key ?? "", name: "", path: "", baseBranch: "main" }])}>
              {t("settings.repoAdd")}
            </Button>
            <OnMacNote show={ro} />
          </div>
        );
      }
      case "budget": {
        const b = draft.budget;
        const setBudget = (patch: Partial<Config["budget"]>) => setDraft({ ...draft, budget: { ...b, ...patch } });
        return (
          <div className="flex max-w-xl flex-col gap-3" data-testid="budget-settings">
            <p className="text-body-sm text-on-surface-variant">{t("settings.budgetCaption")}</p>
            <label className="flex min-h-11 items-center justify-between gap-3 text-body-md">
              {t("settings.budgetEnabled")}
              <Switch checked={b.enabled} onCheckedChange={(v) => setBudget({ enabled: v })} />
            </label>
            <Field label={t("settings.budgetWindow")}>
              <Select className="h-11 md:h-7" value={b.window} onChange={(e) => setBudget({ window: e.target.value as Config["budget"]["window"] })}>
                <option value="5h">{t("settings.budgetWindow.5h")}</option>
                <option value="day">{t("settings.budgetWindow.day")}</option>
                <option value="week">{t("settings.budgetWindow.week")}</option>
              </Select>
            </Field>
            <LimitField label={t("settings.budgetMaxRuns")} min={1} max={10000} step={1} value={b.maxRuns} onChange={(n) => setBudget({ maxRuns: n })} />
            <LimitField label={t("settings.budgetMaxMinutes")} min={1} max={100000} step={1} value={b.maxRunMinutes} onChange={(n) => setBudget({ maxRunMinutes: n })} />
            {draft.executor.kind === "claude-api" ? (
              <LimitField label={t("settings.budgetMaxUsd")} min={0.01} max={100000} step={0.01} value={b.maxUsd} onChange={(n) => setBudget({ maxUsd: n })} />
            ) : (
              <span className="text-body-sm text-on-surface-variant">{t("settings.budgetSubscriptionNote")}</span>
            )}
            <LimitField label={t("settings.budgetWarnAt")} min={50} max={99} step={1} value={Math.round(b.warnAt * 100)} onChange={(n) => setBudget({ warnAt: n === null ? Number.NaN : n / 100 })} />
          </div>
        );
      }
      case "tracing": {
        // phase 4c Task 5 (C-7, C-8): this computer only; a paired phone sees it read-only (it may still export from Cost & quota)
        const tel = draft.telemetry;
        const setTel = (patch: Partial<Config["telemetry"]>) => setDraft({ ...draft, telemetry: { ...tel, ...patch } });
        const local = editable("telemetry.endpoint", remoteClient);
        return (
          <div className="flex min-w-0 max-w-xl flex-col gap-3" data-testid="tracing-settings">
            <p role="note" data-testid="tracing-warning" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-body-sm text-amber-900">
              {t("tracing.warning")}
            </p>
            {remoteClient && <span className="text-body-sm text-amber-800">{t("tracing.onComputer")}</span>}
            <Field label={t("tracing.endpoint")} help={t("tracing.endpointHelp")}>
              <Input
                className="h-11 w-full min-w-0 font-mono md:h-8"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://otel.example.com/v1/traces"
                value={tel.endpoint}
                disabled={!local}
                onChange={(e) => setTel({ endpoint: e.target.value })}
              />
              <OnMacNote show={!local} />
            </Field>
            <label className="flex min-h-11 items-start justify-between gap-3 border-t border-slate-200 pt-3">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body-md">{t("tracing.includeContent")}</span>
                <span className="text-body-sm text-slate-500">{t("tracing.includeContentHelp")}</span>
                <OnMacNote show={!editable("telemetry.includeContent", remoteClient)} />
              </span>
              <Switch
                checked={tel.includeContent}
                disabled={!editable("telemetry.includeContent", remoteClient)}
                aria-label={t("tracing.includeContent")}
                onCheckedChange={(v) => setTel({ includeContent: v })}
              />
            </label>
            {tel.includeContent && (
              <p role="alert" data-testid="tracing-content-warning" className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-body-sm font-semibold text-rose-700">
                {t("tracing.contentWarning")}
              </p>
            )}
            {creds.data && <OtlpHeadersField status={creds.data} remoteClient={remoteClient} />}
          </div>
        );
      }
      case "workflow":
        return (
          <div className="flex max-w-xl flex-col gap-3">
            <SandboxStatusCard />
            <label className="flex items-center justify-between gap-3 text-body-md">
              {t("settings.autoRefine")}
              <Switch checked={draft.autoRefine} onCheckedChange={(v) => setDraft({ ...draft, autoRefine: v })} />
            </label>
            <label className="flex items-center justify-between gap-3 text-body-md">
              {t("settings.reviewAcByDefault")}
              <Switch checked={draft.reviewAcByDefault} onCheckedChange={(v) => setDraft({ ...draft, reviewAcByDefault: v })} />
            </label>
            <Field label={t("settings.concurrency")}>
              <Input
                inputMode="numeric"
                className="w-24 font-mono"
                value={concurrencyText}
                onChange={(e) => setConcurrencyText(e.target.value)}
              />
            </Field>
            {/* P-phone: limits stay editable on a paired phone */}
            <span className="pt-1 text-headline-sm">{t("settings.limits")}</span>
            <NumberField label={t("settings.reviewAttempts")} min={1} max={5} value={draft.review.maxAttempts} onChange={(n) => setDraft({ ...draft, review: { maxAttempts: n } })} />
            <NumberField label={t("settings.maxRounds")} min={1} max={5} value={draft.debate.maxRounds} onChange={(n) => setDraft({ ...draft, debate: { maxRounds: n } })} />
            <NumberField label={t("settings.maxSteps")} min={1} max={50} value={draft.development.maxSteps} onChange={(n) => setDraft({ ...draft, development: { ...draft.development, maxSteps: n } })} />
            <NumberField
              label={t("settings.hookTimeout")}
              min={10}
              max={3600}
              value={draft.development.hookTimeoutMs / 1000}
              onChange={(n) => setDraft({ ...draft, development: { ...draft.development, hookTimeoutMs: n * 1000 } })}
            />
            <NumberField
              label={t("settings.commandTimeout")}
              min={10}
              max={3600}
              value={draft.development.commandTimeoutMs / 1000}
              onChange={(n) => setDraft({ ...draft, development: { ...draft.development, commandTimeoutMs: n * 1000 } })}
            />
            <label className="flex items-start justify-between gap-3 border-t border-slate-200 pt-3">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body-md">{t("settings.sandboxOff")}</span>
                <span className="text-body-sm text-slate-500">{t("settings.sandboxHelp")}</span>
                <OnMacNote show={!editable("development.allowUnsandboxedCommands", remoteClient)} />
              </span>
              <Switch
                checked={draft.development.allowUnsandboxedCommands}
                disabled={!editable("development.allowUnsandboxedCommands", remoteClient)}
                aria-label={t("settings.sandboxOff")}
                onCheckedChange={(v) => setDraft({ ...draft, development: { ...draft.development, allowUnsandboxedCommands: v } })}
              />
            </label>
            {draft.development.allowUnsandboxedCommands && (
              <p role="alert" className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-body-sm font-semibold text-rose-700" data-testid="sandbox-warning">
                {t("settings.sandboxWarning")}
              </p>
            )}
            {/* phase 4a (A-3, M5): the git-hooks sandbox opt-out, this computer only */}
            <label className="flex items-start justify-between gap-3 border-t border-slate-200 pt-3">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body-md">{t("settings.hooksSandboxOff")}</span>
                <span className="text-body-sm text-slate-500">{t("settings.hooksSandboxHelp")}</span>
                <OnMacNote show={!editable("development.allowUnsandboxedHooks", remoteClient)} />
              </span>
              <Switch
                checked={draft.development.allowUnsandboxedHooks}
                disabled={!editable("development.allowUnsandboxedHooks", remoteClient)}
                aria-label={t("settings.hooksSandboxOff")}
                onCheckedChange={(v) => setDraft({ ...draft, development: { ...draft.development, allowUnsandboxedHooks: v } })}
              />
            </label>
            {draft.development.allowUnsandboxedHooks && (
              <p role="alert" className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-body-sm font-semibold text-rose-700" data-testid="hooks-sandbox-warning">
                {t("settings.hooksSandboxWarning")}
              </p>
            )}
            {/* phase 4a Task 4: deny listed ports (default) or allow declared ports only, this computer only */}
            <Field label={t("settings.localNetwork")} help={t("settings.localNetworkHelp")}>
              <Select
                className="w-full max-w-sm"
                value={draft.development.localNetwork}
                disabled={!editable("development.localNetwork", remoteClient)}
                onChange={(e) => setDraft({ ...draft, development: { ...draft.development, localNetwork: e.target.value as Config["development"]["localNetwork"] } })}
              >
                <option value="denylist">{t("settings.localNetworkDenylist")}</option>
                <option value="allowlist">{t("settings.localNetworkAllowlist")}</option>
              </Select>
              <OnMacNote show={!editable("development.localNetwork", remoteClient)} />
            </Field>
            <Field label={t("settings.deniedPorts")} help={t("settings.deniedPortsHelp")}>
              <Input
                inputMode="numeric"
                className="max-w-sm font-mono"
                placeholder={t("settings.deniedPortsPlaceholder")}
                value={portsText}
                disabled={!editable("development.deniedLocalPorts", remoteClient)}
                onChange={(e) => setPortsText(e.target.value)}
              />
              <OnMacNote show={!editable("development.deniedLocalPorts", remoteClient)} />
            </Field>
          </div>
        );
      case "acceptance":
        return (
          <div className="flex max-w-xl flex-col gap-3">
            <NumberField
              label={t("settings.acceptStart")}
              min={10}
              max={900}
              value={draft.acceptance.startTimeoutMs / 1000}
              onChange={(n) => setDraft({ ...draft, acceptance: { ...draft.acceptance, startTimeoutMs: n * 1000 } })}
            />
            <NumberField
              label={t("settings.acceptRun")}
              min={60}
              max={7200}
              value={draft.acceptance.runTimeoutMs / 1000}
              onChange={(n) => setDraft({ ...draft, acceptance: { ...draft.acceptance, runTimeoutMs: n * 1000 } })}
            />
            <NumberField
              label={t("settings.acceptCase")}
              min={1}
              max={600}
              value={draft.acceptance.caseTimeoutMs / 1000}
              onChange={(n) => setDraft({ ...draft, acceptance: { ...draft.acceptance, caseTimeoutMs: n * 1000 } })}
            />
            <Field label={t("settings.claudeConfigDir")} help={t("settings.claudeConfigDirHelp")}>
              <Input
                className="font-mono"
                value={draft.acceptance.claudeConfigDir}
                disabled={!editable("acceptance.claudeConfigDir", remoteClient)}
                onChange={(e) => setDraft({ ...draft, acceptance: { ...draft.acceptance, claudeConfigDir: e.target.value } })}
              />
              <OnMacNote show={!editable("acceptance.claudeConfigDir", remoteClient)} />
            </Field>
            <div className="flex flex-col gap-1">
              <span className="text-body-sm text-slate-500">{t("settings.claudeConfigDirLogin")}</span>
              <code className="break-all rounded border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-code-md [overflow-wrap:anywhere]" data-testid="accept-login-command">
                {`CLAUDE_CONFIG_DIR=${shellQuote(draft.acceptance.claudeConfigDir)} claude /login`}
              </code>
            </div>
          </div>
        );
      case "delivery":
        return (
          <div className="flex max-w-xl flex-col gap-3">
            <Field label={t("settings.ghBin")} help={t("settings.ghBinHelp")}>
              <Input
                className="max-w-sm font-mono"
                value={draft.delivery.ghBin}
                disabled={!editable("delivery.ghBin", remoteClient)}
                onChange={(e) => setDraft({ ...draft, delivery: { ...draft.delivery, ghBin: e.target.value } })}
              />
              <OnMacNote show={!editable("delivery.ghBin", remoteClient)} />
            </Field>
            <Field label={t("settings.azBin")} help={t("settings.azBinHelp")}>
              <Input
                className="max-w-sm font-mono"
                value={draft.delivery.azBin ?? "az"}
                disabled={!editable("delivery.azBin", remoteClient)}
                onChange={(e) => setDraft({ ...draft, delivery: { ...draft.delivery, azBin: e.target.value } })}
              />
              <OnMacNote show={!editable("delivery.azBin", remoteClient)} />
            </Field>
            <p className="text-body-sm text-slate-500">{t("settings.deliveryNote")}</p>
          </div>
        );
      case "remote":
        return <RemoteAccessSection draft={draft} setDraft={setDraft} />;
      default:
        return null;
    }
  };

  const feedback = (
    <>
      {invalid && (
        <p role="alert" className="text-body-sm text-rose-600">
          {invalid}
        </p>
      )}
      {save.error && <ErrorBox error={save.error} />}
    </>
  );

  if (phoneSections) {
    const jiraOk = config.jira.baseUrl !== "";
    const phoneCard = "flex flex-col gap-3 rounded-lg bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.08)]";
    return (
      <>
        {phoneSections.map((sec) => {
          const meta = SECTIONS.find((x) => x.id === sec);
          return (
            <section key={sec} id={`settings-${sec}`} className={cn(phoneCard, "scroll-mt-[calc(var(--header-h,4rem)+0.75rem)]")}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-headline-md [&_svg]:size-5 [&_svg]:text-primary">
                  {meta?.icon}
                  {meta?.label}
                </span>
                {sec === "executor" && <span className="rounded bg-emerald-100 px-2 py-0.5 font-mono text-code-sm text-emerald-800">{t("settings.active")}</span>}
                {sec === "jira" && (
                  <span className={cn("flex items-center gap-1.5 font-mono text-code-sm", jiraOk ? "text-tertiary" : "text-rose-600")}>
                    <span className="size-2 rounded-full bg-current" />
                    {jiraOk ? t("top.jiraConfigured") : t("top.jiraNotConfigured")}
                  </span>
                )}
              </div>
              {bodyOf(sec)}
            </section>
          );
        })}
        <section className={phoneCard}>
          {feedback}
          <Button variant="primary" disabled={!dirty || save.pending} onClick={onSave}>
            <Save className="size-4" />
            {t("settings.saveConfig")}
          </Button>
          <span className="text-body-sm text-on-surface-variant">
            {t("common.thisWill")} {t("settings.saveConfigThisWill")}
            {saved && !dirty && <span className="ml-1 text-emerald-700">{t("settings.saved")}</span>}
          </span>
        </section>
      </>
    );
  }

  const body = bodyOf(section);
  return (
    <Card>
      <CardHeader title={SECTIONS.find((s) => s.id === section)?.label} />
      <div className="flex flex-col gap-4 p-4">
        {body}
        {feedback}
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3">
          <Button
            variant="primary"
            disabled={!dirty || save.pending}
            onClick={onSave}
          >
            <Save className="size-3.5" />
            {t("settings.saveConfig")}
          </Button>
          <ThisWill>{t("settings.saveConfigThisWill")}</ThisWill>
          {saved && !dirty && <span className="text-body-sm text-emerald-700">{t("settings.saved")}</span>}
        </div>
      </div>
    </Card>
  );
}

// ---- agent prompts ----

function layerOf(p: PromptInfo | undefined): string {
  if (!p?.current || p.current.text === "") return t("settings.layerDefault");
  return t("settings.layerCustom", { v: p.current.version });
}

function RoleItem({ role, active, onSelect }: { role: AgentRole; active: boolean; onSelect: () => void }) {
  const p = useApi<PromptInfo>(paths.prompt(role));
  const missing = p.error instanceof ApiError && p.error.status === 404;
  return (
    <button
      onClick={onSelect}
      className={cn("flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left", active ? "bg-surface-container-high" : "hover:bg-slate-50")}
    >
      <span className={cn("font-mono text-code-lg", active && "font-semibold text-primary", missing && "text-slate-400")}>{role}</span>
      <span className={cn("rounded px-1 font-mono text-code-sm", p.data?.current?.text ? "bg-primary text-white" : "bg-slate-100 text-slate-500")}>
        {missing ? t("settings.layerLater") : layerOf(p.data)}
      </span>
    </button>
  );
}

/** `readOnly` on a paired phone: prompt writes are loopback-only (F-I2 / R21; the server enforces it too). */
function PromptEditor({ role, readOnly = false }: { role: AgentRole; readOnly?: boolean }) {
  const info = useApi<PromptInfo>(paths.prompt(role));
  const versions = useApi<PromptVersion[]>(paths.promptVersions(role));
  const [text, setText] = useState("");
  const loadedText = info.data?.current?.text ?? "";
  useEffect(() => setText(loadedText), [role, loadedText]);
  const save = useAction(api.savePrompt);
  const reset = useAction(api.resetPrompt);
  const missing = info.error instanceof ApiError && info.error.status === 404;
  const nextV = (versions.data?.[0]?.version ?? 0) + 1;
  // phase 4d (D-6): Restore default asks first; nothing is sent until Confirm
  const runReset = reset.run;
  const resetGate = useMemo(() => new ConfirmGate((r: AgentRole) => runReset(r)), [runReset]);
  const [asking, setAsking] = useState(false);
  const [showBuiltIn, setShowBuiltIn] = useState(false);
  // phase 4d Task 5: try the unsaved draft once on the sample ticket (this computer, read-only roles, after a confirm)
  const trialOk = trialAvailability(role, !readOnly);
  const [trialAsk, setTrialAsk] = useState(false);
  const [trialRunning, setTrialRunning] = useState(false);
  const [trialResult, setTrialResult] = useState<TrialOutcome | null>(null);
  const [trialError, setTrialError] = useState<string | null>(null);
  const runTrial = async () => {
    setTrialAsk(false);
    setTrialResult(null);
    setTrialError(null);
    clearTrialEvents();
    setTrialRunning(true);
    try {
      setTrialResult(await api.trialPrompt(role, text));
    } catch (e) {
      setTrialError(e instanceof Error ? e.message : String(e));
    } finally {
      setTrialRunning(false);
    }
  };
  // F4D-1 (M1): the bar closes once the request has answered; a failed restore keeps the text (and shows the error)
  const confirmReset = () =>
    confirmAndClose(
      resetGate,
      () => setAsking(false),
      () => setText(""),
    );
  const cancelReset = () => {
    resetGate.cancel();
    setAsking(false);
  };

  if (missing) {
    return <div className="p-4 text-body-md text-slate-500">{t("settings.noSkill")}</div>;
  }
  return (
    <AsyncView state={info}>
      {(p) => (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="break-all rounded bg-surface-container px-1.5 py-0.5 font-mono text-code-md">{t("settings.skill", { name: p.skill.name, version: p.skill.version })}</span>
          </div>
          <div className="flex gap-2 rounded border border-slate-200 bg-slate-50 p-2 text-body-sm text-slate-700">
            <Shield className="size-4 shrink-0 text-amber-700" />
            {t("settings.appendNotice")}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-headline-sm">{t("settings.additional")}</span>
              <span className="font-mono text-code-sm text-slate-500">{t("settings.chars", { n: text.length })}</span>
            </div>
            <Textarea rows={8} value={text} readOnly={readOnly} disabled={readOnly} onChange={(e) => setText(e.target.value)} className="font-mono text-code-lg" aria-label={t("settings.additional")} />
          </div>
          {readOnly && (
            <p role="note" className="text-body-sm text-amber-800">
              {t("settings.promptsOnMac")}
            </p>
          )}
          <div className={cn("flex flex-wrap items-center gap-2", readOnly && "hidden")}>
            <Button variant="blue" disabled={save.pending || text === loadedText} onClick={() => void save.run(role, text)}>
              <Save className="size-3.5" />
              {t("settings.saveAs", { v: nextV })}
            </Button>
            <Button
              disabled={reset.pending || loadedText === ""}
              onClick={() => {
                resetGate.request(role);
                setAsking(true);
              }}
            >
              <RotateCcw className="size-3.5" />
              {t("settings.restoreDefault")}
            </Button>
            {/* a Mac activity (D-8): not shown in the phone layout */}
            <span className="max-md:hidden">
              {trialOk.enabled ? (
                <Button data-testid="trial-button" disabled={trialRunning} onClick={() => setTrialAsk(true)}>
                  <Play className="size-3.5" />
                  {t("settings.tryOnSample")}
                </Button>
              ) : (
                <Tooltip content={trialOk.reason ?? ""}>
                  <span>
                    <Button data-testid="trial-button" disabled>
                      <Play className="size-3.5" />
                      {t("settings.tryOnSample")}
                    </Button>
                  </span>
                </Tooltip>
              )}
            </span>
          </div>
          {!readOnly && <ThisWill>{t("settings.saveAsThisWill", { role })}</ThisWill>}
          {(save.error ?? reset.error) && <ErrorBox error={(save.error ?? reset.error)!} />}
          <div>
            <Button variant="ghost" aria-expanded={showBuiltIn} onClick={() => setShowBuiltIn((v) => !v)}>
              <BookOpen className="size-3.5" />
              {showBuiltIn ? t("prompts.hideBuiltIn") : t("prompts.viewBuiltIn")}
            </Button>
          </div>
          {showBuiltIn && <BuiltInInstructions role={role} />}
          {!trialOk.enabled && !readOnly && <p className="text-body-sm text-slate-500 max-md:hidden">{trialOk.reason}</p>}
          {trialRunning && (
            <div className="flex flex-col gap-1" data-testid="trial-running">
              <span className="text-body-sm text-slate-600">{t("prompts.trialRunning", { role })}</span>
              <LiveLog ticketKey={TRIAL_EVENTS_KEY} roles={[role]} />
            </div>
          )}
          {trialError && <ErrorBox error={trialError} />}
          {trialResult && <TrialResult result={trialResult} />}
          {trialAsk && trialOk.enabled && (
            <ConfirmBar title={t("prompts.trialTitle")} thisWill={trialThisWill(role)} confirmLabel={t("prompts.trialConfirm")} onConfirm={() => void runTrial()} onCancel={() => setTrialAsk(false)} testId="trial-confirm">
              <p className="text-body-sm text-on-surface-variant">{t("prompts.trialBody")}</p>
            </ConfirmBar>
          )}
          {asking && !readOnly && (
            <ResetConfirm role={role} current={loadedText} nextVersion={nextV} pending={reset.pending} onConfirm={() => void confirmReset()} onCancel={cancelReset} />
          )}
          <Card>
            <CardHeader title={t("settings.history")} />
            <AsyncView state={versions} isEmpty={(l) => l.length === 0} empty={t("settings.noHistory")}>
              {(list) => (
                <ul>
                  {list.map((v, i) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5 font-mono text-code-md last:border-b-0">
                      <span className="font-semibold text-primary">v{v.version}</span>
                      <span className="text-slate-500" title={formatTime(v.createdAt)}>
                        {timeAgo(v.createdAt)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-slate-700">{v.text === "" ? t("settings.emptyVersion") : `"${v.text}"`}</span>
                      {i === 0 ? (
                        <Badge tone="done">{t("settings.active")}</Badge>
                      ) : readOnly ? null : (
                        <Button size="sm" variant="ghost" onClick={() => setText(v.text)}>
                          {t("settings.use")}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </AsyncView>
          </Card>
        </div>
      )}
    </AsyncView>
  );
}

function ResetConfirm(p: { role: AgentRole; current: string; nextVersion: number; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  const c = resetConfirmation(p.role, p.current, p.nextVersion);
  return (
    <ConfirmBar title={t("prompts.resetTitle")} thisWill={c.thisWill} confirmLabel={t("prompts.confirmReset")} onConfirm={p.onConfirm} onCancel={p.onCancel} pending={p.pending} testId="reset-confirm">
      <span className="text-body-sm text-on-surface-variant">{t("prompts.resetClears")}</span>
      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-surface-container p-2 font-mono text-code-md">
        {c.preview}
        {c.truncated ? t("prompts.resetMore") : ""}
      </pre>
    </ConfirmBar>
  );
}

/** The skill body (read-only, any device): wraps on phones, scrolls vertically, never sideways. */
function BuiltInInstructions({ role }: { role: AgentRole }) {
  const d = useApi<BuiltInPrompt>(paths.promptDefault(role));
  return (
    <AsyncView state={d}>
      {(b) => (
        <section data-testid="built-in-instructions" className="flex min-w-0 flex-col gap-1">
          <span className="break-all font-mono text-code-sm text-slate-500">{t("prompts.builtInTitle", { name: b.name, version: b.version })}</span>
          <pre className="max-h-96 min-w-0 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded border border-slate-200 bg-slate-50 p-2 font-mono text-code-md">{b.body}</pre>
        </section>
      )}
    </AsyncView>
  );
}

function PromptsSection({ readOnly }: { readOnly: boolean }) {
  const [role, setRole] = useState<AgentRole>("refine-ticket");
  return (
    <Card>
      <CardHeader title={t("settings.prompts")} right={role} />
      <div className="flex flex-col gap-4 p-3 md:grid md:grid-cols-[260px_minmax(0,1fr)]">
        <Select aria-label={t("settings.roles", { n: ROLES.length })} className="w-full font-mono md:hidden" value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <div className="hidden flex-col gap-0.5 md:flex">
          <span className="px-2 pb-1 font-mono text-[10.5px] uppercase tracking-wide text-slate-500">{t("settings.roles", { n: ROLES.length })}</span>
          {ROLES.map((r) => (
            <RoleItem key={r} role={r} active={r === role} onSelect={() => setRole(r)} />
          ))}
        </div>
        <PromptEditor key={role} role={role} readOnly={readOnly} />
      </div>
    </Card>
  );
}

const ROLE_DOT: Partial<Record<AgentRole, string>> = {
  "refine-ticket": "bg-primary",
  "propose-solutions": "bg-secondary",
  "jira-browser": "bg-tertiary",
};

function PhoneRoleRow({ role, onOpen }: { role: AgentRole; onOpen: () => void }) {
  const p = useApi<PromptInfo>(paths.prompt(role));
  const missing = p.error instanceof ApiError && p.error.status === 404;
  return (
    <button onClick={onOpen} className="flex min-h-12 items-center gap-3 rounded px-1 text-left hover:bg-slate-50">
      <span className={cn("size-2.5 shrink-0 rounded-full", missing ? "bg-slate-300" : (ROLE_DOT[role] ?? "bg-primary"))} />
      <span className={cn("min-w-0 truncate font-mono text-code-lg", missing && "text-slate-400")}>{role}</span>
      <span className="shrink-0 rounded bg-surface-container-high px-1.5 font-mono text-code-sm">{missing ? t("settings.layerLater") : layerOf(p.data)}</span>
      <ChevronRight className="ml-auto size-5 shrink-0 text-on-surface-variant" />
    </button>
  );
}

/** Phone settings (Stitch m06): stacked cards; Agents rows open the prompt editor full width. */
function PhoneSettings({ config, state, remoteClient }: { config: ApiState<Config>; state: ConfigDraftState; remoteClient: boolean }) {
  const [role, setRole] = useState<AgentRole | null>(null);
  const card = "flex flex-col gap-3 rounded-lg bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.08)]";
  if (role) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={() => setRole(null)} className="flex min-h-11 items-center gap-1 self-start text-body-md text-primary">
          <ChevronLeft className="size-5" />
          {t("settings.agents")}
        </button>
        <section className={card}>
          <span className="font-mono text-headline-sm">{role}</span>
          <PromptEditor key={role} role={role} readOnly={remoteClient} />
        </section>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <AsyncView state={config}>{(c) => state.form && <ConfigSections section="executor" config={c} state={state} remoteClient={remoteClient} phoneSections={["executor", "jira", "repos", "workflow", "budget", "tracing", "acceptance", "delivery", "remote"]} />}</AsyncView>
      <section className={card}>
        <div className="flex flex-col">
          <span className="flex items-center gap-2 text-headline-md">
            <Bot className="size-5 text-primary" />
            {t("settings.agents")}
          </span>
          <span className="text-body-sm text-on-surface-variant">{t("settings.agentsCaption")}</span>
        </div>
        <div className="flex flex-col">
          {ROLES.map((r) => (
            <PhoneRoleRow key={r} role={r} onOpen={() => setRole(r)} />
          ))}
        </div>
      </section>
      {/* phase 4d: read-only here; edit, clear and re-derive in the desktop layout on this computer */}
      <PreferencesSection readOnly onMacNote={remoteClient} />
    </div>
  );
}

export function SettingsPage() {
  const config = useApi<Config>(paths.config);
  const status = useApi<Status>(paths.status);
  // /settings#<section> opens that section: "Edit" on the Solutions tab (#preferences), "Open Settings" on a blocked ticket
  const [section, setSection] = useState<Section | null>(null);
  const { hash } = useLocation();
  useEffect(() => {
    const target = settingsSectionFromHash(hash);
    if (!target) return;
    setSection(target);
    // the phone layout stacks every section: bring the named one into view once it has rendered
    if (window.matchMedia("(max-width: 767.98px)").matches) {
      let tries = 0;
      const find = () => {
        const el = document.getElementById(`settings-${target}`);
        if (el) el.scrollIntoView({ block: "start" });
        else if (++tries < 20) timer = window.setTimeout(find, 100);
      };
      let timer = window.setTimeout(find, 0);
      return () => window.clearTimeout(timer);
    }
  }, [hash]);
  const active: Section = section ?? (status.data && !status.data.jira.configured ? "jira" : "prompts");
  const draftState = useConfigDraft(config.data);
  const remoteClient = status.data?.local === false;
  // below lg the sub-nav is a pill scroller: bring the active pill into view when (and only when) it changes
  const pillRefs = useRef(new Map<Section, HTMLButtonElement>());
  const prevActive = useRef<Section | undefined>(undefined);
  useEffect(() => {
    const belowLg = window.matchMedia("(max-width: 1023.98px)").matches;
    if (shouldScrollActivePill(prevActive.current, active, belowLg)) pillRefs.current.get(active)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    prevActive.current = active;
  }, [active]);

  return (
    <div className="flex flex-col gap-4 p-4 max-md:min-h-[calc(100dvh-var(--header-h,4rem))] max-md:gap-3 max-md:bg-surface-container-low max-md:px-3">
      {status.data?.restartRequired && (
        <div role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-body-sm text-amber-800 md:hidden">
          {t("settings.restartRequired")}
        </div>
      )}
      <div className="md:hidden">
        <PhoneSettings config={config} state={draftState} remoteClient={remoteClient} />
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2 max-md:hidden">
        <div>
          <h1 className="text-headline-lg">{t("settings.title")}</h1>
          <p className="text-body-md text-slate-600">{t("settings.subtitle")}</p>
        </div>
        <span className="flex items-center gap-1.5 rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-code-md">
          <span className="size-1.5 rounded-full bg-tertiary" />
          {t("settings.executor")}: {status.data?.executor.label ?? t("settings.executorValue")}
        </span>
      </div>
      {status.data?.restartRequired && (
        <div role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-body-sm text-amber-800 max-md:hidden">
          {t("settings.restartRequired")}
        </div>
      )}
      <div className="flex flex-col gap-4 max-md:hidden lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
        {/* below lg the sub-nav is a row of scrollable pills */}
        <Card className="scroll-x flex flex-row gap-1 p-1 lg:flex-col lg:gap-0.5 lg:p-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              ref={(el) => {
                if (el) pillRefs.current.set(s.id, el);
                else pillRefs.current.delete(s.id);
              }}
              onClick={() => setSection(s.id)}
              aria-current={active === s.id ? "page" : undefined}
              className={cn("flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded px-3 text-body-md lg:h-8 lg:px-2", active === s.id ? "bg-surface-container-high font-semibold text-primary" : "text-slate-700 hover:bg-slate-50")}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </Card>
        {active === "prompts" ? (
          <PromptsSection readOnly={remoteClient} />
        ) : active === "preferences" ? (
          <PreferencesSection readOnly={remoteClient} onMacNote={remoteClient} />
        ) : (
          <AsyncView state={config}>{(c) => draftState.form && <ConfigSections section={active} config={c} state={draftState} remoteClient={remoteClient} />}</AsyncView>
        )}
      </div>
    </div>
  );
}
