import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import {
  closeThreadTab,
  openThreadTab,
  updateThreadTab,
  withThreadTabs,
  type ThreadTabMode,
  type ThreadTabsState,
} from "../../lib/threadTabs";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Open file tabs of one thread (`environmentId:threadId`), persisted on this device. */
export function useThreadTabs(threadKey: string | null) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const state =
    threadKey !== null && AsyncResult.isSuccess(preferencesResult)
      ? preferencesResult.value.threadTabs?.[threadKey]
      : undefined;

  const write = useCallback(
    (next: (current: ThreadTabsState | undefined) => ThreadTabsState) => {
      if (threadKey === null) return;
      savePreferences({
        transform: (current) => ({
          threadTabs: withThreadTabs(
            current.threadTabs,
            threadKey,
            next(current.threadTabs?.[threadKey]),
          ),
        }),
      });
    },
    [savePreferences, threadKey],
  );

  return useMemo(
    () => ({
      tabs: state?.tabs ?? [],
      open: (path: string) => write((current) => openThreadTab(current, path, Date.now())),
      close: (path: string) => write((current) => closeThreadTab(current, path, Date.now())),
      setMode: (path: string, mode: ThreadTabMode) =>
        write((current) => updateThreadTab(current, path, { mode }, Date.now())),
      setScroll: (path: string, mode: ThreadTabMode, y: number) =>
        write((current) => updateThreadTab(current, path, { scroll: { mode, y } }, Date.now())),
    }),
    [state, write],
  );
}
