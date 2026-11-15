import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHECKLIST, CROSS_REPO_CHECKLIST } from "@slackoff/shared";
import { parseConfig, type Config } from "../src/config.ts";
import {
  ALWAYS_FORBIDDEN, affectedRepos, isForbidden, isSafeCommand, loadProjectRules, projectRepos, ProjectRulesError,
  RepoNotMappedError, resolveChecklist, type LoadedRules, type ProjectRules, type RepoContext, splitCliCommand, isAppEntry, isGenericInterpreter,
} from "../src/projects/project-rules.ts";
import type { Ticket } from "../src/tickets/ticket-repo.ts";
import { runGit } from "../src/git/run.ts";
import { GlobError, validateGlob } from "../src/projects/glob.ts";
import { gitRefusalMessage, type AppAcceptanceRules } from "../src/projects/project-rules.ts";
import { tmpDir } from "./helpers/tmp.ts";

const root = tmpDir("rules");
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });

/** A fresh repo on branch main with the given files committed. */
function repo(files: Record<string, string>, name = `repo-${n++}`): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

const emptyRules: ProjectRules = { forbiddenPaths: [], commands: {}, jiraStatus: {}, checklist: { add: [], remove: [] }, prompts: {}, acceptance: null, sandbox: { localPorts: [] } };

test("loadProjectRules reads .slackoff/config.json and rules.md from the base branch commit, not the working tree", async () => {
  const cfg = { forbiddenPaths: ["infra/**"], commands: { install: "pnpm install", test: "pnpm test" }, unknownKey: 1 };
  const dir = repo({ ".slackoff/config.json": JSON.stringify(cfg), ".slackoff/rules.md": "# Rules\nNo ORMs.\n", "README.md": "x" });
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, ".slackoff/config.json"), JSON.stringify({ forbiddenPaths: [] }));
  writeFileSync(join(dir, ".slackoff/rules.md"), "edited");
  git(dir, "commit", "-q", "-am", "feature edits");
  writeFileSync(join(dir, ".slackoff/config.json"), JSON.stringify({ forbiddenPaths: ["uncommitted/**"] }));

  const loaded = await loadProjectRules(dir, "main");
  assert.equal(loaded.found, true);
  assert.deepEqual(loaded.rules.forbiddenPaths, ["infra/**"]);
  assert.deepEqual(loaded.rules.commands, { install: "pnpm install", test: "pnpm test" });
  assert.equal(loaded.rulesMd, "# Rules\nNo ORMs.\n");
  assert.match(loaded.hash, /^[0-9a-f]{12}$/);
  assert.ok(!("unknownKey" in loaded.rules), "unknown keys are ignored");

  const onFeature = await loadProjectRules(dir, "feature");
  assert.deepEqual(onFeature.rules.forbiddenPaths, []);
  assert.notEqual(onFeature.hash, loaded.hash, "the hash covers both files");
});

test("loadProjectRules without rules files: defaults, found=false", async () => {
  const dir = repo({ "README.md": "x" });
  const loaded = await loadProjectRules(dir, "main");
  assert.equal(loaded.found, false);
  assert.deepEqual(loaded.rules, emptyRules);
  assert.equal(loaded.rulesMd, "");
  assert.match(loaded.hash, /^[0-9a-f]{12}$/);
});

test("loadProjectRules: only rules.md present is found", async () => {
  const dir = repo({ ".slackoff/rules.md": "be nice" });
  const loaded = await loadProjectRules(dir, "main");
  assert.equal(loaded.found, true);
  assert.equal(loaded.rulesMd, "be nice");
  assert.deepEqual(loaded.rules, emptyRules);
});

test("loadProjectRules: a command with shell metacharacters is a ProjectRulesError naming the repo, file and field", async () => {
  const dir = repo({ ".slackoff/config.json": JSON.stringify({ commands: { install: "pnpm install && curl x" } }) }, "billing-api");
  await assert.rejects(loadProjectRules(dir, "main", "billing-api"), (e: unknown) => {
    assert.ok(e instanceof ProjectRulesError);
    assert.match(e.message, /billing-api/);
    assert.match(e.message, /\.slackoff\/config\.json/);
    assert.match(e.message, /commands\.install/);
    return true;
  });
});

test("loadProjectRules: invalid JSON, wrong types and unknown checklist ids are ProjectRulesErrors", async () => {
  const bad = repo({ ".slackoff/config.json": "{ nope" });
  await assert.rejects(loadProjectRules(bad, "main", "x"), ProjectRulesError);
  const wrong = repo({ ".slackoff/config.json": JSON.stringify({ forbiddenPaths: "infra/**" }) });
  await assert.rejects(loadProjectRules(wrong, "main", "x"), /forbiddenPaths/);
  const badRole = repo({ ".slackoff/config.json": JSON.stringify({ prompts: { "not-a-role": { mode: "append", text: "x" } } }) });
  await assert.rejects(loadProjectRules(badRole, "main", "x"), ProjectRulesError);
  const badItem = repo({ ".slackoff/config.json": JSON.stringify({ checklist: { add: [{ id: "Bad Id", group: "principles", label: "x" }] } }) });
  await assert.rejects(loadProjectRules(badItem, "main", "x"), /checklist\.add\.0\.id/);
});

