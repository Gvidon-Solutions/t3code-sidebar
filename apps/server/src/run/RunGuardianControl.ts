// @effect-diagnostics nodeBuiltinImport:off -- A private control socket lets --stop wait until its local forwarding process has released its listeners.
import * as NodeNet from "node:net";
import { guardianAddress } from "../platform/ServerPlatform.ts";
export async function awaitForwardingStop(root: string, id: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = NodeNet.connect(guardianAddress(root, id));
    socket.setTimeout(35000, () =>
      socket.destroy(new Error("Local port forwarding did not stop.")),
    );
    socket.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ECONNREFUSED") resolve();
      else reject(cause);
    });
    socket.on("data", () => undefined);
    socket.once("end", resolve);
  });
}
