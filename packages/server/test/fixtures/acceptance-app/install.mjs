// Task 6 fixture: the acceptance install step; writes a marker next to the app (or fails with FIXTURE_INSTALL=fail).
import { writeFileSync } from "node:fs";

if (process.env.FIXTURE_INSTALL === "fail") {
  console.error("fixture install: failed on purpose");
  process.exit(3);
}
writeFileSync("installed.txt", `${process.env.TMPDIR ?? ""}\n`);