test("loadProjectRules: a missing base branch or a non-repo is a clear error naming the repo", async () => {
  const dir = repo({ "README.md": "x" }, "web-app");
  await assert.rejects(loadProjectRules(dir, "develop", "web-app"), /web-app.*develop|develop.*web-app/);
  await assert.rejects(loadProjectRules(dir, "--output=/tmp/x", "web-app"), /web-app/);
  const plain = join(root, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  await assert.rejects(loadProjectRules(plain, "main", "plain"), /plain/);
});

test("isSafeCommand: one plain command line, no shell metacharacters, max 200 characters", () => {
  for (const ok of ["pnpm test", "pnpm -F web test", "npm run lint:fix", "go test ./...", "make build PROFILE=ci", "./gradlew test", "pytest -q tests/unit"]) {
    assert.equal(isSafeCommand(ok), true, ok);
  }
  for (const bad of ["", " pnpm test", "pnpm  test", "pnpm test ", "a;b", "a && b", "a | b", "a $(b)", "a `b`", "a > f", "a < f", "a (b)", "rm *", "a?", "a\nb", "a 'b'", 'a "b"', "x".repeat(201)]) {
    assert.equal(isSafeCommand(bad), false, JSON.stringify(bad));
  }
});

test("isForbidden: platform paths always, plus the repo's globs and extra hook dirs", () => {
  assert.deepEqual(ALWAYS_FORBIDDEN, [".git", ".git/**", "**/.git", "**/.git/**", ".slackoff/**", ".husky/**", ".githooks/**"]);
  assert.equal(isForbidden(".slackoff/config.json", emptyRules), true);
  assert.equal(isForbidden(".git", emptyRules), true);
  assert.equal(isForbidden(".git/config", emptyRules), true);
  assert.equal(isForbidden(".githooks/pre-commit", emptyRules), true);
  assert.equal(isForbidden(".husky/pre-commit", emptyRules), true);
  assert.equal(isForbidden("hooks/x", emptyRules, ["hooks/**"]), true);
  assert.equal(isForbidden("hooks/x", emptyRules), false);
  assert.equal(isForbidden("src/index.ts", emptyRules), false);
  const rules = { ...emptyRules, forbiddenPaths: ["infra/**", "*.lock"] };
  assert.equal(isForbidden("infra/main.tf", rules), true);
  assert.equal(isForbidden("yarn.lock", rules), true);
  assert.equal(isForbidden("src/infra.ts", rules), false);
});

test("isForbidden: dotfiles, bare directories, nested .git, empty and '.' are covered", () => {
  for (const p of [
    ".git/.x", ".husky/.x", ".githooks/.hidden", ".slackoff/.x", ".husky/_/.gitignore",
    ".slackoff", ".husky", ".githooks", ".slackoff/", ".husky/", "sub/.git", "sub/.git/config", "a/b/.git/hooks/pre-commit",
    "", ".", "./", "./.git",
  ]) {
    assert.equal(isForbidden(p, emptyRules), true, JSON.stringify(p));
  }
  assert.equal(isForbidden("infra/.env", { ...emptyRules, forbiddenPaths: ["infra/**"] }), true);
  assert.equal(isForbidden("infra", { ...emptyRules, forbiddenPaths: ["infra/**"] }), true);
  assert.equal(isForbidden("hooks/.x", emptyRules, ["hooks/**"]), true);
  assert.equal(isForbidden(".gitignore", emptyRules), false);
  assert.equal(isForbidden("src/.gitkeep", emptyRules), false);
  assert.equal(isForbidden("src/a.ts", { ...emptyRules, forbiddenPaths: ["src/{b,c}.ts", "lib/[ab].ts"] }), false);
  assert.equal(isForbidden("src/c.ts", { ...emptyRules, forbiddenPaths: ["src/{b,c}.ts"] }), true);
  assert.equal(isForbidden("lib/b.ts", { ...emptyRules, forbiddenPaths: ["lib/[ab].ts"] }), true);
});

test("isForbidden: platform paths are case-insensitive everywhere; repo globs on darwin/win32", () => {
  for (const p of [".GIT", ".Git/config", ".SLACKOFF/config.json", ".Husky/pre-commit", ".GitHooks/x", "Sub/.GIT/config"]) {
    assert.equal(isForbidden(p, emptyRules, [], "linux"), true, p);
    assert.equal(isForbidden(p, emptyRules, [], "darwin"), true, p);
  }
  assert.equal(isForbidden("HOOKS/x", emptyRules, ["hooks/**"], "linux"), true);
  const rules = { ...emptyRules, forbiddenPaths: ["infra/**"] };
  assert.equal(isForbidden("INFRA/main.tf", rules, [], "darwin"), true);
  assert.equal(isForbidden("INFRA/main.tf", rules, [], "win32"), true);
  assert.equal(isForbidden("INFRA/main.tf", rules, [], "linux"), false);
});

test("isSafeCommand: the first token is a program, not an assignment, an option or a shell builtin", () => {
  for (const bad of ["FOO=1 pnpm test", "-rf x", "--help", "eval x", "exec pnpm", "source x", ". x", "command ls", "builtin cd", "export A", "alias a", "unset A", "set -e", "env pnpm test", "sudo pnpm", "sh x", "bash x", "zsh x"]) {
    assert.equal(isSafeCommand(bad), false, bad);
  }
  for (const ok of ["pnpm test FOO=1", "./scripts/test", "make CI=1", "node --test"]) assert.equal(isSafeCommand(ok), true, ok);
});

test("loadProjectRules: the path must be the top of a non-bare git work tree", async () => {
  const top = repo({ "sub/README.md": "x" }, "top-repo");
  await assert.rejects(loadProjectRules(join(top, "sub"), "main", "sub"), (e: unknown) => e instanceof RepoNotMappedError && /sub/.test(e.message) && /not the top of a git repository/.test(e.message));
  await assert.rejects(loadProjectRules(join(top, ".git"), "main", "dotgit"), /not the top of a git repository/);
  const bare = join(root, "bare.git");
  execFileSync("git", ["clone", "-q", "--bare", top, bare]);
  await assert.rejects(loadProjectRules(bare, "main", "bare"), /not the top of a git repository/);
  await assert.rejects(loadProjectRules(join(root, "missing"), "main", "missing"), /not the top of a git repository/);
  assert.equal((await loadProjectRules(top + "/", "main", "top")).found, false, "a trailing slash is the same directory");
});

test("loadProjectRules: the base branch must be a branch (not HEAD, a tag, a revision expression)", async () => {
  const dir = repo({ "README.md": "x" }, "branchy");
  git(dir, "tag", "v1");
  git(dir, "commit", "-q", "--allow-empty", "-m", "two");
  for (const b of ["HEAD", "@{-1}", "main~1", "main^", ":/init", "v1", "main..main", "refs/heads/main"]) {
    await assert.rejects(loadProjectRules(dir, b, "branchy"), (e: unknown) => e instanceof RepoNotMappedError && /branchy/.test(e.message), b);
  }
  assert.equal((await loadProjectRules(dir, "main", "branchy")).found, false);
});

test("loadProjectRules: a rules file too large for the output cap is an error saying so", async () => {
  const dir = repo({ ".slackoff/rules.md": "x".repeat(300 * 1024) }, "big");
  await assert.rejects(loadProjectRules(dir, "main", "big"), (e: unknown) => e instanceof ProjectRulesError && /too large/.test(e.message));
});

test("runGit ignores inherited GIT_* variables and reports truncated output", async () => {
  const a = repo({ "a.txt": "a" }, "env-a");
  const b = repo({ "b.txt": "b" }, "env-b");
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
  process.env.GIT_DIR = join(b, ".git");
  process.env.GIT_WORK_TREE = b;
  process.env.GIT_INDEX_FILE = join(b, ".git", "index");
  try {
    const r = await runGit(a, ["rev-parse", "--show-toplevel"]);
    assert.equal(r.code, 0);
    assert.equal(realpathSync(r.stdout.trim()), realpathSync(a));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const big = await runGit(a, ["log", "--format=%H%n%H%n%H"], { maxOutput: 10 });
  assert.equal(big.truncated, true);
  const small = await runGit(a, ["rev-parse", "HEAD"]);
  assert.equal(small.truncated, false);
});

const withPaths = (...forbiddenPaths: string[]): ProjectRules => ({ ...emptyRules, forbiddenPaths });

test("glob folding: NFKC + lower-case on both sides for platform paths everywhere and repo globs on darwin", () => {
  for (const p of [".slac\u212Aoff/x", ".\u017Flackoff/x", ".hu\u017Fky/x", ".githoo\u212As/x", ".GIT/config"]) {
    assert.equal(isForbidden(p, emptyRules, [], "linux"), true, p);
    assert.equal(isForbidden(p, emptyRules, [], "darwin"), true, p);
  }
  assert.equal(isForbidden("cafe\u0301/x", withPaths("caf\u00e9/**"), [], "darwin"), true, "NFD path vs NFC glob on darwin");
  assert.equal(isForbidden("cafe\u0301/x", withPaths("caf\u00e9/**"), [], "linux"), true, "NFC on linux too");
  assert.equal(isForbidden("\u212Aube/x", withPaths("kube/**"), [], "darwin"), true);
  assert.equal(isForbidden("kube/x", withPaths("\u212Aube/**"), [], "darwin"), true);
  assert.equal(isForbidden("\u212Aube/x", withPaths("kube/**"), [], "linux"), false);
});

test("glob braces expand recursively before matching", () => {
  assert.equal(isForbidden("a.pem", withPaths("{*.pem,*.key}")), true);
  assert.equal(isForbidden("a.key", withPaths("{*.pem,*.key}")), true);
  assert.equal(isForbidden("a.txt", withPaths("{*.pem,*.key}")), false);
  assert.equal(isForbidden("x/a.pem", withPaths("**/{*.pem,*.key}")), true);
  assert.equal(isForbidden("x/b", withPaths("x/{a,{b,c}}")), true);
  assert.equal(isForbidden("x/a", withPaths("x/{a,{b,c}}")), true);
  assert.equal(isForbidden("x/d", withPaths("x/{a,{b,c}}")), false);
  assert.equal(isForbidden("infra/x", withPaths("{infra/**,ops}")), true);
  assert.equal(isForbidden("ops/y", withPaths("{infra/**,ops}")), true);
});

test("glob directory semantics: plain names, trailing '/', '/**/' and a leading '/' anchor", () => {
  for (const g of ["infra", "infra/", "infra/**", "infra/**/", "/infra/**", "/infra"]) {
    assert.equal(isForbidden("infra", withPaths(g)), true, g);
    assert.equal(isForbidden("infra/x", withPaths(g)), true, g);
    assert.equal(isForbidden("infra/a/.env", withPaths(g)), true, g);
    assert.equal(isForbidden("infrastructure/x", withPaths(g)), false, g);
    assert.equal(isForbidden("src/infra/x", withPaths(g)), false, g);
  }
  assert.equal(isForbidden("a/b/c/d.ts", withPaths("a/**/**/d.ts")), true);
  assert.equal(isForbidden("a/d.ts", withPaths("a/**/**/d.ts")), true);
});

test("invalid globs: rejected when the rules file is parsed, naming the pattern; isForbidden fails closed", async () => {
  const tooMany = "{" + Array.from({ length: 65 }, (_, i) => `a${i}`).join(",") + "}";
  for (const bad of ["[z-a]", "src/{a,b", "src/a}", "lib/[ab", "lib/ab]", tooMany, "*a*b*c*d*e*f*g*h*i", ""]) {
    assert.throws(() => validateGlob(bad), GlobError, bad);
    assert.equal(isForbidden("src/x", withPaths(bad)), true, `fail closed: ${bad}`);
  }
  validateGlob("*a*b*c*d*e*f*g*h");
  const dir = repo({ ".slackoff/config.json": JSON.stringify({ forbiddenPaths: ["ok/**", "[z-a]"] }) }, "globby");
  await assert.rejects(loadProjectRules(dir, "main", "globby"), (e: unknown) => e instanceof ProjectRulesError && e.message.includes("[z-a]") && /forbiddenPaths\.1/.test(e.message));
});

test("glob matching is linear: the worst allowed pattern against a 200-character path is fast", () => {
  const path = "a".repeat(199) + "b";
  const patterns = ["*a*a*a*a*a*a*a*a", "**/a/**/a/**/a/**/a/**/a/**/a/**/a/**/c", "?*?*?*?*a", "**/**/**/**/x"];
  const t0 = performance.now();
  for (const g of patterns) assert.equal(isForbidden(path, withPaths(g), [], "linux"), false, g);
  const deep = Array.from({ length: 100 }, () => "a").join("/");
  for (const g of patterns) isForbidden(deep, withPaths(g), [], "linux");
  assert.ok(performance.now() - t0 < 50, `took ${performance.now() - t0} ms`);
});

test("gitRefusalMessage: dubious ownership / safe.directory is surfaced", () => {
  const stderr = "fatal: detected dubious ownership in repository at '/w/api'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /w/api\n";
  assert.match(gitRefusalMessage(stderr) ?? "", /dubious ownership/);
  assert.equal(gitRefusalMessage("fatal: not a git repository"), null);
});

test("loadProjectRules: a differently-cased Settings path is the same repo on darwin", { skip: process.platform !== "darwin" }, async () => {
  const dir = repo({ "README.md": "x" }, "Case-Repo");
  const other = join(root, "case-repo");
  assert.equal((await loadProjectRules(other, "main", "case-repo")).found, false);
  assert.equal((await loadProjectRules(dir, "main", "case-repo")).found, false);
});

test("glob folding is full case folding (ß → ss, ı → i)", () => {
  assert.equal(isForbidden("a\u00dfets/x", withPaths("assets/**"), [], "darwin"), true);
  assert.equal(isForbidden("cla\u00dfes/a", withPaths("classes/**"), [], "darwin"), true);
  assert.equal(isForbidden("classes/a", withPaths("cla\u00dfes/**"), [], "darwin"), true);
  assert.equal(isForbidden("\u0131nfra/x", withPaths("infra/**"), [], "darwin"), true);
  assert.equal(isForbidden("a\u00dfets/x", withPaths("assets/**"), [], "linux"), false);
  assert.equal(isForbidden(".gi\u0074/config", emptyRules), true);
  assert.equal(isForbidden(".slacko\u0066\u0066/x", emptyRules, [], "linux"), true);
  assert.equal(isForbidden("src/a.ts", emptyRules, [], "darwin"), false);
});

test("glob folding is idempotent: capital sharp s (U+1E9E) folds to ss like ß", () => {
  assert.equal(isForbidden("aẞets/x", withPaths("assets/**"), [], "darwin"), true);
  assert.equal(isForbidden("assets/x", withPaths("aẞets/**"), [], "darwin"), true);
});

test("astral characters in patterns match by code point (literal, class and range)", () => {
  for (const platform of ["linux", "darwin"] as const) {
    assert.equal(isForbidden("\u{1F600}/x", withPaths("\u{1F600}"), [], platform), true, `emoji literal ${platform}`);
    assert.equal(isForbidden("a\u{1F600}b", withPaths("a\u{1F600}b"), [], platform), true, `emoji inside ${platform}`);
    assert.equal(isForbidden("\u{10428}/x", withPaths("\u{10428}/**"), [], platform), true, `deseret ${platform}`);
    assert.equal(isForbidden("\u{1F601}", withPaths("[\u{1F600}-\u{1F602}]"), [], platform), true, `astral range ${platform}`);
    assert.equal(isForbidden("\u{1F603}", withPaths("[\u{1F600}-\u{1F602}]"), [], platform), false, `outside astral range ${platform}`);
  }
});

test("every glob also covers the descendants of what it matches", () => {
  const cases: Array<[string, string]> = [
    ["secrets-prod/key.pem", "secrets-*"], ["infra1/x", "infra?"], ["adir/x", "[ab]dir"], ["config/sub/a", "config/*"],
    ["src/a.ts", "*"], ["x/a.pem/inner", "**/*.pem"], ["ab/c", "a**"],
  ];
  for (const [path, g] of cases) assert.equal(isForbidden(path, withPaths(g)), true, `${g} ~ ${path}`);
  assert.equal(isForbidden("infrastructure/x", withPaths("infra")), false);
  assert.equal(isForbidden("src/infra/x", withPaths("infra")), false);
  assert.equal(isForbidden("secret/x", withPaths("secrets-*")), false);
  validateGlob("*a*a*a*a*a*a*a*a");
});

test("glob matching does not recurse: a 10,000-character path is fine and fast", () => {
  const long = "a/".repeat(5000);
  const t0 = performance.now();
  assert.equal(isForbidden(long, emptyRules, [], "linux"), false);
  assert.equal(isForbidden(long + ".git/x", emptyRules, [], "linux"), true);
  assert.equal(isForbidden("x".repeat(10_000), withPaths("*a*a*a*a*a*a*a*b"), [], "darwin"), false);
  assert.ok(performance.now() - t0 < 50, `took ${performance.now() - t0} ms`);
});

test("validateGlob rejects '.' and '..' segments", () => {
  for (const bad of ["./infra", "a/./b", "../x", "a/../b", "a/..", "a/.", ".."]) assert.throws(() => validateGlob(bad), GlobError, bad);
  for (const ok of [".env", "a/.hidden/**", "..x", "a/...b"]) validateGlob(ok);
});

const ticket = (key: string): Ticket => ({ key } as Ticket);
const cfg = (projects: Record<string, unknown>): Config => parseConfig({ projects });
const ref = (name: string) => ({ name, path: `/w/${name}`, baseBranch: "main" });

test("projectRepos: the project's repos; unmapped -> RepoNotMappedError", () => {
  const c = cfg({ PROJ: { repos: [ref("api"), ref("web")] } });
  assert.deepEqual(projectRepos(ticket("PROJ-1"), c), [ref("api"), ref("web")]);
  assert.throws(() => projectRepos(ticket("OTHER-1"), c), (e: unknown) => e instanceof RepoNotMappedError && e.message === "Map project OTHER to a repo in Settings");
});

test("affectedRepos: null with one repo -> that repo; null with many -> choose again; unmapped names are named", () => {
  const one = cfg({ PROJ: { repos: [ref("api")] } });
  const two = cfg({ PROJ: { repos: [ref("api"), ref("web")] } });
  assert.deepEqual(affectedRepos(ticket("PROJ-1"), { affectedRepos: null }, one), [ref("api")]);
  assert.throws(() => affectedRepos(ticket("PROJ-1"), { affectedRepos: null }, two), (e: unknown) => e instanceof RepoNotMappedError && e.message === "Choose the affected repositories again");
  assert.deepEqual(affectedRepos(ticket("PROJ-1"), { affectedRepos: ["web"] }, two), [ref("web")]);
  assert.deepEqual(affectedRepos(ticket("PROJ-1"), { affectedRepos: ["web", "api"] }, two).map((r) => r.name), ["web", "api"]);
  assert.throws(
    () => affectedRepos(ticket("PROJ-1"), { affectedRepos: ["api", "billing"] }, two),
    (e: unknown) => e instanceof RepoNotMappedError && e.message === "Repository billing is no longer mapped for project PROJ — fix Settings or choose a different solution",
  );
  assert.throws(() => affectedRepos(ticket("NOPE-1"), { affectedRepos: ["api"] }, two), /Map project NOPE to a repo in Settings/);
});

const ctx = (name: string, rules: Partial<ProjectRules> = {}): RepoContext => {
  const loaded: LoadedRules = { rules: { ...emptyRules, ...rules }, rulesMd: "", hash: "000000000000", found: true };
  return { ...ref(name), rules: loaded };
};

test("resolveChecklist: default 22, +3 cross-repo, remove only when every repo removes, add union", () => {
  assert.equal(DEFAULT_CHECKLIST.length, 22);
  assert.deepEqual(resolveChecklist([ctx("api")]), [...DEFAULT_CHECKLIST]);
  const two = resolveChecklist([ctx("api"), ctx("web")]);
  assert.equal(two.length, 25);
  assert.deepEqual(two.slice(22), [...CROSS_REPO_CHECKLIST]);
  const oneRemoves = resolveChecklist([ctx("api", { checklist: { add: [], remove: ["yagni"] } }), ctx("web")]);
  assert.ok(oneRemoves.some((i) => i.id === "yagni"));
  const bothRemove = resolveChecklist([ctx("api", { checklist: { add: [], remove: ["yagni"] } }), ctx("web", { checklist: { add: [], remove: ["yagni", "dry"] } })]);
  assert.ok(!bothRemove.some((i) => i.id === "yagni"));
  assert.ok(bothRemove.some((i) => i.id === "dry"));
  assert.equal(bothRemove.length, 24);
  const single = resolveChecklist([ctx("api", { checklist: { add: [], remove: ["yagni"] } })]);
  assert.equal(single.length, 21);
  const added = resolveChecklist([
    ctx("api", { checklist: { add: [{ id: "gdpr", group: "non_functional", label: "GDPR" }], remove: [] } }),
    ctx("web", { checklist: { add: [{ id: "gdpr", group: "non_functional", label: "Other" }, { id: "a11y", group: "non_functional", label: "Accessibility" }], remove: [] } }),
  ]);
  assert.equal(added.length, 27);
  assert.deepEqual(added.filter((i) => i.id === "gdpr"), [{ id: "gdpr", group: "non_functional", label: "GDPR" }]);
  assert.throws(() => resolveChecklist([ctx("api", { checklist: { add: [], remove: ["nope"] } })]), (e: unknown) => e instanceof ProjectRulesError && /api/.test(e.message) && /nope/.test(e.message));
});

// ---------------------------------------------------------------- phase 3 (Task 4): acceptance section

const rulesWith = (cfg: unknown, name = `acc-${n++}`) => repo({ ".slackoff/config.json": JSON.stringify(cfg) }, name);
const acceptance = { entry: "web", start: "pnpm dev", baseUrl: "http://127.0.0.1:3000" };

test("acceptance section: parsed with defaults (healthPath '/', env {}); absent -> null", async () => {
  const none = await loadProjectRules(rulesWith({ commands: { test: "pnpm test" } }), "main");
  assert.equal(none.rules.acceptance, null);
  const min = await loadProjectRules(rulesWith({ acceptance }), "main");
  assert.deepEqual(min.rules.acceptance, { ...acceptance, healthPath: "/", env: {} });
  const full = {
    entry: "api", install: "pnpm install --frozen-lockfile", start: "pnpm start", stop: "pnpm stop", baseUrl: "http://localhost:8080/app",
    healthPath: "/health", testCommand: "pnpm e2e", env: { PORT: "8080", NODE_ENV: "test", API_URL: "http://localhost:8080/api" },
  };
  assert.deepEqual((await loadProjectRules(rulesWith({ acceptance: full }), "main")).rules.acceptance, full);
  assert.equal((await loadProjectRules(rulesWith({ acceptance: null }), "main")).rules.acceptance, null);
});

test("jiraStatus.readyForReview is read from the rules file and validated like inProgress", async () => {
  const ok = await loadProjectRules(rulesWith({ jiraStatus: { readyForReview: "Code Review" } }), "main");
  assert.deepEqual(ok.rules.jiraStatus, { readyForReview: "Code Review" });
  await assert.rejects(loadProjectRules(rulesWith({ jiraStatus: { readyForReview: 'Ready "x' } }), "main", "x"), /jiraStatus\.readyForReview/);
});

test("acceptance.baseUrl: only http on 127.0.0.1 / localhost with an explicit port, never Slack Off's own ports", async () => {
  for (const baseUrl of [
    "http://127.0.0.1:4317", "http://localhost:5173", "http://localhost:4317/x", "http://example.com:3000", "https://127.0.0.1:3000",
    "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://user@127.0.0.1:3000", "http://[::1]:3000",
    "http://127.0.0.1:3000?x=1", "http://127.0.0.1:3000#a", "http://127.0.0.1:3000 /x", "file:///etc/passwd", "http://127.0.0.2:3000",
    "http://localhost.evil.com:3000", "http://127.0.0.1:03000",
  ]) {
    const name = `web-${n++}`;
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: { ...acceptance, baseUrl } }, name), "main", name), (e: unknown) => {
      assert.ok(e instanceof ProjectRulesError, baseUrl);
      assert.match(e.message, new RegExp(name), baseUrl);
      assert.equal(e.field, "acceptance.baseUrl", baseUrl);
      return true;
    });
  }
  for (const baseUrl of ["http://127.0.0.1:3000", "http://localhost:8080/", "http://localhost:1/a/b-c_d.e~f"]) {
    const loaded = await loadProjectRules(rulesWith({ acceptance: { ...acceptance, baseUrl } }), "main");
    assert.equal((loaded.rules.acceptance as AppAcceptanceRules | null)?.baseUrl, baseUrl);
  }
});

