import { useAtomValue } from "@effect/atom-react";
import {
  createReplicaStatusAtoms,
  mergeReplicaStatusLists,
} from "@t3tools/client-runtime/state/mesh-layout";
import type { ReplicaLiveStatus } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";
import { environmentServerConfigsAtom } from "./server";

/** Fork: live replica status and retry, as the mesh sidebar needs them. */
export const replicaStatusEnvironment = createReplicaStatusAtoms(connectionAtomRuntime);

/**
 * One stream per connected environment that advertises the mesh RPCs, merged by
 * (logicalKey, environmentId). A server without the capability is skipped.
 */
export const replicaStatusesAtom = Atom.make((get): ReadonlyArray<ReplicaLiveStatus> => {
  const configs = get(environmentServerConfigsAtom);
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const lists: Array<{
    readonly environmentId: string;
    readonly replicas: ReadonlyArray<ReplicaLiveStatus>;
  }> = [];
  for (const environmentId of connected) {
    if (configs.get(environmentId)?.environment.capabilities.meshLayout !== true) continue;
    const value = Option.getOrNull(
      AsyncResult.value(get(replicaStatusEnvironment.live({ environmentId, input: {} }))),
    );
    if (value !== null) lists.push({ environmentId, replicas: value.replicas });
  }
  return mergeReplicaStatusLists(lists);
}).pipe(Atom.withLabel("web-replica-statuses"));

export function useReplicaStatuses(): ReadonlyArray<ReplicaLiveStatus> {
  return useAtomValue(replicaStatusesAtom);
}
