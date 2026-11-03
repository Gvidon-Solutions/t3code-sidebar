import * as Directory from "./MeshProjectDirectory.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProjectId } from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../serverSettings.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import * as Mesh from "./MeshLayoutServiceLive.ts";
import { MeshReplicator, ExchangeInput, layer } from "./MeshReplicator.ts";

const decodeExchange = Schema.decodeUnknownSync(ExchangeInput);
it.effect(
  "gossips A–B–C, heals a partition, forwards late old HLCs and makes replays idempotent",
  () =>
    Effect.gen(function* () {
      const nodes = new Map<
        string,
        {
          mesh: MeshLayoutService["Service"];
          replicator: MeshReplicator["Service"];
          settings: Settings.ServerSettingsService["Service"];
          directory: Directory.MeshProjectDirectory["Service"];
        }
      >();
      let ready = false;
      let localProjects = [
        {
          id: ProjectId.make("A-project"),
          title: "Remote-only project",
          workspaceRoot: "/A/project",
          repositoryIdentity: {
            canonicalKey: "host/owner/project",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "https://example.test/private-source",
            },
            origin: {
              canonicalKey: "host/owner/project",
              remoteUrl: "https://example.test/private-origin",
            },
          },
          defaultModelSelection: null,
          scripts: [],
          createdAt: "",
          updatedAt: "",
          deletedAt: null,
        },
      ];
      const catalogsSent: number[] = [];
      let partition = false;
      for (const [id, adjacent] of [
        ["A", ["B"]],
        ["B", ["C"]],
        ["C", []],
      ] as const) {
        const peers = Layer.succeed(PeerMcpClient, {
          call: Effect.fn("test.meshCall")(function* <S extends Schema.Decoder<unknown>>(input: {
            environmentId: EnvironmentId;
            tool: string;
            arguments: Record<string, unknown>;
            limits: import("../peer/PeerMcpClient.ts").PeerCallLimits;
            success: S;
          }) {
            catalogsSent.push(
              Array.isArray(input.arguments.projectCatalogs)
                ? input.arguments.projectCatalogs.length
                : 0,
            );
            if (partition)
              return yield* new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "partition",
              });
            const result = yield* nodes
              .get(input.environmentId)!
              .replicator.exchange(decodeExchange(input.arguments))
              .pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    }),
                ),
              );
            // oxlint-disable-next-line t3code/no-inline-schema-compile -- The success schema is selected by each call.
            return yield* Schema.decodeEffect(input.success)(result).pipe(Effect.orDie);
          }),
        });
        const links = Layer.mock(PeerLinks)({
          enabled: Effect.succeed(true),
          list: Effect.sync(() =>
            ready
              ? adjacent.map(
                  (other) =>
                    ({
                      environmentId: EnvironmentId.make(other),
                      access: "full-access",
                      status: "reachable",
                      label: other,
                      urls: [],
                      linkedAt: DateTime.makeUnsafe(0),
                      expiresAt: DateTime.makeUnsafe(9999999999999),
                      lastReachedAt: null,
                      lastError: null,
                    }) satisfies PeerLinkSummary,
                )
              : [],
          ),
        });
        const env = Layer.succeed(ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make(id)),
          getDescriptor: Effect.succeed(descriptorOf(id, id)),
        });
        const context = yield* Layer.build(
          layer.pipe(
            Layer.provideMerge(Mesh.layer),
            Layer.provideMerge(
              Layer.mergeAll(
                peers,
                links,
                Directory.layer,
                Layer.mock(ProjectService)({
                  snapshot: Effect.sync(() => ({
                    projects: id === "A" ? localProjects : [],
                    updatedAt: "",
                  })),
                }),
                env,
                Settings.layerTest({ linkedEnvironmentsEnabled: true }),
                Sqlite.layerMemory,
              ),
            ),
            Layer.fresh,
          ),
        );
        const mesh = yield* MeshLayoutService.pipe(Effect.provide(context));
        const replicator = yield* MeshReplicator.pipe(Effect.provide(context));
        nodes.set(id, {
          mesh,
          replicator,
          directory: yield* Directory.MeshProjectDirectory.pipe(Effect.provide(context)),
          settings: yield* Settings.ServerSettingsService.pipe(Effect.provide(context)),
        });
      }
      ready = true;
      const a = nodes.get("A")!,
        b = nodes.get("B")!,
        c = nodes.get("C")!;
      const settle = Effect.gen(function* () {
        yield* a.replicator.sync;
        yield* b.replicator.sync;
        yield* a.replicator.sync;
      });
      yield* a.mesh.edit((config) => ({
        ...config,
        machines: { ...config.machines, A: { label: "A" } },
      }));
      yield* c.mesh.edit((config) => ({
        ...config,
        machines: { ...config.machines, C: { label: "C" } },
      }));
      yield* settle;
      expect(yield* a.mesh.read).toEqual(yield* c.mesh.read);
      expect(
        (yield* c.directory.read).find((catalog) => catalog.environmentId === "A")?.projects,
      ).toEqual([
        {
          id: "A-project",
          title: "Remote-only project",
          workspaceRoot: "/A/project",
          repositoryIdentity: {
            canonicalKey: "host/owner/project",
            origin: { canonicalKey: "host/owner/project" },
          },
          createdAt: "",
        },
      ]);
      expect((yield* c.mesh.read).config.projectMounts).toEqual({});
      catalogsSent.length = 0;
      yield* settle;
      expect(catalogsSent.every((count) => count === 0)).toBe(true);
      localProjects = [];
      yield* settle;
      expect(
        (yield* c.directory.read).find((catalog) => catalog.environmentId === "A")?.projects,
      ).toEqual([]);
      yield* a.settings.updateSettings({ meshEnabled: false });
      yield* a.mesh.apply({
        "machine/gated": { v: { label: "gated" }, h: "0000000000001.00000.gated" },
      });
      yield* a.replicator.sync;
      expect((yield* b.mesh.read).config.machines.gated).toBeUndefined();
      const refused = yield* a.replicator
        .exchange({ fromEnvironmentId: "B", entries: {}, seq: 0, ackReceivedSeq: 0 })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("disabled");
      yield* a.settings.updateSettings({ meshEnabled: true, linkedEnvironmentsEnabled: false });
      yield* a.replicator.sync;
      expect((yield* b.mesh.read).config.machines.gated).toBeUndefined();
      yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: true });
      yield* settle;
      expect((yield* c.mesh.read).config.machines.gated?.label).toBe("gated");
      partition = true;
      for (const [id, node] of nodes)
        yield* node.mesh.edit((config) => ({
          ...config,
          machines: { ...config.machines, [id]: { label: `offline ${id}` } },
        }));
      yield* a.replicator.sync;
      yield* b.replicator.sync;
      partition = false;
      yield* TestClock.adjust("3 seconds");
      yield* settle;
      expect(yield* a.mesh.read).toEqual(yield* b.mesh.read);
      expect(yield* b.mesh.read).toEqual(yield* c.mesh.read);
      const late = { "machine/old": { v: { label: "late" }, h: "0000000000001.00000.old" } };
      yield* c.mesh.apply(late);
      yield* settle;
      expect((yield* a.mesh.read).config.machines.old?.label).toBe("late");
      const snapshot = yield* a.mesh.read;
      yield* a.mesh.apply(snapshot.document);
      yield* settle;
      expect(yield* c.mesh.read).toEqual(snapshot);
    }).pipe(Effect.scoped),
);

