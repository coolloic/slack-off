import { Lock, QrCode, Smartphone } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AsyncView, ErrorBox } from "../components/AsyncView.tsx";
import { ThisWill } from "../components/ThisWill.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { t } from "../i18n/en.ts";
import { api, paths, type Config, type Device, type PairingStart, type RemoteInfo } from "../lib/api.ts";
import { useAction, useApi } from "../lib/hooks.ts";
import { pairingPanelState, qrModules, qrPath, secondsLeft } from "../lib/remote-model.ts";
import { formatTime, timeAgo } from "../lib/utils.ts";

const DEVICES_POLL_MS = 3_000;

function QrSvg({ text }: { text: string }) {
  const { d, size } = useMemo(() => qrPath(qrModules(text)), [text]);
  return (
    <svg role="img" aria-label={t("settings.pairQrLabel")} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className="size-56 max-w-full rounded bg-white">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#0f172a" />
    </svg>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** One-time pairing panel: QR + link + code with a countdown; closes itself when a new device shows up. */
function PairingPanel({ start, onDone, onAgain, newDevice, locked }: { start: PairingStart; onDone: () => void; onAgain: () => void; newDevice: Device | null; locked: boolean }) {
  const now = useNow(newDevice === null && !locked);
  const left = secondsLeft(start.expiresAt, now);
  const code = `${start.code.slice(0, 4)} ${start.code.slice(4)}`;
  const state = pairingPanelState({ paired: newDevice !== null, locked, secondsLeft: left });
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 md:items-start">
      {state === "paired" ? (
        <p role="status" className="text-body-md font-medium text-emerald-700">
          {t("settings.pairedNow", { name: newDevice?.name ?? "" })}
        </p>
      ) : state === "locked" ? (
        <>
          <p role="alert" className="text-body-md text-rose-600">
            {t("settings.pairLocked")}
          </p>
          <div className="flex w-full flex-col gap-1 md:w-auto md:flex-row md:items-center md:gap-3">
            <Button variant="blue" onClick={onAgain}>
              <QrCode className="size-4" />
              {t("settings.pairAgain")}
            </Button>
            <ThisWill>{t("settings.pairPhoneThisWill")}</ThisWill>
          </div>
        </>
      ) : state === "expired" ? (
        <p role="status" className="text-body-md text-rose-600">
          {t("settings.pairExpired")}
        </p>
      ) : (
        <>
          <span className="text-body-sm text-slate-600">{t("settings.pairScan")}</span>
          <div className="flex w-full flex-col items-center gap-3 md:flex-row md:items-start">
            <QrSvg text={start.url} />
            <div className="flex min-w-0 flex-col items-center gap-2 md:items-start">
              <a href={start.url} className="break-all font-mono text-code-md text-primary underline">
                {start.url}
              </a>
              <span className="flex items-baseline gap-2">
                <span className="text-label-sm text-slate-500">{t("settings.pairCode")}</span>
                <span className="font-mono text-headline-md tracking-widest">{code}</span>
              </span>
              <span className="font-mono text-code-sm text-slate-500" aria-live="off">
                {t("settings.pairExpiresIn", { m: Math.floor(left / 60), s: String(left % 60).padStart(2, "0") })}
              </span>
            </div>
          </div>
        </>
      )}
      <Button onClick={onDone} className="w-full md:w-auto">
        {t("settings.pairDone")}
      </Button>
    </div>
  );
}

function DeviceRow({ device }: { device: Device }) {
  const revoke = useAction(api.revokeDevice);
  return (
    <li className="flex flex-col gap-2 border-b border-slate-100 py-2 last:border-b-0 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-center gap-2">
        <Smartphone className="size-4 shrink-0 text-on-surface-variant" />
        <div className="flex min-w-0 flex-col">
          <span className="break-words text-body-md font-medium">{device.name}</span>
          <span className="font-mono text-code-sm text-slate-500" title={formatTime(device.createdAt)}>
            {t("settings.devicePaired", { when: timeAgo(device.createdAt) })} · {t("settings.deviceLastSeen", { when: timeAgo(device.lastSeenAt) })}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1 md:items-end">
        <Button variant="destructive" className="w-full md:w-auto" disabled={revoke.pending} onClick={() => void revoke.run(device.id)}>
          {t("settings.deviceRevoke")}
        </Button>
        <ThisWill>{t("settings.deviceRevokeThisWill")}</ThisWill>
        {revoke.error && <ErrorBox error={revoke.error} />}
      </div>
    </li>
  );
}

/** Pair button + paired devices; only rendered for a browser on the Slack Off computer itself. */
function Pairing({ active }: { active: boolean }) {
  const [started, setStarted] = useState<PairingStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const devices = useApi<Device[]>(paths.devices);
  const pairStatus = useApi<{ locked: boolean }>(paths.pairStatus);
  const known = useRef<Set<number> | null>(null);
  const [newDevice, setNewDevice] = useState<Device | null>(null);

  // while a code is open, poll the device list so the panel can confirm the phone paired
  const reload = devices.reload;
  const reloadStatus = pairStatus.reload;
  useEffect(() => {
    if (!started || newDevice) return;
    const id = setInterval(() => {
      reload();
      reloadStatus();
    }, DEVICES_POLL_MS);
    return () => clearInterval(id);
  }, [started, newDevice, reload, reloadStatus]);
  useEffect(() => {
    if (!devices.data) return;
    if (started && known.current) {
      const fresh = devices.data.find((d) => !known.current!.has(d.id));
      if (fresh) setNewDevice(fresh);
    }
    if (!started) known.current = new Set(devices.data.map((d) => d.id));
  }, [devices.data, started]);

  const onPair = async () => {
    setPending(true);
    setError(null);
    try {
      known.current = new Set((devices.data ?? []).map((d) => d.id));
      setNewDevice(null);
      setStarted(await api.startPairing());
      reloadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {started ? (
        <PairingPanel
          start={started}
          newDevice={newDevice}
          locked={pairStatus.data?.locked === true}
          onDone={() => setStarted(null)}
          onAgain={() => void onPair()}
        />
      ) : (
        <div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-3">
          <Button variant="blue" disabled={!active || pending} onClick={() => void onPair()}>
            <QrCode className="size-4" />
            {t("settings.pairPhone")}
          </Button>
          <ThisWill>{t("settings.pairPhoneThisWill")}</ThisWill>
        </div>
      )}
      {!active && <p className="text-body-sm text-slate-500">{t("settings.remoteEnableFirst")}</p>}
      {error && <ErrorBox error={error} />}
      <div className="flex flex-col gap-1">
        <span className="text-headline-sm">{t("settings.devices")}</span>
        <AsyncView state={devices} isEmpty={(l) => l.length === 0} empty={t("settings.devicesEmpty")}>
          {(list) => (
            <ul className="flex flex-col">
              {list.map((d) => (
                <DeviceRow key={d.id} device={d} />
              ))}
            </ul>
          )}
        </AsyncView>
      </div>
    </div>
  );
}

/** Settings → Remote access. The toggle and host live in the shared config draft (saved with "Save settings"). */
export function RemoteAccessSection({ draft, setDraft }: { draft: Config; setDraft: (c: Config) => void }) {
  const remote = useApi<RemoteInfo>(paths.remote);
  return (
    <AsyncView state={remote}>
      {(r) => {
        const set = (patch: Partial<Config["remoteAccess"]>) => setDraft({ ...draft, remoteAccess: { ...draft.remoteAccess, ...patch } });
        const detected = r.detected ? [r.detected.ip, r.detected.dnsName].filter(Boolean).join(" · ") : null;
        return (
          <div className="flex min-w-0 max-w-2xl flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {r.active ? <Badge tone="done">{t("settings.remoteActive")}</Badge> : <Badge>{t("settings.remoteLocalOnly")}</Badge>}
              <span className="text-body-sm text-slate-600">{detected ? t("settings.remoteDetected", { address: detected }) : t("settings.remoteNotDetected")}</span>
            </div>
            {r.active && (
              <div className="flex flex-col gap-0.5">
                <span className="text-body-sm text-slate-600">{t("settings.remoteListening")}</span>
                <span className="break-all font-mono text-code-lg">{r.active.url}</span>
                {r.active.dnsName && <span className="break-all font-mono text-code-md text-slate-500">http://{r.active.dnsName}:4317</span>}
              </div>
            )}
            {!r.local && <p className="rounded border border-slate-200 bg-slate-50 p-2 text-body-sm text-slate-700">{t("settings.remoteFromPhone")}</p>}
            <label className="flex items-start justify-between gap-3">
              <span className="flex flex-col">
                <span className="text-body-md">{t("settings.remoteToggle")}</span>
                <ThisWill>{t("settings.remoteToggleThisWill")}</ThisWill>
              </span>
              <Switch
                aria-label={t("settings.remoteToggle")}
                checked={draft.remoteAccess.enabled}
                disabled={!r.local}
                onCheckedChange={(v) => set({ enabled: v })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-label-md text-slate-700">{t("settings.remoteHost")}</span>
              <Input
                className="w-full max-w-sm font-mono"
                placeholder={t("settings.remoteHostPlaceholder")}
                value={draft.remoteAccess.host}
                disabled={!r.local}
                onChange={(e) => set({ host: e.target.value })}
              />
              <span className="text-body-sm text-slate-500">{t("settings.remoteHostHelp")}</span>
            </label>
            {r.restartRequired && (
              <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-body-sm text-amber-800">
                {t("settings.remoteRestart")}
              </p>
            )}
            {r.local && <Pairing active={r.active !== null} />}
            <p className="flex gap-2 text-body-sm text-slate-600">
              <Lock className="mt-0.5 size-4 shrink-0 text-on-surface-variant" />
              {t("settings.remoteSecurity")}
            </p>
          </div>
        );
      }}
    </AsyncView>
  );
}
