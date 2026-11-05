// @effect-diagnostics nodeBuiltinImport:off -- The primary reports its own native PTY module and runtime invocation to trusted replica peers.
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { linkPermissions } from "../mesh/MeshLinkPermissions.ts";

const requireNative = NodeModule.createRequire(import.meta.url);
export const read = Effect.fn("RunRuntimeInfo.read")(function* () {
  const permission = yield* linkPermissions();
  if (!permission.linked || !permission.replicas)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Run runtime discovery requires a replica-enabled mesh link.",
    });
  const invocation = yield* resolveSelfInvocation();
  const ptyModule = yield* Effect.try({
    try: () => requireNative.resolve("node-pty"),
    catch: () =>
      new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "The primary's native terminal module is unavailable.",
      }),
  });
  return {
    command: invocation.command,
    ...(invocation.entrypoint ? { entrypoint: invocation.entrypoint } : {}),
    ptyModule,
  };
});
