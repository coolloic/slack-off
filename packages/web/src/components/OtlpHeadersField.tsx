import { KeyRound, Plus, X } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { t } from "../i18n/en.ts";
import { api, type CredentialStatus } from "../lib/api.ts";
import { invalidateAll } from "../lib/hooks.ts";
import { headersBody, headersError, MAX_OTLP_HEADERS, type HeaderRow } from "../lib/telemetry-model.ts";
import { timeAgo } from "../lib/utils.ts";
import { ThisWill } from "./ThisWill.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

/** F4B-5 (M-3): a text box that shows dots, so no browser offers to save it as a password */
const MASKED = { WebkitTextSecurity: "disc" } as CSSProperties;
const blank = (): HeaderRow => ({ name: "", value: "" });

/**
 * Phase 4c Task 5: the OTLP auth headers — the CredentialField pattern with name / value pairs (at most 10). The server
 * returns the names only; values are never prefilled or shown, live in this component's state only and are cleared as
 * soon as the server has them. One PUT to /api/credentials/otlp-headers. On a paired phone: the status only.
 */
export function OtlpHeadersField({ status, remoteClient }: { status: CredentialStatus; remoteClient: boolean }) {
  const s = status.otlpHeaders;
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<HeaderRow[]>([blank()]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const open = !remoteClient && (!s.set || editing);

  const finish = (ok: boolean, savedNote: boolean) => {
    setPending(false);
    invalidateAll();
    if (ok) {
      setRows([blank()]);
      setEditing(false);
      setSaved(savedNote);
    }
  };
  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    finish(false, false);
  };
  const save = () => {
    setSaved(false);
    const invalid = headersError(rows);
    setError(invalid);
    if (invalid) return;
    setPending(true);
    api.setOtlpHeaders(headersBody(rows)).then(() => finish(true, true), fail);
  };
  const remove = () => {
    if (!window.confirm(t("tracing.headersRemoveConfirm"))) return;
    setSaved(false);
    setError(null);
    setPending(true);
    api.removeCredential("otlp-headers").then(() => finish(true, false), fail);
  };
  const setRow = (i: number, patch: Partial<HeaderRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const statusText = !s.set
    ? t("settings.credNotSet")
    : remoteClient
      ? t("settings.credSetOnComputer")
      : `${t("tracing.headersSet", { names: s.names.join(", ") })} · ${timeAgo(s.updatedAt)}`;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded border border-slate-200 p-3" data-testid="credential-otlpHeaders">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <span className="flex items-center gap-1.5 text-label-md text-slate-700">
          <KeyRound className="size-4 shrink-0 text-slate-500" />
          {t("tracing.headers")}
        </span>
        <span data-testid="otlp-headers-status" className={s.set ? "min-w-0 break-all font-mono text-code-sm text-emerald-700" : "font-mono text-code-sm text-amber-800"}>
          {statusText}
        </span>
      </div>
      {open &&
        rows.map((r, i) => (
          <div key={i} className="flex min-w-0 flex-col gap-1.5 md:flex-row md:items-center">
            <Input
              aria-label={`${t("tracing.headerName")} ${i + 1}`}
              placeholder="x-api-key"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-11 w-full min-w-0 font-mono md:h-8 md:w-44"
              value={r.name}
              onChange={(e) => setRow(i, { name: e.target.value })}
            />
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Input
                aria-label={`${t("tracing.headerValue")} ${i + 1}`}
                type="text"
                name={`slackoff-otlp-header-${i}`}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-masked="true"
                style={MASKED}
                className="h-11 min-w-0 flex-1 font-mono md:h-8"
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
              />
              {rows.length > 1 && (
                <Button variant="ghost" className="min-h-11 min-w-11 md:min-h-8 md:min-w-8" aria-label={t("tracing.headerRemoveRow")} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
          </div>
        ))}
      <span className="text-body-sm text-slate-500">{t("tracing.headersHelp")}</span>
      {remoteClient ? (
        <span className="text-body-sm text-amber-800">{t("settings.credOnComputer")}</span>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {open && rows.length < MAX_OTLP_HEADERS && (
              <Button variant="ghost" className="min-h-11 md:min-h-8" disabled={pending} onClick={() => setRows([...rows, blank()])}>
                <Plus className="size-4" />
                {t("tracing.headerAdd")}
              </Button>
            )}
            {open && (
              <Button variant="primary" className="min-h-11 md:min-h-8" disabled={pending} onClick={save}>
                {t("tracing.headersSave")}
              </Button>
            )}
            {open && s.set && (
              <Button
                variant="ghost"
                className="min-h-11 md:min-h-8"
                disabled={pending}
                onClick={() => {
                  setRows([blank()]);
                  setError(null);
                  setEditing(false);
                }}
              >
                {t("settings.credCancel")}
              </Button>
            )}
            {!open && (
              <Button className="min-h-11 md:min-h-8" disabled={pending} onClick={() => (setSaved(false), setEditing(true))}>
                {t("tracing.headersReplace")}
              </Button>
            )}
            {s.set && (
              <Button variant="destructive" className="min-h-11 md:min-h-8" disabled={pending} onClick={remove}>
                {t("tracing.headersRemove")}
              </Button>
            )}
            {saved && <span className="text-body-sm text-emerald-700">{t("settings.credSaved")}</span>}
          </div>
          {open && <ThisWill>{t("tracing.headersThisWill")}</ThisWill>}
        </>
      )}
      {error && (
        <p role="alert" className="text-body-sm text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
