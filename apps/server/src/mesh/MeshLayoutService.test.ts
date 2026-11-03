import { it, expect } from "@effect/vitest";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import * as Mesh from "./MeshLayoutServiceLive.ts";
import * as MeshSettings from "./MeshSettings.ts";

const environment = Layer.succeed(ServerEnvironment, {
  getEnvironmentId: Effect.succeed(EnvironmentId.make("A")),
  getDescriptor: Effect.succeed(descriptorOf("A", "A")),
});
const dependencies = Layer.mergeAll(
  Sqlite.layerMemory,
  Settings.layerTest({
    sidebarWorkspaces: {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      workspaces: [{ id: "main", name: "main" }],
    },
  }),
  environment,
);

it.effect(
  "adopts legacy, persists across service restarts, advances local seq for late old clocks and ignores replays",
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(dependencies);
      const first = yield* Layer.build(
        Mesh.layer.pipe(Layer.provide(Layer.succeedContext(context)), Layer.fresh),
      );
      const service = yield* MeshLayoutService.pipe(Effect.provide(first));
      expect((yield* service.read).config.workspaces).toEqual([{ id: "main", name: "main" }]);
      const settings = yield* Settings.ServerSettingsService.pipe(Effect.provide(context));
      yield* service.apply({ "machine/new": { v: { label: "new" }, h: "9999999999000.00000.B" } });
      const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(context));
      expect((yield* service.nextHlc) > "9999999999000.00000.B").toBe(true);
      const watermark = (yield* sql<{ seq: number }>`SELECT seq FROM mesh_layout_meta`)[0]!.seq;
      const late = { "machine/late": { v: { label: "late" }, h: "0000000000001.00000.C" } };
      yield* service.apply(late);
      const lateRows = yield* sql<{
        key: string;
      }>`SELECT key FROM mesh_layout_entries WHERE seq > ${watermark}`;
      expect(lateRows.filter((r) => !r.key.startsWith("writer/")).map((r) => r.key)).toEqual([
        "machine/late",
      ]);
      const seq = (yield* sql<{ seq: number }>`SELECT seq FROM mesh_layout_meta`)[0]!.seq;
      yield* service.apply(late);
      expect((yield* sql<{ seq: number }>`SELECT seq FROM mesh_layout_meta`)[0]!.seq).toBe(seq);
      expect((yield* settings.getSettings).sidebarWorkspaces).toEqual((yield* service.read).config);
      const second = yield* Layer.build(
        Mesh.layer.pipe(Layer.provide(Layer.succeedContext(context)), Layer.fresh),
      );
      const restarted = yield* MeshLayoutService.pipe(Effect.provide(second));
      expect(yield* restarted.read).toEqual(yield* service.read);
      yield* restarted.edit((config) => ({ ...config, quietAfterDays: 42 }));
      expect(
        (yield* sql<{ seq: number }>`SELECT seq FROM mesh_layout_meta`)[0]!.seq,
      ).toBeGreaterThan(seq);
    }).pipe(Effect.scoped),
);

it.effect(
  "turns a stale old-client whole-object edit into a minimal diff preserving concurrent mesh edits",
  () =>
    Effect.gen(function* () {
      const mesh = yield* MeshLayoutService;
      const before = (yield* mesh.read).config;
      yield* mesh.apply({
        "machine/B": { v: { label: "concurrent" }, h: "0000000000100.00000.B" },
      });
      const result = yield* mesh.editLegacy(before, {
        ...before,
        workspaces: before.workspaces.map((w) => ({ ...w, name: "renamed" })),
      });
      expect(result.config.machines.B?.label).toBe("concurrent");
      expect(result.config.workspaces[0]?.name).toBe("renamed");
      const raw = yield* Settings.ServerSettingsService;
      const wrappedContext = yield* Layer.build(
        MeshSettings.layer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(Settings.ServerSettingsService, raw),
              Layer.succeed(MeshLayoutService, mesh),
            ),
          ),
        ),
      );
      const wrapped = yield* Settings.ServerSettingsService.pipe(Effect.provide(wrappedContext));
      const sql = yield* SqlClient.SqlClient;
      const seq = (yield* sql<{ seq: number }>`SELECT seq FROM mesh_layout_meta`)[0]!.seq;
      yield* wrapped.updateSettings({
        sidebarWorkspaces: { ...result.config, quietAfterDays: 17 },
      });
      expect((yield* mesh.read).config.quietAfterDays).toBe(17);
      expect((yield* raw.getSettings).sidebarWorkspaces).toEqual((yield* mesh.read).config);
      expect(
        (yield* sql<{ key: string }>`SELECT key FROM mesh_layout_entries WHERE seq > ${seq}`).map(
          (row) => row.key,
        ),
      ).toEqual(["ws.quietAfterDays"]);
    }).pipe(Effect.scoped, Effect.provide(Mesh.layer.pipe(Layer.provideMerge(dependencies)))),
);

it.effect("rejects unknown families, malformed clocks and oversized batches and entries", () =>
  Effect.gen(function* () {
    const mesh = yield* MeshLayoutService;
    for (const entries of [
      { "unknown/key": { v: null, h: "0000000000100.00000.B" } },
      { [`machine/${"x".repeat(65536)}`]: { v: null, h: "0000000000100.00000.B" } },
      { "machine/B": { v: null, h: "broken" } },
      { "machine/B": { v: "x".repeat(65537), h: "0000000000100.00000.B" } },
      Object.fromEntries(
        Array.from({ length: 5001 }, (_, i) => [
          `machine/${i}`,
          { v: null, h: "0000000000100.00000.B" },
        ]),
      ),
    ])
      expect(yield* mesh.apply(entries).pipe(Effect.flip)).toMatchObject({
        reason: "invalid_entries",
      });
  }).pipe(Effect.provide(Mesh.layer.pipe(Layer.provide(dependencies)))),
);
