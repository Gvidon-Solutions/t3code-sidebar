import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { loadServerUiOriginSalt } from "./DesktopUiOriginSalt.ts";

describe("loadServerUiOriginSalt", () => {
  it.effect("reuses the same install salt across launches with private permissions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const first = yield* loadServerUiOriginSalt(stateDir);
      const second = yield* loadServerUiOriginSalt(stateDir);
      expect(second).toBe(first);
      const info = yield* fs.stat(path.join(stateDir, "server-ui-origin-salt"));
      expect(info.mode & 0o777).toBe(0o600);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to an in-memory salt when the state directory is unwritable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const stateDir = path.join(root, "not-a-directory");
      yield* fs.writeFileString(stateDir, "file");
      const salt = yield* loadServerUiOriginSalt(stateDir);
      expect(salt).toMatch(/^[a-f0-9]{48}$/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces an invalid salt file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(stateDir, "server-ui-origin-salt"), "not-a-salt");
      const salt = yield* loadServerUiOriginSalt(stateDir);
      expect(salt).toMatch(/^[a-f0-9]{48}$/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
