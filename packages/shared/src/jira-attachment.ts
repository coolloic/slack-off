/**
 * JIRA attachment addresses. In Chrome mode Slack Off never holds an attachment's bytes: the reader records the
 * attachment's JIRA content address and the web page shows it with the developer's own JIRA sign-in. Only an exact
 * `<base>/rest/api/{2,3}/attachment/content/<id>` under the configured https JIRA counts as one.
 */

/** The configured base as `https://host[:port][/path]` without a trailing slash, or null when it is not a plain https URL. */
function normalBase(base: string): string | null {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return null;
  if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(u.origin)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The attachment id when `url` is exactly an attachment content address of the configured JIRA, else null. */
export function jiraAttachmentId(url: string, base: string): string | null {
  const b = normalBase(base);
  if (b === null || url === "") return null;
  const m = new RegExp(`^${escape(b)}/rest/api/[23]/attachment/content/(\\d{1,20})$`).exec(url);
  return m ? m[1]! : null;
}

export function jiraAttachmentContentUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, "")}/rest/api/3/attachment/content/${id}`;
}

export function jiraThumbnailUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, "")}/rest/api/3/attachment/thumbnail/${id}`;
}

/** The origin images may be loaded from (the page's img-src), or null when the base is not a plain https URL. */
export function jiraImageOrigin(base: string): string | null {
  const b = normalBase(base);
  return b === null ? null : new URL(b).origin;
}

/** Jira Cloud answers an attachment request with a redirect to Atlassian's media host (token in the query). */
export const ATLASSIAN_MEDIA_ORIGIN = "https://api.media.atlassian.com";

/**
 * Every origin the page's img-src needs for the configured JIRA's attachment images: the JIRA itself and, for a Jira
 * Cloud site (*.atlassian.net), Atlassian's media host its attachments redirect to. Empty when the base is not plain https.
 */
export function jiraImageSources(base: string): string[] {
  const origin = jiraImageOrigin(base);
  if (origin === null) return [];
  return new URL(origin).hostname.endsWith(".atlassian.net") ? [origin, ATLASSIAN_MEDIA_ORIGIN] : [origin];
}
