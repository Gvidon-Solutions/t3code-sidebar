// @effect-diagnostics nodeBuiltinImport:off -- The fixture executes the serialized worker in a real subprocess and inspects raw pipe frames.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import { workerStateRoot } from "../platform/ServerPlatform.ts";
import { RUN_WORKER_SOURCE } from "./RunWorker.ts";
import { decodeFrame } from "./RunProtocol.ts";

function workerFixture(root: string) {
  const namespace = NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  const invoke = (
    request: Record<string, unknown>,
    options: { allowFailure?: boolean; closeInput?: boolean } = {},
  ) => {
    const child = NodeChildProcess.spawn(process.execPath, [
      "-e",
      RUN_WORKER_SOURCE,
      "--",
      Buffer.from(JSON.stringify({ root, cwd: root, namespace, ignores: [], ...request })).toString(
        "base64",
      ),
    ]);
    if (options.closeInput) child.stdin.end();
    const frames: ReturnType<typeof decodeFrame>[] = [];
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => frames.push(decodeFrame(line)));
    return new Promise<typeof frames>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 || options.allowFailure
          ? resolve(frames)
          : reject(new Error(`Worker exited ${code}`)),
      );
    });
  };
  return { invoke, stateRoot: workerStateRoot(namespace) };
}

it.live("streams both outputs, propagates command failure and detects ignored writes", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-worker-"));
    try {
      const payload = {
        action: "exec",
        namespace: "0123456789abcdef",
        root,
        cwd: root,
        ignores: ["/dist"],
        args: [
          process.execPath,
          "-e",
          "require('fs').mkdirSync('dist'); require('fs').writeFileSync('dist/output','ok'); process.stdout.write('out'); process.stderr.write('err'); process.exitCode=17",
        ],
      };
      const child = NodeChildProcess.spawn(process.execPath, [
        "-e",
        String.raw`
const promises = require('node:fs/promises');
const actualRead = promises.readdir;
promises.readdir = (directory, ...args) => { if (directory.endsWith('dist')) throw Error('Ignored directory scanned'); return actualRead(directory, ...args); };
const actualKill = process.kill.bind(process);
process.kill = (pid, signal) => { if (signal !== 0) throw Error('Unexpected signal after command exit'); return actualKill(pid, signal); };
const processes = require('node:child_process');
const actualSpawn = processes.spawn;
processes.spawn = (command, ...args) => { if (command === 'taskkill') throw Error('Unexpected taskkill after command exit'); return actualSpawn(command, ...args); };
` + RUN_WORKER_SOURCE,
        "--",
        Buffer.from(JSON.stringify(payload)).toString("base64"),
      ]);
      const frames: ReturnType<typeof decodeFrame>[] = [];
      const lines = NodeReadline.createInterface({ input: child.stdout });
      lines.on("line", (line) => frames.push(decodeFrame(line)));
      child.stdin.write('{"type":"beat"}\n{"type":"end"}\n');
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(result).toBe(0);
      expect(
        frames
          .flatMap((f) => (f.type === "out" ? [Buffer.from(f.data, "base64").toString()] : []))
          .join(""),
      ).toBe("out");
      expect(
        frames
          .flatMap((f) => (f.type === "err" ? [Buffer.from(f.data, "base64").toString()] : []))
          .join(""),
      ).toBe("err");
      expect(frames.at(-1)).toEqual({ type: "done", code: 17, ignored: ["dist/"] });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);

it.live("returns 127 for a missing executable without signaling an invalid process group", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-missing-"));
    try {
      const payload = {
        action: "exec",
        namespace: "0123456789abcdef",
        root,
        cwd: root,
        ignores: [],
        args: ["r1-nonexistent-executable"],
      };
      const child = NodeChildProcess.spawn(process.execPath, [
        "-e",
        RUN_WORKER_SOURCE,
        "--",
        Buffer.from(JSON.stringify(payload)).toString("base64"),
      ]);
      const frames: ReturnType<typeof decodeFrame>[] = [];
      const lines = NodeReadline.createInterface({ input: child.stdout });
      lines.on("line", (line) => frames.push(decodeFrame(line)));
      child.stdin.write('{"type":"beat"}\n{"type":"end"}\n');
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code).toBe(0);
      expect(frames.at(-1)).toEqual({ type: "done", code: 127, ignored: [] });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);

it.live("tracks a detached job through disconnect, live logs, list and process-group stop", () =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-background-"));
      const namespace = (await import("node:crypto"))
        .createHash("sha256")
        .update(root)
        .digest("hex")
        .slice(0, 16);
      const invoke = (
        action: string,
        extra: Record<string, unknown> = {},
        onFrame?: (frame: ReturnType<typeof decodeFrame>) => void,
      ) => {
        const payload = { action, namespace, root, cwd: root, ignores: [], ...extra };
        const child = NodeChildProcess.spawn(process.execPath, [
          "-e",
          `
(() => {
const nativeTimeout = global.setTimeout;
const nativeKill = process.kill.bind(process);
const processes = require('node:child_process');
const nativeSpawn = processes.spawn;
let stopping = false, recorded = false;
process.kill = (pid, signal) => { const result = nativeKill(pid, signal); if (signal === 'SIGTERM') stopping = true; return result; };
processes.spawn = (command, ...args) => { if (command === 'taskkill') stopping = true; return nativeSpawn(command, ...args); };
global.setTimeout = (callback, delay, ...args) => { if (stopping && !recorded) { recorded = true; require('node:fs').writeFileSync(${JSON.stringify(NodePath.join(root, "grace.json"))}, JSON.stringify(delay)); } return nativeTimeout(callback, delay, ...args); };
})();
` + RUN_WORKER_SOURCE,
          "--",
          Buffer.from(JSON.stringify(payload)).toString("base64"),
        ]);
        const frames: ReturnType<typeof decodeFrame>[] = [];
        const lines = NodeReadline.createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          const frame = decodeFrame(line);
          frames.push(frame);
          onFrame?.(frame);
        });
        const result = new Promise<typeof frames>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve(frames) : reject(Error(`Worker exited ${code}`)),
          );
        });
        return { child, result };
      };
      let id: string | undefined;
      try {
        const started = await invoke("start", {
          killGraceMs: 23456,
          args: [
            process.execPath,
            "-e",
            "const parent=process.ppid;process.stdout.write('JOB_READY\\n');setInterval(()=>{try{process.kill(parent,0)}catch(error){if(error.code==='ESRCH')process.exit(1);else throw error}},1000)",
          ],
        }).result;
        const ready = started.find((frame) => frame.type === "ready");
        expect(ready?.type).toBe("ready");
        if (ready?.type !== "ready" || !ready.id) throw Error("No job id");
        id = ready.id;
        const reply = await new Promise<string>((resolve, reject) => {
          const address =
            platform === "win32"
              ? String.raw`\\.\pipe\t3-run-${namespace}-${id}`
              : NodePath.join(workerStateRoot(namespace), `${id}.sock`);
          const socket = NodeNet.connect(address);
          let response = "";
          socket.once("error", reject);
          socket.on("data", (data) => {
            response += data.toString();
          });
          socket.once("end", () => resolve(response));
          socket.once("connect", () => socket.end("{bad-json\n"));
        });
        expect(reply).toContain("invalid");
        const list = await invoke("list").result;
        expect(
          list
            .flatMap((frame) =>
              frame.type === "out" ? [Buffer.from(frame.data, "base64").toString()] : [],
            )
            .join(""),
        ).toContain(`${id}\trunning`);
        let stop: Promise<unknown> | undefined;
        const following = invoke("logs", { id, follow: true }, (frame) => {
          if (
            frame.type === "out" &&
            Buffer.from(frame.data, "base64").toString().includes("JOB_READY")
          )
            stop = invoke("stop", { id }).result;
        });
        const logs = await following.result;
        await stop;
        expect(JSON.parse(await NodeFSP.readFile(NodePath.join(root, "grace.json"), "utf8"))).toBe(
          23456,
        );
        expect(logs.at(-1)).toEqual({
          type: "done",
          code: platform === "win32" ? 1 : 143,
          ignored: [],
        });
        const exited = await invoke("list").result;
        expect(
          exited
            .flatMap((frame) =>
              frame.type === "out" ? [Buffer.from(frame.data, "base64").toString()] : [],
            )
            .join(""),
        ).toContain(`${id}\texited`);
        id = undefined;
      } finally {
        if (id) await invoke("stop", { id }).result;
        await NodeFSP.rm(root, { recursive: true, force: true });
        await NodeFSP.rm(
          NodePath.join(NodeOS.tmpdir(), `t3-run-${process.getuid?.() ?? "user"}`, namespace),
          { recursive: true, force: true },
        );
      }
    }),
  ),
);

