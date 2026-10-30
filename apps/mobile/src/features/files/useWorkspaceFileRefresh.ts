import { useIsFocused } from "@react-navigation/native";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
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

/** How often an open file on screen re-checks the disk, so edits from anywhere show up. */
export const OPEN_FILE_POLL_MS = 2_000;
/** Text files above this are not re-read on every poll. */
export const OPEN_FILE_POLL_MAX_BYTES = 512 * 1024;

/** True while the file screen is focused and the app is in the foreground. */
export function useOpenFileScreenActive(enabled: boolean): boolean {
  const focused = useIsFocused();
  const [appState, setAppState] = useState(AppState.currentState);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState to know whether the app is in the foreground
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);
  return enabled && focused && appState === "active";
}

/**
 * Keeps an open workspace file current (sidebar fork): the read is cached, so re-read it after
 * each workspace mutation of the thread and on every return to the screen or the app, and poll
 * while it is on screen so edits made outside the thread show up.
 */
export function useWorkspaceFileRefresh(input: {
  readonly enabled: boolean;
  /** Polling re-reads the whole file, so large files rely on the other triggers. */
  readonly poll: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly resourceKey: string;
  readonly refresh: () => void;
}): void {
  const { environmentId, threadId, resourceKey, poll } = input;
  const refresh = useEffectEvent(input.refresh);

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
  const active = useOpenFileScreenActive(input.enabled);

  // The first run also re-reads on open and on each return, so a cached copy never survives.
  const handledRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the open file from the server after workspace mutations and on each return
  useEffect(() => {
    if (!active) {
      handledRef.current = null;
      return;
    }
    const token = `${resourceKey}\u0000${mutationId ?? ""}`;
    if (token === handledRef.current) return;
    handledRef.current = token;
    refresh();
  }, [active, mutationId, resourceKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the open file on a timer while its screen is active
  useEffect(() => {
    if (!active || !poll) return;
    const timer = setInterval(() => refresh(), OPEN_FILE_POLL_MS);
    return () => clearInterval(timer);
  }, [active, poll]);
}
