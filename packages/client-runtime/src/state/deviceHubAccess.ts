/**
 * `<img>`, `EventSource`, and `WebSocket` cannot set bearer or DPoP headers, so bearer and DPoP
 * connections mint a short-lived WebSocket ticket and pass it as `wsTicket`, the same way the
 * app's own `/ws` upgrade authenticates. Callers fetch a fresh one each time they (re)connect a
 * stream.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import type { DeviceHubAccess } from "../device/hubAccess.ts";

export { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";

const TICKET_TIMEOUT_MS = 8_000;

/**
 * The desktop server UI reaches its own API through the shell proxy, so its media
 * sockets must target the server itself and carry a ticket minted through that proxy.
 */
function serverUiMediaTarget(prepared: PreparedConnection): {
  readonly httpBase: string;
  readonly wsBase: string;
} | null {
  if (prepared.httpAuthorization !== null) return null;
  if (prepared.target._tag !== "PrimaryConnectionTarget") return null;
  let httpProtocol: string;
  try {
    httpProtocol = new URL(prepared.target.httpBaseUrl).protocol;
  } catch {
    return null;
  }
  if (httpProtocol !== "t3code:" && httpProtocol !== "t3code-dev:") return null;
  const ws = new URL(prepared.target.wsBaseUrl);
  const http = new URL(prepared.target.wsBaseUrl);
  http.protocol = ws.protocol === "wss:" ? "https:" : "http:";
  return { httpBase: http.href, wsBase: ws.href };
}

export const resolveDeviceHubAccess = Effect.fn("clientRuntime.state.resolveDeviceHubAccess")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly hubBasePath: string;
  }): Effect.fn.Return<DeviceHubAccess, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
    const serverUi = serverUiMediaTarget(input.prepared);
    if (serverUi !== null) {
      const httpBase = environmentEndpointUrl(serverUi.httpBase, input.hubBasePath);
      const wsBase = environmentEndpointUrl(serverUi.wsBase, input.hubBasePath);
      const client = yield* makeEnvironmentHttpApiGroupClient(input.prepared.httpBaseUrl, "auth");
      const ticket = yield* executeEnvironmentHttpRequest(
        environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/auth/websocket-ticket/media"),
        TICKET_TIMEOUT_MS,
        client.webSocketTicketFor({ headers: {}, params: { use: "media" } }),
      );
      return {
        httpBase,
        wsBase,
        query: { wsTicket: Redacted.value(ticket.ticket) },
        credentials: false,
      };
    }
    const httpBase = environmentEndpointUrl(input.prepared.httpBaseUrl, input.hubBasePath);
    const wsBase = httpBase.replace(/^http/, "ws");
    if (input.prepared.httpAuthorization === null) {
      return { httpBase, wsBase, query: {}, credentials: true };
    }
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    const ticket = yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      group: "auth",
      method: "POST",
      url: (urls) => urls.webSocketTicketFor({ params: { use: "media" } }),
      timeoutMs: TICKET_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.webSocketTicketFor({ headers, params: { use: "media" } }),
    });
    return {
      httpBase,
      wsBase,
      query: { wsTicket: Redacted.value(ticket.ticket) },
      credentials: false,
    };
  },
);
