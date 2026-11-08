import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ReplicaEnvironment, environmentCommands, layer } from "./ReplicaEnvironment.ts";
import * as Processes from "../processRunner.ts";

it.each([
  ["pnpm-lock.yaml", "pnpm", ["install", "--frozen-lockfile"]],
  ["package-lock.json", "npm", ["ci"]],
  ["npm-shrinkwrap.json", "npm", ["ci"]],
  ["yarn.lock", "yarn", ["install", "--frozen-lockfile"]],
  ["bun.lockb", "bun", ["install", "--frozen-lockfile"]],
  ["bun.lock", "bun", ["install", "--frozen-lockfile"]],
  ["uv.lock", "uv", ["sync", "--frozen"]],
  ["Cargo.lock", "cargo", ["fetch", "--locked"]],
  ["go.sum", "go", ["mod", "download"]],
])("detects %s", (file, command, args) =>
  expect(environmentCommands([file], "linux")).toEqual([{ command, args }]),
);
it("installs requirements through uv on both platforms", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const commands = environmentCommands(["requirements.txt"], platform);
    expect(commands[0]).toEqual({ command: "uv", args: ["venv", ".venv"] });
    expect(commands[1]?.args).toContain(
      platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
    );
  }
});
it.effect(
  "installs once, refreshes lock changes and blocks repeated installation of a failed fingerprint until the lock changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "s1-full-" });
      yield* fs.writeFileString(`${root}/pnpm-lock.yaml`, "initial");
      const calls: Processes.ProcessRunInput[] = [];
      let fail = false;
      const processes = Layer.succeed(Processes.ProcessRunner, {
        run: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return {
              code: (fail ? 1 : 0) as Processes.ProcessRunOutput["code"],
              stdout: "",
              stderr: fail ? "dependency unavailable" : "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      });
      const states: string[] = [];
      const report = (state: string) =>
        Effect.sync(() => {
          states.push(state);
        });
      const run = Effect.gen(function* () {
        const environment = yield* ReplicaEnvironment;
        yield* environment.ensure(root, report);
        yield* environment.ensure(root, report);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          command: "pnpm",
          args: ["install", "--frozen-lockfile"],
          cwd: root,
          timeout: "10 minutes",
        });
        expect(states).toEqual(["installing", "ready", "ready"]);
        yield* fs.writeFileString(`${root}/pnpm-lock.yaml`, "changed");
        fail = true;
        expect((yield* environment.ensure(root, report).pipe(Effect.flip)).message).toContain(
          "dependency unavailable",
        );
        fail = false;
        expect(yield* environment.ensure(root, report).pipe(Effect.isFailure)).toBe(true);
        expect(calls).toHaveLength(2);
        yield* fs.writeFileString(`${root}/pnpm-lock.yaml`, "fixed");
        yield* environment.ensure(root, report);
        expect(calls).toHaveLength(3);
        yield* Effect.gen(function* () {
          yield* (yield* ReplicaEnvironment).ensure(root, report);
        }).pipe(Effect.provide(layer.pipe(Layer.provide(processes), Layer.fresh)));
        expect(calls).toHaveLength(3);
      });
      yield* run.pipe(Effect.provide(layer.pipe(Layer.provide(processes))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
