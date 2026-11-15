# Security policy

Slack Off runs agents against your code, JIRA and Git host, so security reports matter to us.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.** Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability** (GitHub's private vulnerability reporting). Include what you found, how to reproduce it, and what an attacker could do with it.

You will get an answer within 7 days. We will tell you when a fix is ready and credit you in the release notes, unless you prefer not to be named.

## What is in scope

- The command sandbox (`packages/server/src/sandbox/`) and anything that lets repository or agent-written code escape it.
- Any way to make Slack Off write to JIRA or the Git host (push, pull request, status, comment) or export a trace without the developer's confirmation.
- Credentials (`credentials.json`, API keys, tokens) reaching a log, an HTTP response, a paired phone, an agent's environment or the audit log.
- Remote access: pairing, sessions, the Host and Origin checks, reaching Slack Off from outside your Tailscale network.
- Tampering with the audit log's hash chain without detection.

The known, accepted limits are listed under [Security model and residual risks](README.md#security-model-and-residual-risks) in the README. A report that one of them is worse than described there is in scope.

## Supported versions

Only the latest commit on `main` is supported.
