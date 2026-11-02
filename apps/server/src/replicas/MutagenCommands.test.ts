import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runner from "./MutagenRunner.ts";
import * as Installer from "./MutagenInstaller.ts";
import * as ProcessRunner from "../processRunner.ts";

it.effect("isolates reset and explicit daemon start/stop and preserves typed CLI failures", () =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    let fail = false;
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
      fail = true;
      expect((yield* runner.reset("session").pipe(Effect.flip)).reason).toBe("mutagen");
    }).pipe(
      Effect.provide(
        Runner.layer.pipe(
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
