import { t, type MessageKey } from "../i18n/en.ts";

const ROLES = new Set([
  "jira-browser", "jira-update", "jira-comment", "refine-ticket", "propose-solutions", "design-solution", "critique-design", "implement-ticket", "acceptance-review",
]);

/** The name a developer reads for an agent role ("Solutions agent", not propose-solutions); an unknown role as it is. */
export function agentName(role: string): string {
  return ROLES.has(role) ? t(`agent.${role}` as MessageKey) : role;
}
