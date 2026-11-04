import { threadProjectTarget } from "@t3tools/shared/meshLayout";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import type {
  ModelSelection,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ThreadMoveInput,
} from "@t3tools/contracts";

export const THREAD_DRAG_TYPE = "application/x-t3-thread";

export function threadMoveValidity(
  source: { readonly environmentId: string; readonly projectId: string },
  target: { readonly environmentId: string; readonly id: string },
): "same-project" | "local" {
  if (source.environmentId !== target.environmentId) {
    throw new Error("Cross-machine moves are not supported; fork the thread instead.");
  }
  return source.projectId === target.id ? "same-project" : "local";
}

/** A move only changes the project on the same machine; it never needs a model. */
export async function moveThread<Result>(options: {
  readonly source: {
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  };
  readonly target: { readonly id: ProjectId; readonly environmentId: EnvironmentId };
  readonly modelSelection?: ModelSelection;
  readonly move: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: ThreadMoveInput;
  }) => Promise<Result>;
}): Promise<Result | null> {
  const validity = threadMoveValidity(options.source, options.target);
  if (validity === "same-project" && options.modelSelection === undefined) return null;
  return options.move({
    environmentId: options.source.environmentId,
    input: {
      threadId: options.source.id,
      ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
      projectId: options.target.id,
    },
  });
}

export function localThreadMoveTarget<
  T extends { readonly environmentId: string; readonly id: string },
>(
  config: SidebarWorkspacesConfig,
  sourceEnvironmentId: string,
  target: T,
  projects: readonly T[],
): T {
  const resolved = threadProjectTarget(config, sourceEnvironmentId, {
    environmentId: target.environmentId,
    projectId: target.id,
  });
  return (
    projects.find(
      (project) =>
        project.environmentId === sourceEnvironmentId && project.id === resolved.local?.projectId,
    ) ?? target
  );
}
