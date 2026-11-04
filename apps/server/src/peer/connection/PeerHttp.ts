import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { PeerCallDispatcher } from "./PeerSessions.ts";
import * as PeerSessions from "./PeerSessions.ts";
import * as PeerWire from "./PeerWire.ts";
import * as PeerCredentials from "./PeerCredentials.ts";

const refused = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: "peer_connection_refused", message },
    { status, headers: { "cache-control": "no-store" } },
  );

/**
 * The persistent peer transport. A linked server upgrades this to a
 * WebSocket, authenticated with its link token exactly like `/mcp`; the
 * receiver then authorizes every call through the same MCP dispatcher.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const others = yield* PeerSessions.PeerSessions;
    const dispatcher = yield* PeerCallDispatcher;
    const credentials = yield* PeerCredentials.PeerCredentials;
    return HttpRouter.add(
      "GET",
      "/peer",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const enabled = yield* settings.getSettings.pipe(
          Effect.map((value) => value.linkedEnvironmentsEnabled),
          Effect.catch((error) =>
            Effect.logWarning("Peer settings could not be read", error).pipe(Effect.as(false)),
          ),
        );
        if (!enabled) return refused(403, "Linked environments is off on this machine.");
        const authenticated = yield* auth.authenticateMcpClient(request).pipe(Effect.result);
        if (authenticated._tag === "Failure") {
          if (authenticated.failure._tag === "ServerAuthInternalError") {
            yield* Effect.logWarning("Peer authentication failed", authenticated.failure);
            return refused(503, "Peer authentication is temporarily unavailable.");
          }
          return refused(401, "A link credential is required.");
        }
        const session = authenticated.success;
        if (
          session.peerLink !== true ||
          (session.peerEnvironmentId === undefined && !request.headers["t3-peer-environment-id"])
        )
          return refused(403, "This credential is not a T3 Code peer link.");
        const callerId = session.peerEnvironmentId ?? request.headers["t3-peer-environment-id"]!;
        const environmentId = EnvironmentId.make(callerId);
        const bound = yield* credentials.bind(callerId, session.sessionId).pipe(Effect.result);
        if (bound._tag === "Failure") return refused(403, bound.failure.message);
        const made = yield* dispatcher.make({
          environmentId: callerId,
          token: request.headers.authorization!.slice(7),
          access: session.access,
        });
        const upgraded = yield* PeerWire.acceptUpgrade(request).pipe(Effect.result);
        if (upgraded._tag === "Failure")
          return refused(400, "The connection could not be upgraded.");
        const accepted = yield* others
          .accept({
            environmentId,
            direction: "inbound",
            access: session.access,
            wire: upgraded.success,
            call: made.call,
          })
          .pipe(Effect.result);
        if (accepted._tag === "Failure")
          return refused(409, "A preferred peer connection already exists.");
        // The handler owns the upgrade for as long as the socket is open.
        yield* Effect.promise(() => upgraded.success.done);
        return HttpServerResponse.empty();
      }),
    );
  }),
);
