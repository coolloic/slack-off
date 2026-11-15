# History: publish from a fresh commit

Decision (author): publish from a new, history-free initial commit (option B below). No local history is rewritten. This document describes the scan, the two options, and the steps for B. Slack Off's plans do not run any of these commands; running them and pushing are the author's.

## What was scanned

`node scripts/scan-history.mjs --out <directory outside the repo>` over every ref (`git log --all`, `git rev-list --all --objects`):

- author and committer names and emails, deduplicated per identity
- every commit message
- branch and tag names
- every text blob in history, with the same rules as the current-tree check (`pnpm check:public`): JIRA hosts outside the placeholder list, emails outside the placeholder pattern, `/Users/<name>` paths other than placeholders, a private-terms list, non-npmjs registries in lockfiles

The report with the matched values is written outside the repository. This document states counts only.

## Result (scanned without a private-terms file; none was supplied)

| Category | Count |
| --- | --- |
| Distinct author / committer identities (all commits share it) | 1 |
| Commit messages with a hit | 1 |
| Branch and tag names with a hit | 0 |
| Line hits in text blobs | 41 (JIRA host, user path, NUL in a text file; rule split is in the report) |
| Current tree (`pnpm check:public`) | 0 hits; 40 binary files (PNG, JPG) need a manual look |

Names that only the author can list were not scanned. Binary files (screenshots) cannot be grepped.

## Option A: rewrite history

Run on a fresh clone, never on the working copy:

```sh
git clone <this repo> /path/to/rewrite-clone && cd /path/to/rewrite-clone
git filter-repo --mailmap /path/outside/repo/mailmap.txt --replace-text /path/outside/repo/replacements.txt
```

Effect: every commit hash changes; existing clones, branches and PR links stop matching; each old clone must be discarded. Hits in blobs and messages are replaced, but anything the replacement lists miss stays public forever.

## Option B (chosen): one initial commit from the current tree

```sh
git checkout --orphan public-main
git add -A
git -c user.name="<public name>" -c user.email="<public email>" commit -m "Initial commit"
# review `git ls-files` and run `pnpm check:public` first; push is the author's step
```

Effect: no old commit, author identity, message, branch or blob is published; nothing to scrub in history, only the tree, which `pnpm check:public` covers. Cost: the development history is not public. Existing clones and PR links keep pointing at the private history. The author chooses the public name and email in the commit command.

## Not executed

These commands are not run by Slack Off's plans. No rewrite was done and nothing was pushed.
