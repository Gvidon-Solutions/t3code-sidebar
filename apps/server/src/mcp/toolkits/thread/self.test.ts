import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { descriptorOf } from "../../../peer/PeerLinks.testkit.ts";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type SidebarWorkspacesConfig,
  NodeId,
  ProviderDriverKind,
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

it.effect.each([
  "primary",
  "replica",
  "no project",
  "alias",
  "remote parent",
  "allocated replica",
  "descriptor",
  "renamed",
] as const)("self describes %s", (role) => {
  const base = liveThreadShell(ThreadId.make("mcp:self"));
  const shell = {
    ...base,
    ...(role === "remote parent"
      ? {
          delegatedFrom: {
            environmentId: EnvironmentId.make("parent-machine"),
            threadId: ThreadId.make("mcp:parent"),
            title: "Parent",
          },
        }
      : {}),
    branch: "topic",
    worktreePath: "/copy/worktree",
    lineage: {
      ...base.lineage,
      parentThreadId: role === "remote parent" ? null : ThreadId.make("mcp:parent"),
    },
  };
  const child = {
    ...liveThreadShell(ThreadId.make("mcp:child")),
    lineage: {
      ...base.lineage,
      parentThreadId: shell.id,
      relationshipToParent: "subagent" as const,
    },
  };
  const initial: SidebarWorkspacesConfig = {
    ...DEFAULT_SERVER_SETTINGS.sidebarWorkspaces,
    projectTitles: role === "renamed" ? { repo: "N-shared project title" } : {},
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
          role:
            role === "replica" || role === "allocated replica"
              ? ("replica" as const)
              : ("primary" as const),
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
  const namedConfig =
    role === "alias"
      ? {
          ...initial,
          projectAliases: { repo: "canonical" },
          projectMounts: { ...initial.projectMounts, canonical: initial.projectMounts.repo! },
        }
      : initial;
  const config =
    role === "descriptor"
      ? {
          ...namedConfig,
          machines: { ...namedConfig.machines, local: { reach: { source: { ssh: "gor" } } } },
        }
      : namedConfig;
  return Effect.gen(function* () {
    const tools = yield* ThreadToolkit.pipe(Effect.provide(HandlersLayer.layer(layer)));
    const results = yield* tools
      .handle("t3_thread_self", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    const result = results.at(-1)?.result;
    expect(result).toMatchObject({
      parentThreadId: "mcp:parent",
      parent: { threadId: "mcp:parent" },
      children: [{ threadId: "mcp:child" }],
      delegatedTasks: [
        { threadId: "mcp:remote-child", environmentId: "remote", status: "running" },
      ],
      workingDirectory: "/copy/worktree",
      worktreePath: "/copy/worktree",
      branch: "topic",
      threadId: "mcp:self",
      machine: { tag: role === "descriptor" ? "GO" : "LO" },
      representation: {
        role: role === "replica" || role === "allocated replica" ? "replica" : "primary",
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
    if (role === "alias") expect(result).toHaveProperty("project.logicalKey", "canonical");
    if (role === "remote parent")
      expect(result).toHaveProperty("parent.environmentId", "parent-machine");
    if (role === "renamed") {
      expect(result).toHaveProperty("project.logicalTitle", "N-shared project title");
      expect(result).toHaveProperty("project.title", "N-shared project title");
    }
    if (role === "allocated replica")
      expect(result).toHaveProperty("project.logicalTitle", "primary");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ServerEnvironment)({
          getDescriptor: Effect.succeed(descriptorOf("local", "Gor")),
        }),
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
          getProjectThreadRecords: () =>
            Effect.succeed({
              ...idleThreadProjection(shell),
              subagents: [
                {
                  id: NodeId.make("task"),
                  threadId: shell.id,
                  runId: null,
                  parentNodeId: NodeId.make("root"),
                  origin: "app_owned",
                  createdBy: "agent",
                  driver: ProviderDriverKind.make("codex"),
                  providerInstanceId: shell.providerInstanceId,
                  providerThreadId: null,
                  childThreadId: null,
                  remoteChild: {
                    environmentId: EnvironmentId.make("remote"),
                    threadId: ThreadId.make("mcp:remote-child"),
                    label: "Remote",
                  },
                  nativeTaskRef: null,
                  prompt: "task",
                  title: "Task",
                  model: null,
                  status: "running",
                  result: null,
                  startedAt: null,
                  completedAt: null,
                  updatedAt: shell.updatedAt,
                },
              ],
            }),
          listProjectThreads: () => Effect.succeed([child]),
        }),
        Layer.mock(ProjectService)({
          getById: () =>
            Effect.succeed(
              role === "no project"
                ? Option.none()
                : Option.some({
                    id: shell.projectId,
                    title: role === "allocated replica" ? "copy" : "Example",
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
              logicalKey: role === "alias" ? "canonical" : "repo",
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
