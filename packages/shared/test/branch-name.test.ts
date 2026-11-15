import assert from "node:assert/strict";
import { test } from "node:test";
import { BRANCH_TYPES, guessBranchType, isTicketBranch } from "../src/branch-name.ts";

test("guessBranchType: defects are fix, documentation is docs, the rest feat", () => {
  assert.equal(guessBranchType("UI | Focus state issue on Site wide banner"), "fix");
  assert.equal(guessBranchType("Login button broken on Safari"), "fix");
  assert.equal(guessBranchType("Bug: totals are wrong"), "fix");
  assert.equal(guessBranchType("Update the README for the API"), "docs");
  assert.equal(guessBranchType("Export orders as CSV"), "feat");
  assert.equal(guessBranchType(""), "feat");
});

test("isTicketBranch: <type>/<KEY>-<slug>[-n] or the legacy slackoff/…, never a base branch", () => {
  for (const ok of ["fix/PROJ-128-focus-state-issue", "feat/FAKE-1-export-orders-as-csv-2", "docs/P-1-ticket", "chore/AB_C-12-x", "slackoff/K-1-add-login", "slackoff/FAKE-3-x-2"]) {
    assert.ok(isTicketBranch(ok), ok);
  }
  for (const bad of ["main", "develop", "release/1.32.0", "hotfix/1.2", "feat/main", "fix/PROJ-128", "fix/proj-1-x", "feature/PROJ-1-x", "fix/PROJ-1-x/../main", "fix/PROJ-1-X", "", "slackoff/"]) {
    assert.ok(!isTicketBranch(bad), bad);
  }
  assert.deepEqual([...BRANCH_TYPES], ["feat", "fix", "docs", "chore", "refactor", "test", "perf", "build", "ci", "style"]);
});