test("acceptance commands pass isSafeCommand; healthPath starts with '/'; entry is web or api", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ start: "pnpm dev && curl x" }, /acceptance\.start/],
    [{ install: "npm i; rm -rf /" }, /acceptance\.install/],
    [{ stop: "kill $(cat pid)" }, /acceptance\.stop/],
    [{ testCommand: "pnpm e2e | tee out" }, /acceptance\.testCommand/],
    [{ start: "sh -c x" }, /acceptance\.start/],
    [{ healthPath: "health" }, /acceptance\.healthPath/],
    [{ healthPath: "/a b" }, /acceptance\.healthPath/],
    [{ entry: "desktop" }, /acceptance\.entry/],
    [{ start: undefined }, /acceptance\.start/],
    [{ baseUrl: undefined }, /acceptance\.baseUrl/],
  ];
  for (const [patch, field] of cases) {
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: { ...acceptance, ...patch } }), "main", "x"), (e: unknown) => {
      assert.ok(e instanceof ProjectRulesError, JSON.stringify(patch));
      assert.match(e.message, field, JSON.stringify(patch));
      return true;
    });
  }
});

test("acceptance.env: plain keys and values, at most 20, never PATH / HOME / NODE_OPTIONS / CLAUDE_CONFIG_DIR / SLACKOFF_*", async () => {
  const bad: Array<Record<string, string>> = [
    { PATH: "/x" }, { HOME: "/tmp" }, { NODE_OPTIONS: "--require=x" }, { CLAUDE_CONFIG_DIR: "/x" }, { SLACKOFF_HOME: "/x" }, { SLACKOFF_FAKE_EXECUTOR: "1" },
    { lower: "x" }, { "1ABC": "x" }, { ["A".repeat(65)]: "x" }, { PORT: "3000; rm" }, { PORT: "a b" }, { PORT: "$(x)" }, { PORT: "x".repeat(201) },
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`K${i}`, "v"])),
  ];
  for (const env of bad) {
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: { ...acceptance, env } }), "main", "x"), (e: unknown) => {
      assert.ok(e instanceof ProjectRulesError, JSON.stringify(env).slice(0, 80));
      assert.match(e.message, /acceptance\.env/, JSON.stringify(env).slice(0, 80));
      return true;
    });
  }
  const ok = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`K${i}`, "v"]));
  assert.deepEqual((await loadProjectRules(rulesWith({ acceptance: { ...acceptance, env: { ...ok } } }), "main")).rules.acceptance?.env, ok);
  assert.deepEqual((await loadProjectRules(rulesWith({ acceptance: { ...acceptance, env: { EMPTY: "" } } }), "main")).rules.acceptance?.env, { EMPTY: "" });
});

