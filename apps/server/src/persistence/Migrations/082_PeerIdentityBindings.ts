import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE peer_client_identities (client_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, issuer_environment_id TEXT NOT NULL)`;
  yield* sql`CREATE TABLE peer_session_identities (session_id TEXT PRIMARY KEY REFERENCES auth_sessions(session_id) ON DELETE CASCADE, environment_id TEXT NOT NULL, source TEXT NOT NULL, bound_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE peer_legacy_identity_candidates (session_id TEXT PRIMARY KEY REFERENCES auth_sessions(session_id) ON DELETE CASCADE)`;
  yield* sql`INSERT INTO peer_legacy_identity_candidates(session_id) SELECT session_id FROM auth_sessions WHERE subject = 'mcp-client' AND revoked_at IS NULL`;
});
