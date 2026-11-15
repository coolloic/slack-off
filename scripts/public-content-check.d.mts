export type Finding = { path: string; line: number; rule: "jira-host" | "email" | "user-path" | "nul-in-text" | "private-term" | "registry"; excerpt: string };
export const ALLOWED_JIRA_HOSTS: string[];
export const ALLOWED_EMAIL: RegExp;
export function checkText(path: string, text: string, privateTerms: readonly string[]): Finding[];
export function checkTree(repoDir: string, privateTerms: readonly string[]): { findings: Finding[]; binaries: string[] };
