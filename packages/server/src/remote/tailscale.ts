import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

/** Runs a command and resolves with its stdout; rejects when it is missing, fails or times out. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<string>;

export interface TailscaleAddress {
  ip: string;
  dnsName: string | null;
}

export const TAILSCALE_APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const BINS = ["tailscale", TAILSCALE_APP_BIN];
const TIMEOUT_MS = 3_000;

const defaultRunner: CommandRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** Tailscale hands out IPv4 addresses from the CGNAT range 100.64.0.0/10 only. */
export function isTailscaleIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 100 && b >= 64 && b <= 127;
}

/** `tailscale ip -4` + `tailscale status --json` (PATH first, then the macOS app binary). Never throws: null when unavailable. */
export async function detectTailscale(run: CommandRunner = defaultRunner): Promise<TailscaleAddress | null> {
  for (const bin of BINS) {
    let ip: string;
    try {
      ip = (await run(bin, ["ip", "-4"])).split(/\s+/).find((s) => s !== "") ?? "";
    } catch {
      continue;
    }
    if (!isTailscaleIPv4(ip)) return null;
    let dnsName: string | null = null;
    try {
      const status = JSON.parse(await run(bin, ["status", "--json"])) as { Self?: { DNSName?: unknown } };
      const name = status.Self?.DNSName;
      if (typeof name === "string" && name !== "") dnsName = name.replace(/\.$/, "");
    } catch {
      // the address alone is enough
    }
    return { ip, dnsName };
  }
  return null;
}

export type Lookup = (name: string) => Promise<string>;
const defaultLookup: Lookup = async (name) => (await lookup(name, { family: 4 })).address;

/**
 * The address the remote listener should bind, or null (remote access off / no Tailscale). `host` may be a Tailscale
 * IPv4, a MagicDNS name (resolved, must land in the tailnet range) or empty (auto-detect).
 */
export async function resolveRemote(
  remoteAccess: { enabled: boolean; host: string },
  detect: () => Promise<TailscaleAddress | null> = () => detectTailscale(),
  resolveName: Lookup = defaultLookup,
): Promise<TailscaleAddress | null> {
  if (!remoteAccess.enabled) return null;
  const host = remoteAccess.host.trim();
  if (host === "") return detect();
  if (isIPv4(host)) {
    if (!isTailscaleIPv4(host)) return null;
    const d = await detect().catch(() => null);
    return { ip: host, dnsName: d?.ip === host ? d.dnsName : null };
  }
  let ip: string;
  try {
    ip = await resolveName(host);
  } catch {
    return null;
  }
  return isTailscaleIPv4(ip) ? { ip, dnsName: host.replace(/\.$/, "") } : null;
}

/** Addresses to listen on: always loopback, plus the Tailscale IP when remote access is active. Never a wildcard. */
export function listenHosts(remote: TailscaleAddress | null): string[] {
  const hosts = ["127.0.0.1"];
  if (remote) {
    if (!isTailscaleIPv4(remote.ip)) throw new Error(`refusing to listen on ${JSON.stringify(remote.ip)}: not a Tailscale address`);
    hosts.push(remote.ip);
  }
  for (const h of hosts) if (h === "0.0.0.0" || h === "::" || h === "") throw new Error("refusing to listen on a wildcard address");
  return hosts;
}
