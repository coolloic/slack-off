// Dev/e2e only (SLACKOFF_FAKE_EXECUTOR=1): the GitHub CLI stand-in fake mode always uses (Task 17). It never talks to
// the network: pull requests live in $SLACKOFF_FAKE_GH_STATE/prs.json. Supports exactly what GhClient calls; any other
// command exits 1.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.SLACKOFF_FAKE_GH_STATE;
if (!dir) {
  process.stderr.write("fake gh: SLACKOFF_FAKE_GH_STATE is not set\n");
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const file = join(dir, "prs.json");
/** @type {Array<{repo: string, number: number, url: string, head: string, base: string, title: string, body: string, open: boolean}>} */
const prs = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const save = () => writeFileSync(file, JSON.stringify(prs, null, 2) + "\n");

const a = process.argv.slice(2);
const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : null);
const fail = (msg) => {
  process.stderr.write(`fake gh: ${msg}\n`);
  process.exit(1);
};
/** "github.com/example-org/web" (or "example-org/web") → its parts */
const repoOf = (r) => {
  const parts = String(r ?? "").split("/");
  const [owner, name] = parts.slice(-2);
  if (!owner || !name) fail(`bad --repo ${r}`);
  return { id: `github.com/${owner}/${name}`, owner, name };
};
const cmd = a.slice(0, 2).join(" ");

if (cmd === "auth status") process.exit(0);

if (cmd === "repo view" && a.includes("--json")) {
  repoOf(a[2]);
  process.stdout.write(JSON.stringify({ isPrivate: true }));
  process.exit(0);
}

if (cmd === "pr list") {
  const r = repoOf(opt("--repo"));
  const head = opt("--head");
  const list = prs
    .filter((p) => p.repo === r.id && p.head === head && p.open)
    .map((p) => ({
      number: p.number, url: p.url, state: "OPEN", headRefName: p.head, baseRefName: p.base,
      isCrossRepository: false, headRepositoryOwner: { login: r.owner },
    }));
  process.stdout.write(JSON.stringify(list));
  process.exit(0);
}

if (cmd === "pr create") {
  const r = repoOf(opt("--repo"));
  const bodyFile = opt("--body-file");
  if (!bodyFile) fail("pr create needs --body-file");
  const number = prs.filter((p) => p.repo === r.id).length + 1;
  const url = `https://github.com/${r.owner}/${r.name}/pull/${number}`;
  prs.push({ repo: r.id, number, url, head: opt("--head"), base: opt("--base"), title: opt("--title"), body: readFileSync(bodyFile, "utf8"), open: true });
  save();
  process.stdout.write(`Creating pull request for ${opt("--head")} into ${opt("--base")} in ${r.owner}/${r.name}\n\n${url}\n`);
  process.exit(0);
}

const findPr = () => {
  const r = repoOf(opt("--repo"));
  const p = prs.find((x) => x.repo === r.id && x.number === Number(a[2]));
  if (!p) fail(`no pull request ${a[2]} in ${r.id}`);
  return p;
};

if (cmd === "pr view" && opt("--json") === "body") {
  process.stdout.write(JSON.stringify({ body: findPr().body }));
  process.exit(0);
}

if (cmd === "pr edit") {
  const p = findPr();
  const bodyFile = opt("--body-file");
  if (!bodyFile) fail("pr edit needs --body-file");
  p.body = readFileSync(bodyFile, "utf8");
  save();
  process.stdout.write(`${p.url}\n`);
  process.exit(0);
}

fail(`unsupported: gh ${a.join(" ")}`);
