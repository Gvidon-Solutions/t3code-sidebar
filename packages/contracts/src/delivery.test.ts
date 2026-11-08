import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CommandId } from "./baseSchemas.ts";
import { DeliveryUpdatingError, isDeliveryUpdating } from "./delivery.ts";
import { OrchestrationV2DispatchCommandError } from "./orchestrationV2.ts";
import { OrchestratorMcpFailure } from "./orchestratorMcp.ts";

it("preserves the updating tag through RPC and MCP error codecs", () => {
  const rpc = new OrchestrationV2DispatchCommandError({
    commandId: CommandId.make("test"),
    commandType: "thread.message.send",
    message: "retry",
    cause: new DeliveryUpdatingError(),
  });
  const rpcCodec = Schema.toCodecJson(OrchestrationV2DispatchCommandError);
  const decoded = Schema.decodeUnknownSync(rpcCodec)(
    JSON.parse(JSON.stringify(Schema.encodeSync(rpcCodec)(rpc))),
  );
  expect(isDeliveryUpdating(decoded)).toBe(true);
  const mcp = new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "retry",
    cause: new DeliveryUpdatingError(),
  });
  const mcpCodec = Schema.toCodecJson(OrchestratorMcpFailure);
  expect(isDeliveryUpdating(Schema.decodeSync(mcpCodec)(Schema.encodeSync(mcpCodec)(mcp)))).toBe(
    true,
  );
  expect(isDeliveryUpdating({ message: "T3_UPDATING: user text" })).toBe(false);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(isDeliveryUpdating(cycle)).toBe(false);
});
