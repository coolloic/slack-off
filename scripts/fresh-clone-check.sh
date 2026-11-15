#!/bin/sh
# Fresh-clone check (phase 4e Task 6): what a first-time user does after `git clone`, automated as far as it can be.
#
# Clones the COMMITTED state of this repository (never the working tree's changes) into a temporary folder, installs
# with the pinned pnpm and the lockfile, type-checks, runs the unit tests, builds the UI, starts the server in fake
# mode with a temporary SLACKOFF_HOME and checks that /api/status answers. Everything it writes is under one temporary
# folder that is deleted at the end: pnpm's store, cache and state included (set for `pnpm install` alone, never
# exported, so the unit tests see the same environment as in your own checkout).
#
# The temporary folder is made under /private/var/tmp, not under $TMPDIR: the command sandbox lets sandboxed commands
# write the system temp dirs, so a checkout inside them would fail the unit tests that prove the checkout is read-only
# to sandboxed code (the tests' own scratch HOMEs live under /private/var/tmp for the same reason). It never changes your Node or pnpm
# installation or any global configuration, and never logs in to anything.
#
# Usage: scripts/fresh-clone-check.sh
#   SLACKOFF_CHECK_OFFLINE=1  install with --offline (only works when the packages are already in the store used)
#   SLACKOFF_CHECK_KEEP=1     keep the temporary folder (its path is printed) to look at after a failure
set -eu

fail() {
  echo "fresh clone check: FAILED: $*" >&2
  exit 1
}

src=$(git rev-parse --show-toplevel)

# Port 4317 is fixed (the command sandbox denies exactly it): a running Slack Off would answer instead of the clone.
if lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port 4317 is already in use (lsof -nP -iTCP:4317 -sTCP:LISTEN shows what): stop that program first"
fi

node_version=$(node --version)
case "$node_version" in
  v26.*) ;;
  *) fail "Node 26 is needed, found $node_version (run 'nvm use' in the repository, or put Node 26 first on PATH)" ;;
esac

# The pnpm version pinned in package.json ("packageManager": "pnpm@x.y.z"). Node 26 ships without corepack, so the pnpm
# on PATH is used when it is that version; corepack is used only if present, with its own home in the temp folder.
want=$(node -p 'require(process.argv[1]).packageManager.replace(/^pnpm@/, "")' "$src/package.json")

tmp=$(mktemp -d /private/var/tmp/slackoff-fresh-clone.XXXXXX)
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "${SLACKOFF_CHECK_KEEP:-}" = "1" ]; then
    echo "kept: $tmp"
  else
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# pnpm --version runs in the repository (a self-switching pnpm picks the version pinned in its package.json only
# there) with the temp cache/state, so it never writes your real pnpm caches
pnpm_version() { (cd "$src" && pnpm_config_cache_dir="$tmp/pnpm-cache" pnpm_config_state_dir="$tmp/pnpm-state" pnpm --version 2>/dev/null); }
if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm_version)" = "$want" ]; then
  set -- pnpm
elif command -v corepack >/dev/null 2>&1; then
  export COREPACK_HOME="$tmp/corepack"
  set -- corepack pnpm
else
  fail "pnpm $want is needed (found: $(pnpm_version || echo none)); see docs/install.md step 2"
fi

# pnpm's store, metadata cache and state stay in the temp folder, never in your real caches (pnpm 12 reads
# pnpm_config_*, not npm_config_*).
# The store is set for the install alone (the sandbox tests check that it is not in their environment).
pnpm_install() {
  pnpm_config_store_dir="$tmp/pnpm-store" pnpm_config_cache_dir="$tmp/pnpm-cache" pnpm_config_state_dir="$tmp/pnpm-state" \
    "$@" install --frozen-lockfile ${offline:+--offline}
}
run_pnpm() {
  pnpm_config_cache_dir="$tmp/pnpm-cache" pnpm_config_state_dir="$tmp/pnpm-state" "$@"
}

step() { echo "== $*"; }

step "clone the committed state of $src"
# core.hooksPath=/dev/null: your global git hooks (a post-checkout hook, say) never run on the clone
git -c core.hooksPath=/dev/null clone --quiet --no-local "$src" "$tmp/slack-off"
cd "$tmp/slack-off"
echo "commit $(git rev-parse --short HEAD), node $node_version, pnpm $("$@" --version)"

step "install (frozen lockfile)"
offline=""
[ "${SLACKOFF_CHECK_OFFLINE:-}" = "1" ] && offline=1
pnpm_install "$@"

step "typecheck"
run_pnpm "$@" typecheck

step "unit tests"
run_pnpm "$@" test

step "build the UI"
run_pnpm "$@" -F web build

step "start in fake mode with a temporary SLACKOFF_HOME"
mkdir "$tmp/home"
SLACKOFF_HOME="$tmp/home" SLACKOFF_FAKE_EXECUTOR=1 node --disable-sigusr1 packages/server/src/main.ts >"$tmp/server.log" 2>&1 &
server_pid=$!

status=""
i=0
while [ "$i" -lt 30 ]; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$tmp/server.log" >&2
    fail "the server exited during startup"
  fi
  status=$(curl -fsS --max-time 2 http://127.0.0.1:4317/api/status 2>/dev/null || true)
  [ -n "$status" ] && break
  sleep 1
  i=$((i + 1))
done
[ -n "$status" ] || { cat "$tmp/server.log" >&2; fail "/api/status did not answer within 30 seconds"; }
case "$status" in
  *'"jira":'*) ;;
  *) fail "/api/status answered without a jira field: $status" ;;
esac
echo "/api/status: $(printf '%s' "$status" | cut -c1-160)"

kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
server_pid=""

echo "fresh clone check: OK"
