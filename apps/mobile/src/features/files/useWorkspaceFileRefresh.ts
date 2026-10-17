import { useIsFocused } from "@react-navigation/native";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";

import { useThreadProjection, useThreadVisibleTurnItems } from "../../state/use-thread-detail";

/**
 * The latest settled item after which files on disk may have changed, as on web
 * (`ChatView`'s `workspaceMutationId`). File tools are explicit; completed commands
 * count because a shell command can change the workspace without naming the paths.
 */
export function workspaceMutationId(
  visibleTurnItems: OrchestrationV2ThreadProjection["visibleTurnItems"],
  latestCheckpointCompletedAt: string | null,
): string | null {
  let itemId: string | null = null;
  for (let index = visibleTurnItems.length - 1; index >= 0; index -= 1) {
    const item = visibleTurnItems[index]?.item;
    if (!item) continue;
    if (item.type !== "command_execution" && item.type !== "file_change") continue;
    if (item.status === "pending" || item.status === "running" || item.status === "waiting") {
      continue;
    }
    itemId = item.id;
    break;
  }
  return itemId === null && latestCheckpointCompletedAt === null
    ? null
    : JSON.stringify([itemId, latestCheckpointCompletedAt]);
}

/**
 * Keeps an open workspace file current (sidebar fork). The read is cached, so
 * without this the screen kept showing the copy from its first visit while the
 * agent edited the file. Re-reads after each workspace mutation of the thread,
 * when the screen regains focus and when the app returns to the foreground.
 */
export function useWorkspaceFileRefresh(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly resourceKey: string;
  readonly refresh: () => void;
}): void {
  const { enabled, environmentId, threadId, resourceKey } = input;
  const refreshRef = useRef(input.refresh);
  refreshRef.current = input.refresh;

  const thread = useThreadProjection({ environmentId, threadId });
  const visibleTurnItems = useThreadVisibleTurnItems({ environmentId, threadId });
  const latestCheckpointCompletedAt = useMemo(
    () =>
      thread === null
        ? null
        : (deriveThreadCheckpointSummaries(thread.projection).at(-1)?.completedAt ?? null),
    [thread],
  );
  const mutationId = workspaceMutationId(visibleTurnItems, latestCheckpointCompletedAt);
  const focused = useIsFocused();
  const active = enabled && focused;

  // The first run also re-reads on open and on refocus, so a cached copy never survives a visit.
  const handledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active) {
      handledRef.current = null;
      return;
    }
    const token = `${resourceKey}\u0000${mutationId ?? ""}`;
    if (token === handledRef.current) return;
    handledRef.current = token;
    refreshRef.current();
  }, [active, mutationId, resourceKey]);

  useEffect(() => {
    if (!active) return;
    let state = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      if (state !== "active" && next === "active") refreshRef.current();
      state = next;
    });
    return () => subscription.remove();
  }, [active]);
}
