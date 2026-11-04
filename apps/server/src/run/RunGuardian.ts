// @effect-diagnostics globalDate:off -- Standalone guardian diagnostics use the native clock without an Effect runtime.
// @effect-diagnostics nodeBuiltinImport:off -- The detached forwarding guardian writes its own diagnostic log outside synchronized files.
// @effect-diagnostics globalTimers:off -- Reconnect backoff belongs to the lifetime of this standalone guardian process.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { RunPlan } from "./RunProtocol.ts";
import { remoteRun } from "./RunTransport.ts";
import { namespaceOf, privateDirectory, workerStateRoot } from "./RunPlatform.ts";
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      plan: RunPlan,
      id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
      ports: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    }),
  ),
);
export async function runGuardian(payload: string) {
  let ready = false;
  try {
    const { plan, id, ports } = decode(Buffer.from(payload, "base64").toString());
    if (plan.kind !== "remote") throw new Error("A forwarding guardian requires a primary.");
    const root = workerStateRoot(namespaceOf(plan.primaryRoot));
    await privateDirectory(root);
    for (;;) {
      try {
        await remoteRun(
          plan,
          { action: "wait", id, ports },
          {
            onFrame: (frame) => {
              if (frame.type === "ready" && !ready) {
                ready = true;
                process.send?.({ ready: true });
              }
            },
          },
        );
        return;
      } catch (cause) {
        await NodeFSP.appendFile(
          NodePath.join(root, `${id}.forwarding.log`),
          `${new Date().toISOString()} ${cause instanceof Error ? cause.message : "Forwarding failed"}\n`,
          { mode: 0o600 },
        );
        if (!ready) throw cause;
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
    }
  } catch (cause) {
    process.send?.({
      ready: false,
      message: cause instanceof Error ? cause.message : "Forwarding failed",
    });
    process.exitCode = 255;
  }
}
