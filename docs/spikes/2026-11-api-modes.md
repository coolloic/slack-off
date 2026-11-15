# Spike: API modes (phase 4b, task 1)

The author has not yet provided a test Anthropic API key or a test JIRA site. Every value below is therefore the plan's **default**: **not verified → phase 4b exit check**. Each one gets its real check in `docs/spikes/phase4b-exit.md`.

| Decided value | Default used | Status | Used by |
|---|---|---|---|
| `API_AUTH_EVIDENCE` | With the key delivered by the `apiKeyHelper` (ruling 4B-11) and an empty `CLAUDE_CONFIG_DIR`, the stream-json `init` event reports `apiKeySource: "apiKeyHelper"` (`API_KEY_SOURCE_HELPER`; with `ANTHROPIC_API_KEY` it would be `"ANTHROPIC_API_KEY"`, with a subscription login `"none"`). No `/login` is needed. `result.total_cost_usd` and `usage` are present. Ruling F4B-3: an API-key run whose `init` reports any other value, or none, is killed and failed. | not verified → exit check (§8) | task 6, final fix pass |
| `API_CHROME` | `'unavailable'`: claude-in-chrome is assumed not to work with API-key auth. Under ruling B-4, `executor.kind === 'claude-api'` therefore requires `jira.source === 'api'`. | not verified → exit check | tasks 3, 6 |
| `API_KEY_DELIVERY` | `'helper'` (ruling 4B-11): the key reaches `claude` only through the platform's `apiKeyHelper` script in the run's `--settings`, never any environment. Task 6 found `'env'` readable from inside the dev and acceptance sandboxes through `KERN_PROCARGS2` (what `ps -E` uses; `/bin/ps` itself is refused as setuid). CLI honouring of `apiKeyHelper` with `--setting-sources ""` is not verified → exit check. | helper (ruling 4B-11) — CLI honouring of apiKeyHelper with --setting-sources "" is not verified → exit check | task 6 |
| `API_AUTH_ERROR` | With an invalid key, the process exits non-zero and the result text contains "Invalid API key". | not verified → exit check | task 6 |
| `JIRA_SEARCH_SHAPE` | `POST /rest/api/3/search/jql` with `jql`, `fields`, `maxResults`, `nextPageToken`. The response has `issues[]`, `nextPageToken` and `isLast`, and no `total` (per Atlassian's documentation). | not verified → exit check | task 4 |
| `JIRA_ATTACHMENT_REDIRECT` | `GET /rest/api/3/attachment/content/{id}` answers with a 3xx to an Atlassian media host. That redirect is followed at most once, `https` only, without the `Authorization` header (ruling B-7). | not verified → exit check | task 4 |
| `JIRA_COMMENT_ADF` | Multi-line text sent as ADF with one paragraph per line reads back equal under `normalizeCommentText`. | not verified → exit check | task 4 |

The JIRA site, key, token, email and ticket content are not recorded here. When the author runs the checks, only field names, exit codes and conclusions go into this file.
