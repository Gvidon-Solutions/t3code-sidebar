import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import type { ThreadTabMode } from "../../lib/threadTabs";
import { useThreadTabs } from "./useThreadTabs";

const SAVE_DELAY_MS = 500;

/**
 * The file screen's tab (sidebar fork): opens it, and remembers its mode and
 * reading position. Positions are pixels in preview and the first visible
 * line in source; surfaces read them once, when they mount.
 */
export function useThreadTabPosition(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly relativePath: string | null;
}) {
  const { environmentId, threadId, relativePath } = input;
  const threadKey =
    environmentId !== null && threadId !== null ? `${environmentId}:${threadId}` : null;
  const threadTabs = useThreadTabs(threadKey);
  const tab =
    relativePath === null
      ? undefined
      : threadTabs.tabs.find((entry) => entry.path === relativePath);

  // The tab actions change with every tab write; callbacks read them through a ref to stay stable.
  const tabsRef = useRef(threadTabs);
  useLayoutEffect(() => {
    tabsRef.current = threadTabs;
  }, [threadTabs]);
  useEffect(() => {
    if (threadKey !== null && relativePath !== null) tabsRef.current.open(relativePath);
  }, [relativePath, threadKey]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending save belongs to the file it was scheduled for.
  useEffect(() => () => clearTimeout(timerRef.current), [relativePath]);
  const savePosition = useCallback(
    (mode: ThreadTabMode, position: number) => {
      if (threadKey === null || relativePath === null) return;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => tabsRef.current.setScroll(relativePath, mode, position),
        SAVE_DELAY_MS,
      );
    },
    [relativePath, threadKey],
  );
  const setMode = useCallback(
    (mode: ThreadTabMode) => {
      if (threadKey !== null && relativePath !== null) tabsRef.current.setMode(relativePath, mode);
    },
    [relativePath, threadKey],
  );

  return {
    mode: tab?.mode,
    restorePosition: (mode: ThreadTabMode) => tab?.scroll?.[mode],
    savePosition,
    setMode,
  } as const;
}
