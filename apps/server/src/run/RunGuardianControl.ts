import { readLine } from "../platform/readLine.ts";
// @effect-diagnostics nodeBuiltinImport:off -- A private control socket lets --stop wait until its local forwarding process has released its listeners.
import * as NodeNet from "node:net";
import { guardianAddress } from "../platform/ServerPlatform.ts";
export async function awaitForwardingStop(root: string, id: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = NodeNet.connect(guardianAddress(root, id));
    socket.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ECONNREFUSED") resolve();
      else reject(cause);
    });
    void readLine(socket, { maxBytes: 1024, timeoutMs: 35000, allowEnd: true }).then(
      () => resolve(),
      reject,
    );
  });
}
