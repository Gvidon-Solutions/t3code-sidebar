import { logicalProjectKeyForRecord } from "@t3tools/shared/meshLayout";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MeshLayoutService } from "../../../mesh/MeshLayoutService.ts";
import { ReplicaRuntime } from "../../../replicas/ReplicaRuntime.ts";
import { ProjectReplicaService } from "../../../replicas/ProjectReplicaService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { PeerLinks } from "../../../peer/PeerLinks.ts";
import { primarySshCommand } from "../../../replicas/ReplicaInstructions.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { threadLinkFor } from "../../McpInvocationContext.ts";

export const threadSelf = Effect.fn("mcp.threadSelf")(function* () {
  const {
    projection: { thread, subagents },
    scope,
    threads,
  } = yield* readThread(undefined, ["subagents"]);
  const mesh = yield* Effect.serviceOption(MeshLayoutService);
  const projects = yield* Effect.serviceOption(ProjectService);
  const replicas = yield* Effect.serviceOption(ProjectReplicaService);
  const links = yield* Effect.serviceOption(PeerLinks);
  const config = Option.isSome(mesh)
    ? (yield* mesh.value.read).config
    : DEFAULT_SERVER_SETTINGS.sidebarWorkspaces;
  const projectOption = Option.isSome(projects)
    ? yield* projects.value.getById(thread.projectId).pipe(Effect.mapError(unavailable))
    : Option.none();
  const project = Option.getOrUndefined(projectOption);
  const server = yield* Effect.serviceOption(ServerEnvironment);
  const descriptor = Option.isSome(server) ? yield* server.value.getDescriptor : undefined;
  const machine = (id: string) => ({
    environmentId: id,
    label:
      config.machines[id]?.label ??
      (id === scope.environmentId ? descriptor?.label : undefined) ??
      id,
    tag:
      config.machines[id]?.tag ??
      (
        config.machines[id]?.label ??
        (id === scope.environmentId ? descriptor?.label : undefined) ??
        id
      )
        .slice(0, 2)
        .toUpperCase(),
  });
  const logicalKey = project
    ? logicalProjectKeyForRecord(
        config,
        { ...project, environmentId: scope.environmentId },
        `${scope.environmentId}:${project.workspaceRoot}`,
      )
    : (Object.keys(config.projectMounts).find((key) =>
        config.projectMounts[key]!.some(
          (rep) => rep.environmentId === scope.environmentId && rep.projectId === thread.projectId,
        ),
      ) ?? null);
  const representations = logicalKey
    ? (config.projectMounts[logicalKey] ??
      (project
        ? [
            {
              environmentId: scope.environmentId,
              projectId: project.id,
              path: project.workspaceRoot,
              role: "primary" as const,
              transport: "git" as const,
              createdAt: project.createdAt,
            },
          ]
        : []))
    : [];
  const representation = representations.find((rep) => rep.environmentId === scope.environmentId);
  const runtime = yield* Effect.serviceOption(ReplicaRuntime);
  const live = Option.isSome(replicas)
    ? yield* replicas.value.status
    : Option.isSome(runtime)
      ? yield* runtime.value.get.pipe(
          Effect.flatMap((service) => service.status),
          Effect.mapError(unavailable),
        )
      : [];
  const status = live.find(
    (row) => row.logicalKey === logicalKey && row.environmentId === scope.environmentId,
  );
  const related = yield* threads
    .listProjectThreads({ includeSubagents: true })
    .pipe(Effect.mapError(unavailable));
  const parentId = thread.lineage.parentThreadId ?? thread.delegatedFrom?.threadId ?? null;
  const parentEnvironmentId = thread.lineage.parentThreadId
    ? scope.environmentId
    : (thread.delegatedFrom?.environmentId ?? scope.environmentId);
  const primary = representations.find((rep) => rep.role === "primary");
  const basename = (path: string) =>
    path.replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1) ?? path;
  const logicalTitle =
    (logicalKey ? config.projectTitles[logicalKey] : undefined) ??
    (project &&
    representation?.role === "replica" &&
    primary &&
    project.title === basename(project.workspaceRoot)
      ? basename(primary.path)
      : project?.title);
  const linked = Option.isSome(links)
    ? yield* links.value.list.pipe(Effect.mapError(unavailable))
    : [];
  return {
    threadId: thread.id,
    title: thread.title,
    link: threadLinkFor(scope, thread.id),
    machine: machine(scope.environmentId),
    project: project
      ? {
          id: project.id,
          title: logicalTitle ?? project.title,
          logicalKey,
          logicalTitle: logicalTitle ?? project.title,
        }
      : null,
    workingDirectory: thread.worktreePath ?? project?.workspaceRoot ?? null,
    worktreePath: thread.worktreePath,
    branch: thread.branch,
    representation: {
      role: representation?.role ?? "primary",
      transport: representation?.transport ?? "git",
      source: representation?.source
        ? {
            machine: machine(representation.source),
            path:
              representations.find((rep) => rep.environmentId === representation.source)?.path ??
              null,
          }
        : null,
      sync: status ?? null,
    },
    primaries: representations
      .filter((rep) => rep.role === "primary")
      .map((rep) => ({
        machine: machine(rep.environmentId),
        path: rep.path,
        ssh: primarySshCommand(config, scope.environmentId, rep.environmentId, rep.path),
      })),
    representations,
    linkedMachines: linked.map((link) => ({
      ...machine(link.environmentId),
      status: link.status,
      access: link.access,
      lastError: link.lastError,
    })),
    parentThreadId: parentId,
    delegatedTasks: subagents.map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      threadId: task.remoteChild?.threadId ?? task.childThreadId,
      environmentId: task.remoteChild?.environmentId ?? scope.environmentId,
    })),
    parent: parentId
      ? {
          threadId: parentId,
          environmentId: parentEnvironmentId,
          link: threadLinkFor({ ...scope, environmentId: parentEnvironmentId }, parentId),
          title:
            thread.delegatedFrom?.title ??
            related.find((row) => row.id === parentId)?.title ??
            null,
        }
      : null,
    children: related
      .filter((child) => child.lineage.parentThreadId === thread.id)
      .map((child) => ({
        threadId: child.id,
        title: child.title,
        link: threadLinkFor(scope, child.id),
      })),
  };
});
