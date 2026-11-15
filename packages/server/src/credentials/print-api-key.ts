// Ruling 4B-11: the program behind the API executor's apiKeyHelper. `node print-api-key.ts <SLACKOFF_HOME>` prints the
// Anthropic API key from credentials.json, read with the store's own checks (regular file, mode 600, owned by you,
// no symlink), and nothing else. No key, or a file that fails its checks → exit 1 with a fixed message on stderr (no
// path, no content). Claude Code runs it; no sandbox can read credentials.json, so it fails inside one.
import { readCredentials } from "./credential-store.ts";

const home = process.argv[2];
if (home === undefined || home === "") {
  process.stderr.write("Slack Off: no data folder given\n");
  process.exit(1);
}
let key: string | undefined;
try {
  key = readCredentials(home).anthropic?.apiKey;
} catch {
  process.stderr.write("Slack Off: credentials.json cannot be read\n");
  process.exit(1);
}
if (key === undefined || key === "") {
  process.stderr.write("Slack Off: no Anthropic API key is set\n");
  process.exit(1);
}
process.stdout.write(key);