it.live("keeps many ignored root files within bounded completion frames", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-ignored-tree-"));
    try {
      const payload = {
        action: "exec",
        namespace: "0123456789abcdef",
        root,
        cwd: root,
        ignores: ["*.cache"],
        args: [
          process.execPath,
          "-e",
          "const fs=require('fs');for(let i=0;i<2048;i++)fs.writeFileSync('dependency-'+('x'.repeat(40))+'-'+i+'.cache','output')",
        ],
      };
      const child = NodeChildProcess.spawn(process.execPath, [
        "-e",
        RUN_WORKER_SOURCE,
        "--",
        Buffer.from(JSON.stringify(payload)).toString("base64"),
      ]);
      const frames: ReturnType<typeof decodeFrame>[] = [];
      const lines = NodeReadline.createInterface({ input: child.stdout });
      lines.on("line", (line) => frames.push(decodeFrame(line)));
      child.stdin.write('{"type":"beat"}\n{"type":"end"}\n');
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code).toBe(0);
      const done = frames.at(-1);
      expect(done?.type).toBe("done");
      if (done?.type !== "done") throw Error("Missing completion frame");
      expect(done.ignored).toHaveLength(0);
      const retained = frames.flatMap((frame) => (frame.type === "ignored" ? frame.paths : []));
      expect(retained).toHaveLength(2048);
      expect(new Set(retained).size).toBe(2048);
      expect(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame)) < 65536)).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);

