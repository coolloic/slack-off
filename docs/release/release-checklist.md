# Release checklist (for the author)

Every step below is the author's. Slack Off's plans write this list and stop: they never push, change a repository's visibility, rewrite history, tag, create a release or publish a package. Tick each box yourself, in order, and stop at the first one that does not hold.

> **2026-11-16:** this release (the history-free commit, the push, the repository settings and making it public) was performed on 2026-11-16 with the author's explicit approval. The boxes below were ticked from that day's record and the audit in [audit-2026-11-16.md](audit-2026-11-16.md). Still open: the Phase 4 third-party run and the optional `v0.1.0` tag.

Decisions already made (see [license-decision.md](license-decision.md) and [history-rewrite-proposal.md](history-rewrite-proposal.md)): the license is MIT, and the public repository starts from one new, history-free commit (option B); the private repository keeps its full history.

## Before publishing

- [x] **LICENSE is committed.** `LICENSE` (MIT, "Copyright (c) 2026 Slack Off contributors") is in the tree, and every `package.json` says `"license": "MIT"`. — done 2026-11-16: `LICENSE` (MIT) committed; the root and every package `package.json` say `"license": "MIT"`.
- [x] **History handled, and checked on a fresh clone.** Option B, as decided: make the history-free commit on a **fresh clone** of the private repository (the steps are in [history-rewrite-proposal.md](history-rewrite-proposal.md), with the public name and email you choose). That clone still holds the private history (its `origin/*` refs and the original branch), so do not check or push from it. Make a separate single-branch clone of the new commit and do everything below, and the push, from there:
  `git clone --single-branch --branch public-main --no-local <the fresh clone> <a verify folder>`. In the verify folder: — done 2026-11-16: option B; the public repository is one commit `33a3177 Initial commit` by the public noreply identity, checked on a single-branch clone as below.
  - [x] `git remote remove origin`, then `git log --all --oneline` shows exactly one commit; — done 2026-11-16: exactly one commit.
  - [x] `pnpm install && pnpm check:public` reports 0 findings; — done 2026-11-16: 0 findings.
  - [x] `node scripts/scan-history.mjs --out <a folder outside the clone>`, with your private-terms file in `SLACKOFF_PRIVATE_TERMS`, reports zero hits (one commit, your public identity, no hits in messages, refs or blobs); — done 2026-11-16: with a private-terms file: one commit, the public identity, 0 hits in messages, refs and blobs except the intended github.com/coolloic URLs.
  - [x] `git log --all --format='%an <%ae>'` shows only the public identity, and `git branch -a` and `git tag` show nothing private. — done 2026-11-16: only the public noreply identity, no tags. Re-checked on a fresh clone of the public URL during the audit: `main` = `33a3177`, 0 tags; the other refs are Dependabot branches opened after publishing.
  (If you chose option A instead, run the same two checks on the rewritten clone.)
