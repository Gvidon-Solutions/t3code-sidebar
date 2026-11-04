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
