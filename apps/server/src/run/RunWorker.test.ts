// @effect-diagnostics nodeBuiltinImport:off -- The fixture executes the serialized worker in a real subprocess and inspects raw pipe frames.
import * as Effect from "effect/Effect";
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
      expect(logs.at(-1)).toEqual({ type: "done", code: 143, ignored: [] });
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
);
