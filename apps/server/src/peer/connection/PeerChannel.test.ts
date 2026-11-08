// @effect-diagnostics nodeBuiltinImport:off -- These tests drive the Node byte-stream boundary.
import type * as NodeStream from "node:stream";
import { expect, it, vi } from "vite-plus/test";
import { PeerChannel, preferConnection, reconnectDelay } from "./PeerChannel.ts";

function pair(
  call: (body: unknown, signal: AbortSignal) => Promise<unknown> = async (body) => body,
) {
  let now = 0;
  const leftWire: string[] = [];
  const rightWire: string[] = [];
  const receivedPipes: NodeStream.Duplex[] = [];
  const events: unknown[] = [];
  const closed: Error[] = [];
  const left = new PeerChannel({
    send: (frame) => leftWire.push(frame),
    close: (error) => closed.push(error),
    call,
    event: (name, body) => events.push({ name, body }),
    pipe: (_target, stream) => receivedPipes.push(stream),
    now: () => now,
  });
  const right = new PeerChannel({
    send: (frame) => rightWire.push(frame),
    close: (error) => closed.push(error),
    call,
    event: (name, body) => events.push({ name, body }),
    pipe: (_target, stream) => receivedPipes.push(stream),
    now: () => now,
  });
  const pump = () => {
    while (leftWire.length || rightWire.length) {
      for (const frame of leftWire.splice(0)) right.receive(frame);
      for (const frame of rightWire.splice(0)) left.receive(frame);
    }
  };
  return {
    left,
    right,
    leftWire,
    rightWire,
    receivedPipes,
    events,
    closed,
    pump,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("chooses the same physical socket at both ends, regardless of arrival order", () => {
  for (const [self, peer] of [
    ["studio", "cloudbox"],
    ["cloudbox", "studio"],
  ] as const) {
    expect(preferConnection(self, peer, true)).toBe(preferConnection(peer, self, false));
    expect(preferConnection(self, peer, true)).not.toBe(preferConnection(self, peer, false));
  }
  expect(reconnectDelay(0, 0)).toBe(800);
  expect(reconnectDelay(0, 1)).toBe(1000);
  expect(reconnectDelay(10, 1)).toBe(15_000);
});

it("multiplexes concurrent calls and notifications without bypassing the receiving handler", async () => {
  const handler = vi.fn(async (body: unknown) => body);
  const p = pair(handler);
  const first = p.left.call({ action: "create" }, { key: "receipt" });
  const second = p.left.call({ action: "create" }, { key: "receipt" });
  p.left.event("layout", { seq: 1 });
  p.pump();
  await vi.waitFor(() => expect(p.rightWire.length).toBe(2));
  p.pump();
  expect(await first).toEqual({ action: "create" });
  expect(await second).toEqual({ action: "create" });
  expect(handler).toHaveBeenCalledTimes(2);
  expect(p.events).toEqual([{ name: "layout", body: { seq: 1 } }]);
  p.left.close(new Error("test complete"));
  p.right.close(new Error("test complete"));
});

it("cancels remote work, times out calls and releases timers on disconnect", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const p = pair(async (_body, incoming) => {
    signal = incoming;
    return new Promise(() => {});
  });
  const abort = new AbortController();
  const first = p.left.call({}, { signal: abort.signal });
  const rejected = expect(first).rejects.toThrow("cancelled");
  p.pump();
  await Promise.resolve();
  abort.abort();
  p.pump();
  await rejected;
  expect(signal?.aborted).toBe(true);
  const second = p.left.call({}, { timeoutMs: 20 });
  const timeout = expect(second).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20);
  p.pump();
  await timeout;
  p.left.close(new Error("test complete"));
  p.right.close(new Error("test complete"));
  expect(vi.getTimerCount()).toBe(0);
});

