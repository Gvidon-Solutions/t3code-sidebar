import { MeshLayoutError } from "@t3tools/contracts";
import { validateEntries } from "./validateEntries.ts";
import * as Schema from "effect/Schema";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import {
  adoptLegacy,
  migrateLogicalProjectIds,
  diff,
  importLegacy,
  materialize,
  merge,
  receive,
  tick,
  type MeshLayoutDocument,
} from "@t3tools/shared/meshLayout";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";

type Row = {
  readonly key: string;
  readonly value: string | null;
  readonly hlc: string;
  readonly seq: number;
};
const storageError = (cause: unknown) =>
  new MeshLayoutError({ reason: "storage", message: "Mesh layout storage failed", cause });

export const layer = Layer.effect(
  MeshLayoutService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsService;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    const lock = yield* Semaphore.make(1);
    const readRows = sql<Row>`SELECT key, value, hlc, seq FROM mesh_layout_entries`;
    const rows = yield* readRows;
    let document: MeshLayoutDocument = Object.fromEntries(
      rows.map((row) => [
        row.key,
        {
          v:
            row.value === null
              ? null
              : (decodeJson(row.value) as import("@t3tools/shared/meshLayout").Json),
          h: row.hlc,
        },
      ]),
    );
    yield* sql`INSERT OR IGNORE INTO mesh_layout_meta (id, hlc, seq) VALUES (1, ${tick(0, null, environmentId)}, 0)`;
    const state = yield* SubscriptionRef.make({ document, config: materialize(document) });
    const persist = Effect.fn("MeshLayoutService.persist")(function* (entries: MeshLayoutDocument) {
      // Client clocks carry device ids; writer membership records servers, not clock writers.
      const writers: MeshLayoutDocument = {
        [`writer/${encodeURIComponent(environmentId)}`]: {
          v: true,
          h: tick(0, null, environmentId),
        },
      };
      const combined = migrateLogicalProjectIds(merge(merge(document, writers), entries));
      const merged = Object.entries(combined)
        .filter(([key]) => key.startsWith("ws/"))
        .some(([, entry]) => entry.h.startsWith("0000000000000."))
        ? adoptLegacy(DEFAULT_SIDEBAR_WORKSPACES_CONFIG, combined)
        : combined;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const meta = (yield* sql<{
            hlc: string;
            seq: number;
          }>`SELECT hlc, seq FROM mesh_layout_meta WHERE id = 1`)[0]!;
          let clock = meta.hlc;
          let seq = meta.seq;
          const now = yield* Clock.currentTimeMillis;
          for (const entry of Object.values(entries)) clock = receive(clock, entry.h, now);
          for (const [key, entry] of Object.entries(merged)) {
            if (merged[key] === document[key]) continue;
            seq++;
            yield* sql`INSERT INTO mesh_layout_entries (key, value, hlc, seq) VALUES (${key}, ${entry.v === null ? null : yield* encodeJson(entry.v)}, ${entry.h}, ${seq}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, seq = excluded.seq`;
          }
          yield* sql`UPDATE mesh_layout_meta SET hlc = ${clock}, seq = ${seq} WHERE id = 1`;
        }),
      );
      const snapshot = { document: merged, config: materialize(merged) };
      yield* settings.updateSettings({ sidebarWorkspaces: snapshot.config });
      if (Object.keys(merged).some((key) => merged[key] !== document[key])) {
        document = merged;
        yield* SubscriptionRef.set(state, snapshot);
      }
      return snapshot;
    }, Effect.mapError(storageError));
    if (rows.length === 0) {
      const legacy = (yield* settings.getSettings).sidebarWorkspaces;
      yield* persist(importLegacy(legacy, environmentId, "0000000000000.00000.legacy"));
    } else {
      yield* persist({});
    }
    const nextHlc = sql
      .withTransaction(
        Effect.gen(function* () {
          const meta = (yield* sql<{
            hlc: string;
          }>`SELECT hlc FROM mesh_layout_meta WHERE id = 1`)[0]!;
          const h = tick(yield* Clock.currentTimeMillis, meta.hlc, environmentId);
          yield* sql`UPDATE mesh_layout_meta SET hlc = ${h} WHERE id = 1`;
          return h;
        }),
      )
      .pipe(Effect.mapError(storageError));
    return MeshLayoutService.of({
      environmentId,
      read: SubscriptionRef.get(state),
      apply: Effect.fn("MeshLayoutService.apply")(function* (entries) {
        yield* validateEntries(entries);
        return yield* lock.withPermit(persist(entries));
      }),
      edit: Effect.fn("MeshLayoutService.edit")(function* (update) {
        return yield* lock.withPermit(
          Effect.gen(function* () {
            const before = materialize(document);
            return yield* persist(diff(before, update(before), document, yield* nextHlc));
          }),
        );
      }),
      editLegacy: Effect.fn("MeshLayoutService.editLegacy")((before, after) =>
        lock.withPermit(
          Effect.gen(function* () {
            const compatible = {
              ...after,
              ...(Object.keys(after.projectTitles ?? {}).length === 0 &&
              Object.keys(before.projectTitles).length > 0
                ? { projectTitles: before.projectTitles }
                : {}),
            };
            return yield* persist(diff(before, compatible, document, yield* nextHlc));
          }),
        ),
      ),
      nextHlc: lock.withPermit(nextHlc),
      changes: SubscriptionRef.changes(state),
    });
  }),
);

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
