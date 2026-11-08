import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE peer_call_receipts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE peer_call_receipts SET created_at = ${now}`;
  yield* sql`CREATE INDEX peer_call_receipts_created_at ON peer_call_receipts(created_at)`;
});
