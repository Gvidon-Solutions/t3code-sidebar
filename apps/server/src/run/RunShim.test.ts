// @effect-diagnostics nodeBuiltinImport:off -- Real subprocess exec is necessary: calling the shim in this process would replace the test runner.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { DEFAULT_REMOTE_COMMANDS } from "./RunProtocol.ts";
it.live(
  "blocks a lite shell with one line, but execs real binaries outside and in nested full representations",
  () =>
    Effect.flatMap(HostProcess.Platform, (platform) =>
      Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-shim-"));
        try {
          const replica = NodePath.join(root, "replica");
          const real = NodePath.join(root, "real");
          const shim = NodePath.join(root, "shims");
          await Promise.all([
            NodeFSP.mkdir(NodePath.join(replica, "nested"), { recursive: true }),
            NodeFSP.mkdir(real),
            NodeFSP.mkdir(shim),
          ]);
          const probe = NodePath.join(root, "probe.cjs");
          await NodeFSP.writeFile(
            probe,
            "process.stdout.write('real:'+process.argv[2]+'\\n');process.exitCode=41;",
          );
          await NodeFSP.writeFile(
            NodePath.join(real, platform === "win32" ? "pytest.cmd" : "pytest"),
            platform === "win32"
              ? `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`
              : '#!/bin/sh\nprintf "real:%s\\n" "$1"\nexit 41\n',
            { mode: 0o700 },
          );
          const manifest = NodePath.join(root, "manifest.json");
          await NodeFSP.writeFile(
            manifest,
            JSON.stringify({
              commands: [...DEFAULT_REMOTE_COMMANDS, "custom-build"],
              representations: [
                { root: replica, lite: true, title: "Sample", machine: "cloudbox" },
                {
                  root: NodePath.join(replica, "nested"),
                  lite: false,
                  title: "Nested",
                  machine: "cloudbox",
                },
              ],
            }),
          );
          const invoke = (cwd: string, name = "pytest") =>
            new Promise<{ code: number | null; stdout: string; stderr: string }>(
              (resolve, reject) => {
                const child = NodeChildProcess.spawn(
                  process.execPath,
                  [
                    NodePath.resolve(import.meta.dirname, "../bin.ts"),
                    "__replica-command",
                    name,
                    "a b",
                  ],
                  {
                    cwd,
                    env: {
                      ...process.env,
                      PATH: `${shim}${NodePath.delimiter}${real}`,
                      T3CODE_RUN_MANIFEST: manifest,
                      T3CODE_RUN_SHIMS: shim,
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                  },
                );
                let stdout = "",
                  stderr = "";
                child.stdout.on("data", (data) => (stdout += data));
                child.stderr.on("data", (data) => (stderr += data));
                child.once("error", reject);
                child.once("close", (code) => resolve({ code, stdout, stderr }));
              },
            );
          for (const name of [...DEFAULT_REMOTE_COMMANDS, "custom-build"])
            expect(await invoke(replica, name)).toEqual({
              code: 127,
              stdout: "",
              stderr: `This is a lite replica of Sample; the environment is on cloudbox. Use: t3 run ${name} 'a b'\n`,
            });
          for (const cwd of [root, NodePath.join(replica, "nested")])
            expect(await invoke(cwd)).toEqual({ code: 41, stdout: "real:a b\n", stderr: "" });
          const configured = JSON.parse(await NodeFSP.readFile(manifest, "utf8")) as {
            commands: string[];
          };
          configured.commands = [];
          await NodeFSP.writeFile(manifest, JSON.stringify(configured));
          expect(await invoke(replica)).toEqual({ code: 41, stdout: "real:a b\n", stderr: "" });
        } finally {
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      }),
    ),
);
