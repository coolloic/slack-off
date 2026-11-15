# Phase 1 exit validation (real JIRA, manual)

This is the manual check the automated e2e cannot do: the real flow against your own JIRA. Run it once, fill in the result and screenshot slots, and commit the file. Use screenshots with ticket content you are allowed to keep; blur names and company hostnames before committing. Never commit a real company hostname, names or emails; use `https://your-company.atlassian.net` in anything you write down here.

Date run: ____  Slack Off commit: ____  Result: [ ] pass  [ ] fail

## Prerequisites

- [ ] Node 26, pnpm, `pnpm install` done.
- [ ] Claude Code installed and logged in (`claude --version` works).
- [ ] Chrome open with the Claude in Chrome extension connected, and **logged in to your JIRA** in that profile.
- [ ] A test ticket in JIRA: assigned to you, open (Ready for Dev is the list's default filter), ideally with 2 comments and 1 screenshot.
- [ ] A fresh data dir is optional but recommended: `SLACKOFF_HOME=$(mktemp -d)`.
- [ ] No dev servers already running on 4317 or 5173.

## Start

```sh
SLACKOFF_HOME=<data dir> pnpm dev:server
pnpm dev:web
```

Open http://127.0.0.1:5173.

## Settings to fill

Open Settings:

- [ ] JIRA base URL: `https://your-company.atlassian.net` (your real one, locally only; do not commit it).
- [ ] Ready-for-dev status matches your JIRA workflow (default filter and highlight on the Tickets list).
- [ ] Most tickets per fetch: keep 100 unless you have more open tickets assigned to you.
- [ ] Repositories: add the test ticket's project key, a local repository path and its base branch.
- [ ] Save settings. The top bar shows JIRA as configured and the executor as "Claude Code (subscription)" (no model name anywhere).

## Steps

For each step, tick the box, note what you saw, and attach a screenshot.

### 1. Fetch
- Do: Tickets page, "Fetch new tickets".
- Look for: all open tickets assigned to you are fetched, not only Ready for Dev ones (author decision 2026-11-06): the status line says "Found N new · M open in total" and M matches your JIRA "assigned to me, not done" count. The JIRA status filter defaults to your Ready-for-dev status; "All open" shows the rest. If M is above the limit, the list says "Showing X of Y open tickets — raise the limit in Settings": check X and Y. Your test ticket appears, state Discovered. Nothing in JIRA changes.
- [ ] Pass. Notes: ____ Screenshot: ____

### 2. Refine
- Do: turn on "Review AC first" for the ticket, select it, "Start refining".
- Look for: state goes Refining then "Awaiting AC review"; no error banner. If JIRA asks you to log in, the ticket becomes Blocked with a clear reason: log in in Chrome and Retry.
- [ ] Pass. Notes: ____ Screenshot: ____

### 3. Snapshot and AC provenance
- Do: open the ticket. "Original snapshot" tab, then "Requirements & AC".
- Look for: description, comments (with their comment IDs) and the screenshot listed in the snapshot; every AC shows a source tag (description paragraph, comment #id, attachment) that links back to the quoted text.
- [ ] Pass. Notes: ____ Screenshot: ____

### 4. Edit an AC
- Do: edit one AC's text and save (it keeps its source; no reason needed). Optionally add a developer AC: saving without a reason must show an error, with a reason it succeeds.
- Look for: a new requirements version appears in the version selector ("edited by developer").
- [ ] Pass. Notes: ____ Screenshot: ____

### 5. Drift check
- Do: after saving, open "AC coverage".
- Look for: the check against the original snapshot (covered / partial / missing / new, contradictions). The tab shows an attention badge if something needs acknowledgement.
- [ ] Pass. Notes: ____ Screenshot: ____

### 6. Acknowledge
- Do: if items need attention, write a note (required: an empty note shows an error) and "Acknowledge & continue".
- Look for: the tab shows "acknowledged"; the state moves to Proposing then "Awaiting choice".
- [ ] Pass. Notes: ____ Screenshot: ____

### 7. Choose a solution
- Do: "Solutions" tab. Read the options, select one, optionally add a note, "Confirm choice".
- Look for: "Chosen: <title>" and the state "Designing (phase 2)". Phase 1 stops here.
- [ ] Pass. Notes: ____ Screenshot: ____

### 8. Audit chain
- Do: `curl -s http://127.0.0.1:4317/api/audit | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.chain, j.events.length)'`
- Look for: `chain` is `{ ok: true, count: N }` where N equals the number of events; events cover discover, refine, requirement edit, drift acknowledge and solution choice.
- [ ] `ok: true`. Output: ____

### 9. JIRA untouched
- Do: open the test ticket in JIRA.
- Look for: no new comments, no status or field changes made by Slack Off.
- [ ] Pass. Notes: ____

## Findings

Anything that surprised you, broke, or needs a follow-up task: ____
