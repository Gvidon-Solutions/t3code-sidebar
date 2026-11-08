import * as MeshTestServices from "../../testFixtures/meshServices.ts";
import { lookupMeshProject } from "./meshProjectLookup.ts";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import { EnvironmentId, ProjectId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import { ProjectReplicaService } from "./ProjectReplicaService.ts";
import { makeReplicaHarness } from "./replicas.testkit.ts";

const decodeCursor = Schema.decodeUnknownSync(Schema.Struct({ cursor: Schema.Number }));

it.effect.each([
  { represented: true, relay: false },
  { represented: false, relay: false },
  { represented: false, relay: true },
  { represented: false, relay: false, brokenPage: true },
])(
  "resolves a remote-only name and places from its actual primary: %o",
  ({ represented, relay, brokenPage = false }) =>
    Effect.gen(function* () {
      const h = makeReplicaHarness();
      const now = yield* DateTime.now;
      const source = {
        environmentId: EnvironmentId.make(relay ? "bridge" : "source"),
        label: relay ? "Bridge" : "Source",
        urls: ["http://127.0.0.1"],
        access: "full-access" as const,
        linkedAt: now,
        expiresAt: now,
        lastReachedAt: now,
        lastError: null,
        status: "reachable" as const,
      };
      const remote = {
        id: ProjectId.make("remote-handle"),
        title: "Remote title",
        workspaceRoot: "/remote/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "",
        updatedAt: "",
        deletedAt: null,
      };
      const calls: { environmentId: string; tool: string }[] = [];
      const peers = Layer.mergeAll(
        (() => {
          const list = Effect.succeed([source]);
          return Layer.mock(PeerLinks)({
            enabled: Effect.succeed(true),
            list,
            get: (id) =>
              Effect.succeed(id === source.environmentId ? Option.some(source) : Option.none()),
            ids: Effect.map(list, (peers) => peers.map((peer) => peer.environmentId)),
          });
        })(),
        Layer.succeed(
          PeerMcpClient,
          PeerMcpClient.of({
            call: (input) => {
              calls.push({ environmentId: input.environmentId, tool: input.tool });
              const cursor =
                input.tool === "t3_mesh_relay"
                  ? decodeCursor(input.arguments.arguments).cursor
                  : input.arguments.cursor;
              if (brokenPage && cursor === 100)
                return Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: "Second page unavailable",
                  }),
                );
              const value =
                input.tool === "t3_mesh_routes"
                  ? relay
                    ? ["source"]
                    : []
                  : relay && input.environmentId === "bridge" && input.tool !== "t3_mesh_relay"
                    ? { projects: [], nextCursor: null }
                    : cursor === 0
                      ? { projects: brokenPage ? [remote] : [], nextCursor: 100 }
                      : { projects: [remote], nextCursor: null };
              // oxlint-disable-next-line t3code/no-inline-schema-compile -- Each peer call supplies its own result schema.
              return Schema.decodeEffect(input.success)(value).pipe(
                Effect.mapError(
                  () =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: "Invalid fixture response",
                    }),
                ),
              );
            },
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* ProjectReplicaService;
        const mesh = yield* MeshLayoutService;
        yield* mesh.edit((config) => ({
          ...config,
          projectMounts: represented
            ? {
                logical: [
                  {
                    environmentId: "source",
                    path: remote.workspaceRoot,
                    projectId: remote.id,
                    role: "primary",
                    transport: "git",
                    createdAt: "",
                  },
                ],
              }
            : {},
          projectTitles: {},
        }));
        const before = (yield* mesh.read).document;
        if (brokenPage) {
          const error = yield* service.machines("remote TITLE").pipe(Effect.flip);
          expect(error.reason).toBe("unreachable");
          expect(error.message).toContain("Second page unavailable");
          expect((yield* mesh.read).document).toEqual(before);
          return;
        }
        const result = yield* service.machines("remote TITLE");
        expect(result.title).toBe(remote.title);
        expect(result.representations).toMatchObject([
          { environmentId: "source", path: remote.workspaceRoot, projectId: remote.id },
        ]);
        if (represented) expect(result.logicalKey).toBe("logical");
        expect((yield* mesh.read).document).toEqual(before);
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "N-mesh-lookup-",
        });
        const placed = yield* service.place({
          project: "Remote title",
          machine: "replica",
          path: `${root}/copy`,
        });
        if (relay)
          expect(
            calls.some((call) => call.tool === "t3_mesh_relay" && call.environmentId === "bridge"),
          ).toBe(true);
        expect(placed.logicalKey).toBe(result.logicalKey);
        expect(placed.representation).toMatchObject({
          environmentId: "replica",
          source: "source",
          role: "replica",
        });
        expect(
          (yield* mesh.read).config.projectMounts[result.logicalKey]?.find(
            (rep) => rep.role === "primary",
          ),
        ).toMatchObject({
          environmentId: "source",
          path: remote.workspaceRoot,
          projectId: remote.id,
        });
      }).pipe(Effect.scoped, Effect.provide(h.layer.pipe(Layer.provideMerge(peers))));
    }).pipe(Effect.provide(MeshTestServices.required)),
);

it.effect("rejects ambiguous unbound project names rather than allocating a second project", () =>
  Effect.gen(function* () {
    const config = DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
    const project = {
      id: ProjectId.make("one"),
      title: "Shared name",
      workspaceRoot: "/one",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "",
      updatedAt: "",
      deletedAt: null,
    };
    for (const layout of [config, { ...config, projectTitles: { logical: "Shared name" } }]) {
      const error = yield* lookupMeshProject(layout, "Shared name", "self", [
        project,
        { ...project, id: ProjectId.make("two"), workspaceRoot: "/two" },
      ]).pipe(Effect.flip);
      expect(error.message).toContain("More than one project");
    }
  }).pipe(Effect.provide(MeshTestServices.required)),
);

it.effect("retains logical projects with zero representations in layout lookup", () =>
  Effect.gen(function* () {
    const config = {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      projectTitles: { logical: "Unplaced project" },
    };
    expect(yield* lookupMeshProject(config, "Unplaced project", "self", [])).toEqual({
      logicalKey: "logical",
      records: [],
    });
  }).pipe(Effect.provide(MeshTestServices.required)),
);
