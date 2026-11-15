// Task 6 fixture: the acceptance stop step; appends this repo's name (the cwd's basename) to ../stop-order.log.
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

appendFileSync("../stop-order.log", `${basename(process.cwd())}\n`);
