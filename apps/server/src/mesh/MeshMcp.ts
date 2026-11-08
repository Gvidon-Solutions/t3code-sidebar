import { declareMcpProtocol } from "../mcp/McpToolDomain.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { MeshReplicator, ExchangeInput } from "./MeshReplicator.ts";
import { MeshRelay, RelayInput, HOP_HEADER } from "./MeshRelay.ts";

const protocols = {
  exchange: declareMcpProtocol("t3_mesh_exchange", "mesh"),
  routes: declareMcpProtocol("t3_mesh_routes", "mesh"),
  relay: declareMcpProtocol("t3_mesh_relay", "mesh"),
};
const protocolNames = new Set<string>(Object.values(protocols).map((tool) => tool.name));

export const interceptMeshRequest = Effect.fn("MeshMcp.interceptRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  limited: McpInvocationContext.McpInvocationScope,
  meshReplicator: Option.Option<MeshReplicator["Service"]>,
  meshRelay: Option.Option<MeshRelay["Service"]>,
  linkedEnvironments: boolean,
) {
  if (request.method === "POST") {
    const body = yield* request.json.pipe(
      Effect.catch((error) =>
        Effect.logDebug("MCP request JSON could not be decoded", error).pipe(Effect.as(undefined)),
      ),
    );
    const call = decodeMeshCall(body);
    if (Option.isSome(call) && protocolNames.has(call.value.params.name)) {
      if (call.value.params.name !== protocols.exchange.name) {
        if (
          limited.client?.linked !== true ||
          limited.client.peerEnvironmentId === undefined ||
          limited.client.access !== "full-access" ||
          !linkedEnvironments
        )
          return HttpServerResponse.jsonUnsafe(
            { error: "mesh_requires_full_access_link" },
            { status: 403 },
          );
        const relay = meshRelay;
        if (Option.isNone(relay))
          return HttpServerResponse.jsonUnsafe({ error: "mesh_unavailable" }, { status: 503 });
        const result = yield* (
          call.value.params.name === protocols.routes.name
            ? decodeRouteOptions(call.value.params.arguments).pipe(Option.getOrUndefined)
                ?.details === true
              ? Effect.all({ routes: relay.value.routes, connections: relay.value.status })
              : relay.value.routes
            : decodeRelay(call.value.params.arguments).pipe(
                Effect.flatMap((input) =>
                  relay.value
                    .relay(input, request.headers[HOP_HEADER]?.split(",") ?? [], {
                      ...McpInvocationContext.clientModeCeiling(limited.client),
                      ...(limited.client?.filesLimit ? { files: limited.client.filesLimit } : {}),
                      ...(limited.client?.replicasLimit === false ? { replicas: false } : {}),
                    })
                    .pipe(
                      Effect.provideService(McpInvocationContext.McpInvocationContext, limited),
                    ),
                ),
              )
        ).pipe(
          Effect.match({
            onFailure: (error) => ({
              content: [
                {
                  type: "text",
                  text: encodeMeshJson({
                    code:
                      error._tag === "OrchestratorMcpFailure" ? error.code : "capability_denied",
                    message:
                      error._tag === "OrchestratorMcpFailure" ? error.message : String(error),
                  }),
                },
              ],
              isError: true,
            }),
            onSuccess: (value) => ({
              content: [
                {
                  type: "text",
                  text: encodeMeshJson(value),
                },
              ],
            }),
          }),
        );
        return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: call.value.id, result });
      }
      if (
        limited.client?.linked !== true ||
        limited.client.peerEnvironmentId === undefined ||
        limited.client.access !== "full-access"
      ) {
        return HttpServerResponse.jsonUnsafe(
          { error: "mesh_requires_full_access_link" },
          { status: 403 },
        );
      }
      const replicator = meshReplicator;
      if (Option.isNone(replicator))
        return HttpServerResponse.jsonUnsafe({ error: "mesh_unavailable" }, { status: 503 });
      const result = yield* decodeExchange(call.value.params.arguments).pipe(
        Effect.flatMap((input) => replicator.value.exchange(input)),
        Effect.match({
          onFailure: (error) => ({
            content: [
              {
                type: "text",
                text: encodeMeshJson({
                  code: "invalid_request",
                  message: String(error),
                }),
              },
            ],
            isError: true,
          }),
          onSuccess: (value) => ({
            content: [
              {
                type: "text",
                text: encodeMeshJson(value),
              },
            ],
          }),
        }),
      );
      return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: call.value.id, result });
    }
  }
});

const decodeMeshCall = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.Unknown,
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({ name: Schema.String, arguments: Schema.Unknown }),
  }),
);
const decodeRelay = Schema.decodeUnknownEffect(RelayInput);
const decodeExchange = Schema.decodeUnknownEffect(ExchangeInput);
const encodeMeshJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeRouteOptions = Schema.decodeUnknownOption(
  Schema.Struct({ details: Schema.optionalKey(Schema.Boolean) }),
);
