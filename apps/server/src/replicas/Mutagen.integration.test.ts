import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as MutagenInstaller from "./MutagenInstaller.ts";
import * as MutagenRunner from "./MutagenRunner.ts";
import { sessionStatus } from "./replicaModel.ts";

it.live("installs verified Mutagen and synchronizes isolated local endpoints bidirectionally", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-replica-integration-" });
      const alpha = path.join(root, "alpha"),
        beta = path.join(root, "beta");
      yield* fs.makeDirectory(alpha);
      yield* fs.makeDirectory(beta);
      yield* fs.makeDirectory(path.join(alpha, ".git"));
      yield* fs.makeDirectory(path.join(alpha, "node_modules"));
      yield* fs.writeFileString(path.join(alpha, ".git", "config"), "private");
      yield* fs.writeFileString(path.join(alpha, "node_modules", "dep"), "private");
      yield* fs.writeFileString(path.join(alpha, "hello"), "alpha");
      const installerLayer = MutagenInstaller.layer.pipe(
        Layer.provide(ServerConfig.layerTest(root, root)),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(ProcessRunner.layer),
        Layer.provide(FetchHttpClient.layer),
      );
      const run = Effect.gen(function* () {
        const runner = yield* MutagenRunner.MutagenRunner;
        yield* Effect.addFinalizer(() => runner.daemon("stop").pipe(Effect.orDie));
        yield* runner.daemon("start");
        const comparison = {
          source: { environmentId: "alpha", path: alpha },
          destination: { environmentId: "beta", path: beta },
          ignores: ["node_modules", "*.tmp"],
        };
        yield* runner.assertReplicaPath(comparison);
        yield* fs.writeFileString(path.join(beta, "hello"), "different");
        expect((yield* runner.assertReplicaPath(comparison).pipe(Effect.flip)).message).toContain(
          "not empty and differs",
        );
        expect(yield* fs.readFileString(path.join(beta, "hello"))).toBe("different");
        yield* fs.writeFileString(path.join(beta, "hello"), "alpha");
        yield* fs.writeFileString(path.join(beta, "ignored.tmp"), "ignored difference");
        yield* runner.assertReplicaPath(comparison);
        yield* fs.remove(path.join(beta, "ignored.tmp"));
        yield* fs.remove(path.join(beta, "hello"));
        yield* fs.symlink(path.join(root, "outside"), path.join(alpha, "absolute-link"));
        yield* fs.symlink("../outside", path.join(alpha, "relative-outside"));
        yield* runner.create({
          name: "t3-integration",
          logicalHash: "integration",
          environmentTag: "local",
          alpha,
          beta,
          ignores: ["node_modules", "!.t3-conflicts"],
        });
        yield* runner.flush("t3-integration");
        expect(yield* fs.readFileString(path.join(beta, "hello"))).toBe("alpha");
        expect(yield* fs.exists(path.join(beta, ".git"))).toBe(false);
        expect(yield* fs.exists(path.join(beta, "node_modules"))).toBe(false);
        expect(sessionStatus((yield* runner.list())[0]!)).toMatchObject({
          state: "watching",
          skipped: 2,
          problems: [],
        });
        expect(yield* fs.exists(path.join(beta, "absolute-link"))).toBe(false);
        expect(yield* fs.exists(path.join(beta, "relative-outside"))).toBe(false);
        yield* fs.writeFileString(path.join(beta, "hello"), "beta edit");
        yield* runner.flush("t3-integration");
        expect(yield* fs.readFileString(path.join(alpha, "hello"))).toBe("beta edit");
        yield* fs.writeFileString(path.join(alpha, "hello"), "alpha edit");
        yield* runner.flush("t3-integration");
        expect(yield* fs.readFileString(path.join(beta, "hello"))).toBe("alpha edit");
        yield* runner.reset("t3-integration");
        yield* runner.flush("t3-integration");
        yield* runner.pause("t3-integration");
        expect(sessionStatus((yield* runner.list())[0]!).state).toBe("paused");
        yield* fs.writeFileString(path.join(alpha, "hello"), "conflict alpha");
        yield* fs.writeFileString(path.join(beta, "hello"), "conflict beta");
        yield* runner.resume("t3-integration");
        yield* runner.flush("t3-integration");
        const conflict = (yield* runner.list())[0]!;
        expect(sessionStatus(conflict)).toMatchObject({ state: "conflict", conflicts: ["hello"] });
        for (const loser of [beta, alpha]) {
          if (loser === alpha) {
            yield* runner.pause("t3-integration");
            yield* fs.writeFileString(path.join(alpha, "hello"), "alpha loses");
            yield* fs.writeFileString(path.join(beta, "hello"), "beta wins");
            yield* runner.resume("t3-integration");
            yield* runner.flush("t3-integration");
          }
          const iso = loser === beta ? "2026-11-03T00:00:00.000Z" : "2026-11-03T00:00:01.000Z";
          const losing = yield* fs.readFileString(path.join(loser, "hello"));
          const winner = yield* fs.readFileString(
            path.join(loser === alpha ? beta : alpha, "hello"),
          );
          yield* runner.pause("t3-integration");
          yield* runner.preserveConflicts({
            root: loser,
            paths: ["hello"],
            iso,
            environmentId: "local",
          });
          yield* runner.reset("t3-integration");
          yield* runner.resume("t3-integration");
          yield* runner.flush("t3-integration");
          expect(yield* fs.readFileString(path.join(alpha, "hello"))).toBe(winner);
          expect(yield* fs.readFileString(path.join(beta, "hello"))).toBe(winner);
          expect(yield* fs.readFileString(path.join(loser, `.t3-conflicts/${iso}/hello`))).toBe(
            losing,
          );
          expect(
            yield* fs.exists(path.join(loser === alpha ? beta : alpha, `.t3-conflicts/${iso}`)),
          ).toBe(false);
        }
        yield* runner.terminate("t3-integration");
        expect(yield* runner.list()).toEqual([]);
      });
      yield* run.pipe(
        Effect.provide(
          MutagenRunner.layer.pipe(
            Layer.provide(installerLayer),
            Layer.provide(ProcessRunner.layer),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
