// @effect-diagnostics nodeBuiltinImport:off -- Exercise the detached guardian's real private listener and diagnostic file with transport failures supplied at the boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { guardianAddress, namespaceOf, workerStateRoot } from "../platform/ServerPlatform.ts";
import { runGuardian } from "./RunGuardian.ts";
import { remoteRun } from "./RunTransport.ts";
import { requestRun } from "./RunClient.ts";
import { RunRemoteError } from "./RunRemoteError.ts";

vi.mock("./RunTransport.ts", () => ({ remoteRun: vi.fn() }));
vi.mock("./RunClient.ts", () => ({ requestRun: vi.fn() }));

it.live("stops forwarding for an expired job and bounds its diagnostic log", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    yield* Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-guardian-"));
      const id = NodeCrypto.randomUUID();
      const plan = {
        kind: "remote",
        logicalKey: "application",
        environmentId: "laptop",
        primaryEnvironmentId: "studio",
        title: "Application",
        machine: "Studio",
        host: "studio",
        primaryRoot: directory,
        replicaRoot: directory,
        cwd: directory,
        platform,
        ignores: [],
      };
      const root = workerStateRoot(namespaceOf(directory));
      const previousExitCode = process.exitCode;
      using _send = vi.spyOn(process, "send").mockReturnValue(true);
      vi.mocked(remoteRun).mockReset();
      vi.mocked(requestRun).mockReset();
      vi.mocked(requestRun).mockResolvedValue({
        ok: true,
        plan: { kind: "local" },
        remoteCommands: [],
      });
      const retryEntered = Promise.withResolvers<void>();
      const finishRetry = Promise.withResolvers<void>();
      vi.mocked(remoteRun)
        .mockImplementationOnce(async (_plan, _request, options) => {
          await options.onFrame({ type: "ready", id });
          throw new RunRemoteError({
            detail: "expired ".repeat(20_000),
            reason: "job_not_found",
          });
        })
        .mockImplementationOnce(async () => {
          retryEntered.resolve();
          await finishRetry.promise;
          return { code: 0, ignored: [] };
        });
      const completion = runGuardian(
        Buffer.from(
          JSON.stringify({ plan, id, ports: [], cwd: directory, timeoutMs: 30000 }),
        ).toString("base64"),
      );
      try {
        await Promise.race([completion, retryEntered.promise]);
        const listenerOpen = await new Promise<boolean>((resolve, reject) => {
          const socket = NodeNet.connect(guardianAddress(directory, id));
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", (error: NodeJS.ErrnoException) =>
            error.code === "ENOENT" || error.code === "ECONNREFUSED"
              ? resolve(false)
              : reject(error),
          );
        });
        expect(listenerOpen).toBe(false);
        expect(
          (await NodeFSP.stat(NodePath.join(root, `${id}.forwarding.log`))).size,
        ).toBeLessThanOrEqual(65536);
      } finally {
        finishRetry.resolve();
        await completion;
        process.exitCode = previousExitCode;
        await NodeFSP.rm(root, { recursive: true, force: true });
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    });
  }),
);
