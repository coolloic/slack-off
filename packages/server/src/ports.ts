// A leaf module (no imports): the ports Slack Off itself listens on, shared by the server, the HTTP layer, the repo
// rules and the local command sandbox (Task 5), so the sandbox always denies what the server actually uses.

/** The server (loopback and the optional Tailscale listener). */
export const SERVER_PORT = 4317;
/** The web dev server (`pnpm dev:web`). */
export const WEB_DEV_PORT = 5173;
/** Slack Off's own listeners. */
export const SLACKOFF_PORTS: readonly number[] = Object.freeze([SERVER_PORT, WEB_DEV_PORT]);
/** Node's inspector (default 9229, and the next one): a sandboxed process must never reach or open one (review fix round 1). */
export const INSPECTOR_PORTS: readonly number[] = Object.freeze([9229, 9230]);
/** Local daemons a sandboxed command must never drive (T5-6): Docker's TCP API, the agent gateway seen on the author's
 * machine, JetBrains IDEs' built-in server. More via config development.deniedLocalPorts. */
export const DOCKER_PORTS: readonly number[] = Object.freeze([2375, 2376]);
export const AGENT_GATEWAY_PORTS: readonly number[] = Object.freeze([18789, 18790, 18791, 18792]);
export const JETBRAINS_PORTS: readonly number[] = Object.freeze([63342]);
/** T7-4: Chrome's remote-debugging port (a browser started with it can be driven, with its profile, from anywhere local). */
export const CHROME_DEBUG_PORTS: readonly number[] = Object.freeze([9222]);
/** Every port the command sandbox denies, outbound and for listening. */
export const DENIED_PORTS: readonly number[] = Object.freeze([
  ...SLACKOFF_PORTS, ...INSPECTOR_PORTS, ...DOCKER_PORTS, ...AGENT_GATEWAY_PORTS, ...JETBRAINS_PORTS, ...CHROME_DEBUG_PORTS,
]);
