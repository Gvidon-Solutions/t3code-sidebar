import { useAtomValue } from "@effect/atom-react";
import { createInboxAtoms } from "@t3tools/client-runtime/state/inbox";
import type { EnvironmentId, InboxSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  type InboxEnvironmentInput,
  type InboxState,
  INBOX_CLOSED_PAGE_SIZE,
  mergeInboxEnvironments,
} from "../components/inbox/inbox.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "./presentation";

/** Fork: agent inbox. See FORK.md, "Agent inbox". */
export const inboxAtoms = createInboxAtoms(connectionAtomRuntime);

/** How many closed issues every environment's subscription includes. */
export const inboxClosedLimitAtom = Atom.make(INBOX_CLOSED_PAGE_SIZE).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-inbox-closed-limit"),
);

export function showMoreClosedInboxIssues(): void {
  appAtomRegistry.update(inboxClosedLimitAtom, (limit) => limit + INBOX_CLOSED_PAGE_SIZE);
}

/**
 * One inbox across every connected environment's live subscription. A server without an inbox
 * never yields a snapshot and is skipped. A restarting subscription keeps its previous snapshot,
 * so the list and notification marks do not blink.
 */
export const inboxStateAtom = Atom.make((get): InboxState => {
  const closedLimit = get(inboxClosedLimitAtom);
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const identities = get(environmentSummaries.identitiesAtom);
  const previous = Option.getOrNull(get.self<InboxState>());
  const labels = new Map<EnvironmentId, string>(
    identities.map((identity) => [identity.environmentId, identity.label]),
  );
  const inputs: InboxEnvironmentInput[] = [];
  for (const environmentId of connected) {
    const snapshot: InboxSnapshot | null = Option.getOrNull(
      AsyncResult.value(get(inboxAtoms.inboxLive({ environmentId, input: { closedLimit } }))),
    );
    const prior = previous?.environments.find((entry) => entry.environmentId === environmentId);
    if (snapshot === null && prior === undefined) continue;
    inputs.push({
      environmentId,
      environmentLabel: labels.get(environmentId) ?? environmentId,
      snapshot: snapshot ?? prior!.snapshot,
    });
  }
  return mergeInboxEnvironments(inputs, previous);
}).pipe(Atom.withLabel("web-inbox-state"));

export function useInboxState(): InboxState {
  return useAtomValue(inboxStateAtom);
}

export function useInboxClosedLimit(): number {
  return useAtomValue(inboxClosedLimitAtom);
}
