# Slack Off skills

Every agent role in Slack Off is a plain Claude Code skill in this folder. Slack Off runs them for you, but you can also install them in your own Claude Code and run one step by hand, without the platform: for example, turn a ticket's text into requirements and acceptance criteria, or have a design critiqued.

## What each folder is

| Folder | What it does |
|---|---|
| `refine-ticket` | Turns a ticket's text into a structured requirement with traceable, verifiable acceptance criteria; or checks edited criteria against the original ticket. Read-only. |
| `propose-solutions` | Proposes 1 to 5 comparable implementation options for a requirement, each with the repositories it changes, pros, cons, risks and complexity. Read-only. |
| `design-solution` | Writes, revises or finalizes a design document for a chosen solution, covering a quality checklist. Writes only the design document. |
| `critique-design` | Reviews a design against the requirement, the code and the quality checklist, with blocking and non-blocking comments. Read-only. |
| `implement-ticket` | Implements a final design one step at a time in the affected repositories, writing code and tests. Edits files. |
| `acceptance-review` | Tests finished work against its acceptance criteria as an end user (Playwright specs, or cases for a CLI or library) and records evidence. Runs your app and tests. |
| `jira-browser` | Reads JIRA tickets through your logged-in Chrome (Claude in Chrome): a JQL list, or one ticket's text, comments and attachments. Read-only. |
| `jira-update` | Moves one JIRA ticket to one given status through your logged-in Chrome. **Changes JIRA.** |
| `jira-comment` | Posts one given comment on one JIRA ticket through your logged-in Chrome. **Changes JIRA.** |
| `samples` | Not a skill: the fictional `SAMPLE-1` ticket, requirement, solution, design and a small sample repository that Slack Off's "Try on a sample ticket" uses. Handy inputs for trying the skills by hand. |

## Install

Copy the skills you want, except `jira-update` and `jira-comment`, which belong only inside Slack Off (see [What you do not get without the platform](#what-you-do-not-get-without-the-platform)). Never overwrite a skill you already have. `cp -Rn` copies without replacing any existing file.

**Into one project (recommended)**, so the skills apply only there:

```sh
cd /path/to/your/project
mkdir -p .claude/skills
cp -Rn <clone>/skills/refine-ticket .claude/skills/
```

**For your user**, so every project sees them:

```sh
mkdir -p ~/.claude/skills
cp -Rn <clone>/skills/refine-ticket ~/.claude/skills/
```

`<clone>` is where you cloned Slack Off. Repeat the `cp -Rn` line for each skill you want. Before copying, check that you have no skill of the same name (`ls .claude/skills` or `ls ~/.claude/skills`). If you do, `cp -Rn` leaves your existing files alone and silently skips the clashing ones, so you would end up with a mix: copy Slack Off's skill under another folder name instead, for example `cp -Rn <clone>/skills/refine-ticket .claude/skills/slackoff-refine-ticket`, and change the `name:` line at the top of its `SKILL.md` to match. Nothing else in your configuration needs to change.

## Use

In Claude Code, ask for a skill by name and give it the input it describes in its `SKILL.md` (each skill states its input and its JSON output). For example:

> Use the refine-ticket skill on this ticket: "PROJ-12 Export the weekly report as CSV. Users want a CSV download next to the PDF one…"

> Use the critique-design skill on `docs/design.md` for the requirement in `requirement.json`, in this repository.

The `samples` folder has ready-made inputs (`sample-ticket.json`, `sample-requirement.json`, `sample-solution.json`, `sample-design.md`) to try them on.

## What you do not get without the platform

A skill is only instructions. The protections that make Slack Off safe are in the platform, not in the skills, and **none of them exists when you run a skill on its own**:

- **No schema check or retry.** Slack Off validates every agent's JSON output against a schema and retries or fails the run; on your own, you check the output yourself.
- **No confirmation before outward actions.** Slack Off shows you exactly what will be sent and waits for your confirmation, then reads JIRA back to verify. On your own, `jira-update` and `jira-comment` change JIRA directly, as soon as the agent runs them. Use these two only inside Slack Off.
- **No acceptance isolation.** Slack Off gives the acceptance agent only the requirements, a history-free copy of the code and its own Claude configuration, and re-runs the tests itself. On your own, `acceptance-review` sees whatever your session sees.
- **No command sandbox.** Slack Off runs repository commands, tests and hooks in a macOS sandbox that keeps them away from Slack Off, your credentials and your keychain. On your own, `implement-ticket` and `acceptance-review` run commands with your full permissions, under whatever permission settings your Claude Code has.
- **No audit log.** Nothing records who decided what.
- **No forbidden paths or restricted tools.** Slack Off limits each role's file tools and commands; on your own, the skill has the tools your session allows.

So "read-only" is only an instruction inside the skill, not a guarantee: nothing stops an agent from doing more. `refine-ticket`, `propose-solutions` and `critique-design` only read text you give them, so they are the safest to try on their own. `jira-browser` drives your logged-in Chrome while reading ticket text written by others, so run it only under permission settings that ask you before each browser action. Review every change `design-solution` and `implement-ticket` make. **Do not install `jira-update` or `jira-comment` outside Slack Off at all:** Claude Code can pick up an installed skill from its description in any session, so either one could change JIRA without the platform's confirmation.
