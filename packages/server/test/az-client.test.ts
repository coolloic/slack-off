import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AZURE_DESCRIPTION_MAX, AzClient, fitAzureDescription } from "../src/delivery/az.ts";
import { prIdFromUrl } from "../src/delivery/pr-client.ts";
import { LINKS_END, LINKS_START } from "../src/delivery/pr-body.ts";
import { tmpDir } from "./helpers/tmp.ts";

// A stand-in `az`: records argv, env and any @file argument's content; answers from a canned JSON per subcommand.
const dir = tmpDir("az");
const bin = join(dir, "az");
const calls = join(dir, "calls.jsonl");
const answers = join(dir, "answers.json");
mkdirSync(dir, { recursive: true });
writeFileSync(
  bin,
  `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
const files = {};
for (const a of argv) if (a.startsWith("@")) files[a] = fs.readFileSync(a.slice(1), "utf8");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, files, env: { AZURE_CORE_ONLY_SHOW_ERRORS: process.env.AZURE_CORE_ONLY_SHOW_ERRORS, AZURE_EXTENSION_USE_DYNAMIC_INSTALL: process.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL } }) + "\\n");
const a = JSON.parse(fs.readFileSync(${JSON.stringify(answers)}, "utf8"));
const key = argv.slice(0, 3).join(" ");
const r = a[key] ?? a[argv.slice(0, 2).join(" ")] ?? { code: 1, stderr: "no answer for " + key };
if (r.stdout) process.stdout.write(typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout));
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.code ?? 0);
`,
);
chmodSync(bin, 0o755);
const answer = (a: Record<string, unknown>) => {
  writeFileSync(answers, JSON.stringify(a));
  writeFileSync(calls, "");
};
const recorded = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; files: Record<string, string>; env: Record<string, string> });
const ID = "dev.azure.com/Contoso/Web Apps/shop-ui";
const ORG = "https://dev.azure.com/Contoso";

test("AzClient.createPr: az repos pr create with organization, project, repository, branches, title and the description from a file", async () => {
  answer({ "repos pr create": { stdout: { pullRequestId: 42 } } });
  const body = join(dir, "body.md");
  writeFileSync(body, "## Summary\nok\n");
  const pr = await new AzClient(bin).createPr({ repo: ID, base: "develop", head: "fix/PROJ-1-x", title: "PROJ-1: x", bodyFile: body });
  assert.deepEqual(pr, { number: 42, url: "https://dev.azure.com/Contoso/Web%20Apps/_git/shop-ui/pullrequest/42" });
  const [c] = recorded();
  assert.deepEqual(c!.argv.slice(0, 3), ["repos", "pr", "create"]);
  const arg = (k: string) => c!.argv[c!.argv.indexOf(k) + 1];
  assert.equal(arg("--organization"), ORG);
  assert.equal(arg("--project"), "Web Apps");
  assert.equal(arg("--repository"), "shop-ui");
  assert.equal(arg("--source-branch"), "fix/PROJ-1-x");
  assert.equal(arg("--target-branch"), "develop");
  assert.equal(arg("--title"), "PROJ-1: x");
  assert.equal(c!.files[arg("--description")!], "## Summary\nok\n");
  for (const bad of ["--auto-complete", "--merge-commit-message", "--squash", "--bypass-policy", "--reviewers", "--work-items", "--open"]) assert.ok(!c!.argv.includes(bad), bad);
  assert.equal(c!.env.AZURE_CORE_ONLY_SHOW_ERRORS, "true");
  assert.equal(c!.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
});

test("AzClient.findOpenPr: reusable for the same source and target; conflict for a fork or another target; none when empty", async () => {
  const pr = (o: Record<string, unknown> = {}) => ({ pullRequestId: 7, sourceRefName: "refs/heads/fix/PROJ-1-x", targetRefName: "refs/heads/develop", repository: { name: "shop-ui" }, ...o });
  const az = new AzClient(bin);
  answer({ "repos pr list": { stdout: [pr()] } });
  assert.deepEqual(await az.findOpenPr(ID, "fix/PROJ-1-x", "develop"), { kind: "reusable", number: 7, url: "https://dev.azure.com/Contoso/Web%20Apps/_git/shop-ui/pullrequest/7" });
  const [c] = recorded();
  assert.equal(c!.argv[c!.argv.indexOf("--status") + 1], "active");
  answer({ "repos pr list": { stdout: [pr({ targetRefName: "refs/heads/main" })] } });
  assert.equal((await az.findOpenPr(ID, "fix/PROJ-1-x", "develop")).kind, "conflict");
  answer({ "repos pr list": { stdout: [pr({ forkSource: { repository: { name: "fork" } } })] } });
  assert.equal((await az.findOpenPr(ID, "fix/PROJ-1-x", "develop")).kind, "conflict");
  answer({ "repos pr list": { stdout: [] } });
  assert.deepEqual(await az.findOpenPr(ID, "fix/PROJ-1-x", "develop"), { kind: "none" });
});

test("AzClient: sign-in and visibility from the project; body read and edit; a failing az names what to do", async () => {
  const az = new AzClient(bin);
  answer({ "devops project show": { stdout: { visibility: "private" } }, "repos pr show": { stdout: { description: "old" } }, "repos pr update": { stdout: {} } });
  assert.equal((await az.authStatus(ID)).ok, true);
  assert.equal(await az.repoVisibility(ID), true);
  assert.equal(await az.getPrBody(ID, 7), "old");
  const file = join(dir, "next.md");
  writeFileSync(file, "new");
  await az.editPrBody(ID, 7, file);
  const upd = recorded().find((c) => c.argv[2] === "update")!;
  assert.equal(upd.argv[upd.argv.indexOf("--id") + 1], "7");
  answer({ "devops project show": { code: 1, stderr: "Please run 'az login' to setup account." } });
  const no = await az.authStatus(ID);
  assert.equal(no.ok, false);
  assert.match(no.detail, /az login/);
  answer({ "devops project show": { stdout: { visibility: "public" } } });
  assert.equal(await az.repoVisibility(ID), false);
});

test("fitAzureDescription: Azure keeps 4000 characters; a longer description is shortened before the links section, which stays whole", () => {
  const links = `${LINKS_START}\n- web: https://dev.azure.com/Contoso/P/_git/web/pullrequest/3\n${LINKS_END}`;
  const long = `## Summary\n${"x".repeat(5000)}\n\n${links}\n`;
  const fit = fitAzureDescription(long);
  assert.ok(fit.length <= AZURE_DESCRIPTION_MAX, String(fit.length));
  assert.ok(fit.includes(links));
  assert.match(fit, /shortened/);
  assert.equal(fitAzureDescription("short"), "short");
});

test("prIdFromUrl: GitHub and Azure DevOps pull request URLs give the repository id and number", () => {
  assert.deepEqual(prIdFromUrl("https://github.com/example-org/api/pull/42"), { id: "github.com/example-org/api", number: 42 });
  assert.deepEqual(prIdFromUrl("https://dev.azure.com/Contoso/Web%20Apps/_git/shop-ui/pullrequest/7"), { id: "dev.azure.com/Contoso/Web Apps/shop-ui", number: 7 });
  assert.equal(prIdFromUrl("https://evil.example/x/pullrequest/1"), null);
});
