# Release checklist (for the author)

Every step below is the author's. Slack Off's plans write this list and stop: they never push, change a repository's visibility, rewrite history, tag, create a release or publish a package. Tick each box yourself, in order, and stop at the first one that does not hold.

Decisions already made (see [license-decision.md](license-decision.md) and [history-rewrite-proposal.md](history-rewrite-proposal.md)): the license is MIT, and the public repository starts from one new, history-free commit (option B); the private repository keeps its full history.

## Before publishing

- [ ] **LICENSE is committed.** `LICENSE` (MIT, "Copyright (c) 2026 Slack Off contributors") is in the tree, and every `package.json` says `"license": "MIT"`.
- [ ] **History handled, and checked on a fresh clone.** Option B, as decided: make the history-free commit on a **fresh clone** of the private repository (the steps are in [history-rewrite-proposal.md](history-rewrite-proposal.md), with the public name and email you choose). That clone still holds the private history (its `origin/*` refs and the original branch), so do not check or push from it. Make a separate single-branch clone of the new commit and do everything below, and the push, from there:
  `git clone --single-branch --branch public-main --no-local <the fresh clone> <a verify folder>`. In the verify folder:
  - [ ] `git remote remove origin`, then `git log --all --oneline` shows exactly one commit;
  - [ ] `pnpm install && pnpm check:public` reports 0 findings;
  - [ ] `node scripts/scan-history.mjs --out <a folder outside the clone>`, with your private-terms file in `SLACKOFF_PRIVATE_TERMS`, reports zero hits (one commit, your public identity, no hits in messages, refs or blobs);
  - [ ] `git log --all --format='%an <%ae>'` shows only the public identity, and `git branch -a` and `git tag` show nothing private.
  (If you chose option A instead, run the same two checks on the rewritten clone.)
- [ ] **Screenshots reviewed by eye.** `pnpm check:public` lists the binary files it cannot read (40 at the time of writing: `design/screens/`, `design/screens/mobile/`, `docs/ba/` and the like). Open each one, and especially the one the README shows (`design/screens/01-tickets.png`): no real company, ticket, person, email, host or path. Replace or blur anything that is not clearly fictional.
- [ ] **Code of conduct contact.** Replace `CONDUCT_CONTACT` in `CODE_OF_CONDUCT.md` with the address or channel where conduct reports reach you privately.
- [ ] **`package.json` points at the public repository.** Add `repository` and `homepage` with the public URL (left out until the address is decided). Keep `"private": true`: there is no npm package (ruling E-5).
- [ ] **The README's clone line.** Replace `<this repository>` / `<the Slack Off repository URL>` in `README.md` and `docs/install.md` with the public clone URL.
- [ ] **Phase 4 exit passed.** The third-party run in [docs/spikes/phase4-exit.md](../spikes/phase4-exit.md) is filled in with "pass", and every problem it found is fixed in the README or the install guide.
- [ ] **The sub-plans' manual exit checks.** Decide which of the unchecked items in `docs/spikes/phase4a-exit.md` … `phase4f-exit.md` must pass before publishing (at least the API-key mode against the real CLI, or say in the README that it is unverified, as it does now).
- [ ] **Tests on the commit you will publish:** `pnpm test`, `pnpm typecheck`, `pnpm e2e` and `scripts/fresh-clone-check.sh` all pass.

## GitHub repository settings

- [ ] Create the public repository empty (no generated README, license or `.gitignore`).
- [ ] Default branch: `main`.
- [ ] Branch protection on `main`: pull requests required, no force pushes, no deletions.
- [ ] Issues on; Discussions as you prefer.
- [ ] A security policy (`SECURITY.md` or the repository's security settings) saying how to report a vulnerability privately; private vulnerability reporting on.
- [ ] Actions: no workflow that uses private secrets. The repository has three automations, none of which uses a secret: `ci.yml` (every pull request, read-only token, safe for forks), `nightly.yml` (every night on `main`; its failure report uses the built-in token to open an issue) and Dependabot (`.github/dependabot.yml`). Under Settings → Actions → General, keep "Fork pull request workflows" requiring approval for first-time contributors, and leave the default workflow permissions read-only.
- [ ] Make the `CI / check` job a required status check in the branch protection on `main`.
- [ ] Turn on Dependabot alerts and security updates (Settings → Code security).
- [ ] Labels: create `good first issue` and `help wanted` (GitHub usually has them already); `nightly-failure` is created by the nightly run when it first fails.
- [ ] No secrets, deploy keys or webhooks copied over from the private repository.

## Publishing

- [ ] Push the history-free commit to the public remote (`git push <public remote> public-main:main`, from the fresh clone, never from the private working copy).
- [ ] Look at the pushed repository on GitHub as a logged-out visitor: README renders, links work, the screenshot is the reviewed one, the license is detected as MIT.
- [ ] Set the repository to public.
- [ ] Optional: tag the first release (`v0.1.0`) and create a GitHub release with short notes.

Slack Off's plans never perform these steps; the author does.
