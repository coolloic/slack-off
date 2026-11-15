#!/usr/bin/env node
// Phase 4f fixture: a tiny to-do CLI for the acceptance case runner (items.txt in the cwd). Test-only subcommands:
// probe (connects to Slack Off's port), read <path>, sleep, color, big, show <file>, env <NAME>, stdin, die (SIGKILL).
import { appendFileSync, readdirSync, readFileSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const items = () => {
  try {
    return readFileSync("items.txt", "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
if (cmd === "list") {
  const all = items();
  console.log(all.length === 0 ? "(no items)" : all.map((x, i) => `${i + 1}. ${x}`).join("\n"));
} else if (cmd === "add" && rest.length === 1) {
  appendFileSync("items.txt", `${rest[0]}\n`);
  console.log(`added ${rest[0]}`);
} else if (cmd === "add") {
  console.error("error: add takes exactly one name");
  process.exit(1);
} else if (cmd === "probe") {
  try {
    await fetch("http://127.0.0.1:4317/api/status");
    console.log("CONNECTED");
  } catch (e) {
    console.log(`probe: ${e.cause?.code ?? e.code ?? e.message}`);
  }
} else if (cmd === "read") {
  try {
    readdirSync(rest[0]);
    console.log("read: READ");
  } catch (e) {
    console.log(`read: ${e.code}`);
  }
} else if (cmd === "sleep") setInterval(() => {}, 60_000);
else if (cmd === "color") console.log("\x1b[31mred\x1b[0m plain \x1b[1;32mbold green\x1b[0m");
else if (cmd === "big") process.stdout.write(`${"x".repeat(99)}\n`.repeat(1000) + "THE END\n");
else if (cmd === "show") process.stdout.write(readFileSync(rest[0], "utf8"));
else if (cmd === "env") console.log(`${rest[0]}=${process.env[rest[0]] ?? ""}`);
else if (cmd === "stdin") console.log(`stdin: ${JSON.stringify(readFileSync(0, "utf8"))}`);
else if (cmd === "die") {
  console.log("dying");
  process.kill(process.pid, "SIGKILL");
}
else {
  console.error("usage: tool <list | add <name>>");
  process.exit(2);
}
