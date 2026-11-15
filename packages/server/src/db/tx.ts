import type { DatabaseSync } from "node:sqlite";

const depths = new WeakMap<DatabaseSync, number>();

export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  const depth = depths.get(db) ?? 0;
  const sp = `sp_${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
  depths.set(db, depth + 1);
  try {
    const result = fn();
    depths.set(db, depth);
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    depths.set(db, depth);
    if (depth === 0) db.exec("ROLLBACK");
    else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}
