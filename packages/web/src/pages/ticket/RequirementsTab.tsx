import type { AcSource, Requirement } from "@slackoff/shared";
import { AlertTriangle, Check, CircleHelp, FileText, ListChecks, MessagesSquare, Pencil, PlusCircle, Plus, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { AsyncView, Empty, ErrorBox } from "../../components/AsyncView.tsx";
import { ClarificationComment, CommentConfirmSheet } from "../../components/ClarificationComment.tsx";
import { DecisionCard } from "../../components/DecisionCard.tsx";
import { SourceTag } from "../../components/SourceTag.tsx";
import { ThisWill } from "../../components/ThisWill.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardHeader } from "../../components/ui/card.tsx";
import { Input, Select, Textarea } from "../../components/ui/input.tsx";
import { t, type MessageKey } from "../../i18n/en.ts";
import type { JiraCommentRecord } from "@slackoff/shared";
import { api, paths, type RequirementRecord, type Snapshot, type TicketDetail } from "../../lib/api.ts";
import { useAction, useApi } from "../../lib/hooks.ts";
import { useDraft } from "../../lib/use-draft.ts";
import { commentDraft, editAc, isDeveloperAdded, nextAcId } from "../../lib/requirements-model.ts";
import { anchor, focusLink, sourceLabel } from "../../lib/sources.ts";
import { cn, paragraphs, timeAgo, STICKY_RAIL } from "../../lib/utils.ts";

type Ac = Requirement["acceptanceCriteria"][number];

/** Source options offered when adding an AC: description paragraphs, comments, attachments, or developer + reason. */
interface SourceOption {
  value: string;
  label: string;
  make: (quote: string) => AcSource;
  defaultQuote: string;
}

function sourceOptions(snap: Snapshot | undefined): SourceOption[] {
  if (!snap) return [];
  const out: SourceOption[] = [];
  paragraphs(snap.description).forEach((p, i) => {
    const ref = `description#p${i + 1}`;
    out.push({ value: ref, label: `${sourceLabel.paragraph(i + 1)} — ${p.slice(0, 40)}`, make: (quote) => ({ type: "description", ref, quote }), defaultQuote: p });
  });
  for (const c of snap.comments) {
    if (!c.jiraCommentId) continue;
    const ref = c.jiraCommentId;
    out.push({ value: `c:${ref}`, label: `${sourceLabel.comment(ref)} (${c.author ?? "?"}) — ${(c.body ?? "").slice(0, 30)}`, make: (quote) => ({ type: "comment", ref, quote }), defaultQuote: c.body ?? "" });
  }
  for (const a of snap.attachments) {
    if (!a.filename) continue;
    const ref = a.filename;
    out.push({ value: `a:${ref}`, label: sourceLabel.attachment(ref), make: (quote) => ({ type: "attachment", ref, quote }), defaultQuote: ref });
  }
  return out;
}

const DEV = "developer";

function AddAcForm({
  acs,
  versions,
  options,
  optionsError,
  onRetryOptions,
  onAdd,
  onCancel,
}: {
  acs: Ac[];
  versions: RequirementRecord[];
  options: SourceOption[];
  optionsError: string | undefined;
  onRetryOptions: () => void;
  onAdd: (ac: Ac) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [verifiable, setVerifiable] = useState(true);
  const [source, setSource] = useState("");
  const [extra, setExtra] = useState(""); // reason (developer) or quote
  const [error, setError] = useState<string | null>(null);
  const id = nextAcId(versions, acs);
  const opt = options.find((o) => o.value === source);

  const reset = () => {
    setText("");
    setVerifiable(true);
    setSource("");
    setExtra("");
    setError(null);
  };
  const submit = () => {
    if (text.trim() === "") return;
    if (source === "" || (source === DEV && extra.trim() === "")) {
      setError(t("req.sourceRequired"));
      return;
    }
    const s: AcSource = source === DEV ? { type: "developer", reason: extra.trim() } : opt!.make(extra.trim() || opt!.defaultQuote);
    onAdd({ id, text: text.trim(), verifiable, source: s });
    reset();
  };

  return (
    <div className="flex flex-col gap-2 border-t border-slate-200 bg-surface-container-low p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-label-sm font-semibold uppercase tracking-[0.05em]">
          <Plus className="size-3.5" />
          {t("req.newAc")}
        </span>
        <span className="font-mono text-code-sm text-slate-500">{t("req.assignsKey", { id })}</span>
      </div>
      {optionsError && <ErrorBox error={`${t("req.sourcesError")} (${optionsError})`} onRetry={onRetryOptions} />}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <Input placeholder={t("req.newAcText")} value={text} onChange={(e) => setText(e.target.value)} aria-label={t("req.newAcText")} />
        <Select
          aria-label={t("req.sourceLabel")}
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setExtra("");
            setError(null);
          }}
        >
          <option value="">{t("req.sourceLabel")}…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          <option value={DEV}>{t("req.sourceDeveloper")}</option>
        </Select>
        <label className="flex items-center gap-2 text-body-sm">
          <input type="checkbox" checked={verifiable} onChange={(e) => setVerifiable(e.target.checked)} />
          {t("req.verifiableLabel")}
        </label>
        {source !== "" && (
          <Input
            placeholder={source === DEV ? t("req.reasonPlaceholder") : opt?.defaultQuote.slice(0, 60) || t("req.quotePlaceholder")}
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            aria-label={source === DEV ? t("req.reasonPlaceholder") : t("req.quotePlaceholder")}
          />
        )}
      </div>
      {error && <p className="text-body-sm text-rose-600">{error}</p>}
      <div className="grid grid-cols-2 gap-2 md:flex md:justify-end">
        <Button onClick={() => (reset(), onCancel?.())}>{t("req.discard")}</Button>
        <Button variant="primary" onClick={submit} disabled={text.trim() === ""}>
          {t("req.addToDraft")}
        </Button>
      </div>
    </div>
  );
}

