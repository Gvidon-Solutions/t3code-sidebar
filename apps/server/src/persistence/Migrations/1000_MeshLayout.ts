import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mesh_layout_entries (key TEXT PRIMARY KEY, value TEXT, hlc TEXT NOT NULL, seq INTEGER NOT NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS mesh_layout_entries_seq ON mesh_layout_entries(seq)`;
  yield* sql`CREATE TABLE IF NOT EXISTS mesh_layout_meta (id INTEGER PRIMARY KEY CHECK(id = 1), hlc TEXT NOT NULL, seq INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS mesh_peer_state (environment_id TEXT PRIMARY KEY, sent_seq INTEGER NOT NULL DEFAULT 0, received_seq INTEGER NOT NULL DEFAULT 0, last_exchange_at TEXT, last_error TEXT)`;
});
