## What and why

<!-- What changed and why, in plain words. Link the issue: "Closes #123". -->

## How it was tested

<!-- The tests you added (tests first for behaviour changes), and anything you checked by hand. -->

## Checklist

- [ ] `pnpm test`, `pnpm typecheck` and `pnpm check:public` pass
- [ ] `pnpm e2e` passes (macOS), or the change cannot affect the UI or the workflow
- [ ] A UI change works at 390px (no horizontal scroll, the decision in the sticky bar, 44px targets) and has a fake-mode path and an e2e at both widths
- [ ] No new outward write without the developer's confirmation; any new child process that runs repository or agent code goes through the sandbox
- [ ] Placeholder names only (no real company host, person, email or home path) in code, fixtures, screenshots and this description
- [ ] README, install guide or a written ruling updated if the change touches them; `pnpm screenshots` re-run if the UI changed visibly
