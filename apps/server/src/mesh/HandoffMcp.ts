import { linkPermissions } from "./MeshLinkPermissions.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { clientModeCeiling } from "../mcp/McpInvocationContext.ts";
import { ThreadHandoffService } from "./ThreadHandoffService.ts";
import { ReceiveHandoffInput } from "./handoffTransport.ts";

const decodeCall = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.Unknown,
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.Literal("t3_thread_receive_handoff"),
      arguments: Schema.Unknown,
    }),
  }),
);
const decodeInput = Schema.decodeUnknownEffect(ReceiveHandoffInput);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const interceptHandoffRequest = Effect.fn("HandoffMcp.interceptRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  scope: McpInvocationScope,
  service: Option.Option<ThreadHandoffService["Service"]>,
  enabled: boolean,
) {
  if (request.method !== "POST") return undefined;
  const call = decodeCall(yield* request.json.pipe(Effect.orElseSucceed(() => undefined)));
  if (Option.isNone(call)) return undefined;
  if (!enabled || scope.client?.linked !== true || scope.client.access !== "full-access")
    return HttpServerResponse.jsonUnsafe(
      { error: "handoff_requires_full_access_link" },
      { status: 403 },
    );
  if (!(yield* linkPermissions().pipe(Effect.provideService(McpInvocationContext, scope))).threads)
    return HttpServerResponse.jsonUnsafe({ error: "link_threads_denied" }, { status: 403 });
  if (Option.isNone(service))
    return HttpServerResponse.jsonUnsafe({ error: "handoff_unavailable" }, { status: 503 });
  const result = yield* decodeInput(call.value.params.arguments).pipe(
    Effect.flatMap((input) => service.value.receive(input, clientModeCeiling(scope.client))),
    Effect.match({
      onSuccess: (value) => ({
        content: [{ type: "text", text: encode(value) }],
        structuredContent: value,
      }),
      onFailure: (error) => ({
        isError: true,
        content: [
          { type: "text", text: encode({ code: "invalid_request", message: String(error) }) },
        ],
      }),
    }),
  );
  return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: call.value.id, result });
});
