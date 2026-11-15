// Task 6 fixture: a tiny target app for acceptance tests. PORT from the environment (the rule file's acceptance.env).
// FIXTURE_MODE: "fail" → exit 1 at once; "nolisten" → never listen (health check times out); "daemonize" → start a
// serving child in the same process group (holding stdout) and exit at once; anything else → serve.
// Test-only endpoints: /env (the environment's keys), /read?f=<path> (whether the app can read a file).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const mode = process.env.FIXTURE_MODE ?? "serve";
if (mode === "fail") {
  console.error(`fixture app: refusing to start (${process.cwd().split("/").pop()})`);
  process.exit(1);
}
if (mode === "daemonize") {
  spawn(process.execPath, [process.argv[1]], { env: { ...process.env, FIXTURE_MODE: "serve" }, stdio: "inherit" });
  console.log("fixture app: daemonized");
  process.exit(0);
}
if (mode === "nolisten") {
  console.log("fixture app: not listening");
  setInterval(() => {}, 60_000);
} else {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") return res.end("ok");
    if (url.pathname === "/env") return res.end(JSON.stringify(Object.keys(process.env).sort()));
    if (url.pathname === "/read") {
      try {
        readFileSync(url.searchParams.get("f") ?? "");
        return res.end("READ");
      } catch (e) {
        return res.end(String(e.code));
      }
    }
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><title>Shop</title><h1>Shop</h1><label>Quantity <input name="qty" value="1"></label><button>Buy</button>');
  });
  server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`fixture app: listening on ${process.env.PORT}`));
}
