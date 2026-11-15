import { jiraAttachmentContentUrl, jiraAttachmentId, jiraThumbnailUrl } from "@slackoff/shared";
import { t } from "../i18n/en.ts";

export interface PickState {
  /** location.key the manual pick belongs to */
  navKey: string;
  picked: number | null;
}

/** Every navigation (a new location.key — even the same `?snap=` link clicked again) drops the manual pick; re-renders keep it. */
export const pickAfterNavigation = (s: PickState, navKey: string): PickState => (s.navKey === navKey ? s : { navKey, picked: null });

/** Shown snapshot: manual pick, else the `?snap=` link when it names a known snapshot, else the latest (ids newest first). */
export function selectedSnapshotId(picked: number | null, snapParam: string | null, ids: readonly number[]): number | null {
  if (picked !== null) return picked;
  if (snapParam !== null && ids.some((id) => String(id) === snapParam)) return Number(snapParam);
  return ids[0] ?? null;
}

/** F-I7: the snapshot's "incomplete" flag when the browser agent could not load older comments. */
export const incompleteLabel = (notLoaded: number | null | undefined): string | null =>
  notLoaded === null || notLoaded === undefined ? null : notLoaded === 0 ? t("snap.incompleteUnknown") : t("snap.incomplete", { n: notLoaded });

/**
 * Chrome mode keeps no attachment bytes: an image whose address is exactly an attachment of the configured JIRA is
 * shown from JIRA with the developer's own sign-in (thumbnail; tap for the full image). Null: use Slack Off's copy
 * (localPath) or the "View in JIRA" link. The page's img-src allows only that JIRA (server htmlCsp).
 */
export function jiraImage(
  a: { localPath: string | null; mime: string | null; url: string | null },
  jiraBase: string | undefined,
): { thumbnail: string; full: string } | null {
  if (a.localPath || !a.mime?.startsWith("image/") || !a.url || !jiraBase) return null;
  const id = jiraAttachmentId(a.url, jiraBase);
  return id === null ? null : { thumbnail: jiraThumbnailUrl(jiraBase, id), full: jiraAttachmentContentUrl(jiraBase, id) };
}
