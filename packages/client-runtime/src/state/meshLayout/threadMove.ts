export const THREAD_DRAG_TYPE = "application/x-t3-thread";
export const CROSS_MACHINE_MOVE_MESSAGE =
  "Move to another machine needs a history export/import protocol for runs, messages, attachments, checkpoints and provider sessions. Context transfer only supports forks within one server.";

export function threadMoveValidity(
  source: { readonly environmentId: string; readonly projectId: string },
  target: { readonly environmentId: string; readonly id: string },
): "same-project" | "local" | "cross-machine" {
  if (source.environmentId !== target.environmentId) return "cross-machine";
  return source.projectId === target.id ? "same-project" : "local";
}
