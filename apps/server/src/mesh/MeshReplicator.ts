import * as PeerIdentities from "../auth/PeerIdentities.ts";
import { meshTimer, MeshTimeScale } from "./MeshTiming.ts";
import { meshRetryDelay } from "./Backoff.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import * as PeerTransport from "../peer/connection/PeerTransport.ts";
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
const decodePush = Schema.decodeUnknownEffect(ExchangeInput);
const LAYOUT_PUSH_EVENT = "mesh.layout.push";
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
    const meshMillis = yield* meshTimer;
    const timeScale = yield* MeshTimeScale;
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;
    const mesh = yield* MeshLayoutService;
    const peers = yield* PeerMcpClient;
    const links = yield* PeerLinks;
    const identities = yield* PeerIdentities.PeerIdentities;
    const settings = yield* ServerSettingsService;
    const transport = yield* PeerTransport.PeerTransport;
    const directory = yield* MeshProjectDirectory;
    const projects = yield* ProjectService;
    const applicationEvents = yield* ApplicationEvents.OrchestrationEventStore;
    yield* sql`CREATE TABLE IF NOT EXISTS mesh_layout_generation (id TEXT PRIMARY KEY, generation TEXT NOT NULL)`;
    yield* sql`INSERT OR IGNORE INTO mesh_layout_generation(id,generation) VALUES ('local',${yield* random.uuidV4().pipe(Effect.orDie)})`;
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
      {
        yield* Effect.gen(function* () {
          const snapshot = yield* projects.snapshot;
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
          const previous = (yield* directory.read).find(
            (catalog) => catalog.environmentId === mesh.environmentId,
          );
          if (!NodeUtil.isDeepStrictEqual(previous?.projects, handles))
            yield* directory.accept([
              { environmentId: mesh.environmentId, h: yield* mesh.nextHlc, projects: handles },
            ]);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Local mesh project catalog could not be refreshed", error),
          ),
        );
      }
      return yield* directory.read;
    });
    const clocks = (catalogs: readonly ProjectCatalog[]) =>
      Object.fromEntries(catalogs.map((catalog) => [catalog.environmentId, catalog.h]));
    const newerCatalogs = (
      catalogs: readonly ProjectCatalog[],
      known: typeof CatalogClocks.Type = {},
    ) => catalogs.filter((catalog) => (known[catalog.environmentId] ?? "") < catalog.h);
    const lock = yield* Semaphore.make(1);
    const retries = new Map<string, { failures: number; after: number }>();
    const retryTimers = new Map<
      string,
      { readonly token: object; readonly fiber: Fiber.Fiber<void, never> }
    >();
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...retryTimers.values()], (timer) => Fiber.interrupt(timer.fiber), {
        discard: true,
      }),
    );
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
        legacyIdentityUpgrades: yield* identities.legacyUpgrades,
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
        yield* directory.accept(
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
          projectCatalogs: newerCatalogs(catalogs, input.knownProjects),
          knownProjects: clocks(catalogs),
        };
      },
      Effect.mapError((cause) =>
        isMeshError(cause)
          ? cause
          : new MeshLayoutError({ reason: "storage", message: "Mesh exchange failed", cause }),
      ),
    );
    const cancelRetry = Effect.fn("MeshReplicator.cancelRetry")(function* (id: string) {
      const timer = retryTimers.get(id);
      if (timer === undefined) return;
      retryTimers.delete(id);
      yield* Fiber.interrupt(timer.fiber);
    });
    const scheduleRetry = Effect.fn("MeshReplicator.scheduleRetry")(function* (
      id: string,
      delay: number,
    ) {
      yield* cancelRetry(id);
      const token = {};
      const fiber = yield* Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(Math.max(0, delay)));
        if (retryTimers.get(id)?.token === token) retryTimers.delete(id);
        yield* sync.pipe(Effect.catch((cause) => Effect.logError("Mesh retry failed", cause)));
      }).pipe(Effect.forkDetach);
      retryTimers.set(id, { token, fiber });
    });
    const payloadFor = Effect.fn("MeshReplicator.payloadFor")(function* (id: string) {
      const watermark = yield* state(id);
      const outgoing = yield* changesSince(watermark.sent_seq);
      const catalogs = yield* captureCatalogs();
      return {
        projectCatalogs: newerCatalogs(catalogs, peerCatalogClocks.get(id)),
        knownProjects: clocks(catalogs),
        generation,
        acknowledgedGeneration: (yield* sql<{
          generation: string;
        }>`SELECT generation FROM mesh_layout_generation WHERE id = ${id}`)[0]?.generation,
        fromEnvironmentId: mesh.environmentId,
        ...outgoing,
        ackReceivedSeq: watermark.received_seq,
      };
    });
    const runSync = Effect.fn("MeshReplicator.runSync")((reconnected = false) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            if (!(yield* enabled)) return;
            if (reconnected) {
              retries.clear();
              for (const id of retryTimers.keys()) yield* cancelRetry(id);
            }
            const linked = yield* links.list;
            for (const peer of linked) {
              if (peer.access !== "full-access" || peer.status === "expired") continue;
              const now = yield* Clock.currentTimeMillis;
              if ((retries.get(peer.environmentId)?.after ?? 0) > now) continue;
              yield* Effect.gen(function* () {
                const outgoing = yield* payloadFor(peer.environmentId);
                const incoming = yield* peers.call({
                  environmentId: EnvironmentId.make(peer.environmentId),
                  tool: "t3_mesh_exchange",
                  arguments: outgoing,
                  limits: { runtimeMode: "full-access", interactionMode: "default" },
                  success: ExchangeOutput,
                });
                if (incoming.knownProjects)
                  peerCatalogClocks.set(peer.environmentId, incoming.knownProjects);
                yield* mesh.apply(incoming.entries as MeshLayoutDocument, peer.environmentId);
                yield* directory.accept(
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
                yield* cancelRetry(peer.environmentId);
              }).pipe(
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    const failures = (retries.get(peer.environmentId)?.failures ?? 0) + 1;
                    const now = yield* Clock.currentTimeMillis;
                    const after = now + meshRetryDelay(failures - 1, 1, undefined, timeScale);
                    retries.set(peer.environmentId, { failures, after });
                    yield* sql`INSERT INTO mesh_peer_state(environment_id, last_error) VALUES (${peer.environmentId}, ${String(cause)}) ON CONFLICT(environment_id) DO UPDATE SET last_error = excluded.last_error`;
                    yield* Effect.logWarning("Mesh peer exchange failed", cause);
                    yield* scheduleRetry(peer.environmentId, after - now);
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
    const sync: Effect.Effect<void, MeshLayoutError> = runSync();
    let fallbackToken: object | undefined;
    const push = Effect.gen(function* () {
      if (!(yield* enabled)) return;
      const network = transport.get();
      const now = yield* DateTime.now;
      let fallback = false;
      for (const id of yield* links.ids) {
        const peer = yield* links.get(id);
        if (
          Option.isNone(peer) ||
          peer.value.access !== "full-access" ||
          DateTime.isLessThanOrEqualTo(peer.value.expiresAt, now)
        )
          continue;
        if (
          network &&
          (yield* network.connected(id)) &&
          (yield* network.event(id, LAYOUT_PUSH_EVENT, yield* payloadFor(id)))
        ) {
          retries.delete(id);
          yield* cancelRetry(id);
        } else fallback = true;
      }
      if (fallback && fallbackToken === undefined) {
        const token = {};
        fallbackToken = token;
        yield* sync.pipe(
          Effect.catch((error) => Effect.logWarning("Mesh HTTP fallback failed", error)),
          Effect.ensuring(
            Effect.sync(() => {
              if (fallbackToken === token) fallbackToken = undefined;
            }),
          ),
          Effect.forkScoped,
        );
      }
    }).pipe(Effect.withSpan("MeshReplicator.push"));
    const receivePush = Effect.fn("MeshReplicator.receivePush")(function* (
      activity: Extract<PeerTransport.PeerActivity, { kind: "event" }>,
    ) {
      const input = yield* decodePush(activity.body);
      const peer = yield* links.get(EnvironmentId.make(activity.environmentId));
      if (
        input.fromEnvironmentId !== activity.environmentId ||
        Option.isNone(peer) ||
        peer.value.access !== "full-access" ||
        DateTime.isLessThanOrEqualTo(peer.value.expiresAt, yield* DateTime.now)
      )
        return yield* new MeshLayoutError({
          reason: "invalid_entries",
          message: "Layout push requires its authenticated full-access peer identity",
        });
      yield* exchange(input);
    });
    yield* Stream.runForEach(
      transport.activity.pipe(
        Stream.filter((activity) => activity.kind === "event"),
        Stream.filter((activity) => activity.name === LAYOUT_PUSH_EVENT),
      ),
      (activity) =>
        receivePush(activity).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Peer layout push rejected", {
              from: activity.environmentId,
              error,
            }),
          ),
        ),
    ).pipe(Effect.forkScoped);

    if (links.changes)
      yield* Stream.runForEach(links.changes, () =>
        runSync(true).pipe(
          Effect.catch((cause) => Effect.logError("Mesh link replication failed", cause)),
        ),
      ).pipe(Effect.forkScoped);
    {
      const afterSequence = yield* applicationEvents.latestApplicationSequence.pipe(
        Effect.mapError(
          (cause) =>
            new MeshLayoutError({
              reason: "storage",
              message: "Project catalog cursor could not be read",
              cause,
            }),
        ),
      );
      yield* Stream.runForEach(
        Stream.groupedWithin(
          applicationEvents.streamProjectedApplicationEvents({
            afterSequence,
            project: (event) => ({ sequence: event.sequence }),
            filter: (event) => "aggregateKind" in event && event.aggregateKind === "project",
          }),
          1000,
          Duration.millis(meshMillis(200)),
        ),
        () => push,
      ).pipe(
        Effect.catch((cause) => Effect.logError("Mesh project catalog replication failed", cause)),
        Effect.forkScoped,
      );
    }
    const changes = Stream.merge(mesh.changes, directory.changes);
    yield* Stream.runForEach(
      Stream.groupedWithin(changes, 1000, Duration.millis(meshMillis(200))),
      () =>
        push.pipe(
          Effect.catch((cause) => Effect.logError("Mesh change replication failed", cause)),
        ),
    ).pipe(Effect.forkScoped);
    yield* runSync().pipe(
      Effect.catch((cause) => Effect.logError("Mesh periodic replication failed", cause)),
      Effect.repeat(Schedule.spaced(Duration.millis(meshMillis(60_000)))),
      Effect.forkScoped,
    );
    return MeshReplicator.of({ exchange, sync, status });
  }).pipe(Effect.provide(NodeCrypto.layer)),
).pipe(Layer.provide(PeerIdentities.layer));

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const isMeshError = Schema.is(MeshLayoutError);
