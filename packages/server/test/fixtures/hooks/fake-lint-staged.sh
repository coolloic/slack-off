#!/bin/sh
# Offline stand-in for lint-staged (phase 4a spike §1): a backup stash, hiding unstaged changes, "formatting" staged
# files and re-adding them, restoring, a temp file in the git dir.
set -eu
gd=$(git rev-parse --absolute-git-dir)          # <common>/worktrees/<name> in a linked worktree
# 1. lint-staged-style backup: stash create + store (objects, refs/stash, logs/refs/stash)
h=$(git stash create)
if [ -n "$h" ]; then git stash store -q -m "fake-lint-staged automatic backup" "$h"; fi
# 2. temp file in the git dir (lint-staged_unstaged.patch)
git diff --binary > "$gd/lint-staged_unstaged.patch"
# 3. stash push --keep-index when there are unstaged changes
stashed=0
unstaged=$(git diff --name-only)
if [ -n "$unstaged" ]; then git stash push --keep-index -q -- $unstaged; stashed=1; fi
# 4. "format" every staged file and re-add it (index)
for f in $(git diff --cached --name-only --diff-filter=ACM); do
  printf '/* formatted */\n' >> "$f"
  git add -- "$f"
done
# 5. restore (restore + drop rather than pop: a pop re-applies the staged hunks over the formatted file → conflict)
if [ "$stashed" = 1 ]; then git checkout -q stash@{0} -- $unstaged; git reset -q -- $unstaged; git stash drop -q; fi
rm -f "$gd/lint-staged_unstaged.patch"
# 6. drop the backup (step 3 can produce the same commit as the backup within one second: then the ref did not move)
if git rev-parse -q --verify refs/stash >/dev/null; then git stash drop -q; fi
# 7. write and delete a temp file under $GIT_DIR (as git exported it, else the admin dir)
t="${GIT_DIR:-$gd}/fake-lint-staged.$$"
echo x > "$t"; rm -f "$t"
echo "fake-lint-staged: ok"
