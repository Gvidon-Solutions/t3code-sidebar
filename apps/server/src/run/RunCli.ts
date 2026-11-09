// @effect-diagnostics nodeBuiltinImport:off -- This module is the runtime CLI boundary for child processes and terminal stdio.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import { nativeInvocation } from "../platform/ServerPlatform.ts";
import { awaitForwardingStop } from "./RunGuardianControl.ts";
import { requestRun } from "./RunClient.ts";
import { remoteRun } from "./RunTransport.ts";
import { rewriteRunOutput } from "./RunOutput.ts";
import { MAX_RUN_TIMEOUT_MS, type RemoteRunPlan } from "./RunProtocol.ts";

export function parseRunArgs(args: readonly string[]) {
  let bg = false,
    follow = false,
    list = false;
  let logs: string | undefined, stop: string | undefined, timeoutMs: number | undefined;
  const ports: number[] = [];
  let command: readonly string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      command = args.slice(index + 1);
      break;
    }
    if (!arg.startsWith("-")) {
      command = args.slice(index);
      break;
    }
    if (arg === "--bg") bg = true;
    else if (arg === "--follow") follow = true;
    else if (arg === "--list") list = true;
    else if (arg === "--logs" || arg === "--stop") {
      const id = args[++index];
      if (!id || !/^[a-f0-9-]{36}$/.test(id))
        throw new Error(`${arg} needs a background process id.`);
      if (arg === "--logs") logs = id;
      else stop = id;
    } else if (arg === "--ports") {
      const value = args[++index];
      if (!value || !/^\d+(,\d+)*$/.test(value))
        throw new Error("--ports needs comma-separated port numbers.");
      for (const item of value.split(",")) {
        const port = Number(item);
        if (port < 1 || port > 65535) throw new Error("Ports must be between 1 and 65535.");
        if (!ports.includes(port)) ports.push(port);
      }
    } else if (arg === "--timeout") {
      const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(args[++index] ?? "");
      if (!duration) throw new Error("--timeout needs a duration such as 30s or 5m.");
      const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
      timeoutMs = Number(duration[1]) * units[duration[2] ?? "s"]!;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RUN_TIMEOUT_MS)
        throw new Error(
          "Timeout must be a positive whole number of milliseconds within the runtime timer range.",
        );
    } else throw new Error(`Unknown t3 run option: ${arg}`);
  }
  const management = Number(list) + Number(logs !== undefined) + Number(stop !== undefined);
  if (
    management > 1 ||
    (management && (command.length || bg || ports.length)) ||
    (!management && !command.length) ||
    (follow && !logs)
  )
    throw new Error(
      "Use: t3 run [--bg] [--ports P[,P]] [--timeout D] -- <command…>, or --list / --logs ID [--follow] / --stop ID.",
    );
  return { bg, follow, list, logs, stop, timeoutMs, ports, command };
}
async function localRun(command: readonly string[]) {
  const resolved = nativeInvocation(command[0]!, command.slice(1));
  const child = NodeChildProcess.spawn(resolved.command, resolved.args, {
    shell: resolved.shell,
    stdio: "inherit",
    env: process.env,
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise<number>((resolve) => {
      child.once("error", (cause: NodeJS.ErrnoException) => {
        process.stderr.write(`${cause.message}\n`);
        resolve(cause.code === "ENOENT" ? 127 : 126);
      });
      child.once("close", (code, signal) =>
        resolve(code ?? 128 + (NodeOS.constants.signals[signal ?? "SIGTERM"] ?? 1)),
      );
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
async function startGuardian(
  plan: RemoteRunPlan,
  id: string,
  ports: readonly number[],
  cwd: string,
  timeoutMs: number,
) {
  const invocation = await Effect.runPromise(
    resolveSelfInvocation().pipe(Effect.provide(NodeServices.layer)),
  );
  const child = NodeChildProcess.spawn(
    invocation.command,
    [
      ...selfInvocationArgs(invocation, [
        "__run-guardian",
        Buffer.from(JSON.stringify({ plan, id, ports, cwd, timeoutMs })).toString("base64"),
      ]),
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Port forwarding did not start (${code}).`)));
    child.once("message", (message: unknown) => {
      if (message && typeof message === "object" && "ready" in message && message.ready === true) {
        resolve();
        return;
      }
      const reason =
        message && typeof message === "object" && "message" in message
          ? String(message.message)
          : "Port forwarding failed to become ready.";
      reject(new Error(reason));
    });
  });
  child.disconnect();
  child.unref();
}
const ignoredNotice = (paths: readonly string[], machine: string) => {
  if (paths.length)
    process.stderr.write(
      `${paths.map((path) => (/[\r\n]/.test(path) ? JSON.stringify(path) : path)).join(", ")} stayed on ${machine}\n`,
    );
};
export async function runCli(args: readonly string[]) {
  if (args.includes("--help") && args[0] === "--help") {
    process.stdout.write(
      "t3 run [--bg] [--ports P[,P]] [--timeout D] -- <command…>\nt3 run --list | --logs ID [--follow] | --stop ID\nFlush and execute on a lite replica's primary; run locally elsewhere. Timeout bounds synchronization and remote execution.\n",
    );
    return;
  }
  try {
    const options = parseRunArgs(args);
    const cwd = process.cwd();
    const resolved = await requestRun("resolve", cwd, options.timeoutMs);
    if (!resolved.ok) {
      process.stderr.write(`${resolved.message}\n`);
      process.exitCode = resolved.code;
      return;
    }
    const plan = resolved.plan;
    if (plan.kind === "local") {
      if (options.list || options.logs || options.stop)
        throw new Error("Background management requires a lite replica.");
      process.exitCode = await localRun(options.command);
      return;
    }
    const stdout = rewriteRunOutput(plan.primaryRoot, plan.replicaRoot);
    const stderr = rewriteRunOutput(plan.primaryRoot, plan.replicaRoot);
    const emit = async (frame: Parameters<Parameters<typeof remoteRun>[2]["onFrame"]>[0]) => {
      if (frame.type === "out")
        await new Promise<void>((resolve, reject) =>
          process.stdout.write(stdout.write(Buffer.from(frame.data, "base64")), (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      if (frame.type === "err")
        await new Promise<void>((resolve, reject) =>
          process.stderr.write(stderr.write(Buffer.from(frame.data, "base64")), (error) =>
            error ? reject(error) : resolve(),
          ),
        );
    };
    const probe = await remoteRun(plan, { action: "probe" }, { onFrame: () => undefined });
    if (probe.code !== 0) {
      process.exitCode = probe.code;
      return;
    }
    if (options.list || options.logs || options.stop) {
      const result = await remoteRun(
        plan,
        {
          action: options.list ? "list" : options.logs ? "logs" : "stop",
          ...(options.logs || options.stop ? { id: options.logs ?? options.stop! } : {}),
          follow: options.follow,
        },
        { onFrame: emit },
      );
      process.stdout.write(stdout.end());
      process.stderr.write(stderr.end());
      if (options.stop) await awaitForwardingStop(plan.primaryRoot, options.stop);
      if (options.stop || options.logs) {
        const flushed = await requestRun("finish", cwd, options.timeoutMs);
        if (!flushed.ok) {
          process.stderr.write(`${flushed.message}\n`);
          process.exitCode = flushed.code;
          return;
        }
        ignoredNotice(result.ignored, plan.machine);
      }
      process.exitCode = options.stop ? 0 : result.code;
      return;
    }
    const prepared = await requestRun("prepare", cwd, options.timeoutMs);
    if (!prepared.ok) {
      process.stderr.write(`${prepared.message}\n`);
      process.exitCode = prepared.code;
      return;
    }
    let result: Awaited<ReturnType<typeof remoteRun>> | undefined;
    let remoteFailed = false;
    let remoteFailure: Error | undefined;
    try {
      result = await remoteRun(
        plan,
        {
          action: options.bg ? "start" : "exec",
          args: options.command,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ports: options.ports,
        },
        {
          onFrame: emit,
          ...(options.bg ? {} : { stdin: process.stdin, tty: Boolean(process.stdin.isTTY) }),
        },
      );
      if (options.bg) {
        if (!result.id) throw new Error("The primary did not return a background process id.");
        {
          try {
            await startGuardian(plan, result.id, options.ports, cwd, options.timeoutMs ?? 30000);
          } catch (cause) {
            await remoteRun(plan, { action: "stop", id: result.id }, { onFrame: emit });
            throw cause;
          }
        }
        process.stdout.write(`${result.id}\n`);
      }
    } catch (cause) {
      remoteFailed = true;
      remoteFailure = cause instanceof Error ? cause : new Error(String(cause));
    }
    {
      process.stdout.write(stdout.end());
      process.stderr.write(stderr.end());
      const flushed = options.bg
        ? { ok: true as const }
        : await requestRun("finish", cwd, remoteFailed ? 1000 : options.timeoutMs).catch(
            (cause: unknown) => ({
              ok: false as const,
              code: 75,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          );
      if (!flushed.ok && remoteFailure)
        remoteFailure = new Error(
          `${remoteFailure.message}; post-run synchronization failed: ${flushed.message}`,
          { cause: remoteFailure },
        );
      if (!flushed.ok && !remoteFailure) {
        process.stderr.write(`${flushed.message}\n`);
        process.exitCode = flushed.code;
      }
    }
    if (remoteFailure) throw remoteFailure;
    if (!result) throw new Error("The primary did not return an exit status.");
    ignoredNotice(result.ignored, plan.machine);
    process.exitCode = result.code || process.exitCode || 0;
  } catch (cause) {
    process.stderr.write(
      `${cause instanceof Error ? cause.message.replace(/[\r\n]+/g, " ") : "t3 run failed"}\n`,
    );
    process.exitCode = 255;
  }
}
