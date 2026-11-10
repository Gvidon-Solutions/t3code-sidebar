import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS peer_reverse_grants (environment_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, secret_name TEXT NOT NULL, access TEXT NOT NULL, expires_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS peer_incoming_sessions (session_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS peer_incoming_sessions_environment ON peer_incoming_sessions(environment_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS peer_call_receipts (environment_id TEXT NOT NULL, request_key TEXT NOT NULL, request_body TEXT NOT NULL, result TEXT, PRIMARY KEY(environment_id, request_key))`;
});
