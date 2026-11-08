import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { MeshConfig } from "./MeshConfig.ts";
import * as ConfigTest from "./MeshConfigTestLayer.ts";
import * as Kit from "./MeshAgentKit.ts";
import * as Migration from "./MeshAgentMigration.ts";
import * as Settings from "../serverSettings.ts";
it.effect(
  "migrates installed private GLOBAL text once through apply and retains explicit edits",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "mesh-migrate-" });
      yield* fs.makeDirectory(`${home}/.agents/skills/t3/global`, { recursive: true });
      const legacy = "Private customer instructions\nKeep every byte.\n";
      yield* fs.writeFileString(`${home}/.agents/skills/t3/global/GLOBAL.md`, legacy);
      yield* Effect.gen(function* () {
        const config = yield* MeshConfig;
        yield* config.apply({ schema: 1, machines: { studio: {} }, agents: { aliases: {} } }, null);
        yield* Layer.build(Migration.layer);
        const migrated = (yield* config.current)!;
        expect(migrated.doc.agents?.instructions).toBe(legacy);
        expect(migrated.doc.agents?.aliases).toEqual({});
        expect((yield* config.history).length).toBe(2);
        yield* config.apply(
          { ...migrated.doc, agents: { instructions: "Owner changed this", aliases: {} } },
          migrated.revision,
        );
        yield* Layer.build(Layer.fresh(Migration.layer));
        expect((yield* config.current)?.doc.agents).toEqual({
          instructions: "Owner changed this",
          aliases: {},
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigTest.layerTest("studio"),
            Kit.layer.pipe(Layer.provide(Settings.layerTest())),
          ),
        ),
        Effect.provideService(HostProcess.Environment, { T3_MESH_AGENT_HOME: home }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