function AcRow({
  ac,
  ticketKey,
  snapshotId,
  editable,
  onChange,
  onDelete,
}: {
  ac: Ac;
  ticketKey: string;
  snapshotId: number;
  editable: boolean;
  onChange: (ac: Ac) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(ac.text);
  const noSource = ac.source.type !== "developer" && ac.source.quote.trim() === "";
  if (editing) {
    return (
      <div className="flex flex-col gap-2 border-b border-slate-200 bg-blue-50/40 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-code-md font-semibold">{ac.id}</span>
          <span className="flex gap-1">
            <Button size="sm" variant="blue" onClick={() => (onChange(editAc(ac, text)), setEditing(false))}>
              <Check className="size-3" />
              {t("common.save")}
            </Button>
            <Button size="sm" onClick={() => (setText(ac.text), setEditing(false))}>
              {t("common.cancel")}
            </Button>
          </span>
        </div>
        <Input value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label={ac.id} />
      </div>
    );
  }
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-200 px-3 py-2 last:border-b-0 md:flex-nowrap md:py-1.5">
      <label className="flex shrink-0 items-center gap-1.5 font-mono text-code-sm text-slate-500">
        <input type="checkbox" checked={ac.verifiable} disabled={!editable} onChange={(e) => onChange({ ...ac, verifiable: e.target.checked })} />
        <span className={ac.verifiable ? "" : "text-amber-700"}>{ac.verifiable ? t("req.verifiable") : t("req.unverifiable")}</span>
      </label>
      <span className="shrink-0 font-mono text-code-md font-semibold">{ac.id}</span>
      <span className="order-2 min-w-0 basis-full break-words text-body-md md:order-none md:flex-1 md:basis-auto">{ac.text}</span>
      <span className="order-3 flex max-w-full min-w-0 items-center md:order-none md:max-w-[45%] md:shrink-0">
        {noSource ? <Badge tone="blocked">{t("req.noSource")}</Badge> : <SourceTag ticketKey={ticketKey} source={ac.source} snapshotId={snapshotId} />}
      </span>
      {editable && (
        <span className="order-1 ml-auto flex shrink-0 gap-0.5 md:order-none md:ml-0">
          <button aria-label={`${t("common.edit")} ${ac.id}`} className="rounded p-3 text-slate-500 hover:bg-slate-100 md:p-1" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </button>
          <button aria-label={`${t("common.delete")} ${ac.id}`} className="rounded p-3 text-slate-500 hover:bg-rose-50 hover:text-rose-600 md:p-1" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}

/** Phone AC card (Stitch m03): id + source chip + 44px edit. Inline edit uses the same `editAc` as desktop AcRow: the AC keeps its source (R18). */
function PhoneAcCard({
  ac,
  ticketKey,
  snapshotId,
  editable,
  onChange,
  onDelete,
}: {
  ac: Ac;
  ticketKey: string;
  snapshotId: number;
  editable: boolean;
  onChange: (ac: Ac) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(ac.text);
  const noSource = ac.source.type !== "developer" && ac.source.quote.trim() === "";
  const save = () => {
    if (text.trim() !== "" && text.trim() !== ac.text) onChange(editAc(ac, text));
    setEditing(false);
  };
  return (
    <article className={cn("flex flex-col gap-2 rounded-lg bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.08)]", editing && "ring-2 ring-primary")}>
      <div className="flex items-center gap-2">
        <span className={cn("shrink-0 font-mono text-code-lg font-semibold", editing && "text-primary")}>{ac.id}</span>
        <span className="flex min-w-0 flex-1 items-center">
          {noSource ? <Badge tone="blocked">{t("req.noSource")}</Badge> : isDeveloperAdded(ac) ? <Badge tone="info">{t("req.devAdded")}</Badge> : <SourceTag ticketKey={ticketKey} source={ac.source} snapshotId={snapshotId} />}
        </span>
        {editing ? (
          <span className="shrink-0 rounded bg-primary px-2 py-0.5 text-label-sm text-white">{t("req.editing")}</span>
        ) : (
          editable && (
            <button aria-label={`${t("common.edit")} ${ac.id}`} className="-my-2 flex size-11 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-slate-100" onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
            </button>
          )
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-label-md">{t("req.criteriaDefinition")}</span>
            <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} className="bg-surface-container-low" />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-body-sm">
            <input type="checkbox" className="size-5" checked={ac.verifiable} onChange={(e) => onChange({ ...ac, verifiable: e.target.checked })} />
            {t("req.verifiableLabel")}
          </label>
          <div className="flex items-center gap-2">
            <Button variant="destructive" className="border-0" aria-label={`${t("common.delete")} ${ac.id}`} onClick={onDelete}>
              <Trash2 className="size-4" />
            </Button>
            <Button className="ml-auto border-0 bg-surface-container-high" onClick={() => (setText(ac.text), setEditing(false))}>
              {t("common.cancel")}
            </Button>
            <Button variant="blue" onClick={save}>
              {t("req.saveAc")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="break-words text-body-md">{ac.text}</p>
          {ac.source.type === "developer" && isDeveloperAdded(ac) && (
            <span className="flex items-start gap-1.5 text-body-sm text-primary">
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
              <span className="min-w-0">
                {t("req.addedByYou")} · <span className="text-on-surface-variant">{ac.source.reason}</span>
              </span>
            </span>
          )}
          {!ac.verifiable && <span className="text-body-sm text-amber-700">{t("req.unverifiable")}</span>}
        </>
      )}
    </article>
  );
}

export interface DraftApi {
  dirty: boolean;
  pending: boolean;
  nextVersion: number;
  save: () => void;
}

function RequirementBody({
  d,
  record,
  versions,
  editable,
  onDirtyChange,
  onDraftApi,
}: {
  d: TicketDetail;
  record: RequirementRecord;
  versions: RequirementRecord[];
  editable: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDraftApi: (api: DraftApi) => void;
}) {
  const key = d.ticket.key;
  const snap = useApi<Snapshot>(paths.snapshot(key, record.snapshotId));
  const options = useMemo(() => sourceOptions(snap.data), [snap.data]);
  const [draft, setDraft] = useState<Requirement>(record.content);
  const [dirty, setDirty] = useState(false);
  // Reset only when a different version is shown; SSE refetches must not wipe unsaved edits.
  useEffect(() => {
    setDraft(record.content);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const save = useAction(api.saveRequirement);
  const nextVersion = (versions[versions.length - 1]?.version ?? 0) + 1;
  const [adding, setAdding] = useState(false);
  // the phone sticky bar's "Save draft" saves this draft
  useEffect(() => {
    onDraftApi({ dirty, pending: save.pending, nextVersion, save: () => void save.run(key, draft).then((ok) => ok && setDirty(false)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, save.pending, draft, key, nextVersion]);

  const update = (r: Requirement) => {
    setDraft(r);
    setDirty(true);
  };
  const setAc = (i: number, ac: Ac) => update({ ...draft, acceptanceCriteria: draft.acceptanceCriteria.map((a, j) => (j === i ? ac : a)) });
  // WebMCP draft (task 18): fills the AC text in the editor only; the developer presses Save
  useDraft(
    "ac_edit",
    key,
    (dr) => {
      const i = draft.acceptanceCriteria.findIndex((a) => a.id === dr.acId);
      if (i >= 0) setAc(i, editAc(draft.acceptanceCriteria[i]!, dr.text));
    },
    editable,
  );
  const delAc = (i: number) => update({ ...draft, acceptanceCriteria: draft.acceptanceCriteria.filter((_, j) => j !== i) });

  const r = editable ? draft : record.content;
  const draftComment = r.draftComment ?? record.draftComment;

  // the unclear-requirement comment: only the latest version's draft can be sent; the edit lives here so both layouts share it
  const isLatestVersion = versions[versions.length - 1]?.id === record.id;
  const comments = useApi<JiraCommentRecord[]>(paths.jiraComments(key));
  const [editedComment, setEditedComment] = useState<string | null>(null);
  // WebMCP draft (task 18): fills the comment box only; the developer presses Send to JIRA
  useDraft("note", key, (dr) => setEditedComment(dr.text));
  const [confirming, setConfirming] = useState(false);
  const send = useAction(api.sendComment);
  const retryComment = useAction(api.retryComment);
  const cd = commentDraft(draftComment, editedComment, comments.data ?? []);
  const sending = (comments.data ?? []).some((c) => c.state === "confirmed");
  const commentBox =
    draftComment !== null && isLatestVersion ? (
      <ClarificationComment
        ticketKey={key}
        text={cd.text}
        error={cd.error}
        history={cd.history}
        sending={sending}
        onEdit={setEditedComment}
        onSend={() => setConfirming(true)}
        onRetry={(id) => void retryComment.run(key, id)}
        retryPending={retryComment.pending}
        retryError={retryComment.error}
      />
    ) : null;
  const confirmSheet = confirming ? (
    <CommentConfirmSheet
      ticketKey={key}
      text={cd.text.replace(/\r\n/g, "\n")}
      pending={send.pending}
      error={send.error}
      onClose={() => setConfirming(false)}
      onConfirm={() =>
        void send.run(key, cd.text.replace(/\r\n/g, "\n")).then((ok) => {
          if (!ok) return;
          setConfirming(false);
          setEditedComment("");
        })
      }
    />
  ) : null;

  return (
    <div className="flex flex-col gap-3">
      {editable && dirty && (
        <div className="sticky top-[calc(var(--header-h,3.5rem)+var(--tabs-h,0px))] z-10 flex flex-wrap items-center justify-between gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 max-md:hidden">
          <span className="text-label-md text-blue-800">{t("req.unsaved")}</span>
          <span className="flex items-center gap-2">
            <ThisWill>{t("req.saveThisWill", { v: nextVersion })}</ThisWill>
            <Button onClick={() => (setDraft(record.content), setDirty(false))}>{t("req.discard")}</Button>
            <Button variant="blue" disabled={save.pending} onClick={() => void save.run(key, draft).then((ok) => ok && setDirty(false))}>
              {t("req.saveVersion", { v: nextVersion })}
            </Button>
          </span>
        </div>
      )}
      {save.error && <ErrorBox error={save.error} />}

      <Card className="max-md:hidden">
        <CardHeader title={t("req.background")} />
        <p className="whitespace-pre-wrap p-3 text-body-md leading-6">{r.background || "—"}</p>
      </Card>
      {/* phones (m03): requirement overview */}
      <section className="flex flex-col gap-2 rounded-lg bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.08)] md:hidden">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-headline-md">
            <FileText className="size-5 text-primary" />
            {t("req.overview")}
          </span>
          <span className="shrink-0 rounded bg-surface-container px-1.5 font-mono text-code-sm">{t("req.versionAgo", { v: record.version, ago: timeAgo(record.createdAt) })}</span>
        </div>
        <p className="whitespace-pre-wrap rounded bg-surface-container-low p-3 text-body-md">{r.background || "—"}</p>
        {editable && <span className="text-body-sm text-on-surface-variant">{t("req.editableCaption")}</span>}
      </section>

      <Card>
        <CardHeader title={t("req.functional")} right={r.functional.length} />
        {r.functional.length === 0 && <Empty />}
        {r.functional.map((f) => (
          <div key={f.id} className="flex gap-2 border-b border-slate-100 px-3 py-1.5 last:border-b-0">
            <span className="h-fit shrink-0 rounded bg-surface-container px-1 font-mono text-code-sm font-semibold text-primary">{f.id}</span>
            <span className="text-body-md">{f.text}</span>
          </div>
        ))}
      </Card>

      {/* phones (m03): AC cards */}
      <section className="flex flex-col gap-3 md:hidden">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-headline-md">
            {t("req.ac")}
            <span className="rounded bg-surface-container-high px-1.5 font-mono text-code-sm">{r.acceptanceCriteria.length}</span>
          </h2>
          <span className="rounded bg-primary-fixed px-1.5 font-mono text-code-sm text-primary">{editable ? t("req.draftChip", { v: dirty ? (versions[versions.length - 1]?.version ?? 0) + 1 : record.version }) : t("req.versionChip", { v: record.version })}</span>
        </div>
        {r.acceptanceCriteria.map((ac, i) => (
          <PhoneAcCard key={`${record.id}-${ac.id}-${i}`} ac={ac} ticketKey={key} snapshotId={record.snapshotId} editable={editable} onChange={(a) => setAc(i, a)} onDelete={() => delAc(i)} />
        ))}
        {editable && dirty && (
          <button className="min-h-11 text-body-sm text-primary underline" onClick={() => (setDraft(record.content), setDirty(false))}>
            {t("req.discardChanges")}
          </button>
        )}
        {editable && !adding && (
          <div className="flex flex-col gap-1.5">
            <button onClick={() => setAdding(true)} className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-surface-container-high text-headline-sm text-primary">
              <PlusCircle className="size-5" />
              {t("req.addAcButton")}
            </button>
            <span className="text-center text-body-sm text-on-surface-variant">
              {t("common.thisWill")} {t("req.addAcThisWill")}
            </span>
          </div>
        )}
        {editable && adding && (
          <div className="overflow-hidden rounded-lg bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
            <AddAcForm
              acs={draft.acceptanceCriteria}
              versions={versions}
              options={options}
              optionsError={snap.error?.message}
              onRetryOptions={snap.reload}
              onAdd={(ac) => (update({ ...draft, acceptanceCriteria: [...draft.acceptanceCriteria, ac] }), setAdding(false))}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}
      </section>

      <Card className="max-md:hidden">
        <CardHeader icon={<ListChecks className="size-3.5" />} title={`${t("req.ac")} · ${r.acceptanceCriteria.length}`} />
        {r.acceptanceCriteria.length === 0 && <Empty />}
        {r.acceptanceCriteria.map((ac, i) => (
          <AcRow key={`${record.id}-${ac.id}-${i}`} ac={ac} ticketKey={key} snapshotId={record.snapshotId} editable={editable} onChange={(a) => setAc(i, a)} onDelete={() => delAc(i)} />
        ))}
        {editable && <AddAcForm acs={draft.acceptanceCriteria} versions={versions} options={options} optionsError={snap.error?.message} onRetryOptions={snap.reload} onAdd={(ac) => update({ ...draft, acceptanceCriteria: [...draft.acceptanceCriteria, ac] })} />}
      </Card>

      <Card>
        <CardHeader icon={<MessagesSquare className="size-3.5" />} title={t("req.discussion")} right={r.discussionOutcomes.length} />
        {r.discussionOutcomes.length === 0 && <Empty>{t("req.noDiscussion")}</Empty>}
        {r.discussionOutcomes.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0 md:flex-nowrap md:py-1.5">
            <span className="shrink-0 font-mono text-code-md font-semibold">{o.id}</span>
            <span className="min-w-0 flex-1 basis-[70%] break-words text-body-md md:basis-auto">{o.text}</span>
            {o.sourceCommentIds.map((c) => (
              <Link key={c} to={focusLink(key, anchor.comment(c), record.snapshotId)}>
                <Badge>{sourceLabel.comment(c)}</Badge>
              </Link>
            ))}
          </div>
        ))}
      </Card>

      {(r.openQuestions.length > 0 || draftComment) && (
        <section className="flex flex-col gap-2 rounded-lg bg-secondary-fixed/40 p-3 md:hidden">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-headline-md">
              <CircleHelp className="size-5 text-secondary" />
              {t("req.openQuestions", { n: r.openQuestions.length })}
            </span>
            <span className="shrink-0 rounded bg-secondary-fixed px-1.5 font-mono text-code-sm text-on-secondary-fixed-variant">{t("req.needsResolution")}</span>
          </div>
          {r.openQuestions.map((q, i) => (
            <p key={i} className="text-body-md font-semibold">
              {i + 1}. {q.text} <span className="font-normal text-on-surface-variant">({t(`req.qkind.${q.kind}` as MessageKey)})</span>
            </p>
          ))}
          {draftComment && commentBox ? (
            <div className="rounded bg-white p-2.5">{commentBox}</div>
          ) : (
            draftComment && (
              <div className="flex flex-col gap-1 rounded bg-white p-2.5">
                <span className="flex items-center gap-1.5 font-mono text-code-sm font-semibold text-secondary">
                  <Pencil className="size-3.5" />
                  {t("req.draftNotSent")}
                </span>
                <p className="whitespace-pre-wrap font-mono text-code-sm">{draftComment}</p>
              </div>
            )
          )}
        </section>
      )}
      {(r.openQuestions.length > 0 || draftComment) && (
        <Card className="border-amber-200 max-md:hidden">
          <CardHeader
            className="border-amber-200 bg-amber-50"
            icon={<AlertTriangle className="size-3.5 text-amber-600" />}
            title={t("req.clarification", { n: r.openQuestions.length })}
          />
          <div className="flex flex-col gap-2 p-3">
            {r.openQuestions.map((q, i) => (
              <div key={i} className="flex items-start gap-2 rounded border border-slate-200 bg-white p-2">
                <Badge tone={q.kind === "conflict" ? "blocked" : "decision"}>{t(`req.qkind.${q.kind}` as MessageKey)}</Badge>
                <span className="text-body-md">{q.text}</span>
              </div>
            ))}
            {draftComment &&
              (commentBox ?? (
                <div className="flex flex-col gap-1">
                  <span className="text-label-md text-slate-600">{t("req.draftComment")}</span>
                  <Textarea readOnly value={draftComment} rows={4} className="font-mono text-code-md" />
                </div>
              ))}
          </div>
        </Card>
      )}
      {confirmSheet}
    </div>
  );
}

function SidePanel({ d, record, dirty, draftApi }: { d: TicketDetail; record: RequirementRecord | undefined; dirty: boolean; draftApi: DraftApi | null }) {
  const key = d.ticket.key;
  const confirm = useAction(api.confirmRequirement);
  const refine = useAction(api.refine);
  const state = d.ticket.state;

  if (state === "discovered") {
    return (
      <Card className="flex flex-col gap-2 p-3">
        <Button variant="primary" size="lg" onClick={() => void refine.run(key)} disabled={refine.pending}>
          {t("req.startRefine")}
        </Button>
        <ThisWill>{t("req.refineThisWill")}</ThisWill>
        {refine.error && <ErrorBox error={refine.error} />}
      </Card>
    );
  }

  const rerun = (
    <div className="flex flex-col gap-1.5">
      <Button onClick={() => void refine.run(key)} disabled={refine.pending}>
        <RotateCw className="size-3.5" />
        {t("req.rerun")}
      </Button>
      <ThisWill>{t("req.rerunThisWill")}</ThisWill>
    </div>
  );

  if (state === "awaiting_ac_review" && record) {
    const acs = record.content.acceptanceCriteria;
    const unverifiable = acs.filter((a) => !a.verifiable).length;
    const unchecked = record.source === "human" && (!d.drift || d.drift.requirementId !== record.id);
    const driftBlocks = d.drift !== null && d.drift.needsAck && !d.drift.acknowledged && d.drift.requirementId === record.id;
    return (
      <div className="flex flex-col gap-3">
        <DecisionCard
          subtitle={t("req.reviewOn")}
          primary={{ label: t("req.confirm"), thisWill: t("req.confirmThisWill"), onClick: () => void confirm.run(key), pending: confirm.pending, disabled: unchecked || dirty || driftBlocks }}
          barSecondary={draftApi ? { label: t("req.saveDraft"), thisWill: t("req.saveThisWill", { v: draftApi.nextVersion }), onClick: draftApi.save, disabled: !draftApi.dirty || draftApi.pending } : undefined}
          error={confirm.error ?? refine.error ?? (dirty ? t("req.saveFirst") : driftBlocks ? t("req.driftBlocks") : unchecked ? t("req.editedNotChecked") : undefined)}
        >
          <ul className="flex flex-col gap-1 text-body-sm">
            <li>{t("req.summary.ac", { n: acs.length })}</li>
            {unverifiable > 0 && <li className="text-amber-700">{t("req.summary.unverifiable", { n: unverifiable })}</li>}
            {record.content.openQuestions.length > 0 && <li className="text-amber-700">{t("req.summary.questions", { n: record.content.openQuestions.length })}</li>}
          </ul>
        </DecisionCard>
        {driftBlocks && (
          <Link to={`/tickets/${key}/coverage`} className="flex min-h-11 items-center gap-1 self-start text-body-md font-semibold text-primary hover:underline lg:min-h-0">
            {t("req.ackInCoverage")} →
          </Link>
        )}
        {rerun}
      </div>
    );
  }

  if (state === "awaiting_drift_ack") {
    return (
      <Card className="flex flex-col gap-2 border-secondary-container/60 bg-[#fff8f1] p-3 text-body-md">
        {t("req.driftPending")}
        <Link to={`/tickets/${key}/coverage`} className="font-semibold text-primary hover:underline">
          {t("tab.coverage")} →
        </Link>
      </Card>
    );
  }

  if (state === "refined" || state === "awaiting_choice") {
    return (
      <Card className="p-3">
        {rerun}
        {refine.error && <ErrorBox error={refine.error} />}
      </Card>
    );
  }
  return null;
}

export function RequirementsTab({ d }: { d: TicketDetail }) {
  const key = d.ticket.key;
  const versions = useApi<RequirementRecord[]>(paths.requirements(key));
  const [picked, setPicked] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [draftApi, setDraftApi] = useState<DraftApi | null>(null);
  const list = versions.data ?? [];
  const latest = list[list.length - 1];
  const record = list.find((r) => r.id === picked) ?? latest;
  const isLatest = record !== undefined && record.id === latest?.id;
  const editable = isLatest && d.ticket.state === "awaiting_ac_review";
  const baseline = list[0];

  return (
    <div className="flex flex-col gap-4 p-4 max-md:min-h-[calc(100dvh-var(--header-h,4rem))] max-md:gap-3 max-md:bg-surface-container-low max-md:px-3 lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-3">
        <AsyncView state={versions} isEmpty={(l) => l.length === 0} empty={d.ticket.state === "refining" ? t("common.loading") : t("req.noRequirement")}>
          {() =>
            record && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Select aria-label={t("req.versionSelect")} value={record.id} onChange={(e) => setPicked(Number(e.target.value))} className="w-full max-w-full font-mono text-code-md font-semibold md:w-auto">
                    {[...list].reverse().map((v) => (
                      <option key={v.id} value={v.id}>
                        {t("req.version", { v: v.version })} · {v.source === "agent" ? t("req.byAgent") : t("req.byHuman")} · {timeAgo(v.createdAt)}
                      </option>
                    ))}
                  </Select>
                  {baseline && <span className="font-mono text-code-sm text-slate-500">{t("req.compareBaseline", { id: baseline.snapshotId })}</span>}
                </div>
                {!isLatest && <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-body-sm text-slate-600">{t("req.oldVersion")}</div>}
                {isLatest && !editable && d.ticket.reviewAc && <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-body-sm text-slate-600">{t("req.readOnlyState")}</div>}
                <RequirementBody d={d} record={record} versions={list} editable={editable} onDirtyChange={setDirty} onDraftApi={setDraftApi} />
              </>
            )
          }
        </AsyncView>
      </div>
      <aside className={cn("order-first flex flex-col gap-3 empty:hidden lg:order-none", STICKY_RAIL)}>
        <SidePanel d={d} record={latest} dirty={dirty && editable} draftApi={editable ? draftApi : null} />
        {picked !== null && !isLatest && (
          <Button variant="ghost" onClick={() => setPicked(null)}>
            <X className="size-3.5" />
            {t("req.version", { v: latest?.version ?? "" })}
          </Button>
        )}
      </aside>
    </div>
  );
}
