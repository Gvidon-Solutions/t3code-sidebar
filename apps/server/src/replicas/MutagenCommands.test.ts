import { it, expect } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
            call.env?.MUTAGEN_DATA_DIRECTORY === "/isolated/mutagen" &&
            call.env?.PATH === "fixture",
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
        name: "mesh-protected",
        logicalHash: "test",
        environmentTag: "test",
        alpha: "/a",
        beta: "/b",
        ignores: ["cache", ".t3-conflicts", "!.t3-conflicts"],
      });
      const args = calls.at(-1)?.args ?? [];
      const patterns = args.flatMap((arg, index) => (arg === "-i" ? [args[index + 1]] : []));
      expect(patterns.at(-1)).toBe("/.t3-conflicts");
      expect(patterns.indexOf("/.t3-conflicts")).toBeGreaterThan(
        patterns.indexOf("!.t3-conflicts"),
      );
      expect(args).toContain("--no-global-configuration");
      fail = true;
      expect((yield* runner.reset("session").pipe(Effect.flip)).reason).toBe("mutagen");
      fail = false;
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
          Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: "fixture" })),
          Layer.provide(
            Layer.succeed(Installer.MutagenInstaller, {
              executable: Effect.succeed("/isolated/bin/mutagen"),
              dataDirectory: "/isolated/mutagen",
            }),
          ),
        ),
      ),
    );
    expect(calls.at(-1)?.args).toEqual(["daemon", "stop"]);
  }),
);

it.effect("surfaces a bounded, redacted Mutagen failure reason", () =>
  Effect.gen(function* () {
    let failure: ProcessRunner.ProcessRunError | undefined;
    let output: ProcessRunner.ProcessRunOutput = {
      code: 1 as ProcessRunner.ProcessRunOutput["code"],
      stdout: "",
      stderr: "",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const processes = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: () => (failure ? Effect.fail(failure) : Effect.succeed(output)),
    });
    yield* Effect.gen(function* () {
      const runner = yield* Runner.MutagenRunner;
      const create = () =>
        runner.create({
          name: "mesh-protected",
          logicalHash: "test",
          environmentTag: "test",
          alpha: "/private/alpha",
          beta: "/private/beta",
          ignores: [],
        });

      output = {
        ...output,
        stderr:
          "\u001b[31mError: unable to receive server magic number: EOF\n" +
          "(error output: Connection timed out during banner exchange\n" +
          "Connection to UNKNOWN port 65535 timed out)\u001b[0m",
      };
      let error = yield* create().pipe(Effect.flip);
      expect(error.reason).toBe("mutagen");
      expect(error.message).toContain("sync create");
      expect(error.message).toContain("exit code 1");
      expect(error.message).toContain("Connection timed out during banner exchange");
      expect(error.message).not.toContain("\u001b");
      expect(error.message).not.toContain("--no-global-configuration");
      expect(error.message).not.toContain("/private/alpha");
      expect(error.message).not.toContain("/private/beta");
      expect(error.cause).toBe(output);

      output = { ...output, stderr: "" };
      error = yield* create().pipe(Effect.flip);
      expect(error.message).toBe(
        "Mutagen sync create failed with exit code 1 without stderr output.",
      );
      expect(error.cause).toBe(output);

      output = {
        ...output,
        stderr:
          "x".repeat(2_000) +
          " connecting with https://mesher:supersecret@example.test/sync token=abc123",
      };
      error = yield* create().pipe(Effect.flip);
      expect(error.message).toContain("sync create");
      expect(error.message).toContain("exit code 1");
      expect(error.message).toContain("<redacted>");
      expect(error.message).not.toContain("supersecret");
      expect(error.message).not.toContain("abc123");
      expect(error.message.length).toBeLessThan(600);

      failure = new ProcessRunner.ProcessTimeoutError({
        command: "/isolated/bin/mutagen",
        argumentCount: 2,
        timeoutMs: 60_000,
      });
      error = yield* create().pipe(Effect.flip);
      expect(error.reason).toBe("mutagen");
      expect(error.message).toContain("sync create");
      expect(error.message).toContain("timed out after 60000ms");
      expect(error.cause).toBe(failure);
    }).pipe(
      Effect.provide(
        Runner.layer.pipe(
          Layer.provide(
            Layer.succeed(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                exists: () => Effect.succeed(true),
              }),
            ),
          ),
          Layer.provide(processes),
          Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: "fixture" })),
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
