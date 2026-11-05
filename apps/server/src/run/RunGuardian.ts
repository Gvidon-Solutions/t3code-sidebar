// @effect-diagnostics globalDate:off -- Standalone guardian diagnostics use the native clock without an Effect runtime.
// @effect-diagnostics nodeBuiltinImport:off -- The detached forwarding guardian writes its own diagnostic log outside synchronized files.
// @effect-diagnostics globalTimers:off -- Reconnect backoff belongs to the lifetime of this standalone guardian process.
import * as NodeNet from "node:net";
import { guardianAddress } from "../platform/ServerPlatform.ts";
import { requestRun } from "./RunClient.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { RunPlan } from "./RunProtocol.ts";
import { remoteRun } from "./RunTransport.ts";
import { namespaceOf, privateDirectory, workerStateRoot } from "../platform/ServerPlatform.ts";
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      plan: RunPlan,
      cwd: Schema.String,
      timeoutMs: Schema.Number,
      id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
      ports: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    }),
  ),
);
export async function runGuardian(payload: string) {
  let ready = false;
  try {
    const { plan, id, ports, cwd, timeoutMs } = decode(Buffer.from(payload, "base64").toString());
    if (plan.kind !== "remote") throw new Error("A forwarding guardian requires a primary.");
    const root = workerStateRoot(namespaceOf(plan.primaryRoot));
    await privateDirectory(root);
    const clients = new Set<NodeNet.Socket>();
    const address = guardianAddress(plan.primaryRoot, id);
    const server = NodeNet.createServer((socket) => {
      clients.add(socket);
      socket.on("error", (cause) => {
        void NodeFSP.appendFile(
          NodePath.join(root, `${id}.forwarding.log`),
          `${String(cause)}\n`,
        ).catch((error) => process.stderr.write(`${String(error)}\n`));
      });
      socket.once("close", () => clients.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
    try {
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
          try {
            const flushed = await requestRun("finish", cwd, timeoutMs);
            if (!flushed.ok)
              await NodeFSP.appendFile(
                NodePath.join(root, `${id}.forwarding.log`),
                `${flushed.message}\n`,
                { mode: 0o600 },
              );
          } catch (cause) {
            await NodeFSP.appendFile(
              NodePath.join(root, `${id}.forwarding.log`),
              `Post-run synchronization failed: ${String(cause)}\n`,
              { mode: 0o600 },
            );
          }
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
    } finally {
      for (const socket of clients) socket.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } catch (cause) {
    if (process.connected)
      process.send?.({
        ready: false,
        message: cause instanceof Error ? cause.message : "Forwarding failed",
      });
    process.exitCode = 255;
  }
}
