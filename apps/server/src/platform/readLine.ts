// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Local IPC owns a bounded socket handshake and returns trailing bytes to the stream.
import type * as NodeNet from "node:net";

export function readLine(
  socket: NodeNet.Socket,
  options: { readonly maxBytes: number; readonly timeoutMs: number; readonly allowEnd?: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const clean = () => {
      clearTimeout(timer);
      socket.removeListener("data", receive);
      socket.removeListener("end", ended);
      socket.removeListener("close", closed);
      socket.removeListener("error", fail);
    };
    const fail = (error: Error) => {
      clean();
      socket.destroy();
      reject(error);
    };
    const closed = () => fail(new Error("Socket closed before a line was received"));
    const ended = () => {
      if (!options.allowEnd) return closed();
      clean();
      resolve(buffer.toString("utf8"));
    };
    const receive = (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const end = buffer.indexOf(10);
      if ((end < 0 ? buffer.length : end) > options.maxBytes)
        return fail(new Error("Socket line exceeds its byte limit"));
      if (end < 0) return;
      socket.pause();
      clean();
      if (buffer.length > end + 1) socket.unshift(buffer.subarray(end + 1));
      resolve(buffer.subarray(0, end).toString("utf8"));
    };
    const timer = setTimeout(() => fail(new Error("Socket line timed out")), options.timeoutMs);
    socket.on("data", receive);
    socket.once("end", ended);
    socket.once("close", closed);
    socket.once("error", fail);
  });
}
