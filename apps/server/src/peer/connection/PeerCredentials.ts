import { AuthSessionId, type AuthMcpClientAccess } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { PeerConnectionError } from "./PeerSessions.ts";

export class PeerCredentials extends Context.Service<
  PeerCredentials,
  {
    readonly grant: (
      environmentId: string,
      access: AuthMcpClientAccess,
    ) => Effect.Effect<{ token: string; expiresAt: number }, PeerConnectionError>;
    readonly bind: (
      environmentId: string,
      sessionId: string,
    ) => Effect.Effect<void, PeerConnectionError>;
    readonly revoke: (environmentId: string) => Effect.Effect<void, PeerConnectionError>;
  }
>()("t3/peer/connection/PeerCredentials") {}

export const layer = Layer.effect(
  PeerCredentials,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const failure = (cause: unknown) =>
      new PeerConnectionError({
        reason: "protocol",
        message: "Peer credential storage failed",
        cause,
      });
    const bind = Effect.fn("PeerCredentials.bind")(function* (
      environmentId: string,
      sessionId: string,
    ) {
      const previous = yield* sql<{
        environment_id: string;
      }>`SELECT environment_id FROM peer_incoming_sessions WHERE session_id = ${sessionId}`;
      if (previous[0] && previous[0].environment_id !== environmentId)
        return yield* new PeerConnectionError({
          reason: "protocol",
          message: "The peer token is bound to another environment",
        });
      yield* sql`INSERT INTO peer_incoming_sessions(session_id, environment_id) VALUES (${sessionId}, ${environmentId}) ON CONFLICT(session_id) DO NOTHING`;
    }, Effect.mapError(failure));
    const revoke = Effect.fn("PeerCredentials.revoke")(function* (environmentId: string) {
      const sessions = yield* sql<{
        session_id: string;
      }>`SELECT session_id FROM peer_incoming_sessions WHERE environment_id = ${environmentId}`;
      for (const session of sessions)
        yield* auth.revokeSession(AuthSessionId.make(session.session_id));
      const grants = yield* sql<{
        session_id: string;
        secret_name: string;
      }>`SELECT session_id, secret_name FROM peer_reverse_grants WHERE environment_id = ${environmentId}`;
      for (const grant of grants) {
        yield* auth.revokeSession(AuthSessionId.make(grant.session_id));
        yield* secrets.remove(grant.secret_name);
      }
      yield* sql`DELETE FROM peer_incoming_sessions WHERE environment_id = ${environmentId}`;
      yield* sql`DELETE FROM peer_reverse_grants WHERE environment_id = ${environmentId}`;
    }, Effect.mapError(failure));
    const grant = Effect.fn("PeerCredentials.grant")(function* (
      environmentId: string,
      access: AuthMcpClientAccess,
    ) {
      const rows = yield* sql<{
        secret_name: string;
        expires_at: number;
        access: string;
      }>`SELECT secret_name, expires_at, access FROM peer_reverse_grants WHERE environment_id = ${environmentId}`;
      const now = yield* DateTime.now;
      const previous = rows[0];
      if (
        previous &&
        previous.access === access &&
        previous.expires_at > now.epochMilliseconds + 60_000
      ) {
        const stored = yield* secrets.get(previous.secret_name);
        if (Option.isSome(stored))
          return { token: new TextDecoder().decode(stored.value), expiresAt: previous.expires_at };
      }
      const issued = yield* auth.issueMcpClientSession({
        label: `T3 Code peer · ${environmentId}`,
        access,
        peerLink: true,
        peerEnvironmentId: environmentId,
        client: { deviceType: "bot" },
      });
      const secretName = `peer-reverse-${issued.sessionId}`;
      yield* secrets.set(secretName, new TextEncoder().encode(issued.token));
      yield* sql`INSERT INTO peer_reverse_grants (environment_id, session_id, secret_name, access, expires_at) VALUES (${environmentId}, ${issued.sessionId}, ${secretName}, ${access}, ${issued.expiresAt.epochMilliseconds}) ON CONFLICT(environment_id) DO UPDATE SET session_id=excluded.session_id, secret_name=excluded.secret_name, access=excluded.access, expires_at=excluded.expires_at`;
      if (previous && previous.secret_name !== secretName)
        yield* secrets.remove(previous.secret_name);
      return { token: issued.token, expiresAt: issued.expiresAt.epochMilliseconds };
    }, Effect.mapError(failure));
    return { bind, revoke, grant };
  }),
);
