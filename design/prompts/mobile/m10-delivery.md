New MOBILE screen (390×844 phone, mobile web) "Delivery – mobile", same design system. Behind it is the acceptance report, dimmed; on top is a BOTTOM SHEET (rounded top corners, drag handle) titled "Confirm delivery".

Inside the sheet:
1. A NUMBERED ACTION LIST. Each action is one full line of text, with branch and repo names in monospace:
   1. "Re-read PROJ-128 from JIRA (read only) and check the ACs against any change"
   2. "Push branch slackoff/PROJ-128-idempotency-keys of api to origin (github.com/example-org/api) — never forced"
   3. "Push branch slackoff/PROJ-128-idempotency-keys of web to origin (github.com/example-org/web) — never forced"
   4. "Open a pull request in github.com/example-org/api: slackoff/PROJ-128-idempotency-keys → main"
   5. "Open a pull request in github.com/example-org/web: slackoff/PROJ-128-idempotency-keys → main"
   6. "Edit the 2 pull request descriptions to link to each other"
   7. "Set PROJ-128 to \"Ready for Human Review\" in JIRA (your Chrome)", with a small "JIRA" tag
   8. "Comment on PROJ-128 in JIRA with the pull request links", with a small "JIRA" tag
2. An AMBER WARNING card with two lines:
   - "E2E was not executed: no acceptance section in .slackoff/config.json of web"
   - "github.com/example-org/web is public (or its visibility is unknown): the description shows the requirement and AC text"
3. "Pull request descriptions": two collapsed rows (api, web). The first is expanded and shows the description in monospace (Summary, Chosen solution, Acceptance, a small AC table), with a note: "Screenshots stay in Slack Off — the description has no links to them".
4. A small greyed variant row: "JIRA is not changed (status sync is off in Settings)".
5. A small greyed variant: a RED BLOCKER card, "web: gh is not logged in to github.com — run gh auth login", with the primary button greyed out.

Sheet footer:
- left: a secondary "Cancel" button;
- right: an orange primary "Deliver" button.

Also draw a second frame, "Delivery progress":
- A list of the same 8 steps, one row each, with a status icon (done ✓ green, running spinner blue, pending grey circle, failed ✗ red, not needed dash).
- The PR rows show the PR link "example-org/api#42".
- The failed JIRA comment step shows a small "Retry" button and the reason "Login required — sign in to JIRA in Chrome, then Retry".
- At the top, a red blocked banner variant: "Remote branch has commits that are not in the local branch — resolve it, then Retry", with a Retry button.
- At the bottom, a DONE card: "Pull requests opened" listing 2 PR cards (repo, number, title), and "JIRA: Ready for Human Review".

Opaque bars, nothing wider than the screen, touch targets ≥44px, English copy, no model names, no person names.
