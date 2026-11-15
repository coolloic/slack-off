/**
 * The two mode comparison tables: how Slack Off talks to Claude (spec §7.1's six aspects plus the credentials row of
 * phase 4b) and how it reads JIRA (the table of the phase 4b plan). One source for the Settings page
 * (`ModeComparison`) and the README; `packages/server/test/docs.test.ts` checks the README against it word for word.
 *
 * Every value must match the implementation: both executors run the same `claude` CLI with the same flags and sandbox
 * (ruling B-1); the API-key executor needs the JIRA API mode (ruling B-4); the JIRA API mode is Jira Cloud only
 * (ruling B-6). No value may contain "|" (it is rendered as a Markdown table cell).
 */
export interface ModeComparisonTable {
  columns: [string, string];
  rows: Array<{ label: string; values: [string, string] }>;
}

export const MODE_COMPARISON: { executor: ModeComparisonTable; jira: ModeComparisonTable } = {
  executor: {
    columns: ["Claude Code subscription (default)", "Anthropic API key"],
    rows: [
      { label: "Needs", values: ["A Claude Code subscription and the claude CLI logged in on this computer", "An Anthropic API key and the claude CLI installed"] },
      { label: "Cost", values: ["Included in your subscription", "Billed per token to your Anthropic account"] },
      {
        label: "Getting started",
        values: [
          "Easy: browser, code and commands work out of the box",
          "Harder: the same Claude Code CLI and sandbox, but it cannot drive Chrome, so JIRA must use the API mode",
        ],
      },
      {
        label: "Concurrency and quota",
        values: [
          "Limited by your subscription quota; parallel agents can reach it",
          "Not your subscription quota: limited by your account rate limits and budget",
        ],
      },
      {
        label: "Control",
        values: [
          "Tools, permissions and sandbox are set by Slack Off through the CLI's flags",
          "The same: the same CLI with the same flags; only the authentication differs",
        ],
      },
      {
        label: "Credentials",
        values: [
          "Your Claude Code login; never read or stored",
          "Stored on this computer (credentials.json, mode 600); handed to claude by a helper, never put in its environment",
        ],
      },
      { label: "Good for", values: ["Individual developers; trying it out", "Heavy automation; usage paid by a team"] },
    ],
  },
  jira: {
    columns: ["Browser (default)", "JIRA API"],
    rows: [
      { label: "Needs", values: ["Chrome with Claude in Chrome, logged in to JIRA", "An Atlassian API token and your email"] },
      { label: "Credentials", values: ["Your browser session; never read or stored", "Stored on this computer (credentials.json, mode 600)"] },
      { label: "Speed and cost", values: ["One agent run per read (uses your Claude quota)", "Direct HTTP calls, no agent run, no quota"] },
      {
        label: "Robustness",
        values: [
          "Reads the page as a person would; page layout changes can confuse it",
          "Structured data; needs API access to be allowed by your JIRA admins",
        ],
      },
      { label: "Supported", values: ["Jira Cloud, Data Center (any page you can open)", "Jira Cloud (REST v3)"] },
      { label: "Good for", values: ["Trying it out; no admin approval needed", "Daily use; many tickets"] },
    ],
  },
};
