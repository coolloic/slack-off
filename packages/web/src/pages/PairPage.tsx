import { Smartphone } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorBox } from "../components/AsyncView.tsx";
import { ThisWill } from "../components/ThisWill.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { t } from "../i18n/en.ts";
import { api } from "../lib/api.ts";
import { deviceNameFromUa, normalizeCode } from "../lib/remote-model.ts";

/** Phone-side pairing (/pair?code=…): outside the app shell, which would otherwise call the API before a session exists. */
export function PairPage() {
  const initial = normalizeCode(new URLSearchParams(window.location.search).get("code"));
  const [code, setCode] = useState(initial);
  const [name, setName] = useState(() => deviceNameFromUa(navigator.userAgent));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ready = code.length === 8 && name.trim() !== "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      await api.redeemPairing(code, name.trim());
      setDone(true);
      window.location.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh justify-center bg-surface-container-low px-4 py-8">
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-md flex-col gap-4 self-start rounded-lg bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
        <div className="flex items-center gap-2">
          <Smartphone className="size-6 text-primary" />
          <h1 className="text-headline-lg">{t("pair.title")}</h1>
        </div>
        <p className="text-body-md text-slate-600">{t("pair.subtitle")}</p>
        {initial === "" && <p className="rounded border border-slate-200 bg-slate-50 p-2 text-body-sm text-slate-700">{t("pair.noCode")}</p>}
        <label className="flex flex-col gap-1">
          <span className="text-label-md text-slate-700">{t("pair.code")}</span>
          <Input
            className="h-11 font-mono text-headline-md tracking-widest md:h-11"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={9}
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
          />
          <span className="text-body-sm text-slate-500">{t("pair.codeHelp")}</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label-md text-slate-700">{t("pair.deviceName")}</span>
          <Input className="h-11 text-body-md md:h-11" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          <span className="text-body-sm text-slate-500">{t("pair.deviceNameHelp")}</span>
        </label>
        {error && <ErrorBox error={error} />}
        {done && (
          <p role="status" className="text-body-md text-emerald-700">
            {t("pair.success")}
          </p>
        )}
        <div className="flex flex-col gap-1">
          <Button type="submit" variant="blue" size="lg" className="w-full md:h-11" disabled={!ready || pending || done}>
            {t("pair.submit")}
          </Button>
          <ThisWill>{t("pair.submitThisWill")}</ThisWill>
        </div>
      </form>
    </main>
  );
}
