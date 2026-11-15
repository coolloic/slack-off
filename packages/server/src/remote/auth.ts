import type { Context } from "hono";
import { SESSION_MAX_AGE_S } from "./pairing.ts";

export const SESSION_COOKIE = "slackoff_session";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Loopback is decided from the TCP socket's remote address only — never from Host / X-Forwarded-For. */
export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } };
}

/** Remote address of the underlying socket (@hono/node-server bindings); undefined when unknown, which callers treat as remote. */
export function socketAddress(c: Context): string | undefined {
  const env = c.env as (NodeBindings & { server?: NodeBindings }) | undefined;
  const bindings = env?.server ?? env;
  return bindings?.incoming?.socket?.remoteAddress;
}

export const isLocalRequest = (c: Context): boolean => isLoopback(socketAddress(c));

/** Value of the session cookie, if present. */
export function sessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** HttpOnly, SameSite=Strict, 180 days. No Secure: the tailnet transport is plain http (WireGuard-encrypted underneath). */
export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}`;
