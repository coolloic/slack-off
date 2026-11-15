import { ExternalLink } from "lucide-react";
import { t } from "../i18n/en.ts";
import { safeJiraUrl } from "../lib/jira-link.ts";
import { cn } from "../lib/utils.ts";

/**
 * F-8: the ticket key as a link to the ticket in JIRA (new tab), or plain text when the URL is not on the configured
 * JIRA origin. Clicks never bubble to the surrounding card/row.
 */
export function JiraKeyLink({ ticketKey, url, baseUrl, className }: { ticketKey: string; url: string | null; baseUrl: string | undefined; className?: string }) {
  const href = safeJiraUrl(url, baseUrl);
  if (!href) return <span className={className}>{ticketKey}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("tickets.openKeyInJira", { key: ticketKey })}
      title={t("tickets.openKeyInJira", { key: ticketKey })}
      onClick={(e) => e.stopPropagation()}
      className={cn("inline-flex items-center gap-1 hover:underline", className)}
    >
      <span className="break-all">{ticketKey}</span>
      <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
    </a>
  );
}
