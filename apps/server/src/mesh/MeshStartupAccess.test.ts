import { AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import * as Layer from "effect/Layer";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { allowed, meshControlRequest } from "./MeshStartupAccess.ts";
it("admits only replication, update coordination and initialization before trial commit", () => {
  expect(meshControlRequest({ method: "initialize" })).toBe(true);
  for (const name of [
    "t3_mesh_exchange",
    "t3_mesh_update_vote",
    "t3_mesh_update_health",
    "t3_mesh_routes",
  ])
    expect(meshControlRequest({ method: "tools/call", params: { name } })).toBe(true);
  expect(
    meshControlRequest({
      method: "tools/call",
      params: { name: "t3_mesh_relay", arguments: { tool: "t3_mesh_update_vote" } },
    }),
  ).toBe(true);
  for (const name of [
    "t3_thread_launch",
    "t3_mesh_config_apply",
    "t3_mesh_update",
    "t3_project_place",
  ]) {
    expect(meshControlRequest({ method: "tools/call", params: { name } })).toBe(false);
    expect(
      meshControlRequest({
        method: "tools/call",
        params: { name: "t3_mesh_relay", arguments: { tool: name } },
      }),
    ).toBe(false);
  }
});
it.effect(
  "requires a full-access peer session and retains the request body for the real MCP handler",
  () =>
    Effect.gen(function* () {
      for (const peerLink of [false, true]) {
        const request = HttpServerRequest.fromWeb(
          new Request("http://localhost/mcp", {
            method: "POST",
            body: JSON.stringify({ method: "tools/call", params: { name: "t3_mesh_exchange" } }),
          }),
        );
        expect(
          yield* allowed.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            Effect.provide(
              Layer.mock(EnvironmentAuth)({
                authenticateMcpClient: () =>
                  Effect.succeed({
                    sessionId: AuthSessionId.make("peer"),
                    label: "Studio",
                    access: "full-access",
                    peerLink,
                  }),
              }),
            ),
          ),
        ).toBe(peerLink);
        expect(yield* request.json).toEqual({
          method: "tools/call",
          params: { name: "t3_mesh_exchange" },
        });
      }
    }),
);

it.effect(
  "keeps the public peer descriptor available during a trial so incoming-only peers can reconnect",
  () =>
    allowed.pipe(
      Effect.map((value) => {
        expect(value).toBe(true);
      }),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://localhost/.well-known/t3/environment")),
      ),
      Effect.provide(Layer.mock(EnvironmentAuth)({})),
    ),
);
