import { meshRetryDelay } from "../mesh/Backoff.ts";
import { RunRemoteError } from "./RunRemoteError.ts";
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
    let logQueue = Promise.resolve();
    const appendLog = (text: string) => {
      const file = NodePath.join(root, `${id}.forwarding.log`);
      const bytes = Buffer.from(text);
      const entry = bytes.subarray(Math.max(0, bytes.length - 65536));
      const write = async () => {
        let size = 0;
        try {
          size = (await NodeFSP.stat(file)).size;
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        }
        if (size + entry.length > 65536) await NodeFSP.writeFile(file, entry, { mode: 0o600 });
        else await NodeFSP.appendFile(file, entry, { mode: 0o600 });
      };
      logQueue = logQueue.then(write, write);
      return logQueue;
    };
    const flush = async () => {
      try {
        const flushed = await requestRun("finish", cwd, timeoutMs);
        if (!flushed.ok) await appendLog(`${flushed.message}\n`);
      } catch (cause) {
        await appendLog(`Post-run synchronization failed: ${String(cause)}\n`);
      }
    };
    const clients = new Set<NodeNet.Socket>();
    const address = guardianAddress(plan.primaryRoot, id);
    const server = NodeNet.createServer((socket) => {
      clients.add(socket);
      socket.on("error", (cause) => {
        void appendLog(`${String(cause)}\n`).catch((error) =>
          process.stderr.write(`${String(error)}\n`),
        );
      });
      socket.once("close", () => clients.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
    try {
      let failures = 0;
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
          await flush();
          return;
        } catch (cause) {
          await appendLog(
            `${new Date().toISOString()} ${cause instanceof Error ? cause.message : "Forwarding failed"}\n`,
          );
          if (ready && cause instanceof RunRemoteError && cause.reason === "job_not_found") {
            await flush();
            return;
          }
          if (!ready) throw cause;
          await new Promise<void>((resolve) => setTimeout(resolve, meshRetryDelay(failures++)));
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
