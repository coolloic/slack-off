export type AgentRole =
  | 'jira-browser'
  | 'jira-update'
  | 'refine-ticket'
  | 'propose-solutions'
  | 'design-solution'
  | 'critique-design'
  | 'implement-ticket'
  | 'acceptance-review'
  | 'jira-comment';

/** Roles that change something outside the platform, each time confirmed by the developer: never retried, never paused by the usage gate. */
export const WRITE_AGENT_ROLES: readonly AgentRole[] = ['jira-update', 'jira-comment'];
