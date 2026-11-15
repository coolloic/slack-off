import { KeyRound } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { t } from "../i18n/en.ts";
import { api, type CredentialStatus } from "../lib/api.ts";
import { invalidateAll } from "../lib/hooks.ts";
import { credentialFields, credentialInputError, credentialRequest, type CredentialKind } from "../lib/settings-model.ts";
import { cn } from "../lib/utils.ts";
import { ThisWill } from "./ThisWill.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

/**
 * Phase 4b Task 7 (B-9): one credential — the Anthropic API key, or the JIRA email and API token.
 * - The server never returns a value, so the boxes are never prefilled; what is typed lives in this component's state
 *   only (never a URL, storage or a log) and is cleared as soon as the server has it. It is never echoed back.
 * - Password boxes with autocomplete off. Saving sends one PUT to the credential's own endpoint; "Remove" asks first.
 * - On a paired phone: the status only ("Set on this computer" / "Not set"), read-only.
 */
/** F4B-5 (M-3): a text box that shows dots, so no browser offers to save it as a password */
const MASKED = { WebkitTextSecurity: "disc" } as CSSProperties;

export function CredentialField({ kind, status, remoteClient, help }: { kind: CredentialKind; status: CredentialStatus; remoteClient: boolean; help: string }) {
  const fields = credentialFields(kind, status, remoteClient);
  const set = fields[0]!.set;
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const open = !remoteClient && (!set || editing);
  const what = kind === "jira" ? t("settings.jiraToken") : t("settings.anthropicKey");

  const clear = () => {
    setEmail("");
    setSecret("");
  };
  const done = (ok: boolean, savedNote: boolean) => {
    setPending(false);
    invalidateAll();
    if (ok) {
      clear();
      setEditing(false);
      setSaved(savedNote);
    }
  };
  const save = () => {
    setSaved(false);
    const input = { email, secret };
    const invalid = credentialInputError(kind, input);
    setError(invalid);
    if (invalid) return;
    setPending(true);
    const r = credentialRequest(kind, input);
    api.setCredential(r.path, r.body).then(
      () => done(true, true),
      // the server's message names fields and rules only, never a value
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        done(false, false);
      },
    );
  };
  const remove = () => {
    if (!window.confirm(t("settings.credRemoveConfirm", { what }))) return;
    setSaved(false);
    setError(null);
    setPending(true);
    api.removeCredential(kind).then(
      () => done(true, false),
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        done(false, false);
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded border border-slate-200 p-3" data-testid={`credential-${kind}`}>
      {fields.map((f) => (
        <div key={f.id} className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
            <span className="flex items-center gap-1.5 text-label-md text-slate-700">
              <KeyRound className="size-4 shrink-0 text-slate-500" />
              {f.label}
            </span>
            <span data-testid={`credential-status-${f.id}`} className={cn("font-mono text-code-sm", f.set ? "text-emerald-700" : "text-amber-800")}>
              {f.statusText}
            </span>
          </div>
          {f.hint !== null && <span className="break-all text-body-sm text-slate-500">{t("settings.credHint", { hint: f.hint })}</span>}
          {open && (
            <Input
              aria-label={f.label}
              type={f.inputType}
              name={`slackoff-${f.id.replace(".", "-")}`}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              className="h-11 w-full font-mono md:h-8"
              style={f.masked ? MASKED : undefined}
              data-masked={f.masked ? "true" : undefined}
              value={f.id === "jira.email" ? email : secret}
              onChange={(e) => (f.id === "jira.email" ? setEmail(e.target.value) : setSecret(e.target.value))}
            />
          )}
        </div>
      ))}
      <span className="text-body-sm text-slate-500">{help}</span>
      {remoteClient ? (
        <span className="text-body-sm text-amber-800">{t("settings.credOnComputer")}</span>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {open && (
              <Button variant="primary" disabled={pending} onClick={save}>
                {t("settings.credSave")}
              </Button>
            )}
            {open && set && (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  clear();
                  setError(null);
                  setEditing(false);
                }}
              >
                {t("settings.credCancel")}
              </Button>
            )}
            {!open && (
              <Button disabled={pending} onClick={() => (setSaved(false), setEditing(true))}>
                {t("settings.credReplace")}
              </Button>
            )}
            {set && (
              <Button variant="destructive" disabled={pending} onClick={remove}>
                {t("settings.credRemove")}
              </Button>
            )}
            {saved && <span className="text-body-sm text-emerald-700">{t("settings.credSaved")}</span>}
          </div>
          {open && <ThisWill>{t("settings.credSaveThisWill")}</ThisWill>}
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
