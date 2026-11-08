// @effect-diagnostics nodeBuiltinImport:off -- Exercises byte framing against private loopback sockets.
import * as NodeNet from "node:net";
import { expect, it, vi } from "vite-plus/test";
import { readLine } from "./readLine.ts";

async function pair() {
  const server = NodeNet.createServer();
  const accepted = new Promise<NodeNet.Socket>((resolve, reject) => {
    server.once("connection", resolve);
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No TCP address");
  const client = NodeNet.connect(address.port, "127.0.0.1");
  const connected = new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const peer = await accepted;
  await connected;
  return {
    client,
    peer,
    async [Symbol.asyncDispose]() {
      client.destroy();
      peer.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
it("preserves split UTF-8 and returns trailing binary bytes to the socket", async () => {
  await using sockets = await pair();
  const pending = readLine(sockets.client, { maxBytes: 4, timeoutMs: 1000 });
  sockets.peer.write(Buffer.from([0xc3]));
  sockets.peer.end(Buffer.from([0xa9, 10, 0, 255]));
  expect(await pending).toBe("é");
  const tail: Buffer[] = [];
  for await (const chunk of sockets.client) tail.push(chunk);
  expect(Buffer.concat(tail)).toEqual(Buffer.from([0, 255]));
});
it("bounds bytes before decoding and distinguishes EOF acknowledgements", async () => {
  await using sockets = await pair();
  const pending = readLine(sockets.client, { maxBytes: 1, timeoutMs: 1000 });
  sockets.peer.end("é\n");
  await expect(pending).rejects.toThrow("byte limit");
  await using ack = await pair();
  const stopped = readLine(ack.client, { maxBytes: 0, timeoutMs: 1000, allowEnd: true });
  ack.peer.end();
  expect(await stopped).toBe("");
});
it("rejects an incomplete handshake at its configured deadline", async () => {
  await using sockets = await pair();
  vi.useFakeTimers();
  try {
    const pending = readLine(sockets.client, { maxBytes: 20, timeoutMs: 1000 });
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});
