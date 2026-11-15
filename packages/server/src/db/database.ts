import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.ts";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // H7: a REPLACE conflict deletes the old row; with recursive triggers that delete fires the immutability guards
  db.exec("PRAGMA recursive_triggers = ON");
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = row.user_version; i < migrations.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
