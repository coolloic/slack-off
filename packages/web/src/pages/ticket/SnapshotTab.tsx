import { AlertTriangle, Clock, Download, FileText, Image as ImageIcon, Loader2, Lock, MessageSquare, Paperclip, Wand2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { AsyncView, Empty } from "../../components/AsyncView.tsx";
import { ThisWill } from "../../components/ThisWill.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardHeader } from "../../components/ui/card.tsx";
import { Select } from "../../components/ui/input.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { t } from "../../i18n/en.ts";
import { api, paths, type Snapshot, type SnapshotSummary, type Status } from "../../lib/api.ts";
import { useAction, useApi, useLive, type ApiState } from "../../lib/hooks.ts";
import { jiraText } from "../../lib/jira-mode.ts";
import { incompleteLabel, jiraImage, pickAfterNavigation, selectedSnapshotId, type PickState } from "../../lib/snapshot-model.ts";
import { anchor } from "../../lib/sources.ts";
import { cn, formatTime, paragraphs, timeAgo } from "../../lib/utils.ts";

/** Scroll to and mark `?focus=`; re-runs on every navigation (location.key), so clicking the same source link again works. */
function useFocus(ready: boolean): string | null {
  const [params] = useSearchParams();
  const { key: navKey } = useLocation();
  const focus = params.get("focus");
  useEffect(() => {
    if (!ready || !focus) return;
    for (const old of document.querySelectorAll(".highlight-flash")) old.classList.remove("highlight-flash");
    const el = [...document.querySelectorAll<HTMLElement>(`[data-anchor="${CSS.escape(focus)}"]`)].find((x) => x.offsetParent !== null);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.remove("highlight-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("highlight-flash");
  }, [ready, focus, navKey]);
  return focus;
}

function Timeline({
  list,
  selected,
  onSelect,
}: {
  list: SnapshotSummary[];
  selected: number;
  onSelect: (id: number) => void;
}) {
  const n = list.length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-wide text-slate-500">
        <span>{t("snap.history")}</span>
        <span>{t("snap.revisions", { n })}</span>
      </div>
      {list.map((s, i) => {
        const v = n - i; // list is newest first
        const isLatest = i === 0;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={cn("flex flex-col gap-1 rounded border p-2 text-left", s.id === selected ? "border-primary-container bg-blue-50/40" : "border-slate-200 hover:bg-slate-50")}
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-label-md">
                <span className={cn("rounded px-1 font-mono text-code-sm", isLatest ? "bg-primary text-white" : "bg-slate-100")}>v{v}</span>
                {isLatest ? t("snap.current") : v === 1 ? t("snap.baseline") : `#${s.id}`}
              </span>
              <span className={cn("font-mono text-code-sm", isLatest ? "text-tertiary" : "text-slate-500")}>{isLatest ? t("snap.active") : t("snap.frozen")}</span>
            </div>
            <span className="font-mono text-code-sm text-slate-500" title={formatTime(s.fetchedAt)}>
              {t("snap.fetched", { ago: timeAgo(s.fetchedAt) })}
            </span>
            {s.changeSummary && <span className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-code-sm text-amber-800">{s.changeSummary}</span>}
            {s.commentsNotLoaded !== null && s.commentsNotLoaded !== undefined && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-code-sm text-amber-900">{t("snap.incompleteShort")}</span>
            )}
            <span className="flex justify-between font-mono text-code-sm text-slate-500">
              <span>{t("snap.sha256")}</span>
              <span className="font-semibold text-slate-700">{s.contentHash.slice(0, 8)}…</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** F-I7: older comments were not loaded by the browser agent, so this snapshot is incomplete. */
function IncompleteFlag({ notLoaded }: { notLoaded: number | null }) {
  const label = incompleteLabel(notLoaded);
  if (!label) return null;
  return (
    <div role="note" data-testid="snapshot-incomplete" className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-body-sm text-amber-900">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" />
      <span className="min-w-0 break-words">{label}</span>
    </div>
  );
}

function Description({ snap, base }: { snap: Snapshot; base: Snapshot | null }) {
  const paras = paragraphs(snap.description);
  const baseParas = base ? paragraphs(base.description) : null;
  const removed = baseParas ? baseParas.filter((p) => !paras.includes(p)) : [];
  return (
    <Card>
      <CardHeader
        icon={<FileText className="size-3.5" />}
        title={t("snap.description")}
        right={
          baseParas && (
            <span className="flex gap-1.5">
              <span className="rounded bg-emerald-100 px-1 text-emerald-800">+ {t("snap.inserted")}</span>
              <span className="rounded bg-rose-100 px-1 text-rose-700 line-through">{t("snap.removed")}</span>
            </span>
          )
        }
      />
      <div className="flex flex-col gap-2 p-3">
        {paras.length === 0 && <Empty>{t("snap.noDescription")}</Empty>}
        {paras.map((p, i) => {
          const inserted = baseParas !== null && !baseParas.includes(p);
          return (
            <div key={i} data-anchor={anchor.paragraph(i + 1)} className={cn("flex gap-3 rounded px-2 py-1", inserted && "bg-emerald-50")}>
              <span className="w-7 shrink-0 pt-0.5 text-right font-mono text-code-sm text-slate-400">{t("snap.paragraph", { n: i + 1 })}</span>
              <p className={cn("min-w-0 whitespace-pre-wrap text-body-md leading-6", inserted && "text-emerald-900")}>{p}</p>
            </div>
          );
        })}
        {removed.map((p, i) => (
          <div key={`r${i}`} className="flex gap-3 rounded bg-rose-50 px-2 py-1">
            <span className="w-7 shrink-0 pt-0.5 text-right font-mono text-code-sm text-rose-400">−</span>
            <p className="min-w-0 whitespace-pre-wrap text-body-md leading-6 text-rose-700 line-through">{p}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function initials(name: string | null): string {
  return (name ?? "?").slice(0, 2).toUpperCase();
}

function Comments({ snap, base }: { snap: Snapshot; base: Snapshot | null }) {
  const baseIds = base ? new Set(base.comments.map((c) => c.jiraCommentId)) : null;
  const ids = new Set(snap.comments.map((c) => c.jiraCommentId));
  const removed = base ? base.comments.filter((c) => !ids.has(c.jiraCommentId)) : [];
  return (
    <Card>
      <CardHeader icon={<MessageSquare className="size-3.5" />} title={t("snap.comments", { n: snap.comments.length })} />
      {snap.comments.length === 0 && <Empty>{t("snap.noComments")}</Empty>}
      {[...snap.comments.map((c) => ({ c, gone: false })), ...removed.map((c) => ({ c, gone: true }))].map(({ c, gone }) => {
        const isNew = baseIds !== null && !baseIds.has(c.jiraCommentId);
        return (
          <div
            key={`${gone ? "r" : ""}${c.id}`}
            data-anchor={!gone && c.jiraCommentId ? anchor.comment(c.jiraCommentId) : undefined}
            className={cn("flex gap-3 border-b border-slate-100 px-3 py-2.5 last:border-b-0", isNew && "bg-amber-50/50", gone && "bg-rose-50/60")}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-200 font-mono text-[10px] font-semibold text-slate-700">{initials(c.author)}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="text-headline-sm">{c.author ?? "—"}</span>
                  {isNew && <Badge tone="decision">{t("snap.newInLatest")}</Badge>}
                  {gone && <Badge tone="blocked">{t("snap.removedInLatest")}</Badge>}
                </span>
                <span className="flex items-center gap-2 font-mono text-code-sm text-slate-500">
                  <span title={formatTime(c.created)}>{timeAgo(c.created)}</span>
                  {c.jiraCommentId && <span className="rounded bg-slate-100 px-1 font-semibold text-slate-700">#{c.jiraCommentId}</span>}
                </span>
              </div>
              <p className={cn("whitespace-pre-wrap break-words text-body-md leading-6", gone && "line-through")}>{c.body}</p>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

/**
 * An image Slack Off holds no copy of, shown from JIRA with the developer's own sign-in (jiraImage). It fails where
 * this browser is not signed in to JIRA (a phone, another browser): then the fallback shows instead.
 */
function JiraThumb({ img, filename, className, fallback }: { img: { thumbnail: string; full: string }; filename: string | null; className: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <a href={img.full} target="_blank" rel="noreferrer" aria-label={t("snap.openImage", { name: filename ?? "—" })} className={cn("flex items-center justify-center overflow-hidden", className)}>
      <img src={img.thumbnail} alt={filename ?? ""} loading="lazy" referrerPolicy="no-referrer" data-testid="jira-thumb" onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
    </a>
  );
}

/** An attachment read without its bytes (Chrome mode, or over the API budget): open the ticket in JIRA, where the developer is signed in. */
function ViewInJira({ filename, jiraUrl, className }: { filename: string | null; jiraUrl: string | null; className: string }) {
  if (!jiraUrl) return <span className={className}>{t("snap.metadataOnly")}</span>;
  return (
    <a href={jiraUrl} target="_blank" rel="noreferrer" aria-label={t("snap.viewInJiraNamed", { name: filename ?? "—" })} className={cn(className, "text-primary hover:underline")}>
      {t("snap.viewInJira")}
    </a>
  );
}

function Attachments({ snap, ticketKey, jiraUrl, jiraBase }: { snap: Snapshot; ticketKey: string; jiraUrl: string | null; jiraBase: string | undefined }) {
  return (
    <Card>
      <CardHeader icon={<Paperclip className="size-3.5" />} title={t("snap.attachments", { n: snap.attachments.length })} />
      {snap.attachments.length === 0 ? (
        <Empty>{t("snap.noAttachments")}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 p-2 md:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
          {snap.attachments.map((a) => {
            const href = paths.attachment(ticketKey, snap.id, a.id);
            const image = a.localPath && a.mime?.startsWith("image/");
            const remote = jiraImage(a, jiraBase);
            const label = <span className="font-mono text-code-md text-slate-500">{a.mime ?? a.kind}</span>;
            return (
              <div key={a.id} data-anchor={a.filename ? anchor.attachment(a.filename) : undefined} className="flex flex-col rounded border border-slate-200">
                <div className="flex h-24 items-center justify-center overflow-hidden bg-surface-container-low">
                  {image ? (
                    <img src={href} alt={a.filename ?? ""} className="max-h-full object-contain" />
                  ) : remote ? (
                    <JiraThumb img={remote} filename={a.filename} className="size-full" fallback={label} />
                  ) : (
                    label
                  )}
                </div>
                <div className="flex flex-col gap-0.5 border-t border-slate-200 p-2">
                  <span className="truncate text-label-md" title={a.filename ?? ""}>
                    {a.filename ?? "—"}
                  </span>
                  <span className="font-mono text-code-sm text-slate-500">{t("snap.sha256")}: {a.sha256 ? a.sha256.slice(0, 8) : "—"}</span>
                  <span className="flex items-center justify-between font-mono text-code-sm">
                    <span className="text-slate-500">{a.kind === "inline_image" ? t("snap.kindInline") : t("snap.kindAttachment")}</span>
                    {a.localPath ? (
                      <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        {t("snap.download")}
                      </a>
                    ) : (
                      <ViewInJira filename={a.filename} jiraUrl={jiraUrl} className="text-slate-400" />
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** Phone snapshot (Stitch m05): version picker + change chip, ticket card, anchored paragraphs, comments, attachment rows. */
function PhoneSnapshot({
  ticketKey,
  jiraUrl,
  jiraBase,
  canRead,
  list,
  selectedId,
  onPick,
  snap,
  v1,
}: {
  ticketKey: string;
  jiraUrl: string | null;
  list: SnapshotSummary[];
  selectedId: number | null;
  onPick: (id: number) => void;
  snap: ApiState<Snapshot>;
  v1: Snapshot | undefined;
  jiraBase: string | undefined;
  canRead: boolean;
}) {
  const idx = list.findIndex((x) => x.id === selectedId);
  const version = idx >= 0 ? list.length - idx : 0;
  const changed = v1 !== undefined && snap.data !== undefined && snap.data.id !== v1.id && snap.data.contentHash !== v1.contentHash;
  const card = "flex flex-col gap-2.5 rounded-lg bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.08)]";
  return (
    <div className="flex flex-col gap-3 bg-surface-container-low px-3 py-3 md:hidden">
      <section className={card}>
        <div className="flex items-center gap-2">
          <span className="relative flex min-w-0 flex-1 items-center">
            <Clock className="pointer-events-none absolute left-3 size-4 text-on-surface-variant" />
            <Select aria-label={t("snap.history")} className="w-full bg-surface-container-low pl-9 font-mono" value={selectedId ?? ""} onChange={(e) => onPick(Number(e.target.value))}>
              {list.map((x, i) => (
                <option key={x.id} value={x.id}>
                  {t("snap.versionAgo", { v: list.length - i, ago: timeAgo(x.fetchedAt) })}
                </option>
              ))}
            </Select>
          </span>
          {changed && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-secondary-fixed px-2.5 py-1 text-label-sm text-on-secondary-fixed-variant">
              <span className="size-1.5 rounded-full bg-secondary" />
              {t("snap.changedSince", { v: 1 })}
            </span>
          )}
        </div>
        <span className="flex items-center gap-1.5 text-body-sm text-on-surface-variant">
          <Lock className="size-4 shrink-0" />
          {t("snap.readOnlyCaption")}
        </span>
        {canRead && <ReadAgain ticketKey={ticketKey} />}
      </section>
      <AsyncView state={snap}>
        {(s) => {
          const paras = paragraphs(s.description);
          const v1Paras = v1 && v1.id !== s.id ? paragraphs(v1.description) : null;
          const v1Comments = v1 && v1.id !== s.id ? new Set(v1.comments.map((c) => c.jiraCommentId)) : null;
          const noneLocal = s.attachments.every((a) => !a.localPath);
          return (
            <>
              <section className={card}>
                <span className="w-fit max-w-full break-all rounded bg-surface-container-high px-2 py-0.5 font-mono text-code-sm">{ticketKey}</span>
                <h2 className="break-words text-headline-md">{s.title}</h2>
                <IncompleteFlag notLoaded={s.commentsNotLoaded} />
              </section>
              <section className={card}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-headline-md">
                    {t("snap.description")}
                    <span className="rounded bg-surface-container-high px-1.5 font-mono text-code-sm">#v{version}</span>
                  </span>
                  <span className="text-body-sm text-on-surface-variant">{t("snap.anchoredCaption")}</span>
                </div>
                {paras.length === 0 && <Empty>{t("snap.noDescription")}</Empty>}
                {paras.map((p, i) => {
                  const isChanged = v1Paras !== null && !v1Paras.includes(p);
                  return (
                    <div key={i} data-anchor={anchor.paragraph(i + 1)} className={cn("flex flex-col gap-1 rounded p-2", isChanged && "bg-secondary-fixed/40")}>
                      <span className="flex items-center gap-2">
                        <span className="rounded bg-surface-container-high px-1.5 font-mono text-code-sm text-on-surface-variant">p{i + 1}</span>
                        {isChanged && (
                          <span className="flex items-center gap-1 text-label-sm text-secondary">
                            <span className="size-1.5 rounded-full bg-secondary" />
                            {t("snap.changed")}
                          </span>
                        )}
                      </span>
                      <p className="whitespace-pre-wrap text-body-md">{p}</p>
                    </div>
                  );
                })}
              </section>
              <section className={card}>
                <span className="text-headline-md">{t("snap.comments", { n: s.comments.length })}</span>
                {s.comments.length === 0 && <Empty>{t("snap.noComments")}</Empty>}
                {s.comments.map((c) => (
                  <div key={c.id} data-anchor={c.jiraCommentId ? anchor.comment(c.jiraCommentId) : undefined} className="flex flex-col gap-1 rounded bg-surface-container-low p-2.5">
                    <span className="flex flex-wrap items-center gap-x-1.5 text-body-sm text-on-surface-variant">
                      {c.jiraCommentId && <span className="font-mono text-code-sm text-primary">{t("snap.commentId", { id: c.jiraCommentId })}</span>}
                      <span>· {c.author ?? "—"}</span>
                      {v1Comments && !v1Comments.has(c.jiraCommentId) && <span className="text-secondary">· {t("snap.newInLatest")}</span>}
                      <span className="ml-auto">{timeAgo(c.created)}</span>
                    </span>
                    <p className="whitespace-pre-wrap text-body-md">{c.body}</p>
                  </div>
                ))}
              </section>
              <section className={card}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-headline-md">{t("snap.attachmentsShort", { n: s.attachments.length })}</span>
                  {s.attachments.length > 0 && noneLocal && <span className="text-body-sm text-on-surface-variant">{t("snap.notDownloaded")}</span>}
                </div>
                {s.attachments.length === 0 && <Empty>{t("snap.noAttachments")}</Empty>}
                {s.attachments.map((a) => (
                  <div key={a.id} data-anchor={a.filename ? anchor.attachment(a.filename) : undefined} className="flex items-center gap-3 rounded bg-surface-container-low p-2.5">
                    {(() => {
                      const icon = (
                        <span className="flex size-10 shrink-0 items-center justify-center rounded bg-surface-container-high text-primary">
                          {a.mime?.startsWith("image/") ? <ImageIcon className="size-5" /> : <FileText className="size-5" />}
                        </span>
                      );
                      const remote = jiraImage(a, jiraBase);
                      return remote ? <JiraThumb img={remote} filename={a.filename} className="size-14 shrink-0 rounded bg-surface-container-high" fallback={icon} /> : icon;
                    })()}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-mono text-code-md">{a.filename ?? "—"}</span>
                      <span className="truncate text-body-sm text-on-surface-variant">
                        {a.mime ?? a.kind} · {t("snap.sha256")} {a.sha256 ? a.sha256.slice(0, 8) : "—"}
                      </span>
                    </span>
                    {a.localPath ? (
                      <a href={paths.attachment(ticketKey, s.id, a.id)} target="_blank" rel="noreferrer" className="flex min-h-11 shrink-0 items-center px-2 text-primary">
                        {t("snap.download")}
                      </a>
                    ) : (
                      <ViewInJira filename={a.filename} jiraUrl={jiraUrl} className="flex min-h-11 shrink-0 items-center px-2 text-label-sm" />
                    )}
                  </div>
                ))}
              </section>
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}

/** Read the ticket again from JIRA (read-only, nothing else runs): an unchanged ticket adds no version; Chrome mode also records the image addresses. */
function ReadAgain({ ticketKey, className }: { ticketKey: string; className?: string }) {
  const read = useAction(api.readJira);
  const { running } = useLive();
  const reading = read.pending || running[ticketKey] === "jira-browser";
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Button className="min-h-11 w-full md:min-h-9" disabled={reading} onClick={() => void read.run(ticketKey)} data-testid="snapshot-read-again">
        {reading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
        {reading ? t("snap.reading") : t("snap.readAgain")}
      </Button>
      {read.error && <span role="alert" className="text-body-sm text-rose-700">{read.error}</span>}
    </div>
  );
}

/**
 * No snapshot yet. A discovered ticket has only its list entry (key, title, status): Read from JIRA saves the
 * snapshot without refining (read-only); Start refining reads it too and then runs the refine agent.
 */
function NoSnapshot({ ticketKey, canRefine }: { ticketKey: string; canRefine: boolean }) {
  const read = useAction(api.readJira);
  const refine = useAction(api.refine);
  const { running } = useLive();
  const reading = read.pending || running[ticketKey] === "jira-browser";
  const error = read.error ?? refine.error;
  return (
    <div className="flex flex-col items-center gap-3">
      <span>{canRefine ? t("snap.emptyDiscovered") : t("snap.empty")}</span>
      {canRefine && (
        <>
          {reading ? (
            <span role="status" data-testid="snapshot-reading" className="flex min-h-11 items-center gap-2 font-semibold text-primary md:min-h-9">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("snap.reading")}
            </span>
          ) : (
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="blue" className="min-h-11 px-4 md:min-h-9" disabled={refine.pending} onClick={() => void read.run(ticketKey)} data-testid="snapshot-read">
                <Download className="size-4" aria-hidden />
                {t("snap.readFromJira")}
              </Button>
              <Button className="min-h-11 px-4 md:min-h-9" disabled={refine.pending} onClick={() => void refine.run(ticketKey)} data-testid="snapshot-refine">
                <Wand2 className="size-4" aria-hidden />
                {t("snap.startRefining")}
              </Button>
            </div>
          )}
          <ThisWill>{t("snap.readFromJiraThisWill")}</ThisWill>
        </>
      )}
      {error && <span role="alert" className="text-rose-700">{error}</span>}
    </div>
  );
}

export function SnapshotTab({ ticketKey, jiraUrl, snapshots, canRefine = false, canRead = false }: { ticketKey: string; jiraUrl: string | null; snapshots: ApiState<SnapshotSummary[]>; canRefine?: boolean; canRead?: boolean }) {
  const list = snapshots.data ?? [];
  const firstId = list[list.length - 1]?.id ?? null;
  // the configured JIRA: images Slack Off holds no copy of are shown from it (jiraImage)
  const jiraBase = useApi<Status>(paths.status).data?.jira.baseUrl || undefined;
  // `?snap=<id>` (from an AC source link) preselects the snapshot the requirement was built from.
  const [params] = useSearchParams();
  const { key: navKey } = useLocation();
  const snapParam = params.get("snap");
  const [pickState, setPickState] = useState<PickState>({ navKey, picked: null });
  // every navigation (even to the same ?snap= link) drops a manual pick so the linked snapshot shows again
  const current = pickAfterNavigation(pickState, navKey);
  if (current !== pickState) setPickState(current);
  const picked = current.picked;
  const setPicked = (id: number | null) => setPickState({ navKey, picked: id });
  const [compare, setCompare] = useState(false);
  const selectedId = selectedSnapshotId(picked, snapParam, list.map((s) => s.id));
  const snap = useApi<Snapshot>(selectedId !== null ? paths.snapshot(ticketKey, selectedId) : null);
  const canCompare = list.length > 1;
  // phones always mark changes against v1
  const v1 = useApi<Snapshot>(canCompare && firstId !== null ? paths.snapshot(ticketKey, firstId) : null);
  const base = useApi<Snapshot>(compare && canCompare && firstId !== null && firstId !== selectedId ? paths.snapshot(ticketKey, firstId) : null);
  useFocus(snap.data !== undefined);

  return (
    <AsyncView state={snapshots} isEmpty={(l) => l.length === 0} empty={<NoSnapshot ticketKey={ticketKey} canRefine={canRefine} />}>
      {() => (
        <>
        <PhoneSnapshot ticketKey={ticketKey} jiraUrl={jiraUrl} jiraBase={jiraBase} canRead={canRead} list={list} selectedId={selectedId} onPick={setPicked} snap={snap} v1={v1.data} />
        <div className="flex flex-col gap-4 p-4 max-md:hidden lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="flex flex-col gap-3">
            <Card className="hidden p-3 lg:block">
              <div className="flex items-center gap-2 text-headline-sm">
                <Lock className="size-4" />
                {t("snap.immutableTitle")}
              </div>
              <p className="mt-1 text-body-sm text-slate-600">{t("snap.immutableBody")}</p>
            </Card>
            {canRead && <ReadAgain ticketKey={ticketKey} />}
            <label className={cn("flex min-h-11 items-center justify-between rounded border border-slate-200 px-3 py-2 text-label-md", !canCompare && "opacity-50")}>
              {t("snap.compare")}
              <Switch checked={compare && canCompare} disabled={!canCompare} onCheckedChange={setCompare} />
            </label>
            {/* below lg the timeline is a version select above the content */}
            <Select
              aria-label={t("snap.history")}
              className="w-full lg:hidden"
              value={selectedId ?? ""}
              onChange={(e) => setPicked(Number(e.target.value))}
            >
              {list.map((s, i) => (
                <option key={s.id} value={s.id}>
                  v{list.length - i} · {i === 0 ? t("snap.current") : t("snap.frozen")} · {timeAgo(s.fetchedAt)} · {s.contentHash.slice(0, 8)}
                </option>
              ))}
            </Select>
            <div className="hidden lg:block">
              <Timeline list={list} selected={selectedId ?? -1} onSelect={setPicked} />
            </div>
            {snap.data && (
              <Card className="hidden flex-col gap-1.5 p-3 text-body-sm lg:flex">
                <div className="font-mono text-[10.5px] uppercase tracking-wide text-slate-500">{t("snap.provenance")}</div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">{t("snap.fetchedVia")}</span>
                  <span className="text-right font-mono text-code-sm">{jiraText("snap.fetchedViaValue", snap.data.jiraSource)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">{t("snap.jiraUpdated")}</span>
                  <span className="font-mono text-code-sm">{formatTime(snap.data.jiraUpdatedAt)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">{t("snap.contentHash")}</span>
                  <span className="font-mono text-code-sm text-tertiary">{snap.data.contentHash.slice(0, 12)}…</span>
                </div>
                <p className="mt-1 text-code-sm text-slate-500">{t("snap.adjustInJira")}</p>
              </Card>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <AsyncView state={snap}>
              {(s) => {
                const b = compare && base.data ? base.data : null;
                return (
                  <>
                    <h2 className="break-words text-headline-md">{s.title}</h2>
                    <IncompleteFlag notLoaded={s.commentsNotLoaded} />
                    <Description snap={s} base={b} />
                    <Comments snap={s} base={b} />
                    <Attachments snap={s} ticketKey={ticketKey} jiraUrl={jiraUrl} jiraBase={jiraBase} />
                  </>
                );
              }}
            </AsyncView>
          </div>
        </div>
        </>
      )}
    </AsyncView>
  );
}