it.live("runs native command scripts through the runtime worker with exact argv and status", () =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-script-"));
      try {
        const probe = NodePath.join(root, "probe.cjs");
        await NodeFSP.writeFile(
          probe,
          "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.exitCode=37;",
        );
        const script = NodePath.join(root, platform === "win32" ? "command.cmd" : "command");
        const quote = (value: string) => "'" + value.replaceAll("'", `'"'"'`) + "'";
        await NodeFSP.writeFile(
          script,
          platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`
            : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(probe)} "$@"\n`,
          { mode: 0o700 },
        );
        const args = ["space value", 'quote"value', "%PATH%", "a&b"];
        const payload = {
          action: "exec",
          namespace: "0123456789abcdef",
          root,
          cwd: root,
          ignores: [],
          args: [script, ...args],
        };
        const child = NodeChildProcess.spawn(process.execPath, [
          NodePath.resolve(import.meta.dirname, "../bin.ts"),
          "__run-worker",
          Buffer.from(JSON.stringify(payload)).toString("base64"),
        ]);
        const frames: ReturnType<typeof decodeFrame>[] = [];
        const lines = NodeReadline.createInterface({ input: child.stdout });
        lines.on("line", (line) => frames.push(decodeFrame(line)));
        child.stdin.write('{"type":"beat"}\n{"type":"end"}\n');
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(code).toBe(0);
        expect(frames.at(-1)).toEqual({ type: "done", code: 37, ignored: [] });
        const output = frames
          .flatMap((frame) =>
            frame.type === "out" ? [Buffer.from(frame.data, "base64").toString()] : [],
          )
          .join("");
        expect(JSON.parse(output)).toEqual(args);
        expect(frames.filter((frame) => frame.type === "err")).toHaveLength(0);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }),
  ),
);

