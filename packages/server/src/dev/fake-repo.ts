// Dev/e2e only (SLACKOFF_FAKE_EXECUTOR=1): two small git repos the fake FAKE project is mapped to, each with a local
// bare repository standing in for GitHub. Never used otherwise.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { RepoRef } from "../projects/project-rules.ts";
import { runGit } from "../git/run.ts";

/** The GitHub organisation every fake origin names; fetches and pushes go to `${home}/fake-remotes/` instead. */
export const FAKE_GITHUB_PREFIX = "https://github.com/example-org/";

/** web's tiny target app for acceptance (Task 17): an orders page with an Export button, on $PORT. */
const SERVER_MJS = `// The fake web app the acceptance run starts (Slack Off fake mode).
import { createServer } from "node:http";

const port = Number(process.env.PORT);
const page = \`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Orders</title></head>
  <body>
    <h1>Orders</h1>
    <table><tr><th>Order</th><th>VAT</th></tr><tr><td>1001</td><td>20%</td></tr></table>
    <button type="button">Export CSV</button>
  </body>
</html>\`;

createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(port, "127.0.0.1");
`;

/**
 * phase 4a Task 8: web's offline fake lint-staged, run by its pre-commit hook (argv[2]: the hook's pid). It connects to
 * Slack Off's port: inside the dev-hook sandbox that is refused before any packet is sent (EPERM). It prints the result
 * (the step shows the hook's output) and writes "<pid> sandboxed" (or "NOT sandboxed") to $TMPDIR/slackoff-hook-marker
 * — in the sandbox, the ticket's own tmp dir.
 */
const FAKE_LINT_MJS = `import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
const pid = process.argv[2] ?? "?";
const done = (r) => {
  console.log(\`fake-lint: probe 127.0.0.1:4317 -> \${r}\`);
  try {
    writeFileSync(join(tmpdir(), "slackoff-hook-marker"), \`\${pid} \${r === "EPERM" ? "sandboxed" : "NOT sandboxed"}\\n\`);
  } catch (e) {
    console.log(\`fake-lint: marker not written: \${e.code}\`);
  }
  process.exit(0);
};
const s = connect({ host: "127.0.0.1", port: 4317 });
s.setTimeout(3000, () => { s.destroy(); done("TIMEOUT"); });
s.on("connect", () => { s.destroy(); done("CONNECTED"); });
s.on("error", (e) => done(e.code ?? "ERROR"));
`;

/** phase 4f: cli's tiny to-do CLI (the acceptance target of FAKE-4): list, add <name>; no arguments → usage, exit 2. */
const TOOL_MJS = `#!/usr/bin/env node
// The fake to-do CLI the acceptance cases run (Slack Off fake mode). Items live in items.txt in the working directory.
import { appendFileSync, readFileSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const items = () => {
  try {
    return readFileSync("items.txt", "utf8").split("\\n").filter(Boolean);
  } catch {
    return [];
  }
};
if (cmd === "list") {
  const all = items();
  console.log(all.length === 0 ? "(no items)" : all.map((x, i) => \`\${i + 1}. \${x}\`).join("\\n"));
} else if (cmd === "add" && rest.length === 1) {
  appendFileSync("items.txt", \`\${rest[0]}\\n\`);
  console.log(\`added \${rest[0]}\`);
} else {
  process.stderr.write("usage: tool <list | add <name>>\\n");
  process.exit(2);
}
`;

