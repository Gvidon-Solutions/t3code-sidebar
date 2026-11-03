import type {
  ModelSelection,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ThreadMoveInput,
} from "@t3tools/contracts";

export const THREAD_DRAG_TYPE = "application/x-t3-thread";
function threadMoveConfirmation(machine: string): string {
  return `Move to ${machine}? The conversation continues there; this thread is archived.`;
}

export function threadMoveValidity(
  source: { readonly environmentId: string; readonly projectId: string },
  target: { readonly environmentId: string; readonly id: string },
): "same-project" | "local" | "cross-machine" {
  if (source.environmentId !== target.environmentId) return "cross-machine";
  return source.projectId === target.id ? "same-project" : "local";
}

export async function moveThreadWithConfirmation<Result>(options: {
  readonly source: {
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  };
  readonly target: { readonly id: ProjectId; readonly environmentId: EnvironmentId };
  readonly modelSelection?: ModelSelection;
  readonly machine: string;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly move: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: ThreadMoveInput;
  }) => Promise<Result>;
}): Promise<Result | null> {
  const validity = threadMoveValidity(options.source, options.target);
  if (validity === "same-project" && options.modelSelection === undefined) return null;
  if (
    validity === "cross-machine" &&
    !(await options.confirm(threadMoveConfirmation(options.machine)))
  )
    return null;
  return options.move({
    environmentId: options.source.environmentId,
    input: {
      threadId: options.source.id,
      ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
      projectId: options.target.id,
      ...(validity === "cross-machine"
        ? { targetEnvironmentId: options.target.environmentId }
        : {}),
    },
  });
}
