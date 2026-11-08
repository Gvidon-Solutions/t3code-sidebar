import { expect, it } from "@effect/vitest";
import { PeerIdentitySource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { PeerIdentities, layer } from "./PeerIdentities.ts";

const decodeSources = Schema.decodeEffect(Schema.Array(PeerIdentitySource));
const isIdentitySource = Schema.is(PeerIdentitySource);

it.effect("reports only legacy identity upgrades in session order", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const identities = yield* PeerIdentities;
    const sources = yield* decodeSources([
      "pairing-code",
      "legacy-local-link",
      "mutual-grant",
      "legacy-local-link",
    ]);
    for (const [index, source] of sources.entries()) {
      const id = `session-${index}`;
      yield* sql`INSERT INTO auth_sessions(session_id, subject, scopes, method, issued_at, expires_at) VALUES (${id}, 'mcp-client', '[]', 'access-token', '2026-01-01', '2027-01-01')`;
      yield* sql`INSERT INTO peer_session_identities(session_id, environment_id, source, bound_at) VALUES (${id}, 'cloudbox', ${source}, '2026-01-01')`;
    }
    expect(yield* identities.legacyUpgrades).toEqual([
      { sessionId: "session-1", environmentId: "cloudbox", boundAt: "2026-01-01" },
      { sessionId: "session-3", environmentId: "cloudbox", boundAt: "2026-01-01" },
    ]);
    expect(isIdentitySource("arbitrary-source")).toBe(false);
    yield* sql`DELETE FROM auth_sessions WHERE session_id = 'session-1'`;
    expect(yield* identities.legacyUpgrades).toHaveLength(1);
  }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
