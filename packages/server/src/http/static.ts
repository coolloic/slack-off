import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Context } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * The page's policy. imgSources: the configured https JIRA and, for Jira Cloud, the media host its attachments redirect
 * to (jiraImageSources), whose images the Snapshot tab shows with the developer's own JIRA sign-in (Chrome mode keeps no
 * bytes); empty = images from Slack Off only.
 */
export function htmlCsp(imgSources: readonly string[]): string {
  const img = imgSources.map((s) => ` ${s}`).join("");
  return `default-src 'self'; img-src 'self' data: blob:${img}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}

/**
 * Serves the built web UI from `distDir` (SPA: unknown extension-less paths get index.html). Files outside `distDir`
 * are never served: the decoded path is resolved and must stay inside the real dist directory, symlinks included.
 * Only mounted for non-/api paths.
 */
export function webUi(distDir: string, opts: { imgSources?: () => readonly string[] } = {}): (c: Context) => Promise<Response> {
  const root = realpathSync(distDir);
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  const notFound = (c: Context) => c.text("Not found", 404);

  const send = async (c: Context, file: string, cache: string): Promise<Response> => {
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if (type.startsWith("text/html")) {
      headers["content-security-policy"] = htmlCsp(opts.imgSources?.() ?? []);
      headers["x-frame-options"] = "DENY";
    }
    const data = c.req.method === "HEAD" ? null : await readFile(file);
    return new Response(data, { status: 200, headers });
  };

  return async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return notFound(c);
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return notFound(c);
    }
    if (path.includes("\0") || path.includes("\\")) return notFound(c);
    const target = resolve(root, "." + path);
    if (!inside(target)) return notFound(c);
    if (existsSync(target) && statSync(target).isFile()) {
      const real = realpathSync(target);
      if (!inside(real)) return notFound(c);
      return send(c, real, path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    }
    const last = path.split("/").pop() ?? "";
    if (extname(last) !== "") return notFound(c); // a missing asset is a 404, not the app shell
    const index = resolve(root, "index.html");
    if (!existsSync(index)) return notFound(c);
    return send(c, index, "no-cache");
  };
}
