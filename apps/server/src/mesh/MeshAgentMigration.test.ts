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

it.effect("imports GLOBAL.md before the kit adopts the legacy skill directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "mesh-migrate-order-" });
    const source = `${home}/bundled`;
    yield* fs.makeDirectory(`${source}/scripts`, { recursive: true });
    yield* fs.writeFileString(`${source}/SKILL.md`, "---\nname: t3\n---\n\nnew skill\n");
    yield* fs.writeFileString(`${source}/scripts/t3ctl.mjs`, "export {};");
    const installed = `${home}/.agents/skills/t3`;
    yield* fs.makeDirectory(`${installed}/scripts`, { recursive: true });
    yield* fs.makeDirectory(`${installed}/global`, { recursive: true });
    yield* fs.writeFileString(`${installed}/SKILL.md`, "---\nname: t3\n---\n\nold skill\n");
    yield* fs.writeFileString(`${installed}/scripts/t3ctl.mjs`, "export {};");
    const legacy = "Private customer instructions\n";
    yield* fs.writeFileString(`${installed}/global/GLOBAL.md`, legacy);
    yield* Effect.gen(function* () {
      const config = yield* MeshConfig;
      yield* config.apply({ schema: 1, machines: { studio: {} } }, null);
      yield* Layer.build(Migration.layer);
      const migrated = (yield* config.current)!;
      expect(migrated.doc.agents?.instructions).toBe(legacy);
      const kit = yield* Kit.MeshAgentKit;
      yield* kit.reconcile(migrated.doc);
      expect(yield* fs.readFileString(`${installed}/SKILL.md`)).toContain("new skill");
      expect(yield* fs.readFileString(`${installed}/global/GLOBAL.md`)).toBe(legacy);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigTest.layerTest("studio"),
          Kit.layer.pipe(Layer.provide(Settings.layerTest())),
        ),
      ),
      Effect.provideService(HostProcess.Environment, {
        T3_MESH_AGENT_HOME: home,
        T3_MESH_AGENT_SOURCE: source,
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
