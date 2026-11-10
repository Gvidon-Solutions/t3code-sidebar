// @effect-diagnostics nodeBuiltinImport:off - read synchronously by the preflight subprocess and at startup.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import {
  BUILD_FORK_MIGRATION_HEAD,
  BUILD_MIGRATION_HEAD,
  isLegacyForkMigration,
} from "./Migrations.ts";

export { BUILD_FORK_MIGRATION_HEAD, BUILD_MIGRATION_HEAD };

/** Where a migration row lives. The two ledgers use disjoint id ranges, so a recorded id alone
 * does not tell which build head it must be compared against. */
export type MigrationLedger = "upstream" | "fork";

export interface RecordedMigration {
  readonly id: number;
  readonly name: string;
  readonly ledger: MigrationLedger;
}

export { isLegacyForkMigration };

const readLedger = (
  db: NodeSqlite.DatabaseSync,
  table: "effect_sql_migrations" | "effect_sql_fork_migrations",
  ledger: MigrationLedger,
): ReadonlyArray<RecordedMigration> => {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (hasTable === undefined) return [];
  return db
    .prepare(`SELECT migration_id, name FROM ${table} ORDER BY migration_id`)
    .all()
    .map((row) => ({ id: Number(row.migration_id), name: String(row.name), ledger }));
};

/** Migrations either ledger records, read-only. A missing or new database records none; one that
 * exists but cannot be read is null, since its history is unknown. */
export function recordedMigrations(databasePath: string): ReadonlyArray<RecordedMigration> | null {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return NodeFS.existsSync(databasePath) ? null : [];
  }
  try {
    return [
      ...readLedger(db, "effect_sql_migrations", "upstream"),
      ...readLedger(db, "effect_sql_fork_migrations", "fork"),
    ].sort((left, right) => left.id - right.id);
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // A read-only handle has nothing to flush; the result above already stands.
    }
  }
}

/** Highest migration the database holds once this build's startup migrations have run. A newer
 * build may have recorded more than this build knows. Undefined when the database is unreadable. */
export function databaseMigrationHead(databasePath: string): number | undefined {
  const recorded = recordedMigrations(databasePath);
  if (recorded === null) return undefined;
  return Math.max(
    BUILD_MIGRATION_HEAD,
    BUILD_FORK_MIGRATION_HEAD,
    ...recorded.filter((row) => !isLegacyForkMigration(row)).map(({ id }) => id),
  );
}