it("detects a peer that stops reading even while it keeps sending unrelated traffic", () => {
  const p = pair();
  expect(p.left.nextTickDelay()).toBe(15_000);
  p.advance(15_000);
  p.left.tick();
  expect(p.left.nextTickDelay()).toBe(30_000);
  expect(JSON.parse(p.leftWire[0]!)).toMatchObject({ type: "ping" });
  p.advance(30_000);
  p.left.receive(JSON.stringify({ type: "event", name: "noise", body: null }));
  expect(p.left.nextTickDelay()).toBe(15_000);
  p.advance(15_000);
  p.left.tick();
  expect(p.closed[0]?.message).toBe("Peer heartbeat timed out");
});

it("keeps healthy idle connections alive and rejects malformed or oversized frames", () => {
  const p = pair();
  for (let i = 0; i < 10; i++) {
    p.advance(15_000);
    p.left.tick();
    p.right.tick();
    p.pump();
  }
  expect(p.closed).toEqual([]);
  p.left.receive('{"type":"credit","id":"unknown","bytes":-1}');
  expect(p.closed).toHaveLength(1);
  p.right.receive("x".repeat(32 * 1024 * 1024 + 1));
  expect(p.closed).toHaveLength(2);
});

it("carries large MCP file and transcript responses without truncation", async () => {
  const body = { text: "transcript".repeat(256 * 1024) };
  const p = pair();
  const answer = p.left.call(body);
  p.pump();
  await vi.waitFor(() => expect(p.rightWire).toHaveLength(1));
  p.pump();
  expect(await answer).toEqual(body);
  p.left.close(new Error("test complete"));
  p.right.close(new Error("test complete"));
});

it("bounds a stalled reader, resumes on consumption and preserves half-close", async () => {
  const p = pair();
  const left = p.left.openPipe("sshd");
  const leftErrors: Error[] = [];
  left.on("error", (error) => leftErrors.push(error));
  p.pump();
  const right = p.receivedPipes[0]!;
  right.on("error", (error) => leftErrors.push(error));
  const payload = Buffer.alloc(1024 * 1024, 47);
  let written = false;
  left.write(payload, () => {
    written = true;
  });
  p.pump();
  expect(written).toBe(false);
  expect(right.readableLength).toBe(256 * 1024);
  const chunks: Buffer[] = [];
  right.on("data", (data: Buffer) => {
    chunks.push(data);
  });
  await vi.waitFor(() => {
    p.pump();
    expect(written).toBe(true);
  });
  const ended = new Promise<void>((resolve) => right.once("end", resolve));
  left.end();
  await vi.waitFor(() => {
    p.pump();
    expect(right.readableEnded).toBe(true);
  });
  await ended;
  expect(Buffer.concat(chunks)).toEqual(payload);
  const reply: Buffer[] = [];
  left.on("data", (data: Buffer) => reply.push(data));
  right.end("still writable");
  await vi.waitFor(() => {
    p.pump();
    expect(left.readableEnded).toBe(true);
  });
  expect(Buffer.concat(reply).toString()).toBe("still writable");
  expect(leftErrors).toEqual([]);
  p.left.close(new Error("test complete"));
  p.right.close(new Error("test complete"));
});

it("isolates interrupted pipes and fails pending work when the connection is lost", async () => {
  const interrupted = pair();
  const pipe = interrupted.left.openPipe("sshd");
  const id = JSON.parse(interrupted.leftWire[0]!).id as string;
  const pipeError = new Promise<Error>((resolve) => pipe.once("error", resolve));
  interrupted.pump();
  const remoteError = new Promise<Error>((resolve) =>
    interrupted.receivedPipes[0]!.once("error", resolve),
  );
  pipe.destroy(new Error("pipe interrupted"));
  interrupted.left.receive(JSON.stringify({ type: "credit", id, bytes: 1 }));
  interrupted.left.receive(JSON.stringify({ type: "data", id, data: "bGF0ZQ==" }));
  interrupted.left.receive(JSON.stringify({ type: "end", id }));
  interrupted.pump();
  expect((await pipeError).message).toBe("pipe interrupted");
  expect((await remoteError).message).toBe("pipe interrupted");
  expect(interrupted.closed).toEqual([]);
  const subsequent = interrupted.left.call({ action: "after interruption" });
  interrupted.pump();
  await vi.waitFor(() => expect(interrupted.rightWire).toHaveLength(1));
  interrupted.pump();
  expect(await subsequent).toEqual({ action: "after interruption" });
  interrupted.left.close(new Error("test complete"));
  interrupted.right.close(new Error("test complete"));

  const p = pair();
  const stream = p.left.openPipe("sshd");
  const errored = new Promise<Error>((resolve) => stream.once("error", resolve));
  const written = new Promise<Error | null | undefined>((resolve) =>
    stream.write(Buffer.alloc(1024 * 1024), resolve),
  );
  const pending = p.left.call({});
  const refused = expect(pending).rejects.toThrow("connection lost");
  p.left.close(new Error("connection lost"));
  expect((await written)?.message).toBe("connection lost");
  expect((await errored).message).toBe("connection lost");
  await refused;
});

