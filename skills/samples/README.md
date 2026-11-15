# Trial-run samples

Fictional content used by "Try on a sample ticket" in Settings → Agent prompts (phase 4d, ruling D-7). Nothing here
comes from a real project, ticket or person. A trial run copies `sample-repo/` to a scratch directory, runs one
read-only role (refine-ticket, propose-solutions, design-solution or critique-design) with your unsaved prompt text,
shows the result and deletes the copy. It never writes to JIRA, a real repository or any ticket.

- `sample-ticket.json` — `SAMPLE-1`, the input of refine-ticket (one comment disagrees slightly with the description).
- `sample-requirement.json` — its requirement, the input of propose-solutions, design-solution and critique-design.
- `sample-solution.json` — the chosen option, the input of design-solution.
- `sample-design.md` — a design, the input of critique-design.
- `sample-repo/` — a tiny Node project with a weekly report module and its tests.