test("fix 2: acceptance.env refuses loader, shell, proxy, git, npm-config and secret-named variables", async () => {
  const bad = [
    "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "GIT_DIR", "GIT_SSH_COMMAND",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NPM_CONFIG_REGISTRY", "GH_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_PROFILE",
    "NPM_TOKEN", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "MY_TOKEN", "APP_SECRET", "DB_PASSWORD",
  ];
  for (const key of bad) {
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: { ...acceptance, env: { [key]: "x" } } }), "main", "x"), (e: unknown) => {
      assert.ok(e instanceof ProjectRulesError, key);
      assert.match(e.message, /acceptance\.env/, key);
      return true;
    });
  }
  const ok = { PORT: "3000", NODE_ENV: "test", TOKENIZER: "x", ENVIRONMENT: "ci", GITHUB_REPO_NAME: "a" };
  assert.deepEqual((await loadProjectRules(rulesWith({ acceptance: { ...acceptance, env: ok } }), "main")).rules.acceptance?.env, ok);
});

test("fix 3: healthPath and the baseUrl path refuse '//', '..' segments and backslashes", async () => {
  for (const healthPath of ["//evil.example.com/x", "/a/../b", "/..", "/a/..", "/a\\b", "/a//b"]) {
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: { ...acceptance, healthPath } }), "main", "x"), /acceptance\.healthPath/, healthPath);
  }
  for (const baseUrl of ["http://127.0.0.1:3000//evil.example.com", "http://127.0.0.1:3000/a/../b", "http://127.0.0.1:3000/..", "http://127.0.0.1:3000/a//b"]) {
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: { ...acceptance, baseUrl } }), "main", "x"), /acceptance\.baseUrl/, baseUrl);
  }
  const ok = await loadProjectRules(rulesWith({ acceptance: { ...acceptance, healthPath: "/api/health..check?x=1", baseUrl: "http://localhost:3000/app/" } }), "main");
  assert.equal((ok.rules.acceptance as AppAcceptanceRules | null)?.healthPath, "/api/health..check?x=1");
});

