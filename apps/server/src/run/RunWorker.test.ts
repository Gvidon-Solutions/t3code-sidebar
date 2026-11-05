// @effect-diagnostics nodeBuiltinImport:off -- The fixture executes the serialized worker in a real subprocess and inspects raw pipe frames.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { RUN_WORKER_SOURCE } from "./RunWorker.ts";
import { decodeFrame } from "./RunProtocol.ts";

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
        RUN_WORKER_SOURCE,
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
      expect(frames.at(-1)).toEqual({ type: "done", code: 17, ignored: ["dist/output"] });
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
          RUN_WORKER_SOURCE,
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
          args: [
            process.execPath,
            "-e",
            "process.stdout.write('JOB_READY\\n');setInterval(()=>{},1000)",
          ],
        }).result;
        const ready = started.find((frame) => frame.type === "ready");
        expect(ready?.type).toBe("ready");
        if (ready?.type !== "ready" || !ready.id) throw Error("No job id");
        id = ready.id;
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

it.live("keeps a large ignored dependency tree within a bounded completion frame", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-ignored-tree-"));
    try {
      const payload = {
        action: "exec",
        namespace: "0123456789abcdef",
        root,
        cwd: root,
        ignores: ["/node_modules"],
        args: [
          process.execPath,
          "-e",
          "const fs=require('fs');fs.mkdirSync('node_modules');for(let i=0;i<2048;i++)fs.writeFileSync('node_modules/dependency-'+('x'.repeat(40))+'-'+i,'output')",
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
