import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Runner from "./MutagenRunner.ts";
import * as Installer from "./MutagenInstaller.ts";
import * as ProcessRunner from "../processRunner.ts";

it.effect("isolates reset and explicit daemon start/stop and preserves typed CLI failures", () =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    let fail = false;
    let privateStateExists = false;
    const processes = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return {
            code: (fail ? 1 : 0) as ProcessRunner.ProcessRunOutput["code"],
            stdout: "[]",
            stderr: fail ? "failure" : "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    yield* Effect.gen(function* () {
      const runner = yield* Runner.MutagenRunner;
      expect(yield* runner.listExisting).toEqual([]);
      expect(calls).toEqual([]);
      yield* runner.daemon("start");
      yield* runner.reset("session");
      yield* runner.daemon("stop");
      expect(calls.map((call) => call.args)).toEqual([
        ["daemon", "start"],
        ["sync", "reset", "session"],
        ["daemon", "stop"],
      ]);
      expect(
        calls.every(
          (call) =>
            call.command === "/isolated/bin/mutagen" &&
            call.env?.MUTAGEN_DATA_DIRECTORY === "/isolated/mutagen",
        ),
      ).toBe(true);
      privateStateExists = true;
      expect(yield* runner.listExisting).toEqual([]);
      expect(calls.at(-1)?.args).toEqual([
        "sync",
        "list",
        "--label-selector",
        "t3-logical",
        "--template",
        "{{json .}}",
      ]);
      yield* runner.create({
        name: "N-protected",
        logicalHash: "test",
        environmentTag: "test",
        alpha: "/a",
        beta: "/b",
        ignores: ["cache", ".t3-conflicts", "!.t3-conflicts"],
      });
      const args = calls.at(-1)?.args ?? [];
      const patterns = args.flatMap((arg, index) => (arg === "-i" ? [args[index + 1]] : []));
      expect(patterns.at(-1)).toBe(".t3-conflicts");
      expect(patterns.indexOf(".t3-conflicts")).toBeGreaterThan(patterns.indexOf("!.t3-conflicts"));
      expect(args).toContain("--no-global-configuration");
      fail = true;
      expect((yield* runner.reset("session").pipe(Effect.flip)).reason).toBe("mutagen");
    }).pipe(
      Effect.provide(
        Runner.layer.pipe(
          Layer.provide(
            Layer.succeed(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                exists: () => Effect.sync(() => privateStateExists),
              }),
            ),
          ),
          Layer.provide(processes),
          Layer.provide(
            Layer.succeed(Installer.MutagenInstaller, {
              executable: Effect.succeed("/isolated/bin/mutagen"),
              dataDirectory: "/isolated/mutagen",
            }),
          ),
        ),
      ),
    );
  }),
);
