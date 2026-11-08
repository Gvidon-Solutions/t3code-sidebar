import { meshMillis } from "./MeshTiming.ts";
import { MeshLayoutError } from "@t3tools/contracts";
import { validateEntries } from "./validateEntries.ts";
import * as Schema from "effect/Schema";
import { migrateLayout, legacySettingsDiff } from "./migration/layoutMigration.ts";
import {
  diff,
  importLegacy,
  materialize,
  merge,
  receive,
  tick,
  isFutureHlc,
  hlcPhysical,
  validateLayoutEntry,
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
    yield* sql`CREATE TABLE IF NOT EXISTS mesh_layout_quarantine (key TEXT PRIMARY KEY, value TEXT, hlc TEXT NOT NULL, reason TEXT NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS mesh_clock_rejections (peer_id TEXT PRIMARY KEY, count INTEGER NOT NULL, example TEXT NOT NULL, last_logged INTEGER NOT NULL)`;
    const stored = yield* readRows;
    const rows: Row[] = [];
    const now = yield* Clock.currentTimeMillis;
    for (const row of stored) {
      const reason = storedRowReason(row, now);
      if (reason === null) rows.push(row);
      else {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT OR REPLACE INTO mesh_layout_quarantine(key,value,hlc,reason) VALUES (${row.key},${row.value},${row.hlc},${reason})`;
            yield* sql`DELETE FROM mesh_layout_entries WHERE key = ${row.key}`;
          }),
        );
        yield* Effect.logWarning("Quarantined mesh layout row", row.key, reason);
      }
    }
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
    const savedClock = (yield* sql<{
      hlc: string;
    }>`SELECT hlc FROM mesh_layout_meta WHERE id = 1`)[0]!.hlc;
    if (isFutureHlc(savedClock, now)) {
      const recovered = rows.reduce(
        (clock, row) => (row.hlc > clock ? row.hlc : clock),
        tick(now, null, environmentId),
      );
      yield* sql`UPDATE mesh_layout_meta SET hlc = ${recovered} WHERE id = 1`;
      yield* Effect.logWarning("Recovered mesh clock after quarantining future rows", {
        savedClock,
        recovered,
      });
    }
    const state = yield* SubscriptionRef.make({ document, config: materialize(document) });
    const persist = Effect.fn("MeshLayoutService.persist")(function* (entries: MeshLayoutDocument) {
      // Client clocks carry device ids; writer membership records servers, not clock writers.
      const writers: MeshLayoutDocument = {
        [`writer/${encodeURIComponent(environmentId)}`]: {
          v: true,
          h: tick(0, null, environmentId),
        },
      };
      const merged = migrateLayout(merge(merge(document, writers), entries));
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const meta = (yield* sql<{
            hlc: string;
            seq: number;
          }>`SELECT hlc, seq FROM mesh_layout_meta WHERE id = 1`)[0]!;
          let clock = meta.hlc;
          let seq = meta.seq;
          const now = yield* Clock.currentTimeMillis;
          for (const entry of Object.values(entries)) {
            const previous = clock;
            clock = yield* Effect.try({
              try: () => receive(previous, entry.h, now),
              catch: storageError,
            });
          }
          for (const row of yield* readRows) {
            if (!Object.hasOwn(merged, row.key))
              yield* sql`DELETE FROM mesh_layout_entries WHERE key = ${row.key}`;
          }
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
          const now = yield* Clock.currentTimeMillis;
          const h = yield* Effect.try({
            try: () => tick(now, meta.hlc, environmentId),
            catch: storageError,
          });
          yield* sql`UPDATE mesh_layout_meta SET hlc = ${h} WHERE id = 1`;
          return h;
        }),
      )
      .pipe(Effect.mapError(storageError));
    return MeshLayoutService.of({
      environmentId,
      read: SubscriptionRef.get(state),
      apply: Effect.fn("MeshLayoutService.apply")(
        function* (entries, peerId = "local") {
          yield* validateEntries(entries);
          const now = yield* Clock.currentTimeMillis;
          const rejected = Object.entries(entries).filter(([, entry]) => isFutureHlc(entry.h, now));
          if (rejected.length > 0) {
            const example = yield* encodeJson(rejected.at(-1));
            const previous = (yield* sql<{
              last_logged: number;
            }>`SELECT last_logged FROM mesh_clock_rejections WHERE peer_id = ${peerId}`)[0];
            const log = previous === undefined || now - previous.last_logged >= 60_000;
            yield* sql`INSERT INTO mesh_clock_rejections(peer_id,count,example,last_logged) VALUES (${peerId},${rejected.length},${example},${now}) ON CONFLICT(peer_id) DO UPDATE SET count = count + excluded.count, example = excluded.example, last_logged = ${log ? now : previous!.last_logged}`;
            if (log)
              yield* Effect.logWarning("Mesh clock guard rejected future entries", peerId, example);
            return yield* new MeshLayoutError({
              reason: "invalid_entries",
              message: "clock more than five minutes ahead",
            });
          }
          return yield* lock.withPermit(persist(entries));
        },
        Effect.mapError((cause) => (isMeshError(cause) ? cause : storageError(cause))),
      ),
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
            return yield* persist(legacySettingsDiff(before, after, document, yield* nextHlc));
          }),
        ),
      ),
      collectTombstones: Effect.fn("MeshLayoutService.collectTombstones")(
        (acknowledgedSeq: number) =>
          lock
            .withPermit(
              Effect.gen(function* () {
                const cutoff =
                  (yield* Clock.currentTimeMillis) - meshMillis(30 * 24 * 60 * 60 * 1000);
                const expired = (yield* readRows).filter(
                  (row) =>
                    hlcPhysical(row.hlc) < cutoff &&
                    (row.key.startsWith("author/") ||
                      (row.value === null && row.seq <= acknowledgedSeq)),
                );
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    for (const row of expired)
                      yield* sql`DELETE FROM mesh_layout_entries WHERE key = ${row.key} AND seq = ${row.seq}`;
                  }),
                );
                if (expired.length > 0) {
                  const removed = new Set(expired.map((row) => row.key));
                  document = Object.fromEntries(
                    Object.entries(document).filter(([key]) => !removed.has(key)),
                  );
                  yield* SubscriptionRef.set(state, { document, config: materialize(document) });
                }
              }),
            )
            .pipe(Effect.mapError(storageError)),
      ),
      nextHlc: lock.withPermit(nextHlc),
      changes: SubscriptionRef.changes(state),
    });
  }),
);

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function storedRowReason(row: Row, now: number): string | null {
  try {
    const reason = validateLayoutEntry(row.key, {
      v:
        row.value === null
          ? null
          : (decodeJson(row.value) as import("@t3tools/shared/meshLayout").Json),
      h: row.hlc,
    });
    return reason ?? (isFutureHlc(row.hlc, now) ? "clock more than five minutes ahead" : null);
  } catch (cause) {
    return String(cause);
  }
}

const isMeshError = Schema.is(MeshLayoutError);
