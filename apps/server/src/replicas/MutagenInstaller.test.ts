import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Installer from "./MutagenInstaller.ts";

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("corrupt", { status: 200 }))),
  ),
);
const setup = (root: string, mutagenPath = "") =>
  Installer.layer.pipe(
    Layer.provide(ServerConfig.layerTest(root, root)),
    Layer.provide(ServerSettings.layerTest({ mutagenPath })),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(http),
  );
it.effect(
  "honors an explicit executable and rejects an archive before unpacking when its checksum differs",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mutagen-installer-" });
      yield* Effect.gen(function* () {
        const installer = yield* Installer.MutagenInstaller;
        expect(yield* installer.executable).toBe("/custom/mutagen");
        expect(installer.dataDirectory).toBe(`${root}/mutagen`);
        expect(yield* fs.exists(`${root}/bin`)).toBe(false);
      }).pipe(Effect.provide(setup(root, "/custom/mutagen")));
      yield* Effect.gen(function* () {
        const installer = yield* Installer.MutagenInstaller;
        const error = yield* installer.executable.pipe(Effect.flip);
        expect(error.message).toBe("Mutagen archive checksum mismatch.");
        expect(yield* fs.exists(`${root}/bin/mutagen`)).toBe(false);
      }).pipe(Effect.provide(setup(root)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

const platforms = [
  {
    os: "linux",
    arch: "x64",
    asset: "linux_amd64",
    sha: "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
  },
  {
    os: "linux",
    arch: "arm64",
    asset: "linux_arm64",
    sha: "bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a",
  },
  {
    os: "darwin",
    arch: "x64",
    asset: "darwin_amd64",
    sha: "7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf",
  },
  {
    os: "darwin",
    arch: "arm64",
    asset: "darwin_arm64",
    sha: "6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2",
  },
  {
    os: "win32",
    arch: "x64",
    asset: "windows_amd64",
    sha: "3e237e77f69959ed520a0f877330a431507bb0a85d9da7919764ba0c87b702c7",
  },
  {
    os: "win32",
    arch: "arm64",
    asset: "windows_arm64",
    sha: "9ac53447e46f019be9d37f49c00eeed8635966b885ed29ef06b3ff19afdee532",
  },
] as const;
it.effect.each(platforms)("installs the pinned $asset executable and agents, once", (target) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mutagen-platform-" });
    const requests: string[] = [];
    let extractions = 0;
    const client = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("archive")));
      }),
    );
    const crypto = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () =>
          Effect.succeed(
            Uint8Array.from(target.sha.match(/../g)!.map((hex) => Number.parseInt(hex, 16))),
          ),
      }),
    );
    const process = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.gen(function* () {
          extractions++;
          expect(input.command).toBe("tar");
          expect(input.env?.MUTAGEN_DATA_DIRECTORY).toBe(`${root}/mutagen`);
          const staging = input.args[3]!;
          yield* fs.writeFileString(
            `${staging}/${target.os === "win32" ? "mutagen.exe" : "mutagen"}`,
            "binary",
          );
          yield* fs.writeFileString(`${staging}/mutagen-agents.tar.gz`, "agents");
          return {
            code: 0 as ProcessRunner.ProcessRunOutput["code"],
            stdout: "",
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }).pipe(Effect.orDie),
    });
    yield* Effect.gen(function* () {
      const installer = yield* Installer.MutagenInstaller;
      const installed = yield* installer.executable;
      expect(installed).toBe(`${root}/bin/${target.os === "win32" ? "mutagen.exe" : "mutagen"}`);
      expect(yield* fs.readFileString(installed)).toBe("binary");
      expect(yield* fs.readFileString(`${root}/bin/mutagen-agents.tar.gz`)).toBe("agents");
      expect(yield* installer.executable).toBe(installed);
      expect(requests).toEqual([
        `https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_${target.asset}_v0.18.1.tar.gz`,
      ]);
      expect(extractions).toBe(1);
    }).pipe(
      Effect.provide(
        Installer.layer.pipe(
          Layer.provide(ServerConfig.layerTest(root, root)),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(process),
          Layer.provide(client),
          Layer.provide(crypto),
          Layer.provide(Layer.succeed(HostProcess.Platform, target.os)),
          Layer.provide(Layer.succeed(HostProcess.Architecture, target.arch)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("times out a stalled download before extraction", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "s1-installer-timeout-" });
    const entered = yield* Deferred.make<void>();
    const stalled = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    );
    yield* Effect.gen(function* () {
      const installer = yield* Installer.MutagenInstaller;
      const running = yield* installer.executable.pipe(
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("30 seconds");
      expect((yield* Fiber.join(running)).reason).toBe("mutagen");
      expect(yield* fs.exists(`${root}/bin`)).toBe(false);
    }).pipe(
      Effect.provide(
        Installer.layer.pipe(
          Layer.provide(ServerConfig.layerTest(root, root)),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(ProcessRunner.layer),
          Layer.provide(stalled),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
