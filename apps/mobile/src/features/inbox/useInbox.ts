import { useAtomValue } from "@effect/atom-react";
import { countInbox } from "@t3tools/client-runtime/inbox";
import { createInboxAtoms } from "@t3tools/client-runtime/state/inbox";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { workspaceConnections } from "../../state/workspace";
import {
  INBOX_CLOSED_PAGE_SIZE,
  mergeInboxSources,
  type InboxListState,
  type InboxSource,
} from "./inboxList";

/** Fork: agent inbox. Atoms for every environment the phone talks to. */
export const inboxEnvironment = createInboxAtoms(connectionAtomRuntime);

/**
 * One list across every enabled environment. Each environment keeps its own
 * live subscription; one that fails (an older server without the inbox) is
 * left out without a message, and one that drops keeps its last snapshot.
 */
const inboxListAtom = Atom.family((closedLimit: number) =>
  Atom.make((get): InboxListState => {
    const sources: InboxSource[] = [];
    for (const environment of get(workspaceConnections.environmentsAtom)) {
      if (!environment.isEnabled) continue;
      const live = (limit: number) =>
        get(
          inboxEnvironment.inboxLive({
            environmentId: environment.environmentId,
            input: { closedLimit: limit },
          }),
        );
      const result = live(closedLimit);
      // "Show more" opens a larger subscription; show the first page until it lands.
      const snapshot = Option.getOrNull(
        AsyncResult.value(
          Option.isNone(AsyncResult.value(result)) && closedLimit !== INBOX_CLOSED_PAGE_SIZE
            ? live(INBOX_CLOSED_PAGE_SIZE)
            : result,
        ),
      );
      sources.push({
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel,
        snapshot,
        pending:
          snapshot === null &&
          result._tag !== "Failure" &&
          environment.connectionState === "connected",
      });
    }
    return mergeInboxSources(sources, closedLimit);
  }).pipe(Atom.withLabel(`mobile:inbox-list:${closedLimit}`)),
);

export function useInboxList(closedLimit: number = INBOX_CLOSED_PAGE_SIZE): InboxListState {
  return useAtomValue(inboxListAtom(closedLimit));
}

/** The header icon's counters: blue unread, red waiting for the owner. */
export function useInboxCounts() {
  const { items } = useInboxList();
  return useMemo(() => countInbox(items), [items]);
}
