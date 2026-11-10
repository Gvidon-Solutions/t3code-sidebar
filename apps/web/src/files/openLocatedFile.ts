import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readMeshLayoutConfigSnapshot } from "../state/meshLayoutConfig";
import { environmentSummaries } from "../state/presentation";

/** The fields a resolver, a picker choice or `ui_open` hands to the right panel. */
export interface LocatedFileTarget {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly line?: number;
  readonly root?: string;
  readonly rawPath?: string;
  readonly displayPath?: string;
  readonly projectTitle?: string;
  readonly inProject?: boolean;
  readonly notSynced?: boolean;
  readonly worktreeRemoved?: boolean;
}

/** The one open path for a resolved file on web; `ui_open` and picker choices use it. */
export function openLocatedFile(threadRef: ScopedThreadRef, target: LocatedFileTarget): void {
  const identityLabel =
    appAtomRegistry
      .get(environmentSummaries.identitiesAtom)
      .find((identity) => identity.environmentId === target.environmentId)?.label ??
    String(target.environmentId);
  const machineLabel = machineDisplayOf(
    readMeshLayoutConfigSnapshot() ?? { machines: {} },
    target.environmentId,
    identityLabel,
  ).label;
  const details = {
    ...(target.notSynced ? { notSynced: true } : {}),
    ...(target.rawPath === undefined ? {} : { rawPath: target.rawPath }),
    ...(target.displayPath === undefined ? {} : { resolvedDisplayPath: target.displayPath }),
    ...(target.root === undefined ? {} : { root: target.root }),
    ...(target.inProject === false ? { inProject: false } : {}),
    ...(target.worktreeRemoved ? { worktreeRemoved: true } : {}),
  };
  if (target.environmentId !== threadRef.environmentId) {
    useRightPanelStore.getState().openFile(
      threadRef,
      target.absolutePath,
      target.line,
      {
        environmentId: target.environmentId,
        workspaceRoot: target.root ?? "/",
        projectName: target.projectTitle ?? machineLabel,
        machineLabel,
        ...(target.notSynced ? { notSynced: true } : {}),
        ...(target.rawPath === undefined ? {} : { rawPath: target.rawPath }),
      },
      details,
    );
    return;
  }
  useRightPanelStore
    .getState()
    .openFile(threadRef, target.absolutePath, target.line, undefined, details);
}
