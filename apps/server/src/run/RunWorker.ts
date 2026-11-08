/* oxlint-disable t3code/no-global-process-runtime -- This standalone worker owns native process groups and is also serialized for older remote runtimes. */
import { readLine } from "../platform/readLine.ts";
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The remote supervisor owns native process groups, private sockets and bounded journals.
import { workerPlatform, nativeInvocation } from "../platform/ServerPlatform.ts";
import { workerPolicy } from "./RunWorkerPolicy.ts";
import type * as NodeEvents from "node:events";
import type * as NodeStream from "node:stream";
type Frame = { readonly type: string; readonly data?: string; readonly [key: string]: unknown };
type RunError = Error & { runReason?: string };
type WorkerChild = NodeEvents.EventEmitter & {
  pid?: number | undefined;
  stdin: NodeStream.Writable;
  stdout: NodeStream.Readable;
  stderr: NodeStream.Readable;
};
interface WorkerConfig {
  action: string;
  args: string[];
  cwd: string;
  root: string;
  namespace: string;
  id: string;
  ignores?: string[];
  tty?: boolean;
  ptyModule?: string;
  rows?: number;
  cols?: number;
  ports?: number[];
  timeoutMs?: number;
  follow?: boolean;
  killGraceMs?: unknown;
  retentionMs?: unknown;
  logBytes?: unknown;
  runtimeInvocation?: { command: string; entrypoint?: string };
}
interface JobRecord {
  id: string;
  name: string | undefined;
  cwd: string;
  ports: number[];
  startedAt: string;
  status: string;
  code?: number;
  ignored?: string[];
  lastError?: string;
}

