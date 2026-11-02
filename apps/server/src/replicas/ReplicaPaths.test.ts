import * as PlatformError from "effect/PlatformError";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Settings from "../serverSettings.ts";
import * as Paths from "./ReplicaPaths.ts";

it.effect(
  "reserves the original path when free, then falls back without overwriting collisions, across restart",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-replica-paths-" });
      const layer = Paths.layer.pipe(
        Layer.provide(Settings.layerTest()),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
      );
      yield* Effect.gen(function* () {
        const paths = yield* Paths.ReplicaPaths;
        expect(yield* paths.allocate(`${home}/project`)).toBe(`${home}/project`);
        expect(yield* paths.allocate(`${home}/project`)).toBe(`${home}/t3-replicas/project`);
        expect(yield* paths.allocate(`${home}/project`)).toBe(`${home}/t3-replicas/project-2`);
        const roots = yield* Effect.all(
          [paths.allocate(`${home}/project`), paths.allocate(`${home}/project`)],
          { concurrency: 2 },
        );
        expect(new Set(roots).size).toBe(2);
        expect(yield* paths.allocate("relative").pipe(Effect.isFailure)).toBe(true);
      }).pipe(Effect.provide(layer));
      yield* Effect.gen(function* () {
        const paths = yield* Paths.ReplicaPaths;
        expect(yield* paths.allocate(`${home}/project`)).toBe(`${home}/t3-replicas/project-5`);
        expect(yield* paths.allocate(`${home}/missing-parent/other`)).toBe(
          `${home}/t3-replicas/other`,
        );
      }).pipe(Effect.provide(Layer.fresh(layer)));
      yield* Effect.gen(function* () {
        const paths = yield* Paths.ReplicaPaths;
        expect(yield* paths.allocate(`${home}/project`)).toBe(`${home}/custom/project`);
      }).pipe(
        Effect.provide(
          Paths.layer.pipe(Layer.provide(Settings.layerTest({ replicaRoot: `${home}/custom` }))),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back when the source parent is not writable", () =>
  Effect.gen(function* () {
    const created: string[] = [];
    const fs = FileSystem.makeNoop({
      exists: () => Effect.succeed(false),
      access: () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "access",
          }),
        ),
      makeDirectory: (root) =>
        Effect.sync(() => {
          created.push(root);
        }),
    });
    yield* Effect.gen(function* () {
      const paths = yield* Paths.ReplicaPaths;
      expect(yield* paths.allocate("/not-writable/example")).toBe("/home/test/custom/example");
      expect(created).toEqual(["/home/test/custom", "/home/test/custom/example"]);
    }).pipe(
      Effect.provide(
        Paths.layer.pipe(
          Layer.provide(Settings.layerTest({ replicaRoot: "~/custom" })),
          Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
          Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/home/test")),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