// ---------------------------------------------------------------- phase 4a Task 4: sandbox.localPorts

test("sandbox.localPorts: default []; up to 20 ports 1-65535 kept; a Slack Off / denied port, 70000, 0 or 21 entries -> ProjectRulesError naming the repo and the field", async () => {
  assert.deepEqual((await loadProjectRules(rulesWith({}), "main")).rules.sandbox, { localPorts: [] });
  assert.deepEqual((await loadProjectRules(rulesWith({ sandbox: { localPorts: [3000, 5432] } }), "main")).rules.sandbox, { localPorts: [3000, 5432] });
  assert.deepEqual((await loadProjectRules(rulesWith({ sandbox: {} }), "main")).rules.sandbox, { localPorts: [] });
  const twenty = Array.from({ length: 20 }, (_, i) => 6000 + i);
  assert.equal((await loadProjectRules(rulesWith({ sandbox: { localPorts: twenty } }), "main")).rules.sandbox!.localPorts.length, 20);
  for (const bad of [[4317], [5173], [9229], [70000], [0], [1.5], [...twenty, 6020]]) {
    await assert.rejects(loadProjectRules(rulesWith({ sandbox: { localPorts: bad } }, "ports-api"), "main", "ports-api"), (e: unknown) => {
      assert.ok(e instanceof ProjectRulesError, String(e));
      assert.match(e.message, /ports-api/);
      assert.match(e.message, /sandbox\.localPorts/);
      return true;
    }, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- phase 4f (Task 2): cli and library entries

test("phase 4f: acceptance entry 'cli' — cli.command required; a ./ path or a program name first; no '..', no absolute path", async () => {
  const ok = await loadProjectRules(rulesWith({ acceptance: { entry: "cli", cli: { command: "./bin/tool.mjs" } } }), "main");
  assert.deepEqual(ok.rules.acceptance, { entry: "cli", cli: { command: "./bin/tool.mjs" }, env: {}, caseEnvKeys: [], caseDotfiles: [] });
  const full = { entry: "cli", install: "pnpm install", build: "pnpm build", cli: { command: "./dist/cli.js --no-color" }, testCommand: "pnpm test", env: { TOOL_MODE: "test" }, caseEnvKeys: ["TOOL_COLOR"], caseDotfiles: [".toolrc"] };
  assert.deepEqual((await loadProjectRules(rulesWith({ acceptance: full }), "main")).rules.acceptance, full);
  for (const command of ["./tool", "./bin/tool.mjs run", "./dist/cli.js --no-color ./data/x.json"]) {
    assert.equal(((await loadProjectRules(rulesWith({ acceptance: { entry: "cli", cli: { command } } }), "main")).rules.acceptance as { cli: { command: string } }).cli.command, command);
  }
  const bad: Array<[unknown, RegExp]> = [
    [{ entry: "cli" }, /acceptance\.cli/],
    [{ entry: "cli", cli: {} }, /acceptance\.cli\.command/],
    [{ entry: "cli", cli: { command: "node ../x.mjs" } }, /acceptance\.cli\.command.*\.\./],
    [{ entry: "cli", cli: { command: "./a/../../x" } }, /acceptance\.cli\.command/],
    [{ entry: "cli", cli: { command: "../x" } }, /acceptance\.cli\.command/],
    [{ entry: "cli", cli: { command: "/usr/bin/curl x" } }, /acceptance\.cli\.command.*absolute/],
    [{ entry: "cli", cli: { command: "node /etc/x" } }, /acceptance\.cli\.command/],
    [{ entry: "cli", cli: { command: "Tool" } }, /acceptance\.cli\.command/],
    // 4F-5 (M2): never a program name on PATH
    [{ entry: "cli", cli: { command: "mytool" } }, /acceptance\.cli\.command.*\.\/ path/],
    [{ entry: "cli", cli: { command: "my-tool.v2 run" } }, /acceptance\.cli\.command.*\.\/ path/],
    [{ entry: "cli", cli: { command: "bin/tool" } }, /acceptance\.cli\.command/],
    [{ entry: "cli", cli: { command: "./" } }, /acceptance\.cli\.command/],
    [{ entry: "cli", cli: { command: "tool; rm -rf /" } }, /acceptance\.cli\.command/],
    [{ entry: "cli", cli: { command: "tool $(id)" } }, /acceptance\.cli\.command/],
    [{ entry: "cli", cli: { command: "./bin/tool" }, build: "make && x" }, /acceptance\.build/],
    [{ entry: "cli", cli: { command: "./bin/tool" }, env: { PATH: "/x" } }, /acceptance\.env/],
  ];
  for (const [a, field] of bad) {
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: a }), "main", "x"), (e: unknown) => {
      assert.ok(e instanceof ProjectRulesError, JSON.stringify(a));
      assert.match(e.message, field, JSON.stringify(a));
      return true;
    });
  }
});

