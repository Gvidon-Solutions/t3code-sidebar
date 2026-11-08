import { declareMcpProtocol, linkAllowsDomain } from "../mcp/McpToolDomain.ts";
import { linkPermissions } from "./MeshLinkPermissions.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { clientModeCeiling, McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { ThreadForkService } from "./ThreadForkService.ts";
import { ForkTransportInput } from "./forkTransport.ts";

const receiver = declareMcpProtocol("t3_thread_receive_fork", "threads");
const decodeCall = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.Unknown,
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.Literal(receiver.name),
      arguments: Schema.Unknown,
    }),
  }),
);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const decodeInput = Schema.decodeUnknownEffect(ForkTransportInput);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const interceptForkRequest = Effect.fn("ForkMcp.interceptRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  scope: McpInvocationScope,
  service: Option.Option<ThreadForkService["Service"]>,
  enabled: boolean,
) {
  if (request.method !== "POST") return undefined;
  const call = decodeCall(yield* request.json.pipe(Effect.orElseSucceed(() => undefined)));
  if (Option.isNone(call)) return undefined;
  if (!enabled || scope.client?.linked !== true || scope.client.access !== "full-access")
    return HttpServerResponse.jsonUnsafe(
      { error: "fork_requires_full_access_link" },
      { status: 403 },
    );
  const permissions = yield* linkPermissions().pipe(
    Effect.provideService(McpInvocationContext, scope),
  );
  if (!linkAllowsDomain(receiver.domain, permissions, scope.client.peerEnvironmentId !== undefined))
    return HttpServerResponse.jsonUnsafe({ error: "link_threads_denied" }, { status: 403 });
  if (Option.isNone(service))
    return HttpServerResponse.jsonUnsafe({ error: "fork_unavailable" }, { status: 503 });
  const result = yield* decodeInput(call.value.params.arguments).pipe(
    Effect.flatMap((input) =>
      service.value.receive(input, {
        ...clientModeCeiling(scope.client),
        ...(!permissions.replicas ? { replicas: false } : {}),
      }),
    ),
    Effect.match({
      onSuccess: (value) => ({
        content: [{ type: "text", text: encode(value) }],
        structuredContent: value,
      }),
      onFailure: (error) => ({
        isError: true,
        content: [
          {
            type: "text",
            text: encode({
              code: isMcpFailure(error) ? error.code : "invalid_request",
              message: error.message,
            }),
          },
        ],
      }),
    }),
  );
  return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: call.value.id, result });
});