export function runWorkerMain(
  require: NodeRequire,
  payload: string,
  resolveInvocation: typeof nativeInvocation,
  platform: typeof workerPlatform,
  policy: typeof workerPolicy,
  readSocketLine: typeof readLine,
) {
  const fs = require("node:fs") as typeof import("node:fs");
  const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  const net = require("node:net") as typeof import("node:net");
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const readline = require("node:readline") as typeof import("node:readline");
  const nativeSpawn = (require("node:child_process") as typeof import("node:child_process")).spawn;

  const spawn = (
    command: string,
    args: readonly string[],
    options: import("node:child_process").SpawnOptions,
  ) => {
    const resolved = resolveInvocation(command, args);
    return nativeSpawn(resolved.command, resolved.args, { ...options, shell: resolved.shell });
  };
  const c = JSON.parse(Buffer.from(payload, "base64").toString()) as WorkerConfig;
  c.args ??= [];
  c.id ??= "";

  if (c.tty && process.stdin.isTTY) process.stdin.setRawMode(true);
  const { root, address, privateStat, protectSocket, groupAlive, signalGroup } = platform(
    require,
    c.namespace,
    spawn,
  );
  const { killGraceMs, jobRetentionMs, jobLogBytes } = policy();
  let stopGraceMs: number, retentionMs: number, logBytes: number;
  const record = (id: string) => path.join(root, id + ".json");
  const journal = (id: string) => path.join(root, id + ".ndjson");
  const validId = (id: unknown) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
  const frame = (value: Frame) =>
    process.stdout.write(String.fromCharCode(30) + "T3RUN " + JSON.stringify(value) + "\n");
  async function completion(
    code: number,
    paths: readonly string[],
    emit: (value: Frame) => boolean | void = frame,
  ) {
    async function send(value: Frame) {
      if (emit(value) === false) await require("node:events").once(process.stdout, "drain");
    }
    if (Buffer.byteLength(JSON.stringify(paths)) <= 32768) {
      await send({ type: "done", code, ignored: paths });
      return;
    }
    let chunk: string[] = [],
      size = 0;
    for (const file of paths) {
      const bytes = Buffer.byteLength(JSON.stringify(file)) + 1;
      if (chunk.length && size + bytes > 32768) {
        await send({ type: "ignored", paths: chunk });
        chunk = [];
        size = 0;
      }
      chunk.push(file);
      size += bytes;
    }
    if (chunk.length) await send({ type: "ignored", paths: chunk });
    await send({ type: "done", code, ignored: [] });
  }
  const atomic = async (file: string, value: unknown) => {
    const temp = file + "." + crypto.randomUUID();
    await fsp.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fsp.rename(temp, file);
  };
  const state = async (id: string) => {
    try {
      return JSON.parse(await fsp.readFile(record(id), "utf8")) as JobRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        (error as RunError).runReason = "job_not_found";
      throw error;
    }
  };
  async function prepareRoot() {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    const s = await fsp.lstat(root);
    if (!privateStat(s)) throw Error("Run state directory is not private");
    const cutoff = Date.now() - retentionMs;
    for (const name of await fsp.readdir(root)) {
      const match = /^([a-f0-9-]{36})[.](json|ndjson)(?:[.]([a-f0-9-]{36}))?$/.exec(name);
      if (!match) continue;
      const file = path.join(root, name);
      let info;
      try {
        info = await fsp.stat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
      if (match[3]) {
        if (info.mtimeMs < Date.now() - Math.max(retentionMs, 86400000))
          await fsp.rm(file, { force: true });
        continue;
      }
      if (match[2] === "ndjson") {
        try {
          await fsp.access(record(match[1]!));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await fsp.rm(file, { force: true });
        }
        continue;
      }
      let row;
      try {
        row = await state(match[1]!);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        frame({
          type: "err",
          data: Buffer.from(
            "Cannot inspect background job " + match[1]! + "; its files were retained\n",
          ).toString("base64"),
        });
        continue;
      }
      if (row.status !== "exited" && row.status !== "lost") continue;
      await fsp.rm(record(match[1]!), { force: true });
      await fsp.rm(journal(match[1]!), { force: true });
      if (process.platform !== "win32") await fsp.rm(address(match[1]!), { force: true });
    }
  }
  function ignored(relative: string) {
    const segments = relative.split("/");
    if (segments.includes(".git")) return true;
    let result = false;
    for (const raw of c.ignores || []) {
      const negate = raw.startsWith("!");
      const pattern = (negate ? raw.slice(1) : raw).replace(/\/$/, "");
      const anchored = pattern.startsWith("/");
      const glob = anchored ? pattern.slice(1) : pattern;
      for (let i = 1; i <= segments.length; i++) {
        const prefix = segments.slice(0, i).join("/");
        if (
          anchored || glob.includes("/")
            ? path.matchesGlob(prefix, glob)
            : path.matchesGlob(segments[i - 1]!, glob)
        )
          result = !negate;
      }
    }
    return result;
  }
  async function manifest() {
    const entries = new Map<string, string>();
    async function walk(directory: string, relative: string) {
      let children;
      try {
        children = await fsp.readdir(directory, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      for (const child of children) {
        const rel = relative ? relative + "/" + child.name : child.name;
        const full = path.join(directory, child.name);
        if (child.isDirectory()) {
          if (child.name === ".git") continue;
          if (ignored(rel)) entries.set(rel + "/", "directory");
          else await walk(full, rel);
        } else if (ignored(rel)) {
          const stat = await fsp.lstat(full, { bigint: true });
          entries.set(rel, String(stat.mtimeNs) + ":" + String(stat.size));
        }
      }
    }
    await walk(c.root, "");
    return entries;
  }
  async function changed(before: Map<string, string>) {
    const after = await manifest();
    return [...after]
      .filter(([file, stamp]) => stamp === "directory" || before.get(file) !== stamp)
      .map(([file]) => file);
  }
  async function control(id: string, signal: string) {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(address(id));
      socket.setTimeout(3000, () => socket.destroy(Error("Background process did not answer")));
      socket.on("error", reject);
      socket.on("connect", () => socket.end(JSON.stringify({ signal }) + "\n"));
      socket.on("data", () => resolve());
      socket.on("end", resolve);
    });
  }
  async function observe(id: string, logs: boolean, follow: boolean) {
    let offset = 0;
    let buffer = "";
    let decoder = new (require("node:string_decoder").StringDecoder)("utf8");
    let identity: string | undefined;
    let watcher: import("node:fs").FSWatcher | undefined;
    let draining = false;
    let again = false;
    let completed = false;
    const close = () => {
      if (watcher) watcher.close();
      process.stdin.destroy();
    };
    async function drain() {
      if (draining) {
        again = true;
        return;
      }
      draining = true;
      try {
        do {
          again = false;
          if (logs) {
            const handle = await fsp.open(journal(id), "r");
            try {
              const info = await handle.stat();
              const nextIdentity = String(info.dev) + ":" + String(info.ino);
              if (identity !== nextIdentity || info.size < offset) {
                offset = 0;
                buffer = "";
                decoder = new (require("node:string_decoder").StringDecoder)("utf8");
                identity = nextIdentity;
              }
              const size = info.size;
              while (size > offset) {
                const data = Buffer.alloc(Math.min(65536, size - offset));
                const read = await handle.read(data, 0, data.length, offset);
                offset += read.bytesRead;
                buffer += decoder.write(data.subarray(0, read.bytesRead));
                let end;
                while ((end = buffer.indexOf("\n")) >= 0) {
                  const item = JSON.parse(buffer.slice(0, end));
                  buffer = buffer.slice(end + 1);
                  if (item.type === "done") completed = true;
                  if (!frame(item))
                    await new Promise((resolve) => process.stdout.once("drain", resolve));
                }
              }
            } finally {
              await handle.close();
            }
          }
          const current = await state(id);
          if (!completed && current.status !== "running") {
            await completion(current.code ?? 255, current.ignored || []);
            completed = true;
          }
          if (completed || !follow) {
            close();
            if (!completed) frame({ type: "done", code: 0, ignored: [] });
          }
        } while (again && !completed && follow);
      } finally {
        draining = false;
      }
    }
    if (follow) {
      watcher = fs.watch(root, (_, name) => {
        if (name === id + ".json" || name === id + ".ndjson") drain().catch(fail);
      });
      process.stdin.on("end", close);
      process.stdin.resume();
    }
    function fail(error: Error) {
      close();
      frame({ type: "error", message: (error as Error).message });
      process.exitCode = 255;
    }
    if (!logs) frame({ type: "ready", id });
    await drain();
  }
  function appendJournal(id: string, value: Frame) {
    const file = journal(id);
    const line = Buffer.from(JSON.stringify(value) + "\n");
    const notice = Buffer.from(
      JSON.stringify({
        type: "err",
        data: Buffer.from("Earlier background output was truncated by retention.\n").toString(
          "base64",
        ),
      }) + "\n",
    );
    if (line.length > Math.floor(logBytes / 2) - notice.length) {
      if (value.type !== "out" && value.type !== "err")
        throw Error("Background record exceeds journal limit");
      const data = Buffer.from(String(value.data), "base64");
      const chunk = Math.floor(((Math.floor(logBytes / 2) - notice.length - 128) * 3) / 4);
      for (let offset = 0; offset < data.length; offset += chunk)
        appendJournal(id, {
          ...value,
          data: data.subarray(offset, offset + chunk).toString("base64"),
        });
      return;
    }
    if (fs.statSync(file).size + line.length <= logBytes) {
      fs.appendFileSync(file, line);
      return;
    }
    const combined = Buffer.concat([fs.readFileSync(file), line]);
    let tail = combined.subarray(
      Math.max(0, combined.length - (Math.floor(logBytes / 2) - notice.length)),
    );
    if (tail.length < combined.length) tail = tail.subarray(tail.indexOf(10) + 1);
    const temporary = file + "." + crypto.randomUUID();
    fs.writeFileSync(temporary, Buffer.concat([notice, tail]), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  async function execute(job: boolean) {
    const before = await manifest();
    const id = c.id ?? "";
    let child: WorkerChild;
    let terminalSignal: NodeJS.Signals | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let graceFinished: Promise<void> | undefined;
    let finishGrace: (() => void) | undefined;
    let commandTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let server: import("node:net").Server | undefined;
    let stopping = false;
    let finished = false;
    let lastBeat = Date.now();
    const emit: (value: Frame) => boolean | void = job
      ? (value: Frame) => appendJournal(id, value)
      : frame;
    const metadata: JobRecord = {
      id,
      name: c.args[0]!,
      cwd: c.cwd,
      ports: c.ports || [],
      startedAt: new Date().toISOString(),
      status: "running",
    };
    function signal(sig: NodeJS.Signals) {
      if (
        !child ||
        !Number.isSafeInteger(child.pid) ||
        child.pid === undefined ||
        child.pid <= 0 ||
        finished
      )
        return;
      signalGroup(child.pid, sig, emit);
    }
    function stop(sig: NodeJS.Signals) {
      if (stopping || finished) return;
      stopping = true;
      terminalSignal = sig;
      signal(sig);
      graceFinished = new Promise((resolve) => {
        finishGrace = resolve;
        killTimer = setTimeout(() => {
          signal("SIGKILL");
          resolve();
        }, stopGraceMs);
      });
    }
    if (job) await fsp.writeFile(journal(id), "", { mode: 0o600 });
    if (c.tty) {
      if (!c.ptyModule) throw Error("The primary terminal runtime was not discovered");
      const { EventEmitter } = require("node:events") as typeof import("node:events");
      const { PassThrough, Writable } = require("node:stream") as typeof import("node:stream");
      const resolved = resolveInvocation(c.args[0]!, c.args.slice(1));
      const pty = (require(c.ptyModule) as typeof import("node-pty")).spawn(
        resolved.ptyCommand,
        typeof resolved.ptyArgs === "string" ? resolved.ptyArgs : [...resolved.ptyArgs],
        {
          cwd: c.cwd,
          env: process.env,
          name: process.env.TERM || "xterm-256color",
          cols: c.cols || 80,
          rows: c.rows || 24,
          encoding: null,
        },
      );
      const ptyChild = Object.assign(new EventEmitter(), {
        pid: pty.pid,
        stdin: new Writable(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      ptyChild.stdout = new PassThrough();
      ptyChild.stderr = new PassThrough();
      ptyChild.stdin = new Writable({
        write(data, _, next) {
          try {
            pty.write(data.toString());
            next();
          } catch (error) {
            next(error as Error);
          }
        },
        final(next) {
          pty.write(resolved.ptyEof);
          next();
        },
      });
      pty.onData((data: string) => {
        if (!ptyChild.stdout.write(Buffer.from(data))) pty.pause();
      });
      ptyChild.stdout.on("drain", () => pty.resume());
      pty.onExit((event: { signal?: number; exitCode: number }) => {
        const code = event.signal ? 128 + event.signal : event.exitCode;
        ptyChild.emit("exit", code, null);
        ptyChild.stdout.end();
        ptyChild.stderr.end();
        ptyChild.emit("close", code, null);
      });
      child = ptyChild;
    } else {
      const process = spawn(c.args[0]!, c.args.slice(1), {
        cwd: c.cwd,
        env: globalThis.process.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!process.stdin || !process.stdout || !process.stderr)
        throw Error("Command stdio is unavailable");
      child = Object.assign(process, {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
      });
    }
    child.once("exit", () => {
      if (!stopping && groupAlive(child.pid)) stop("SIGTERM");
    });
    for (const [stream, type] of [
      [child.stdout, "out"],
      [child.stderr, "err"],
    ] as const)
      stream.on("data", (data: Buffer) => {
        if (emit({ type, data: data.toString("base64") }) === false) {
          child.stdout.pause();
          child.stderr.pause();
        }
      });
    if (!job)
      process.stdout.on("drain", () => {
        child.stdout.resume();
        child.stderr.resume();
      });
    const complete = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code: number | null, sig: NodeJS.Signals | null) =>
        resolve(
          code === null
            ? 128 + (os.constants.signals[sig || terminalSignal || "SIGTERM"] || 1)
            : code,
        ),
      );
    });
    if (job) {
      server = net.createServer((socket) => {
        socket.on("error", (e) => emit({ type: "error", message: e.message }));
        void readSocketLine(socket, { maxBytes: 1024, timeoutMs: 3000 }).then(
          (line) => {
            let signal: "SIGINT" | "SIGTERM";
            try {
              const request = JSON.parse(line) as { signal?: unknown };
              if (request.signal === "status") {
                socket.end("running\n");
                return;
              }
              if (request.signal !== "SIGINT" && request.signal !== "SIGTERM")
                throw Error("Invalid signal");
              signal = request.signal;
            } catch {
              socket.end("invalid request\n");
              emit({
                type: "err",
                data: Buffer.from("Invalid background control request\n").toString("base64"),
              });
              return;
            }
            stop(signal);
            socket.end("ok\n");
          },
          (error) => {
            emit({ type: "error", message: String(error) });
            socket.destroy();
          },
        );
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(address(id), resolve);
      });
      await protectSocket(address(id));
      await atomic(record(id), metadata);
      if (process.send) {
        process.send({ ready: true });
        process.disconnect();
      }
      child.stdin.end();
    } else {
      const input = readline.createInterface({ input: process.stdin });
      input.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type === "beat") lastBeat = Date.now();
          else if (message.type === "data") child.stdin.write(Buffer.from(message.data, "base64"));
          else if (message.type === "end") child.stdin.end();
          else if (message.type === "signal" && ["SIGINT", "SIGTERM"].includes(message.signal))
            stop(message.signal);
        } catch (e) {
          emit({ type: "error", message: (e as Error).message });
          stop("SIGTERM");
        }
      });
      input.on("close", () => stop("SIGTERM"));
      frame({ type: "ready", id: "" });
      watchdog = setInterval(() => {
        if (Date.now() - lastBeat > 5000) stop("SIGTERM");
      }, 1000);
      process.stdout.on("error", () => stop("SIGTERM"));
    }
    child.stdin.on("error", (e) => {
      if (
        (e as NodeJS.ErrnoException).code !== "EPIPE" &&
        (e as NodeJS.ErrnoException).code !== "ERR_STREAM_DESTROYED"
      ) {
        emit({ type: "error", message: (e as Error).message });
        stop("SIGTERM");
      }
    });
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGHUP", () => stop("SIGTERM"));
    if (c.timeoutMs) commandTimer = setTimeout(() => stop("SIGTERM"), c.timeoutMs);
    let code: number;
    try {
      code = await complete;
    } catch (e) {
      emit({ type: "err", data: Buffer.from((e as Error).message + "\n").toString("base64") });
      code = (e as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 126;
    }
    if (graceFinished && groupAlive(child.pid)) await graceFinished;
    if (finishGrace) finishGrace();
    finished = true;
    clearTimeout(killTimer);
    clearTimeout(commandTimer);
    clearInterval(watchdog);
    const outputs = await changed(before);
    if (job) await atomic(record(id), { ...metadata, status: "exited", code, ignored: outputs });
    await completion(code, outputs, emit);
    if (server) await new Promise((resolve) => server.close(resolve));
    process.stdin.destroy();
  }
  async function main() {
    stopGraceMs = killGraceMs(c.killGraceMs ?? process.env.T3CODE_RUN_KILL_GRACE_MS);
    retentionMs = jobRetentionMs(c.retentionMs ?? process.env.T3CODE_RUN_RETENTION_MS);
    logBytes = jobLogBytes(c.logBytes ?? process.env.T3CODE_RUN_LOG_BYTES);
    if (!c.namespace || !/^[a-f0-9]{16}$/.test(c.namespace)) throw Error("Invalid run namespace");
    await prepareRoot();
    if (c.action === "probe") {
      frame({ type: "done", code: 0, ignored: [] });
      return;
    }
    if (c.action === "exec") {
      await execute(false);
      return;
    }
    if (c.action === "job") {
      if (typeof c.id !== "string" || !validId(c.id)) throw Error("Invalid background id");
      await execute(true);
      return;
    }
    if (c.action === "start") {
      const id = crypto.randomUUID();
      const payload = Buffer.from(JSON.stringify({ ...c, action: "job", id })).toString("base64");
      const source = process.execArgv[process.execArgv.indexOf("-e") + 1];
      const launcher = c.runtimeInvocation;
      const daemon = spawn(
        launcher ? launcher.command : process.execPath,
        launcher
          ? [...(launcher.entrypoint ? [launcher.entrypoint] : []), "__run-worker", payload]
          : ["-e", source!, "--", payload],
        { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      await new Promise<void>((resolve, reject) => {
        daemon.once("error", reject);
        daemon.once("exit", (code) =>
          reject(Error("Background process failed to start (" + code + ")")),
        );
        daemon.once("message", (message) => {
          if (message && typeof message === "object" && "ready" in message && message.ready)
            resolve();
          else reject(Error("Invalid background handshake"));
        });
      });
      daemon.unref();
      frame({ type: "ready", id });
      frame({ type: "done", code: 0, ignored: [] });
      return;
    }
    if (c.action === "list") {
      const rows: JobRecord[] = [];
      for (const name of await fsp.readdir(root))
        if (/^[a-f0-9-]{36}\.json$/.test(name)) rows.push(await state(name.slice(0, -5)));
      frame({
        type: "out",
        data: Buffer.from(
          rows
            .map(
              (row) =>
                row.id +
                "\t" +
                row.status +
                "\t" +
                row.name +
                "\t" +
                row.cwd +
                "\t" +
                (row.code === undefined ? "" : row.code) +
                "\t" +
                (row.ports || []).join(","),
            )
            .join("\n") + (rows.length ? "\n" : ""),
        ).toString("base64"),
      });
      frame({ type: "done", code: 0, ignored: [] });
      return;
    }
    if (!validId(c.id)) throw Error("Invalid background id");
    const current = await state(c.id);
    if (current.status === "lost") {
      const error = Error(current.lastError || "The background supervisor no longer exists");
      (error as RunError).runReason = "job_not_found";
      throw error;
    }
    if (
      current.status === "running" &&
      (c.action === "wait" || (c.action === "logs" && c.follow))
    ) {
      try {
        await control(c.id, "status");
      } catch (error) {
        const latest = await state(c.id);
        if (latest.status === "running") {
          if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            (error as RunError).runReason = "job_not_found";
            await atomic(record(c.id), {
              ...latest,
              status: "lost",
              code: 255,
              lastError: "The background supervisor no longer exists; command outcome is unknown",
            });
          }
          throw error;
        }
      }
    }
    if (c.action === "stop") {
      if (current.status === "running") await control(c.id, "SIGTERM");
      await observe(c.id, false, true);
      return;
    }
    if (c.action === "logs" || c.action === "wait") {
      await observe(c.id, c.action === "logs", c.follow || c.action === "wait");
      return;
    }
    throw Error("Unknown remote run action");
  }
  return main().catch((error) => {
    frame({
      type: "error",
      message: (error as Error).message,
      ...((error as RunError).runReason ? { reason: (error as RunError).runReason } : {}),
    });
    process.exitCode = 255;
  });
}

export const RUN_WORKER_SOURCE = `(${runWorkerMain.toString()})(require, process.argv[1], (command, args) => ({command,args,shell:false,ptyCommand:command,ptyArgs:args,ptyEof:"\\x04"}), ${workerPlatform.toString()}, ${workerPolicy.toString()}, ${readLine.toString()});`;