function files(name: "api" | "web" | "cli", appPort: number): Record<string, string> {
  if (name === "cli") {
    return {
      "README.md": "# cli\n",
      "bin/tool.mjs": TOOL_MJS,
      ".slackoff/config.json": JSON.stringify({ acceptance: { entry: "cli", cli: { command: "./bin/tool.mjs" } } }, null, 2) + "\n",
    };
  }
  if (name === "api") {
    return {
      "README.md": "# api\n",
      ".slackoff/config.json": JSON.stringify({ forbiddenPaths: ["infra/**"], commands: { test: "node --test" } }, null, 2) + "\n",
    };
  }
  return {
    "README.md": "# web\n",
    "server.mjs": SERVER_MJS,
    ".slackoff/config.json":
      JSON.stringify(
        {
          commands: { test: "node --test" },
          acceptance: { entry: "web", start: "node server.mjs", baseUrl: `http://127.0.0.1:${appPort}`, healthPath: "/", env: { PORT: String(appPort) } },
        },
        null,
        2,
      ) + "\n",
    // rejects staged content containing TODO (committed executable: mode 100755, P-C20); phase 4a Task 8: then runs an
    // offline stand-in for lint-staged, which shows the hook ran in the dev-hook sandbox
    ".githooks/pre-commit":
      '#!/bin/sh\nif git diff --cached | grep -q "^+.*TODO"; then\n  echo "TODO found"\n  exit 1\nfi\nnode "$(git rev-parse --show-toplevel)/.githooks/fake-lint.mjs" "$$"\nexit 0\n',
    ".githooks/fake-lint.mjs": FAKE_LINT_MJS,
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await runGit(cwd, ["-c", "user.name=Slack Off (fake)", "-c", "user.email=fake@slackoff.invalid", "-c", "commit.gpgsign=false", ...args]);
  if (r.code !== 0) throw new Error(`fake repo: git ${args.join(" ")} failed: ${r.stderr.trim()}`);
}

const canListen = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT"));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });

/** SLACKOFF_FAKE_APP_PORT, else the first port in 4700–4799 free on 127.0.0.1 and ::1. */
async function fakeAppPort(): Promise<number> {
  const fixed = Number(process.env.SLACKOFF_FAKE_APP_PORT ?? "");
  if (Number.isInteger(fixed) && fixed > 0) return fixed;
  for (let p = 4700; p < 4800; p++) if ((await canListen("127.0.0.1", p)) && (await canListen("::1", p))) return p;
  throw new Error("fake mode: no free port in 4700–4799 for the fake web app");
}

/**
 * `${home}/fake-repos/{api,web}` on branch main, created on first use and reused afterwards. Each origin is
 * `https://github.com/example-org/<name>.git` (what `git config --get remote.origin.url` shows), and the repo's own
 * config maps that prefix to `file://${home}/fake-remotes/` for fetch and push (insteadOf + pushInsteadOf, the longest
 * match wins over any user-wide rule): nothing ever reaches GitHub. web declares an acceptance section; api does not.
 */
export async function createFakeRepos(home: string, o: { cli?: boolean } = {}): Promise<RepoRef[]> {
  const refs: RepoRef[] = [];
  const remotes = join(home, "fake-remotes");
  let appPort: number | null = null;
  // phase 4f (SLACKOFF_FAKE_CLI_REPO=1, the phase-4f e2e only): a third repo with a command-line tool
  for (const name of o.cli === true ? (["api", "web", "cli"] as const) : (["api", "web"] as const)) {
    const dir = join(home, "fake-repos", name);
    if (!existsSync(join(dir, ".git"))) {
      appPort ??= await fakeAppPort();
      mkdirSync(dir, { recursive: true });
      await git(dir, "init", "-q", "-b", "main");
      for (const [p, content] of Object.entries(files(name, appPort))) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), content);
        if (p.endsWith("pre-commit") || p.startsWith("bin/")) chmodSync(join(dir, p), 0o755);
      }
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "init");
      if (name === "web") await git(dir, "config", "core.hooksPath", ".githooks"); // after the first commit
      // the stand-in for GitHub
      const bare = join(remotes, `${name}.git`);
      mkdirSync(bare, { recursive: true });
      await git(bare, "init", "-q", "--bare", "-b", "main");
      await git(dir, "config", `url.file://${remotes}/.insteadOf`, FAKE_GITHUB_PREFIX);
      await git(dir, "config", `url.file://${remotes}/.pushInsteadOf`, FAKE_GITHUB_PREFIX);
      await git(dir, "remote", "add", "origin", `${FAKE_GITHUB_PREFIX}${name}.git`);
      await assertFakeOrigin(home, dir, name);
      await git(dir, "push", "-q", "origin", "refs/heads/main:refs/heads/main");
      // a release branch only origin has (a ticket may branch from it: Base on the ticket page)
      await git(dir, "push", "-q", "origin", "refs/heads/main:refs/heads/release/1.0.0");
    }
    refs.push({ name, path: dir, baseBranch: "main" });
  }
  return refs;
}

/**
 * Fake mode's last check before a push (Task 17): origin names the fake GitHub organisation and both its fetch and push
 * URLs resolve to a bare repository under `${home}/fake-remotes/`. Anything else throws, so the push never runs.
 */
export async function assertFakeOrigin(home: string, wt: string, repo: string): Promise<void> {
  const read = async (args: string[]) => {
    const r = await runGit(wt, args);
    return r.code === 0 ? r.stdout.trim() : "";
  };
  const url = await read(["config", "--get", "remote.origin.url"]);
  const fetchUrl = await read(["remote", "get-url", "origin"]);
  const pushUrl = await read(["remote", "get-url", "--push", "origin"]);
  const local = `file://${join(home, "fake-remotes")}/`;
  if (!url.startsWith(FAKE_GITHUB_PREFIX) || !fetchUrl.startsWith(local) || !pushUrl.startsWith(local)) {
    throw new Error(`fake mode: ${repo}'s origin is not a fake remote (url ${url}, fetch ${fetchUrl}, push ${pushUrl}) — nothing was pushed`);
  }
}
