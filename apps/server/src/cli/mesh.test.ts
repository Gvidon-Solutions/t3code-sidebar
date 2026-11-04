// @effect-diagnostics nodeBuiltinImport:off -- This fixture drives the actual ProxyCommand subprocess through a private local socket.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { pipeAddress, preparePipeAddress } from "../peer/connection/PeerPlatform.ts";

it.live("the mesh pipe binary bridges binary stdio and fails visibly when the local server refuses a target", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "N1-cli-pipe-" });
    const address = pipeAddress(baseDir, process.platform, process.getuid?.());
    yield* Effect.promise(() => preparePipeAddress(address, process.platform, process.getuid?.()));
    const sockets = new Set<NodeNet.Socket>();
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<NodeNet.Server>((resolve) => {
        const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
          socket.on("error", () => socket.destroy());
          let buffer = Buffer.alloc(0);
          const request = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            const newline = buffer.indexOf(10);
            if (newline < 0) return;
            socket.removeListener("data", request);
            const target = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as { machine: string; target: string };
            expect(target.target).toBe("sshd");
            if (target.machine !== "cloudbox") {
              socket.end(`${JSON.stringify({ ok: false, error: "Fixture machine offline" })}\n`);
              return;
            }
            socket.write('{"ok":true}\n');
            if (buffer.length > newline + 1) socket.write(buffer.subarray(newline + 1));
            socket.pipe(socket);
          };
          socket.on("data", request);
        });
        server.listen(address, () => resolve(server));
      })),
      (server) => Effect.promise(() => new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })),
    );
    const run = (machine: string, payload: Buffer) => Effect.promise(() => new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(process.execPath, [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), "mesh", "pipe", machine, "--base-dir", baseDir], { stdio: ["pipe", "pipe", "pipe"] });
      const output: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.stdin.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout: Buffer.concat(output), stderr }));
      child.stdin.end(payload);
    }));
    const payload = Buffer.from(Array.from({ length: 512 * 1024 }, (_, index) => index % 256));
    const result = yield* run("cloudbox", payload);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout.equals(payload)).toBe(true);
    const refused = yield* run("laptop", Buffer.alloc(0));
    expect(refused.code).not.toBe(0);
    expect(refused.stdout.length).toBe(0);
    expect(refused.stderr).toContain("Fixture machine offline");
    expect(yield* fs.exists(`${baseDir}/userdata/statev2.sqlite`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
