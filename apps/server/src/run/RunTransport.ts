// @effect-diagnostics nodeBuiltinImport:off -- SSH processes and their stdio are the CLI transport boundary.
// @effect-diagnostics globalTimers:off -- SSH heartbeat timers are scoped to the captured child and cleared on close.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import type { RemoteRunPlan, WorkerFrame } from "./RunProtocol.ts";
import { decodeFrame } from "./RunProtocol.ts";
import { loginCommand, namespaceOf } from "./RunPlatform.ts";
import { RUN_WORKER_SOURCE } from "./RunWorker.ts";

export interface RemoteRequest {
  readonly action: "probe" | "exec" | "start" | "list" | "logs" | "stop" | "wait";
  readonly args?: readonly string[];
  readonly id?: string;
  readonly follow?: boolean;
  readonly ports?: readonly number[];
  readonly timeoutMs?: number;
}
export const sshArguments = (plan: RemoteRunPlan, request: RemoteRequest, tty: boolean) => {
  const payload = Buffer.from(
    JSON.stringify({
      ...request,
      cwd: plan.cwd,
      root: plan.primaryRoot,
      ignores: plan.ignores,
      namespace: namespaceOf(plan.primaryRoot),
    }),
  ).toString("base64");
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=3",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=1",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    ...(process.env.T3CODE_RUN_SSH_CONFIG ? ["-F", process.env.T3CODE_RUN_SSH_CONFIG] : []),
    ...(tty ? ["-tt"] : ["-T"]),
    ...(request.ports ?? []).flatMap((port) => ["-L", `127.0.0.1:${port}:127.0.0.1:${port}`]),
    plan.host,
    loginCommand(RUN_WORKER_SOURCE, payload, plan.platform, tty),
  ];
};
export async function remoteRun(
  plan: RemoteRunPlan,
  request: RemoteRequest,
  options: {
    readonly stdin?: NodeJS.ReadStream;
    readonly onFrame: (frame: WorkerFrame) => void;
    readonly signal?: AbortSignal;
    readonly tty?: boolean;
  },
): Promise<{ code: number; ignored: readonly string[]; id?: string }> {
  const child = NodeChildProcess.spawn("ssh", sshArguments(plan, request, options.tty ?? false), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let done: { code: number; ignored: readonly string[] } | undefined;
  let id: string | undefined;
  let reason = "";
  let fatal = false;
  let protocolError: Error | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const control = (value: object) => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const input = options.stdin;
  const data = (chunk: Buffer) => control({ type: "data", data: chunk.toString("base64") });
  const end = () => control({ type: "end" });
  const interrupt = () => control({ type: "signal", signal: "SIGINT" });
  const terminate = () => control({ type: "signal", signal: "SIGTERM" });
  const abort = () => {
    terminate();
    child.kill("SIGTERM");
  };
  const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    try {
      const frame = decodeFrame(line);
      if (frame.type === "done") done = { code: frame.code, ignored: frame.ignored };
      if (frame.type === "ready") id = frame.id;
      if (frame.type === "error") {
        reason = frame.message;
        fatal = true;
      }
      options.onFrame(frame);
    } catch (cause) {
      protocolError = cause instanceof Error ? cause : new Error("Invalid primary response");
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    reason = (reason + chunk.toString()).slice(-4096);
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
      protocolError = error;
      child.kill("SIGTERM");
    }
  });
  if (request.action === "exec") {
    heartbeat = setInterval(() => control({ type: "beat" }), 1000);
    control({ type: "beat" });
    if (input) {
      input.on("data", data);
      input.once("end", end);
      if (input.readableEnded) end();
    } else end();
  }
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (protocolError) throw protocolError;
    if (status !== 0 || !done || fatal) {
      const detail =
        reason.trim().split(/\r?\n/).at(-1) ||
        `SSH closed without a command result (status ${status ?? "signal"})`;
      throw new Error(`Cannot run on ${plan.machine}: ${detail}`);
    }
    return { ...done, ...(id ? { id } : {}) };
  } finally {
    clearInterval(heartbeat);
    input?.removeListener("data", data);
    input?.removeListener("end", end);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    options.signal?.removeEventListener("abort", abort);
    child.stdin.end();
    lines.close();
  }
}
