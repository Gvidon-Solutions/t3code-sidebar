// @effect-diagnostics nodeBuiltinImport:off -- The fixture builds and executes the shipped worker bundle in a real subprocess.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { decodeFrame } from "./RunProtocol.ts";

const appsServer = NodeURL.fileURLToPath(new URL("../../", import.meta.url));

const invoke = (source: string, root: string, namespace: string, payload: object) => {
  const child = NodeChildProcess.spawn(process.execPath, [
    "-e",
    source,
    "--",
    Buffer.from(JSON.stringify({ root, cwd: root, namespace, ignores: [], ...payload })).toString(
      "base64",
    ),
  ]);
  if ((payload as { action?: string }).action === "exec")
    child.stdin.write('{"type":"beat"}\n{"type":"end"}\n');
  else child.stdin.end();
  const frames: ReturnType<typeof decodeFrame>[] = [];
  const lines = NodeReadline.createInterface({ input: child.stdout });
  lines.on("line", (line) => frames.push(decodeFrame(line)));
  const result = new Promise<typeof frames>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(frames) : reject(Error(`Bundled worker exited ${code}`)),
    );
  });
  return { child, result };
};

it.live("runs exec and background start actions from the bundled worker source", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-bundle-"));
    try {
      const outDir = NodePath.join(root, "bundle");
      await build({
        cwd: appsServer,
        entry: ["src/run/RunWorker.ts"],
        outDir,
        format: "esm",
        platform: "node",
        clean: true,
        minify: true,
        dts: false,
      });
      await NodeFSP.symlink(
        NodePath.join(appsServer, "node_modules"),
        NodePath.join(outDir, "node_modules"),
        "dir",
      );
      const bundled = (await import(
        NodeURL.pathToFileURL(NodePath.join(outDir, "RunWorker.mjs")).href
      )) as {
        RUN_WORKER_SOURCE: string;
      };
      expect(bundled.RUN_WORKER_SOURCE.length).toBeGreaterThan(0);
      const work = NodePath.join(root, "work");
      await NodeFSP.mkdir(work);

      const exec = await invoke(bundled.RUN_WORKER_SOURCE, work, "0123456789abcdef", {
        action: "exec",
        args: [process.execPath, "-e", "process.stdout.write('bundle-exec')"],
      }).result;
      expect(
        exec
          .flatMap((frame) =>
            frame.type === "out" ? [Buffer.from(frame.data, "base64").toString()] : [],
          )
          .join(""),
      ).toBe("bundle-exec");

      const start = await invoke(bundled.RUN_WORKER_SOURCE, work, "abcdef0123456789", {
        action: "start",
        args: [
          process.execPath,
          "-e",
          "process.stdout.write('bundle-start');setInterval(()=>{},1000)",
        ],
      }).result;
      const ready = start.find((frame) => frame.type === "ready");
      expect(ready?.type).toBe("ready");
      if (ready?.type !== "ready" || !ready.id) throw Error("Bundled worker returned no job id");
      const stop = await invoke(bundled.RUN_WORKER_SOURCE, work, "abcdef0123456789", {
        action: "stop",
        id: ready.id,
      }).result;
      expect(stop.every((frame) => frame.type !== "error")).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);