test("phase 4f: acceptance entry 'library' — runtime node only, an npm package name, a relative package dir (default '.')", async () => {
  const ok = await loadProjectRules(rulesWith({ acceptance: { entry: "library", library: { runtime: "node", import: "acceptance-lib" } } }), "main");
  assert.deepEqual(ok.rules.acceptance, { entry: "library", library: { runtime: "node", import: "acceptance-lib", path: "." }, env: {}, caseEnvKeys: [], caseDotfiles: [] });
  const scoped = { entry: "library", build: "pnpm build", library: { runtime: "node", import: "@example-org/slug", path: "packages/slug" }, env: {}, caseEnvKeys: [], caseDotfiles: [] };
  assert.deepEqual((await loadProjectRules(rulesWith({ acceptance: scoped }), "main")).rules.acceptance, scoped);
  const bad: Array<[unknown, RegExp]> = [
    [{ entry: "library", library: { runtime: "python", import: "x" } }, /acceptance\.library\.runtime/],
    [{ entry: "library", library: { runtime: "node", import: "Bad Name" } }, /acceptance\.library\.import/],
    [{ entry: "library", library: { runtime: "node", import: "../x" } }, /acceptance\.library\.import/],
    [{ entry: "library", library: { runtime: "node", import: "@scope" } }, /acceptance\.library\.import/],
    [{ entry: "library", library: { runtime: "node", import: "x", path: "../other" } }, /acceptance\.library\.path/],
    [{ entry: "library", library: { runtime: "node", import: "x", path: "/abs" } }, /acceptance\.library\.path/],
    [{ entry: "library", library: { runtime: "node", import: "x", path: "a/../../b" } }, /acceptance\.library\.path/],
    [{ entry: "library", library: { runtime: "node", import: "x", path: "a/.git" } }, /acceptance\.library\.path/],
    [{ entry: "library" }, /acceptance\.library/],
  ];
  for (const [a, field] of bad) {
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: a }), "main", "x"), (e: unknown) => {
      assert.ok(e instanceof ProjectRulesError, JSON.stringify(a));
      assert.match(e.message, field, JSON.stringify(a));
      return true;
    });
  }
});

