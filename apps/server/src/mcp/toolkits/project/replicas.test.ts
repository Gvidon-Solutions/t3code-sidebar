import { layerLinkedTest } from "../../../replicas/MeshLayoutTestLayer.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import type * as Tool from "effect/ai/Tool";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import { EnvironmentId, type AuthMcpClientAccess } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Runtime from "../../../replicas/ReplicaRuntime.ts";
import * as Replicas from "../../../replicas/ProjectReplicaService.ts";
import { MeshLayoutService } from "../../../mesh/MeshLayoutService.ts";
import { makeReplicaHarness } from "../../../replicas/replicas.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const client = (access: AuthMcpClientAccess, linked = false) =>
  Layer.succeed(Invocation.McpInvocationContext, {
    environmentId: EnvironmentId.make("source"),
    requestNamespace: "client:replica-test",
    thread: undefined,
    client: {
      sessionId: "replica-test",
      label: "test",
      access,
      linked,
      ...(linked ? { peerEnvironmentId: EnvironmentId.make("replica") } : {}),
    },
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  });

it.effect(
  "MCP places and lists representations by machine tag and refuses unverifiable removal or read-only writes",
  () =>
    Effect.gen(function* () {
      const h = makeReplicaHarness("source", true);
      let driverUnavailable = false;
      const forwarding = Layer.mock(PeerForwarding.PeerForwarding)({
        call: (_scope, tool, _target, params) => {
          expect(params).toMatchObject({ project: "repo", live: false });
          return driverUnavailable
            ? Effect.fail(
                new OrchestratorMcpFailure({ code: "orchestration_error", message: "offline" }),
              )
            : Effect.succeed({
                logicalKey: "repo",
                representations: [
                  {
                    environmentId: "replica",
                    path: "/replica",
                    transport: "mutagen",
                    role: "replica",
                    source: "source",
                    createdAt: "",
                    machine: "Replica",
                    live: {
                      logicalKey: "repo",
                      environmentId: "replica",
                      state: "mounting",
                      progress: 0.4,
                      conflicts: [],
                      problems: [],
                      updatedAt: "",
                    },
                  },
                ],
              } as unknown as Tool.Success<typeof tool>);
        },
      });
      const dependencies = Layer.mergeAll(
        forwarding,
        client("full-access"),
        Layer.mock(Threads.ThreadManagementService)({}),
        Layer.effect(
          Runtime.ReplicaRuntime,
          Effect.map(Replicas.ProjectReplicaService, (service) => ({
            get: Effect.succeed(service),
          })),
        ),
      ).pipe(Layer.provideMerge(h.layer));
      yield* Effect.gen(function* () {
        const mesh = yield* MeshLayoutService;
        yield* mesh.edit((config) => ({
          ...config,
          machines: { ...config.machines, newPeer: { label: "New peer", tag: "NP" } },
        }));
        const tools = yield* ProjectToolkit.pipe(
          Effect.provide(McpToolAccess.HandlersLayer.layer(Handlers.layer)),
        );
        const added = yield* tools
          .handle("t3_project_place", { project: "Example", machine: "NP" })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(added.at(-1)?.result).toMatchObject({
          logicalKey: "repo",
          ready: false,
          representation: { environmentId: "newPeer", role: "replica", source: "source" },
        });
        const listed = yield* tools
          .handle("t3_project_machines", { project: "repo" })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(listed.at(-1)?.result).toMatchObject({
          logicalKey: "repo",
          representations: expect.arrayContaining([
            expect.objectContaining({ environmentId: "newPeer", tag: "NP" }),
          ]),
        });
        yield* mesh.edit((config) => ({
          ...config,
          machines: { ...config.machines, replica: {} },
        }));
        const live = yield* tools
          .handle("t3_project_machines", { project: "repo" })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(live.at(-1)?.result).toMatchObject({
          representations: expect.arrayContaining([
            expect.objectContaining({
              environmentId: "replica",
              live: expect.objectContaining({ progress: 0.4 }),
            }),
          ]),
        });
        driverUnavailable = true;
        const offline = yield* tools
          .handle("t3_project_machines", { project: "repo" })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(offline.at(-1)?.result).toMatchObject({
          representations: expect.arrayContaining([
            expect.objectContaining({
              environmentId: "replica",
              driverEnvironmentId: "replica",
            }),
          ]),
        });
        expect(JSON.stringify(offline.at(-1)?.result)).not.toContain('"state":"error"');
        const denied = yield* tools
          .handle("t3_project_place", { project: "repo", machine: "NP", action: "remove" })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(client("read-only")));
        expect(denied.at(-1)?.result).toMatchObject({ code: "capability_denied" });
        const fenced = yield* tools
          .handle("t3_project_place", { project: "repo", machine: "NP", action: "remove" })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provide(
              Layer.merge(
                client("auto", true),
                layerLinkedTest("source", { source: "source", replica: "replica" }),
              ),
            ),
          );
        expect(fenced.at(-1)?.result).toMatchObject({
          code: "capability_denied",
          message: expect.stringContaining("linked environment"),
        });
        expect(
          (yield* mesh.read).config.projectMounts.repo!.some(
            (rep) => rep.environmentId === "newPeer",
          ),
        ).toBe(true);
        const removed = yield* tools
          .handle("t3_project_place", { project: "repo", machine: "NP", action: "remove" })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(removed.at(-1)?.result).toMatchObject({
          code: "invalid_request",
          message: "Cannot reach the replica driver to verify unsynced changes.",
        });
        expect(
          (yield* mesh.read).config.projectMounts.repo!.some(
            (rep) => rep.environmentId === "newPeer",
          ),
        ).toBe(true);
        expect(h.terminated).toEqual([]);
      }).pipe(Effect.provide(dependencies));
    }),
);
