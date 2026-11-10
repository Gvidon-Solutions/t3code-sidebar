import legacyMeshLayout from "./Migrations/1000_MeshLayout.ts";
import peerConnections from "./Migrations/1001_PeerConnections.ts";
import peerIdentityBindings from "./Migrations/1002_PeerIdentityBindings.ts";
import receiptRetention from "./Migrations/1003_PeerReceiptRetention.ts";
import closeTerminalRunNodes from "./Migrations/1004_CloseTerminalRunNodes.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { forkMigrationManifest, migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const forkMigrations = forkMigrationManifest;
const allMigrations = [...v2Migrations, ...forkMigrations];
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), allMigrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), allMigrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a fresh database and records the fork ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runMigrations(), allMigrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(
        (yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations ORDER BY migration_id`).map(
          (row) => [row.migration_id, row.name] as const,
        ),
        forkMigrationManifest,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades an upstream-only database by adding the fork ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      assert.deepStrictEqual(
        (yield* runMigrations()).map(([id]) => id),
        forkMigrations.map(([id]) => id),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([
    { label: "renumbered 80-84", rows: [[80, "MeshLayout"], [81, "PeerConnections"], [82, "PeerIdentityBindings"], [83, "PeerReceiptRetention"], [84, "CloseTerminalRunNodes"]] },
    { label: "original 77-84", rows: [[77, "MeshLayout"], [78, "PeerConnections"], [82, "PeerIdentityBindings"], [83, "PeerReceiptRetention"], [84, "CloseTerminalRunNodes"]] },
  ] as const)(
    "moves a legacy fork database's $label records into the fork ledger",
    ({ rows }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });
        yield* legacyMeshLayout;
        yield* peerConnections;
        yield* peerIdentityBindings;
        yield* receiptRetention;
        yield* closeTerminalRunNodes;
        yield* sql`INSERT INTO mesh_layout_entries VALUES ('future/key', '{"retained":true}', '1:0:studio', 1)`;
        yield* sql`INSERT INTO peer_call_receipts (environment_id, request_key, request_body, result, created_at) VALUES ('studio', 'saved', '{}', '{"saved":true}', 42)`;
        for (const [id, name] of rows) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        }
        assert.deepStrictEqual(yield* runMigrations(), [[80, "ScheduledTaskThreadMode"]]);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(
          (yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations ORDER BY migration_id`).map(
            (row) => [row.migration_id, row.name] as const,
          ),
          forkMigrationManifest,
        );
        assert.deepStrictEqual(yield* sql`SELECT value FROM mesh_layout_entries`, [
          { value: '{"retained":true}' },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT result, created_at FROM peer_call_receipts`, [
          { result: '{"saved":true}', created_at: 42 },
        ]);
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to open a database written by a newer fork build", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO effect_sql_fork_migrations (migration_id, name) VALUES (1005, 'FutureForkMigration')`;
      const before = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "1005_FutureForkMigration (unknown to this build)");
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
        before,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps a site-local fork ledger name divergence visible", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`UPDATE effect_sql_fork_migrations SET name = 'SiteLocalFork' WHERE migration_id = 1000`;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "1000_MeshLayout (recorded: SiteLocalFork)");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      [...migrationManifest, ...forkMigrationManifest].toSorted(([a], [b]) => a - b),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
