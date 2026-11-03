import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ThreadToolkit } from "./tools.ts";
import { layer } from "./handlers.ts";
import { HandlersLayer } from "../../McpToolAccess.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { ProjectReplicaService } from "../../../replicas/ProjectReplicaService.ts";
import { MeshLayoutService } from "../../../mesh/MeshLayoutService.ts";

it.effect.each(["primary", "replica", "no project"] as const)("self describes %s", (role) => {
  const shell = liveThreadShell(ThreadId.make("mcp:self"));
  const config = {
    ...DEFAULT_SERVER_SETTINGS.sidebarWorkspaces,
    machines: {
      local: { label: "Local", tag: "LO", reach: { source: { ssh: "gor" } } },
      source: { label: "Gor", tag: "GO" },
    },
    projectMounts: {
      repo: [
        {
          environmentId: "local",
          projectId: shell.projectId,
          path: "/copy",
          role: role === "replica" ? ("replica" as const) : ("primary" as const),
          transport: "mutagen" as const,
          source: "source",
          createdAt: "",
        },
        {
          environmentId: "source",
          path: "/primary",
          role: "primary" as const,
          transport: "git" as const,
          createdAt: "",
        },
      ],
    },
  };
  return Effect.gen(function* () {
    const tools = yield* ThreadToolkit.pipe(Effect.provide(HandlersLayer.layer(layer)));
    const results = yield* tools
      .handle("t3_thread_self", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    const result = results.at(-1)?.result;
    expect(result).toMatchObject({
      threadId: "mcp:self",
      machine: { tag: "LO" },
      representation: {
        role: role === "replica" ? "replica" : "primary",
        sync: { sessionName: "t3-repo-local", state: "conflict", conflicts: ["file"] },
      },
      primaries: expect.arrayContaining([
        expect.objectContaining({
          machine: { environmentId: "source", label: "Gor", tag: "GO" },
          path: "/primary",
          ssh: expect.stringContaining("ssh 'gor'"),
        }),
      ]),
    });
    if (role === "no project") expect(result).toHaveProperty("project", null);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(McpInvocationContext, {
          environmentId: EnvironmentId.make("local"),
          requestNamespace: "self",
          thread: {
            threadId: shell.id,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "self",
          },
          client: undefined,
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
          listProjectThreads: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService)({
          getById: () =>
            Effect.succeed(
              role === "no project"
                ? Option.none()
                : Option.some({
                    id: shell.projectId,
                    title: "Example",
                    workspaceRoot: "/copy",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-01T00:00:00Z",
                    deletedAt: null,
                  }),
            ),
        }),
        Layer.mock(MeshLayoutService)({
          environmentId: "local",
          read: Effect.succeed({ config, document: {} }),
        }),
        Layer.mock(ProjectReplicaService)({
          status: Effect.succeed([
            {
              logicalKey: "repo",
              environmentId: "local",
              sessionName: "t3-repo-local",
              state: "conflict",
              conflicts: ["file"],
              problems: [],
              updatedAt: "",
            },
          ]),
        }),
      ),
    ),
  );
});
