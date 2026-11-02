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
