/**
 * F-8: `ticket.url` comes from the browser agent (untrusted). Link to it only when it is an absolute http(s) URL whose
 * origin equals the configured JIRA base URL's origin; otherwise callers render the key as plain text.
 */
export function safeJiraUrl(url: string | null | undefined, baseUrl: string | null | undefined): string | null {
  if (!url || !baseUrl) return null;
  let u: URL;
  let base: URL;
  try {
    u = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.origin !== base.origin) return null;
  return u.href;
}
