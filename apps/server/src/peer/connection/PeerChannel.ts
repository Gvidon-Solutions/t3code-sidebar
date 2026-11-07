import { meshMillis } from "../../mesh/MeshTiming.ts";
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This wire adapter exposes Node Duplex streams and owns cancellable JavaScript request deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";
import * as Schema from "effect/Schema";

const id = Schema.String;
const Frame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("call"), id, key: id, body: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("result"), id, body: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("error"), id, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cancel"), id }),
  Schema.Struct({ type: Schema.Literal("event"), name: id, body: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literals(["ping", "pong"]), nonce: id }),
  Schema.Struct({ type: Schema.Literal("open"), id, target: id }),
  Schema.Struct({ type: Schema.Literal("data"), id, data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("credit"), id, bytes: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("end"), id }),
  Schema.Struct({ type: Schema.Literal("reset"), id, message: Schema.optionalKey(Schema.String) }),
]);
type Frame = typeof Frame.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));
const WINDOW = 256 * 1024;
const CHUNK = 32 * 1024;
const MAX_FRAME = 32 * 1024 * 1024;

/** Lower environment id's dial wins; the other side can still dial when it alone has a route. */
export const preferConnection = (self: string, peer: string, outbound: boolean) =>
  outbound === self < peer;

export const reconnectDelay = (attempt: number, random: number) =>
  meshMillis(Math.min(15_000, 1000 * 2 ** Math.min(4, Math.max(0, attempt)))) *
  (0.8 + Math.min(1, Math.max(0, random)) * 0.2);

interface PipeState {
  readonly stream: NodeStream.Duplex;
  credit: number;
  received: number;
  pending: { bytes: Buffer; done: (error?: Error | null) => void } | undefined;
  localEnded: boolean;
  remoteEnded: boolean;
}

/** One bounded, multiplexed session. The adapter owns authentication, timers and WebSocket I/O. */
export class PeerChannel {
  private readonly pending = new Map<
    string,
    { resolve: (body: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly running = new Map<string, AbortController>();
  private readonly pipes = new Map<string, PipeState>();
  private closed = false;
  private lastReceived: number;
  private lastPing: number;
  private ping: string | undefined;

  private readonly options: {
    readonly send: (frame: string) => void;
    readonly close: (reason: Error) => void;
    readonly call: (body: unknown, signal: AbortSignal) => Promise<unknown>;
    readonly event: (name: string, body: unknown) => void;
    readonly pipe: (target: string, stream: NodeStream.Duplex) => void;
    readonly now: () => number;
  };

  constructor(options: PeerChannel["options"]) {
    this.options = options;
    this.lastReceived = options.now();
    this.lastPing = this.lastReceived;
  }

  private send(frame: Frame) {
    if (this.closed) throw new Error("Peer connection is closed");
    const wire = JSON.stringify(frame);
    if (Buffer.byteLength(wire) > MAX_FRAME) throw new Error("Peer frame exceeds limit");
    try {
      this.options.send(wire);
    } catch (error) {
      const reason = error instanceof Error ? error : new Error("Peer frame delivery failed");
      this.close(reason);
      throw reason;
    }
  }

  private trySend(frame: Frame) {
    try {
      this.send(frame);
      return true;
    } catch (error) {
      this.close(error instanceof Error ? error : new Error("Peer frame delivery failed"));
      return false;
    }
  }

  call(body: unknown, options: { key?: string; signal?: AbortSignal; timeoutMs?: number } = {}) {
    if (this.pending.size >= 128) return Promise.reject(new Error("Peer call limit exceeded"));
    const callId = NodeCrypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        cleanup();
        this.pending.delete(callId);
        if (!this.closed) this.trySend({ type: "cancel", id: callId });
        reject(new Error("Peer call cancelled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        this.pending.delete(callId);
        if (!this.closed) this.trySend({ type: "cancel", id: callId });
        reject(new Error("Peer call timed out"));
      }, options.timeoutMs ?? 60_000);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      this.pending.set(callId, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        cleanup();
        abort();
        return;
      }
      try {
        this.send({ type: "call", id: callId, key: options.key ?? callId, body });
      } catch (error) {
        this.pending.delete(callId);
        cleanup();
        reject(error);
      }
    });
  }

  event(name: string, body: unknown) {
    this.send({ type: "event", name, body });
  }

  openPipe(target: string) {
    const pipeId = NodeCrypto.randomUUID();
    const stream = this.makePipe(pipeId);
    this.send({ type: "open", id: pipeId, target });
    return stream;
  }

  private flush(state: PipeState, pipeId: string) {
    const pending = state.pending;
    if (!pending) return;
    while (state.credit > 0 && pending.bytes.length > 0) {
      const bytes = pending.bytes.subarray(0, Math.min(CHUNK, state.credit));
      pending.bytes = pending.bytes.subarray(bytes.length);
      state.credit -= bytes.length;
      if (!this.trySend({ type: "data", id: pipeId, data: bytes.toString("base64") })) return;
    }
    if (pending.bytes.length === 0) {
      state.pending = undefined;
      pending.done();
    }
  }