it.effect("reports each peer's last exchange, error and sequence numbers", () =>
  Effect.gen(function* () {
    const peers = Layer.succeed(PeerMcpClient, {
      call: () => Effect.die("the status test never calls a peer"),
    });
    const links = Layer.mock(PeerLinks)({
      enabled: Effect.succeed(true),
      list: Effect.succeed([]),
    });
    const env = Layer.succeed(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("A")),
      getDescriptor: Effect.succeed(descriptorOf("A", "A")),
    });
    const context = yield* Layer.build(
      layer.pipe(
        Layer.provideMerge(Mesh.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            peers,
            links,
            env,
            Settings.layerTest({ linkedEnvironmentsEnabled: true }),
            Sqlite.layerMemory,
          ),
        ),
        Layer.fresh,
      ),
    );
    const replicator = yield* MeshReplicator.pipe(Effect.provide(context));
    const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(context));
    yield* sql`INSERT INTO mesh_peer_state(environment_id, sent_seq, received_seq, last_exchange_at, last_error) VALUES ('B', 4, 7, '2026-01-01T00:00:00.000Z', NULL)`;
    yield* sql`INSERT INTO mesh_peer_state(environment_id, sent_seq, received_seq, last_exchange_at, last_error) VALUES ('C', 0, 0, NULL, 'offline')`;
    expect(yield* replicator.status).toEqual({
      peers: [
        {
          environmentId: "B",
          lastExchangeAt: "2026-01-01T00:00:00.000Z",
          lastError: null,
          sentSeq: 4,
          receivedSeq: 7,
        },
        {
          environmentId: "C",
          lastExchangeAt: null,
          lastError: "offline",
          sentSeq: 0,
          receivedSeq: 0,
        },
      ],
    });
  }).pipe(Effect.scoped),
);
