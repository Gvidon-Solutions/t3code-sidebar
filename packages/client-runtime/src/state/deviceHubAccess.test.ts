import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import { resolveDeviceHubAccess } from "./deviceHubAccess.ts";

const ENVIRONMENT_ID = EnvironmentId.make("studio");

const serverUiPrepared = {
  environmentId: ENVIRONMENT_ID,
  label: "Studio",
  httpBaseUrl: "t3code://server-7-abc/",
  socketUrl: "wss://studio.example/ws",
  httpAuthorization: null,
  target: new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Studio",
    httpBaseUrl: "t3code://server-7-abc/",
    wsBaseUrl: "wss://studio.example/",
  }),
} as const;

function recordedFetch(...responses: ReadonlyArray<Response>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let index = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[index++];
    return response ? Promise.resolve(response) : Promise.reject(new Error("unexpected fetch"));
  }) satisfies typeof fetch;
  return { fetchFn, calls };
}

describe("resolveDeviceHubAccess", () => {
  it.effect("mints a media ticket through the shell proxy for server UI streams", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(
        Response.json({ ticket: "media-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
      );
      const access = yield* resolveDeviceHubAccess({
        prepared: serverUiPrepared as never,
        hubBasePath: "/api/device-hub",
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetch.fetchFn)));

      expect(String(fetch.calls[0]?.[0])).toBe(
        "t3code://server-7-abc/api/auth/websocket-ticket/media",
      );
      expect(fetch.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
      expect(access).toEqual({
        httpBase: "https://studio.example/api/device-hub",
        wsBase: "wss://studio.example/api/device-hub",
        query: { wsTicket: "media-ticket" },
        credentials: false,
      });
    }),
  );

  it.effect("keeps first-party cookies for a loopback primary", () =>
    Effect.gen(function* () {
      const access = yield* resolveDeviceHubAccess({
        prepared: {
          ...serverUiPrepared,
          httpBaseUrl: "http://127.0.0.1:3773/",
          target: new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "Studio",
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
          }),
        } as never,
        hubBasePath: "/api/device-hub",
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(() => Promise.reject(new Error("no")))));

      expect(access).toEqual({
        httpBase: "http://127.0.0.1:3773/api/device-hub",
        wsBase: "ws://127.0.0.1:3773/api/device-hub",
        query: {},
        credentials: true,
      });
    }),
  );
});