  private makePipe(pipeId: string) {
    if (this.pipes.has(pipeId) || this.pipes.size >= 128)
      throw new Error("Peer pipe limit exceeded");
    const channel = this;
    const state: PipeState = {
      credit: WINDOW,
      received: 0,
      pending: undefined,
      localEnded: false,
      remoteEnded: false,
      stream: new NodeStream.Duplex({
        allowHalfOpen: true,
        highWaterMark: CHUNK,
        read() {
          if (state.received > 0 && !channel.closed) {
            const bytes = state.received;
            state.received = 0;
            channel.trySend({ type: "credit", id: pipeId, bytes });
          }
        },
        write(chunk: Buffer, _encoding, done) {
          state.pending = { bytes: chunk, done };
          channel.flush(state, pipeId);
        },
        final(done) {
          state.localEnded = true;
          channel.trySend({ type: "end", id: pipeId });
          done();
        },
        destroy(error, done) {
          channel.pipes.delete(pipeId);
          if (!channel.closed && !(state.localEnded && state.remoteEnded))
            channel.trySend({
              type: "reset",
              id: pipeId,
              ...(error ? { message: error.message.slice(0, 512) } : {}),
            });
          state.pending?.done(error ?? new Error("Peer pipe closed"));
          state.pending = undefined;
          done(error);
        },
      }),
    };
    this.pipes.set(pipeId, state);
    return state.stream;
  }

  /** Returns after dispatch, so responses remain readable while a long call or pipe is blocked. */
  receive(wire: string) {
    if (this.closed) return;
    try {
      if (Buffer.byteLength(wire) > MAX_FRAME) throw new Error("Peer frame exceeds limit");
      const frame = decode(wire);
      this.lastReceived = this.options.now();
      switch (frame.type) {
        case "ping":
          this.send({ type: "pong", nonce: frame.nonce });
          break;
        case "pong":
          if (frame.nonce === this.ping) this.ping = undefined;
          break;
        case "result":
          this.pending.get(frame.id)?.resolve(frame.body);
          this.pending.delete(frame.id);
          break;
        case "error":
          this.pending.get(frame.id)?.reject(new Error(frame.message));
          this.pending.delete(frame.id);
          break;
        case "cancel":
          this.running.get(frame.id)?.abort();
          break;
        case "event":
          this.options.event(frame.name, frame.body);
          break;
        case "call":
          this.dispatch(frame);
          break;
        case "open":
          this.options.pipe(frame.target, this.makePipe(frame.id));
          break;
        case "reset":
          this.pipes.get(frame.id)?.stream.destroy(new Error(frame.message ?? "Peer reset pipe"));
          break;
        case "end": {
          const pipe = this.pipes.get(frame.id);
          // Reset can race with frames already in flight on the connection.
          if (!pipe) break;
          if (pipe.remoteEnded) throw new Error("Invalid peer pipe end");
          pipe.remoteEnded = true;
          pipe.stream.push(null);
          break;
        }
        case "credit": {
          const pipe = this.pipes.get(frame.id);
          if (frame.bytes <= 0 || frame.bytes > WINDOW) throw new Error("Invalid peer pipe credit");
          if (!pipe) break;
          if (pipe.credit + frame.bytes > WINDOW) throw new Error("Invalid peer pipe credit");
          pipe.credit += frame.bytes;
          this.flush(pipe, frame.id);
          break;
        }
        case "data": {
          const pipe = this.pipes.get(frame.id);
          const data = Buffer.from(frame.data, "base64");
          if (data.length === 0 || data.length > CHUNK || data.toString("base64") !== frame.data)
            throw new Error("Invalid peer pipe data");
          if (!pipe) break;
          if (pipe.remoteEnded || pipe.received + data.length > WINDOW)
            throw new Error("Invalid peer pipe data");
          pipe.received += data.length;
          pipe.stream.push(data);
          break;
        }
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error("Invalid peer frame"));
    }
  }

  private dispatch(frame: Extract<Frame, { type: "call" }>) {
    if (this.running.has(frame.id)) {
      this.close(new Error("Duplicate active peer request id"));
      return;
    }
    if (this.running.size >= 128) {
      this.send({ type: "error", id: frame.id, message: "Peer call limit exceeded" });
      return;
    }
    const controller = new AbortController();
    this.running.set(frame.id, controller);
    const result = Promise.resolve().then(() => this.options.call(frame.body, controller.signal));
    void result
      .then(
        (value) => {
          if (!this.closed) this.send({ type: "result", id: frame.id, body: value });
        },
        (error: unknown) => {
          if (!this.closed)
            this.send({
              type: "error",
              id: frame.id,
              message: error instanceof Error ? error.message : "Peer call failed",
            });
        },
      )
      .catch((error: unknown) => {
        this.close(error instanceof Error ? error : new Error("Peer response delivery failed"));
      })
      .finally(() => {
        this.running.delete(frame.id);
      });
  }

  tick() {
    const now = this.options.now();
    if (
      now - this.lastReceived >= meshMillis(45_000) ||
      (this.ping !== undefined && now - this.lastPing >= meshMillis(45_000))
    ) {
      this.close(new Error("Peer heartbeat timed out"));
    } else if (now - this.lastPing >= meshMillis(15_000) && this.ping === undefined) {
      this.ping = NodeCrypto.randomUUID();
      this.lastPing = now;
      this.trySend({ type: "ping", nonce: this.ping });
    }
  }

  close(reason: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    for (const pipe of this.pipes.values()) pipe.stream.destroy(reason);
    this.pipes.clear();
    this.options.close(reason);
  }
}
