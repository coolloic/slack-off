// Phase 4a (Task 3): `node hook-verify.ts <hooks dir> <sha256>` — run by every hook wrapper, outside the sandbox, right
// before it starts the repository's hook: exit 0 only when the hooks directory still has the fingerprint the developer
// accepted (F2-I1 pin); otherwise 1 and the wrapper does not run the hook. Loads node built-ins only.
import { hashHooksDir } from "../git/hooks-hash.ts";

const [dir, hash] = process.argv.slice(2);
let ok = false;
try {
  ok = typeof dir === "string" && dir.startsWith("/") && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) && hashHooksDir(dir) === hash;
} catch {
  // F4A-3 (M-b): a hooks dir too large to fingerprint (or unreadable) fails closed
  ok = false;
}
process.exit(ok ? 0 : 1);