test("phase 4f: splitCliCommand — words on single spaces; isAppEntry tells web / api from cli / library", async () => {
  assert.deepEqual(splitCliCommand("node ./bin/tool.mjs --no-color"), ["node", "./bin/tool.mjs", "--no-color"]);
  assert.equal(isAppEntry({ entry: "web", start: "x", baseUrl: "http://127.0.0.1:3000", healthPath: "/", env: {} }), true);
  assert.equal(isAppEntry({ entry: "cli", cli: { command: "./x" }, env: {}, caseEnvKeys: [], caseDotfiles: [] }), false);
});

test("phase 4f fix 1 (4F-3): a generic interpreter is never cli.command's first word — the CLI is the project's own executable", async () => {
  for (const first of ["node", "nodejs", "sh", "bash", "zsh", "dash", "fish", "env", "npx", "npm", "pnpm", "yarn", "bunx", "bun", "deno", "python", "python3", "python3.12", "ruby", "perl", "php", "osascript"]) {
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: { entry: "cli", cli: { command: `${first} ./bin/tool.mjs` } } }), "main", "x"), (e: unknown) => {
      assert.ok(e instanceof ProjectRulesError, first);
      assert.match(e.message, /acceptance\.cli\.command.*(interpreter|one command)/, first); // isSafeCommand refuses a shell already
      return true;
    });
  }
  assert.equal(isGenericInterpreter("pythonic"), false);
  assert.equal(isGenericInterpreter("python3.11"), true);
});

