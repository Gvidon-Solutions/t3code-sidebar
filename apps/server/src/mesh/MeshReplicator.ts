import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import * as NodeUtil from "node:util";
import {
  MeshProjectDirectory,
  ProjectCatalog,
  CatalogClocks,
  type ProjectHandle,
} from "./MeshProjectDirectory.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { EnvironmentId, MeshLayoutEntries, MeshLayoutError } from "@t3tools/contracts";
import type { MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";

export const ExchangeInput = Schema.Struct({
  generation: Schema.optionalKey(Schema.String),
  acknowledgedGeneration: Schema.optional(Schema.String),
  projectCatalogs: Schema.optionalKey(Schema.Array(ProjectCatalog)),
  knownProjects: Schema.optionalKey(CatalogClocks),
  fromEnvironmentId: Schema.String,
  entries: MeshLayoutEntries,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ackReceivedSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const ExchangeOutput = Schema.Struct({
  generation: Schema.optionalKey(Schema.String),
  entries: MeshLayoutEntries,
  seq: Schema.Int,
  projectCatalogs: Schema.optionalKey(Schema.Array(ProjectCatalog)),
  knownProjects: Schema.optionalKey(CatalogClocks),
});
type PeerState = { sent_seq: number; received_seq: number };
export interface PeerStatus {
  readonly environmentId: string;
  readonly lastExchangeAt: string | null;
  readonly lastError: string | null;
  readonly sentSeq: number;
  readonly receivedSeq: number;
}
export class MeshReplicator extends Context.Service<
  MeshReplicator,
  {
    readonly exchange: (
      input: typeof ExchangeInput.Type,
    ) => Effect.Effect<typeof ExchangeOutput.Type, MeshLayoutError>;
    readonly sync: Effect.Effect<void, MeshLayoutError>;
    /** Per-peer replication bookkeeping from `mesh_peer_state`. */
    readonly status: Effect.Effect<import("@t3tools/contracts").MeshLayoutStatus, MeshLayoutError>;
  }
>()("t3/mesh/MeshReplicator") {}

export const layer = Layer.effect(
  MeshReplicator,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const mesh = yield* MeshLayoutService;
    const peers = yield* PeerMcpClient;
    const links = yield* PeerLinks;
    const settings = yield* ServerSettingsService;
    const directory = yield* Effect.serviceOption(MeshProjectDirectory);
    const projects = yield* Effect.serviceOption(ProjectService);
    yield* sql`CREATE TABLE IF NOT EXISTS mesh_layout_generation (id TEXT PRIMARY KEY, generation TEXT NOT NULL)`;
    yield* sql`INSERT OR IGNORE INTO mesh_layout_generation(id,generation) VALUES ('local',${yield* crypto.randomUUIDv4().pipe(Effect.orDie)})`;
    const generation = (yield* sql<{
      generation: string;
    }>`SELECT generation FROM mesh_layout_generation WHERE id = 'local'`)[0]!.generation;
    const observeGeneration = Effect.fn("MeshReplicator.observeGeneration")(function* (
      id: string,
      observed: string | undefined,
    ) {
      if (observed === undefined) return false;
      const previous = (yield* sql<{
        generation: string;
      }>`SELECT generation FROM mesh_layout_generation WHERE id = ${id}`)[0]?.generation;
      if (previous === observed) return false;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR REPLACE INTO mesh_layout_generation(id,generation) VALUES (${id},${observed})`;
          yield* sql`DELETE FROM mesh_peer_state WHERE environment_id = ${id}`;
        }),
      );
      return true;
    });
    const peerCatalogClocks = new Map<string, typeof CatalogClocks.Type>();
    const captureCatalogs = Effect.fn("MeshReplicator.captureCatalogs")(function* () {
      if (Option.isNone(directory)) return [] as readonly ProjectCatalog[];
      if (Option.isSome(projects)) {
        yield* Effect.gen(function* () {
          const snapshot = yield* projects.value.snapshot;
          const handles: ProjectHandle[] = snapshot.projects
            .filter((project) => project.deletedAt === null)
            .map((project) => ({
              id: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              createdAt: project.createdAt,
              ...(project.repositoryIdentity !== undefined
                ? {
                    repositoryIdentity: project.repositoryIdentity
                      ? {
                          canonicalKey: project.repositoryIdentity.canonicalKey,
                          ...(project.repositoryIdentity.origin
                            ? {
                                origin: {
                                  canonicalKey: project.repositoryIdentity.origin.canonicalKey,
                                },
                              }
                            : {}),
                        }
                      : null,
                  }
                : {}),
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
          const previous = (yield* directory.value.read).find(
            (catalog) => catalog.environmentId === mesh.environmentId,
          );
          if (!NodeUtil.isDeepStrictEqual(previous?.projects, handles))
            yield* directory.value.accept([
              { environmentId: mesh.environmentId, h: yield* mesh.nextHlc, projects: handles },
            ]);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Local mesh project catalog could not be refreshed", error),
          ),
        );
      }
      return yield* directory.value.read;
    });
    const clocks = (catalogs: readonly ProjectCatalog[]) =>
      Object.fromEntries(catalogs.map((catalog) => [catalog.environmentId, catalog.h]));
    const newerCatalogs = (
      catalogs: readonly ProjectCatalog[],
      known: typeof CatalogClocks.Type = {},
    ) => catalogs.filter((catalog) => (known[catalog.environmentId] ?? "") < catalog.h);
    const lock = yield* Semaphore.make(1);
    const nextPeriodic = new Map<string, number>();
    const retries = new Map<string, { failures: number; after: number }>();
    const enabled = settings.getSettings.pipe(
      Effect.map((s) => s.meshEnabled && s.linkedEnvironmentsEnabled),
    );
    const changesSince = Effect.fn("MeshReplicator.changesSince")(function* (seq: number) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            key: string;
            value: string | null;
            hlc: string;
            seq: number;
          }>`SELECT key, value, hlc, seq FROM mesh_layout_entries WHERE seq > ${seq} ORDER BY seq LIMIT 5000`;
          const meta = (yield* sql<{
            seq: number;
          }>`SELECT seq FROM mesh_layout_meta WHERE id = 1`)[0]!;
          return {
            entries: Object.fromEntries(
              rows.map((row) => [
                row.key,
                {
                  v: row.value === null ? null : decodeJson(row.value),
                  h: row.hlc,
                },
              ]),
            ),
            seq: rows.length === 5000 ? rows.at(-1)!.seq : meta.seq,
          };
        }),
      );
    });
    const state = Effect.fn("MeshReplicator.state")(function* (id: string) {
      return (
        (yield* sql<PeerState>`SELECT sent_seq, received_seq FROM mesh_peer_state WHERE environment_id = ${id}`)[0] ?? {
          sent_seq: 0,
          received_seq: 0,
        }
      );
    });
    const record = Effect.fn("MeshReplicator.record")(function* (
      id: string,
      sent: number,
      received: number,
    ) {
      yield* sql`INSERT INTO mesh_peer_state(environment_id, sent_seq, received_seq, last_exchange_at, last_error) VALUES (${id}, ${sent}, ${received}, ${DateTime.formatIso(yield* DateTime.now)}, NULL) ON CONFLICT(environment_id) DO UPDATE SET sent_seq = max(sent_seq, excluded.sent_seq), received_seq = max(received_seq, excluded.received_seq), last_exchange_at = excluded.last_exchange_at, last_error = NULL`;
    });
    const status = Effect.gen(function* () {
      const rows = yield* sql<{
        environment_id: string;
        sent_seq: number;
        received_seq: number;
        last_exchange_at: string | null;
        last_error: string | null;
      }>`SELECT environment_id, sent_seq, received_seq, last_exchange_at, last_error FROM mesh_peer_state ORDER BY environment_id`;
      return {
        quarantine: yield* sql<{
          key: string;
          reason: string;
        }>`SELECT key, reason FROM mesh_layout_quarantine ORDER BY key`,
        clockRejections: yield* sql<{
          peerId: string;
          count: number;
          example: string;
        }>`SELECT peer_id AS peerId, count, example FROM mesh_clock_rejections ORDER BY peer_id`,
        peers: rows.map((row): PeerStatus => ({
          environmentId: row.environment_id,
          lastExchangeAt: row.last_exchange_at,
          lastError: row.last_error,
          sentSeq: row.sent_seq,
          receivedSeq: row.received_seq,
        })),
      };
    }).pipe(
      Effect.mapError(
        (cause) => new MeshLayoutError({ reason: "storage", message: "Mesh status failed", cause }),
      ),
    );
    const exchange = Effect.fn("MeshReplicator.exchange")(
      function* (input: typeof ExchangeInput.Type) {
        if (!(yield* enabled))
          return yield* new MeshLayoutError({
            reason: "disabled",
            message: "Mesh replication is disabled",
          });
        yield* observeGeneration(input.fromEnvironmentId, input.generation);
        yield* mesh.apply(input.entries as MeshLayoutDocument, input.fromEnvironmentId);
        if (Option.isSome(directory))
          yield* directory.value.accept(
            (input.projectCatalogs ?? []).filter(
              (catalog) => catalog.environmentId !== mesh.environmentId,
            ),
          );
        const acknowledged =
          input.acknowledgedGeneration === generation || input.generation === undefined
            ? input.ackReceivedSeq
            : 0;
        const output = yield* changesSince(acknowledged);
        yield* record(
          input.fromEnvironmentId,
          acknowledged,
          input.generation === undefined || input.acknowledgedGeneration === generation
            ? input.seq
            : 0,
        );
        // The peer just reached us, so it is up again: stop backing off from it.
        retries.delete(input.fromEnvironmentId);
        const catalogs = yield* captureCatalogs();
        return {
          ...output,
          generation,
          ...(Option.isSome(directory)
            ? {
                projectCatalogs: newerCatalogs(catalogs, input.knownProjects),
                knownProjects: clocks(catalogs),
              }
            : {}),
        };
      },
      Effect.mapError((cause) =>
        isMeshError(cause)
          ? cause
          : new MeshLayoutError({ reason: "storage", message: "Mesh exchange failed", cause }),
      ),
    );
    const runSync = Effect.fn("MeshReplicator.runSync")((periodic: boolean) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            if (!(yield* enabled)) return;
            const linked = (yield* links.list).filter(
              (peer) => peer.access === "full-access" && peer.status !== "expired",
            );
            for (const peer of linked) {
              if (peer.access !== "full-access" || peer.status === "expired") continue;
              const now = yield* Clock.currentTimeMillis;
              if ((retries.get(peer.environmentId)?.after ?? 0) > now) continue;
              if (periodic && (nextPeriodic.get(peer.environmentId) ?? 0) > now) continue;
              yield* Effect.gen(function* () {
                const watermark = yield* state(peer.environmentId);
                const outgoing = yield* changesSince(watermark.sent_seq);
                const catalogs = yield* captureCatalogs();
                const incoming = yield* peers.call({
                  environmentId: EnvironmentId.make(peer.environmentId),
                  tool: "t3_mesh_exchange",
                  arguments: {
                    ...(Option.isSome(directory)
                      ? {
                          projectCatalogs: newerCatalogs(
                            catalogs,
                            peerCatalogClocks.get(peer.environmentId),
                          ),
                          knownProjects: clocks(catalogs),
                        }
                      : {}),
                    generation,
                    acknowledgedGeneration: (yield* sql<{
                      generation: string;
                    }>`SELECT generation FROM mesh_layout_generation WHERE id = ${peer.environmentId}`)[0]
                      ?.generation,
                    fromEnvironmentId: mesh.environmentId,
                    ...outgoing,
                    ackReceivedSeq: watermark.received_seq,
                  },
                  limits: { runtimeMode: "full-access", interactionMode: "default" },
                  success: ExchangeOutput,
                });
                if (incoming.knownProjects)
                  peerCatalogClocks.set(peer.environmentId, incoming.knownProjects);
                yield* mesh.apply(incoming.entries as MeshLayoutDocument, peer.environmentId);
                if (Option.isSome(directory))
                  yield* directory.value.accept(
                    (incoming.projectCatalogs ?? []).filter(
                      (catalog) => catalog.environmentId !== mesh.environmentId,
                    ),
                  );
                const changedGeneration = yield* observeGeneration(
                  peer.environmentId,
                  incoming.generation,
                );
                yield* record(
                  peer.environmentId,
                  changedGeneration ? 0 : outgoing.seq,
                  incoming.seq,
                );
                retries.delete(peer.environmentId);
                nextPeriodic.set(peer.environmentId, now + PERIODIC_PULL_MS);
              }).pipe(
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    const failures = (retries.get(peer.environmentId)?.failures ?? 0) + 1;
                    retries.set(peer.environmentId, {
                      failures,
                      after:
                        (yield* Clock.currentTimeMillis) +
                        Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(failures, 4)),
                    });
                    yield* sql`INSERT INTO mesh_peer_state(environment_id, last_error) VALUES (${peer.environmentId}, ${String(cause)}) ON CONFLICT(environment_id) DO UPDATE SET last_error = excluded.last_error`;
                    yield* Effect.logWarning("Mesh peer exchange failed", cause);
                  }),
                ),
              );
            }
            if (mesh.collectTombstones) {
              let acknowledged = Number.MAX_SAFE_INTEGER;
              for (const peer of linked)
                acknowledged = Math.min(acknowledged, (yield* state(peer.environmentId)).sent_seq);
              yield* mesh.collectTombstones(acknowledged);
            }
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new MeshLayoutError({ reason: "storage", message: "Mesh sync failed", cause }),
          ),
        ),
    );
    const sync = runSync(false);
    if (links.changes)
      yield* Stream.runForEach(links.changes, () =>
        sync.pipe(Effect.catch((cause) => Effect.logError("Mesh link replication failed", cause))),
      ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(Stream.groupedWithin(mesh.changes, 1000, "200 millis"), () =>
      sync.pipe(Effect.catch((cause) => Effect.logError("Mesh change replication failed", cause))),
    ).pipe(Effect.forkScoped);
    yield* runSync(true).pipe(
      Effect.catch((cause) => Effect.logError("Mesh periodic replication failed", cause)),
      Effect.repeat(Schedule.spaced("60 seconds")),
      Effect.forkScoped,
    );
    return MeshReplicator.of({ exchange, sync, status });
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

/**
 * How often each linked peer is pulled when nothing changed here. Links point one way, so a peer
 * that cannot call us is only heard through these pulls; an empty exchange is cheap.
 */
export const PERIODIC_PULL_MS = 60_000;

/** Longest pause before retrying an unreachable peer; a peer that calls in resets it. */
export const MAX_RETRY_MS = 15_000;

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const isMeshError = Schema.is(MeshLayoutError);