it.live("collects expired completed jobs while keeping running records and their journals", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-retention-"));
    const fixture = workerFixture(root);
    const completed = NodeCrypto.randomUUID();
    const running = NodeCrypto.randomUUID();
    try {
      await NodeFSP.mkdir(fixture.stateRoot, { recursive: true, mode: 0o700 });
      for (const [id, status] of [
        [completed, "exited"],
        [running, "running"],
      ]) {
        const record = NodePath.join(fixture.stateRoot, `${id}.json`);
        await NodeFSP.writeFile(record, JSON.stringify({ id, status, code: 0 }), { mode: 0o600 });
        await NodeFSP.utimes(record, 0, 0);
        await NodeFSP.writeFile(NodePath.join(fixture.stateRoot, `${id}.ndjson`), "old output", {
          mode: 0o600,
        });
      }
      await fixture.invoke({ action: "probe" });
      await expect(
        NodeFSP.stat(NodePath.join(fixture.stateRoot, `${completed}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        NodeFSP.stat(NodePath.join(fixture.stateRoot, `${completed}.ndjson`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await NodeFSP.stat(NodePath.join(fixture.stateRoot, `${running}.json`))).isFile(),
      ).toBe(true);
      expect(
        (await NodeFSP.stat(NodePath.join(fixture.stateRoot, `${running}.ndjson`))).isFile(),
      ).toBe(true);
    } finally {
      await NodeFSP.rm(fixture.stateRoot, { recursive: true, force: true });
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);
it.live("bounds a background journal and reports truncation while retaining the final output", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-journal-"));
    const fixture = workerFixture(root);
    let id: string | undefined;
    try {
      const frames = await fixture.invoke({
        action: "start",
        logBytes: 131072,
        args: [process.execPath, "-e", "process.stdout.write('x'.repeat(512*1024)+'THE_END\\n')"],
      });
      const ready = frames.find((frame) => frame.type === "ready");
      if (ready?.type !== "ready" || !ready.id) throw new Error("No background job id");
      id = ready.id;
      await fixture.invoke({ action: "wait", id });
      expect(
        (await NodeFSP.stat(NodePath.join(fixture.stateRoot, `${id}.ndjson`))).size,
      ).toBeLessThanOrEqual(131072);
      const logs = await fixture.invoke({ action: "logs", id });
      const text = logs
        .flatMap((frame) =>
          frame.type === "out" ? [Buffer.from(frame.data, "base64").toString()] : [],
        )
        .join("");
      expect(text.endsWith("THE_END\n")).toBe(true);
      expect(
        logs.some(
          (frame) =>
            frame.type === "err" &&
            Buffer.from(frame.data, "base64").toString().includes("truncated"),
        ),
      ).toBe(true);
    } finally {
      if (id) await fixture.invoke({ action: "stop", id });
      await NodeFSP.rm(fixture.stateRoot, { recursive: true, force: true });
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);

it.live("reports a lost supervisor instead of waiting forever on its running record", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-lost-"));
    const fixture = workerFixture(root);
    const id = NodeCrypto.randomUUID();
    try {
      await NodeFSP.mkdir(fixture.stateRoot, { recursive: true, mode: 0o700 });
      const record = NodePath.join(fixture.stateRoot, `${id}.json`);
      await NodeFSP.writeFile(record, JSON.stringify({ id, status: "running" }), { mode: 0o600 });
      const frames = await fixture.invoke(
        { action: "wait", id },
        { allowFailure: true, closeInput: true },
      );
      expect(frames.find((frame) => frame.type === "error")).toMatchObject({
        reason: "job_not_found",
      });
      expect(JSON.parse(await NodeFSP.readFile(record, "utf8"))).toMatchObject({
        status: "lost",
        code: 255,
      });
    } finally {
      await NodeFSP.rm(fixture.stateRoot, { recursive: true, force: true });
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);
it.live(
  "recovers completion from the durable record when retained logs lack a completion frame",
  () =>
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-completion-"));
      const fixture = workerFixture(root);
      const id = NodeCrypto.randomUUID();
      try {
        await NodeFSP.mkdir(fixture.stateRoot, { recursive: true, mode: 0o700 });
        await NodeFSP.writeFile(
          NodePath.join(fixture.stateRoot, `${id}.json`),
          JSON.stringify({ id, status: "exited", code: 17, ignored: [] }),
          { mode: 0o600 },
        );
        await NodeFSP.writeFile(
          NodePath.join(fixture.stateRoot, `${id}.ndjson`),
          JSON.stringify({ type: "out", data: Buffer.from("final output").toString("base64") }) +
            "\n",
          { mode: 0o600 },
        );
        const frames = await fixture.invoke(
          { action: "logs", id, follow: true },
          { closeInput: true },
        );
        expect(frames.at(-1)).toEqual({ type: "done", code: 17, ignored: [] });
      } finally {
        await NodeFSP.rm(fixture.stateRoot, { recursive: true, force: true });
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }),
);
