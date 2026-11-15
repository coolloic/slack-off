# License decision

Decision (author): MIT, copyright holder "Slack Off contributors". `LICENSE` and the `"license": "MIT"` field in every `package.json` follow from it.

## MIT or Apache-2.0

| | MIT | Apache-2.0 |
| --- | --- | --- |
| Length | Short, one paragraph of terms | Long |
| Obligation | Keep the copyright and permission notice | Keep notices, state changes, carry a NOTICE file |
| Patent grant | None stated | Explicit grant, with termination if the licensee sues |
| Ecosystem fit | Most common for Node packages and Claude Code skills | Common in larger corporate projects |

## Production dependency licenses

From `pnpm licenses list --prod` (offline, against the installed tree), counts by license:

| License | Packages |
| --- | --- |
| MIT | 38 |
| OFL-1.1 | 2 (the Inter and JetBrains Mono font packages) |
| Apache-2.0 | 1 |
| ISC | 1 |

None of these conflicts with distributing this project under MIT. The two OFL-1.1 packages are fonts: they keep their own license and are not relicensed. Their license text must stay with the font files if they are redistributed.
