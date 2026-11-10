import { RunRemoteError } from "./RunRemoteError.ts";
// @effect-diagnostics nodeBuiltinImport:off -- SSH processes and their stdio are the CLI transport boundary.
// @effect-diagnostics globalTimers:off -- SSH heartbeat timers are scoped to the captured child and cleared on close.
import { resolveSshHost } from "@t3tools/shared/meshConfig/sshHost";
import * as NodeChildProcess from "node:child_process";
import * as NodeStringDecoder from "node:string_decoder";
import type { RemoteRunPlan, WorkerFrame } from "./RunProtocol.ts";
import { decodeFrame, FRAME_PREFIX } from "./RunProtocol.ts";
import {
  loginCommand,
  namespaceOf,
  nativeInvocation,
  sshOptions,
} from "../platform/ServerPlatform.ts";
import { RUN_WORKER_SOURCE } from "./RunWorker.ts";

export interface RemoteRequest {
  readonly action: "probe" | "exec" | "start" | "list" | "logs" | "stop" | "wait";
  readonly args?: readonly string[];
  readonly id?: string;
  readonly follow?: boolean;
  readonly ports?: readonly number[];
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly retentionMs?: number;
  readonly logBytes?: number;
}
const sshArguments = (plan: RemoteRunPlan, request: RemoteRequest, tty: boolean) => {
  const payload = Buffer.from(
    JSON.stringify({
      ...request,
      killGraceMs: request.killGraceMs ?? process.env.T3CODE_RUN_KILL_GRACE_MS,
      retentionMs: request.retentionMs ?? process.env.T3CODE_RUN_RETENTION_MS,
      logBytes: request.logBytes ?? process.env.T3CODE_RUN_LOG_BYTES,
      tty,
      cols: process.stdout.columns,
      rows: process.stdout.rows,
      runtimeInvocation: plan.runtime,
      ptyModule: plan.runtime?.ptyModule,
      cwd: plan.cwd,
      root: plan.primaryRoot,
      ignores: plan.ignores,
      namespace: namespaceOf(plan.primaryRoot),
    }),
  ).toString("base64");
  return [
    ...sshOptions({
      configPath: process.env.T3CODE_RUN_SSH_CONFIG,
      connectTimeoutSeconds: 15,
      aliveCount: 3,
      connectionAttempts: 1,
      exitOnForwardFailure: true,
    }),
    ...(tty ? ["-tt"] : ["-T"]),
    ...(request.action === "start" ? [] : (request.ports ?? [])).flatMap((port) => [
      "-L",
      `127.0.0.1:${port}:127.0.0.1:${port}`,
    ]),
    "--",
    resolveSshHost(plan.host),
    loginCommand(RUN_WORKER_SOURCE, payload, plan.platform, tty, plan.runtime),
  ];
};
export async function remoteRun(
  plan: RemoteRunPlan,
  request: RemoteRequest,
  options: {
    readonly stdin?: NodeJS.ReadStream;
    readonly onFrame: (frame: WorkerFrame) => void | Promise<void>;
    readonly signal?: AbortSignal;
    readonly tty?: boolean;
  },
): Promise<{ code: number; ignored: readonly string[]; id?: string }> {
  const resolved = nativeInvocation("ssh", sshArguments(plan, request, options.tty ?? false));
  const child = NodeChildProcess.spawn(resolved.command, resolved.args, {
    shell: resolved.shell,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let done: { code: number; ignored: readonly string[] } | undefined;
  let id: string | undefined;
  const ignored: string[] = [];
  let reason = "";
  let fatal = false;
  let remoteReason: "job_not_found" | undefined;
  let protocolError: Error | undefined;
  let forcedClose = false;
  let closeDeadline: ReturnType<typeof setTimeout> | undefined;
  let consuming = false;
  // A ProxyCommand descendant can retain stdio after SSH exits; drain output before closing it.
  const closeIdlePipes = () => {
    closeDeadline = setTimeout(() => {
      if (consuming || child.stdout.readableLength > 0) {
        closeIdlePipes();
        return;
      }
      forcedClose = true;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }, 1000);
    closeDeadline.unref();
  };
  child.once("exit", closeIdlePipes);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let ready = request.action !== "exec";
  const pendingControls: object[] = [];
  const control = (value: object) => {
    if (!ready) {
      pendingControls.push(value);
      return;
    }
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const input = options.stdin;
  const raw = input?.isRaw ?? false;
  if (options.tty && input?.isTTY) input.setRawMode(true);
  const data = (chunk: Buffer) => control({ type: "data", data: chunk.toString("base64") });
  const end = () => control({ type: "end" });
  let cancelled: number | undefined;
  const interrupt = () => {
    if (request.action === "exec") control({ type: "signal", signal: "SIGINT" });
    else {
      cancelled = 130;
      child.kill("SIGTERM");
    }
  };
  const terminate = () => {
    if (request.action === "exec") control({ type: "signal", signal: "SIGTERM" });
    else {
      cancelled = 143;
      child.kill("SIGTERM");
    }
  };
  const abort = () => {
    terminate();
    child.kill("SIGTERM");
  };
  const consumeLine = async (line: string) => {
    const marker = line.indexOf(FRAME_PREFIX);
    if (marker < 0) {
      await options.onFrame({ type: "out", data: Buffer.from(line + "\n").toString("base64") });
      return;
    }
    if (marker > 0)
      await options.onFrame({
        type: "out",
        data: Buffer.from(line.slice(0, marker)).toString("base64"),
      });
    const frame = decodeFrame(line.slice(marker));
    if (frame.type === "ignored") ignored.push(...frame.paths);
    if (frame.type === "done") done = { code: frame.code, ignored: [...ignored, ...frame.ignored] };
    if (frame.type === "ready") {
      if (frame.id) id = frame.id;
      if (!ready) {
        ready = true;
        for (const value of pendingControls) control(value);
        if (input) {
          input.on("data", data);
          input.once("end", end);
          if (input.readableEnded) end();
        } else end();
        heartbeat = setInterval(() => control({ type: "beat" }), 1000);
        control({ type: "beat" });
      }
    }
    if (frame.type === "error") {
      reason = frame.message;
      remoteReason =
        frame.reason ??
        (request.id &&
        /ENOENT/.test(frame.message) &&
        (frame.message.includes(`${request.id}.json`) ||
          frame.message.includes(`${request.id}.sock`))
          ? "job_not_found"
          : undefined);
      fatal = true;
    }
    await options.onFrame(frame);
  };
  const reading = (async () => {
    const decoder = new NodeStringDecoder.StringDecoder("utf8");
    let pending = "";
    try {
      for await (const chunk of child.stdout) {
        pending += decoder.write(chunk);
        let boundary: number;
        while ((boundary = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + 1);
          consuming = true;
          try {
            await consumeLine(line);
          } finally {
            consuming = false;
          }
        }
        if (pending.length > 1024 * 1024) throw new Error("Run frame exceeds its size limit.");
      }
      pending += decoder.end();
      if (pending) await consumeLine(pending);
    } catch (cause) {
      if (!forcedClose)
        protocolError = new Error("The primary returned an invalid run frame.", { cause });
      child.kill("SIGTERM");
    }
  })();
  child.stderr.on("data", (chunk: Buffer) => {
    reason = (reason + chunk.toString()).slice(-4096);
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
      protocolError = error;
      child.kill("SIGTERM");
    }
  });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const status = await closed;
    await reading;
    if (cancelled !== undefined) return { code: cancelled, ignored: [] };
    if (protocolError) throw protocolError;
    if (status !== 0 || !done || fatal) {
      const detail =
        reason.trim().split(/\r?\n/).at(-1) ||
        `SSH closed without a command result (status ${status ?? "signal"})`;
      throw new RunRemoteError({
        detail: `Cannot run on ${plan.machine}: ${detail}`,
        ...(remoteReason ? { reason: remoteReason } : {}),
      });
    }
    return { ...done, ...(id ? { id } : {}) };
  } finally {
    clearTimeout(closeDeadline);
    clearInterval(heartbeat);
    if (options.tty && input?.isTTY) input.setRawMode(raw);
    input?.removeListener("data", data);
    input?.removeListener("end", end);
    if (input?.listenerCount("data") === 0) input.pause();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    options.signal?.removeEventListener("abort", abort);
    child.stdin.end();
    child.stdout.destroy();
  }
}
