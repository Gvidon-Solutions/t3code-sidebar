import { PeerLinkError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

type Upgrade = {
  readonly sessionId: string;
  readonly environmentId: string;
  readonly boundAt: string;
};
export class PeerIdentities extends Context.Service<
  PeerIdentities,
  {
    readonly legacyUpgrades: Effect.Effect<readonly Upgrade[], PeerLinkError>;
  }
>()("t3/auth/PeerIdentities") {}

export const layer = Layer.effect(
  PeerIdentities,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return PeerIdentities.of({
      legacyUpgrades:
        sql<Upgrade>`SELECT session_id AS sessionId, environment_id AS environmentId, bound_at AS boundAt FROM peer_session_identities WHERE source = 'legacy-local-link' ORDER BY session_id`.pipe(
          Effect.mapError(
            (cause) =>
              new PeerLinkError({
                reason: "storage",
                message: "Could not read peer identity upgrades",
                cause,
              }),
          ),
        ),
    });
  }),
);