it("streams 200 MiB through a credit window without retaining the transfer", async () => {
  let left: PeerChannel;
  let right: PeerChannel;
  let received = 0;
  let receiver: NodeStream.Duplex | undefined;
  const errors: Error[] = [];
  const closed = (error: Error) => errors.push(error);
  const unused = async () => null;
  left = new PeerChannel({
    send: (wire) => queueMicrotask(() => right.receive(wire)),
    close: closed,
    call: unused,
    event: () => {},
    pipe: (_target, stream) => stream.destroy(new Error("Unexpected reverse open")),
    now: () => 0,
  });
  right = new PeerChannel({
    send: (wire) => queueMicrotask(() => left.receive(wire)),
    close: closed,
    call: unused,
    event: () => {},
    pipe: (_target, stream) => {
      receiver = stream;
      stream.on("error", closed);
      stream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        expect(chunk.every((value) => value === 91)).toBe(true);
      });
      stream.on("end", () => stream.end());
    },
    now: () => 0,
  });
  const stream = left.openPipe("sshd");
  stream.on("error", closed);
  stream.resume();
  const finished = new Promise<void>((resolve) => stream.once("end", resolve));
  const chunk = Buffer.alloc(1024 * 1024, 91);
  for (let i = 0; i < 200; i++) {
    await new Promise<void>((resolve, reject) =>
      stream.write(chunk, (error) => (error ? reject(error) : resolve())),
    );
  }
  stream.end();
  await finished;
  expect(received).toBe(200 * 1024 * 1024);
  expect(receiver?.readableLength).toBe(0);
  expect(errors).toEqual([]);
});

it("serves calls while one pipe reader is stalled and rejects forged credit", async () => {
  const p = pair();
  const stream = p.left.openPipe("sshd");
  const errors: Error[] = [];
  stream.on("error", (error) => errors.push(error));
  p.pump();
  p.receivedPipes[0]!.on("error", (error) => errors.push(error));
  const blocked = new Promise<Error | null | undefined>((resolve) =>
    stream.write(Buffer.alloc(1024 * 1024), resolve),
  );
  const call = p.left.call({ probe: true });
  const opening = JSON.parse(p.leftWire[0]!) as { id: string };
  p.pump();
  await vi.waitFor(() => expect(p.rightWire.length).toBe(1));
  p.pump();
  expect(await call).toEqual({ probe: true });
  p.left.receive(JSON.stringify({ type: "credit", id: opening.id, bytes: 256 * 1024 + 1 }));
  expect((await blocked)?.message).toBe("Invalid peer pipe credit");
  p.right.close(new Error("test complete"));
});

it("fails pending requests when frame enqueueing throws", async () => {
  const closed: Error[] = [];
  const channel = new PeerChannel({
    send: () => {
      throw new Error("Socket output queue full");
    },
    close: (reason) => closed.push(reason),
    call: async () => null,
    event: () => {},
    pipe: (_target, stream) => stream.destroy(new Error("Unexpected pipe")),
    now: () => 0,
  });
  await expect(channel.call({ probe: true })).rejects.toThrow("Socket output queue full");
  expect(closed[0]?.message).toBe("Socket output queue full");
  await expect(channel.call({ probe: true })).rejects.toThrow("Peer connection is closed");
});
