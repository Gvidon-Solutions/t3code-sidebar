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
              baseDir: "/isolated",
            }),
          ),
        ),
      ),
    );
    expect(calls.at(-1)?.args).toEqual(["daemon", "stop"]);
  }),
);

const updateHandoffState = JSON.stringify({
  protocol: 3,
  activeVersion: "0.1.5",
  update: {
    id: "update-handoff",
    fromVersion: "0.1.5",
    targetVersion: "0.1.6",
    status: "pending",
    dbPath: "/isolated/state/t3.sqlite",
  },
});

const handoffRunner = (options: {
  readonly calls: ProcessRunner.ProcessRunInput[];
  readonly serviceState: boolean;
  readonly stopMarker: boolean;
}) => {
  const statePath = "/isolated/runtime/service-state.json";
  const stopMarkerPath = "/isolated/runtime/.service-stopping";
  const processes = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) =>
      Effect.sync(() => {
        options.calls.push(input);
        return {
          code: 0 as ProcessRunner.ProcessRunOutput["code"],
          stdout: "[]",
          stderr: "",
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const fs = Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      exists: (filePath) =>
        Effect.succeed(
          (options.serviceState && filePath === statePath) ||
            (options.stopMarker && filePath === stopMarkerPath),
        ),
      readFileString: (filePath) =>
        Effect.succeed(options.serviceState && filePath === statePath ? updateHandoffState : ""),
    }),
  );
  return Runner.layer.pipe(
    Layer.provide(fs),
    Layer.provide(processes),
    Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: "fixture" })),
    Layer.provide(
      Layer.succeed(Installer.MutagenInstaller, {
        executable: Effect.succeed("/isolated/bin/mutagen"),
        dataDirectory: "/isolated/mutagen",
        baseDir: "/isolated",
      }),
    ),
  );
};

it.effect("keeps the private Mutagen daemon across an update handoff", () => {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const runner = yield* Runner.MutagenRunner;
      yield* runner.daemon("start");
    }).pipe(Effect.provide(handoffRunner({ calls, serviceState: true, stopMarker: false })));
    expect(calls.map((call) => call.args)).toEqual([["daemon", "start"]]);
  });
});

it.effect("still stops the private Mutagen daemon when the service is explicitly stopping", () => {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const runner = yield* Runner.MutagenRunner;
      yield* runner.daemon("start");
    }).pipe(Effect.provide(handoffRunner({ calls, serviceState: true, stopMarker: true })));
    expect(calls.map((call) => call.args)).toEqual([
      ["daemon", "start"],
      ["daemon", "stop"],
    ]);
  });
});

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

      output = {
        ...output,
        stderr:
          "scp: operator@private-host:/home/operator/secret/file: Permission denied; " +
          "ssh: connect to host operator@private-host: Connection timed out during banner exchange",
      };
      error = yield* create().pipe(Effect.flip);
      expect(error.message).toContain("Permission denied");
      expect(error.message).toContain("Connection timed out during banner exchange");
      expect(error.message).not.toContain("operator@private-host");
      expect(error.message).not.toContain("/home/operator");
      expect(error.message).toContain("<redacted scp endpoint>");

      output = {
        ...output,
        stderr:
          "open '/home/operator/secret dir/file.txt' failed; " +
          "read C:\\Users\\operator\\secret\\file.txt failed; " +
          "read C:/Users/operator/secret/file.txt failed",
      };
      error = yield* create().pipe(Effect.flip);
      expect(error.message).toContain("failed");
      for (const value of ["secret dir", "file.txt", "C:\\Users", "C:/Users", "operator"])
        expect(error.message).not.toContain(value);
      expect(error.message.match(/<redacted path>/g)?.length).toBeGreaterThanOrEqual(3);

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
              baseDir: "/isolated",
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("keeps process runner paths out of public Mutagen failures", () =>
  Effect.gen(function* () {
    const command = "/private/synthetic/bin/mutagen";
    const cwd = "/private/synthetic/work";
    const spawnCwd = "/private/synthetic/spawn";
    const resolvedCommand = "/private/synthetic/resolved/mutagen";
    let failure: ProcessRunner.ProcessRunError = new ProcessRunner.ProcessSpawnError({
      command,
      argumentCount: 2,
      cwd,
      spawnCwd,
      resolvedCommand,
      cause: new Error("spawn failed for operator@private-host:/private/synthetic/detail"),
    });
    const processes = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: () => Effect.fail(failure),
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
      const assertSafe = (message: string) => {
        for (const value of [
          command,
          cwd,
          spawnCwd,
          resolvedCommand,
          "/private",
          "synthetic",
          "operator@private-host",
        ])
          expect(message).not.toContain(value);
      };

      const spawned = yield* create().pipe(Effect.flip);
      expect(spawned.reason).toBe("mutagen");
      expect(spawned.message).toBe("Mutagen sync create could not run (ProcessSpawnError).");
      assertSafe(spawned.message);
      expect(spawned.cause).toBe(failure);

      failure = new ProcessRunner.ProcessTimeoutError({
        command,
        argumentCount: 2,
        cwd,
        spawnCwd,
        timeoutMs: 60_000,
      });
      const timedOut = yield* create().pipe(Effect.flip);
      expect(timedOut.message).toBe(
        "Mutagen sync create timed out after 60000ms (ProcessTimeoutError).",
      );
      assertSafe(timedOut.message);
      expect(timedOut.cause).toBe(failure);
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
              baseDir: "/isolated",
            }),
          ),
        ),
      ),
    );
  }),
);