- [x] **Screenshots reviewed by eye.** `pnpm check:public` lists the binary files it cannot read (40 at the time of writing: `design/screens/`, `design/screens/mobile/`, `docs/ba/` and the like). Open each one, and especially the one the README shows (`design/screens/01-tickets.png`): no real company, ticket, person, email, host or path. Replace or blur anything that is not clearly fictional. — done 2026-11-16: all 48 binary images (48 now, not 40) opened and reviewed: fictional data only; the mockup person names are confirmed fictional by the author.
- [x] **Code of conduct contact.** Replace `CONDUCT_CONTACT` in `CODE_OF_CONDUCT.md` with the address or channel where conduct reports reach you privately. — done 2026-11-16: reports go through GitHub's Report content / a private report; no `CONDUCT_CONTACT` placeholder left.
- [x] **`package.json` points at the public repository.** Add `repository` and `homepage` with the public URL (left out until the address is decided). Keep `"private": true`: there is no npm package (ruling E-5). — done 2026-11-16: `repository`, `homepage` and `bugs` point at https://github.com/coolloic/slack-off; `"private": true` kept.
- [x] **The README's clone line.** Replace `<this repository>` / `<the Slack Off repository URL>` in `README.md` and `docs/install.md` with the public clone URL. — done 2026-11-16: README.md and docs/install.md clone `https://github.com/coolloic/slack-off.git`; followed verbatim from a temp folder in the audit (install and start OK).
- [ ] **Phase 4 exit passed.** The third-party run in [docs/spikes/phase4-exit.md](../spikes/phase4-exit.md) is filled in with "pass", and every problem it found is fixed in the README or the install guide. — not yet (2026-11-16): the third-party run has not happened (needs a third party). The author-side stand-in from the public URL passed; see [audit-2026-11-16.md](audit-2026-11-16.md).
- [x] **The sub-plans' manual exit checks.** Decide which of the unchecked items in `docs/spikes/phase4a-exit.md` … `phase4f-exit.md` must pass before publishing (at least the API-key mode against the real CLI, or say in the README that it is unverified, as it does now). — done 2026-11-16: published with the README saying the API-key helper is not yet verified against the real CLI (Residual risks); the remaining manual checks are triaged in [audit-2026-11-16.md](audit-2026-11-16.md).
- [x] **Tests on the commit you will publish:** `pnpm test`, `pnpm typecheck`, `pnpm e2e` and `scripts/fresh-clone-check.sh` all pass. — done 2026-11-16: locally on `33a3177`: `pnpm test` (server 1417, web 195, shared 47; 0 failed, 5 skipped), `pnpm typecheck` clean, `scripts/fresh-clone-check.sh` OK, `pnpm e2e` passed from a normal checkout. GitHub CI on macOS runners is red (3 server sandbox tests) pending `fix/ci-macos-sandbox-tests`.

## GitHub repository settings

- [x] Create the public repository empty (no generated README, license or `.gitignore`). — done 2026-11-16: created empty.
- [x] Default branch: `main`. — done 2026-11-16: `main`.
- [x] Branch protection on `main`: pull requests required, no force pushes, no deletions. — done 2026-11-16: PR required (0 approvals), strict required check, no force pushes, no deletions, conversation resolution required.
- [x] Issues on; Discussions as you prefer. — done 2026-11-16: Issues on.
- [x] A security policy (`SECURITY.md` or the repository's security settings) saying how to report a vulnerability privately; private vulnerability reporting on. — done 2026-11-16: `SECURITY.md` in the tree; private vulnerability reporting on; secret scanning and push protection on.
- [x] Actions: no workflow that uses private secrets. The repository has three automations, none of which uses a secret: `ci.yml` (every pull request, read-only token, safe for forks), `nightly.yml` (every night on `main`; its failure report uses the built-in token to open an issue) and Dependabot (`.github/dependabot.yml`). Under Settings → Actions → General, keep "Fork pull request workflows" requiring approval for first-time contributors, and leave the default workflow permissions read-only. — done 2026-11-16: no workflow uses a repository secret; default workflow permissions read-only; fork PR workflows need approval for first-time contributors (both read back through the API in the audit).
- [x] Make the `CI / check` job a required status check in the branch protection on `main`. — done 2026-11-16: `check` is a strict required check on `main`. CI is currently red on macOS runners (3 server sandbox tests) pending `fix/ci-macos-sandbox-tests`.
- [x] Turn on Dependabot alerts and security updates (Settings → Code security). — done 2026-11-16: alerts and security updates on.
- [x] Labels: create `good first issue` and `help wanted` (GitHub usually has them already); `nightly-failure` is created by the nightly run when it first fails. — done 2026-11-16: both exist.
- [x] No secrets, deploy keys or webhooks copied over from the private repository. — done 2026-11-16: none.

## Publishing

- [x] Push the history-free commit to the public remote (`git push <public remote> public-main:main`, from the fresh clone, never from the private working copy). — done 2026-11-16: pushed as `main`.
- [x] Look at the pushed repository on GitHub as a logged-out visitor: README renders, links work, the screenshot is the reviewed one, the license is detected as MIT. — done 2026-11-16: anonymous view returns 200, license detected as MIT; every relative link in the README resolves in a fresh clone (audit).
- [x] Set the repository to public. — done 2026-11-16: public.
- [ ] Optional: tag the first release (`v0.1.0`) and create a GitHub release with short notes. — not done as of 2026-11-16.

Slack Off's plans never perform these steps; the author does. (The 2026-11-16 release was performed with the author's explicit approval; see the note at the top.)