test("phase 4f fix 1 (4F-3, 4F-4): caseEnvKeys pass the reserved rules; caseDotfiles are top-level dotfile names", async () => {
  const base = { entry: "cli", cli: { command: "./bin/tool.mjs" } };
  for (const [patch, field] of [
    [{ caseEnvKeys: ["PATH"] }, /acceptance\.caseEnvKeys/],
    [{ caseEnvKeys: ["NODE_OPTIONS"] }, /acceptance\.caseEnvKeys/],
    [{ caseEnvKeys: ["MY_TOKEN"] }, /acceptance\.caseEnvKeys/],
    [{ caseEnvKeys: ["lower"] }, /acceptance\.caseEnvKeys/],
    [{ caseDotfiles: ["toolrc"] }, /acceptance\.caseDotfiles/],
    [{ caseDotfiles: [".git"] }, /acceptance\.caseDotfiles/],
    [{ caseDotfiles: [".."] }, /acceptance\.caseDotfiles/],
    [{ caseDotfiles: [".a/b"] }, /acceptance\.caseDotfiles/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    await assert.rejects(loadProjectRules(rulesWith({ acceptance: { ...base, ...patch } }), "main", "x"), field, JSON.stringify(patch));
  }
});

test("4F-7 I-2: cli.interactive flags a CLI that needs a terminal (boolean, default absent)", async () => {
  const ok = await loadProjectRules(rulesWith({ acceptance: { entry: "cli", cli: { command: "./bin/tool.mjs", interactive: true } } }), "main");
  assert.equal((ok.rules.acceptance as { cli: { interactive?: boolean } }).cli.interactive, true);
  await assert.rejects(loadProjectRules(rulesWith({ acceptance: { entry: "cli", cli: { command: "./bin/tool.mjs", interactive: "yes" } } }), "main", "x"), /acceptance\.cli\.interactive/);
});

test("Settings commands fill what the base branch's .slackoff/config.json does not name; the file wins for what it names", async () => {
  const none = repo({ "README.md": "x" });
  const fromSettings = await loadProjectRules(none, "main", "web", { install: "npm ci", lint: "npm run lint" });
  assert.deepEqual(fromSettings.rules.commands, { install: "npm ci", lint: "npm run lint" });
  assert.equal(fromSettings.found, false);
  const plain = await loadProjectRules(none, "main", "web");
  assert.deepEqual(plain.rules.commands, {});
  assert.notEqual(fromSettings.hash, plain.hash, "the rules hash covers what the agents get");
  const withFile = repo({ ".slackoff/config.json": JSON.stringify({ commands: { test: "pnpm test", install: "pnpm install" } }), "README.md": "x" });
  const merged = await loadProjectRules(withFile, "main", "web", { install: "npm ci", lint: "npm run lint" });
  assert.deepEqual(merged.rules.commands, { install: "pnpm install", lint: "npm run lint", test: "pnpm test" });
});
