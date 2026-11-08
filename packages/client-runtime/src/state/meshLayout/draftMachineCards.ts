import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

import { machineDisplayOf, type MachineDisplay } from "../machineDisplay.ts";

/** How a new-thread machine card describes the copy the draft would use. */
export type DraftMachineCardStatus =
  | "synced"
  | "copying"
  | "out-of-sync"
  | "will-copy"
  | "no-models"
  | "unreachable";

export interface DraftMachineCardStateInput {
  readonly label: string;
  /** This client has a connection to the machine. */
  readonly connected: boolean;
  /** The mesh can reach the machine, even when this client is not connected to it. */
  readonly reachable: boolean;
  readonly viaLabel?: string | null | undefined;
  readonly hasProject: boolean;
  /** Null when the machine's provider catalog is unknown to this client. */
  readonly hasUsableModels: boolean | null;
  readonly sync?: "synced" | "copying" | "out-of-sync" | null | undefined;
}

export interface DraftMachineCardState {
  readonly status: DraftMachineCardStatus;
  readonly text: string;
  readonly selectable: boolean;
}

/**
 * One card's plain sentence. A machine that the mesh reaches but this client cannot
 * connect to is not called "not connected": it is named by the way it is reachable.
 */
export function draftMachineCardState(input: DraftMachineCardStateInput): DraftMachineCardState {
  if (!input.connected && !input.reachable) {
    return { status: "unreachable", text: `Can't reach ${input.label}`, selectable: false };
  }
  // A machine reached through the mesh still describes its copy; this device just
  // cannot start a thread there until it connects to that machine directly.
  const selectable = input.connected;
  if (input.hasUsableModels === false) {
    return {
      status: "no-models",
      text: `No models set up on ${input.label}`,
      selectable: false,
    };
  }
  if (input.sync === "copying") {
    return { status: "copying", text: "Copying files…", selectable };
  }
  if (input.sync === "out-of-sync") {
    return { status: "out-of-sync", text: "Out of sync", selectable };
  }
  if (!input.hasProject) {
    return { status: "will-copy", text: "Will set up a copy here", selectable };
  }
  return { status: "synced", text: "Synced", selectable };
}

export interface DraftMachineCardChoice {
  readonly environmentId: string;
  readonly label: string;
  readonly projectId: string | null;
  readonly primary: boolean;
  readonly connected: boolean;
  readonly hasUsableModels: boolean | null;
  readonly sync?: "synced" | "copying" | "out-of-sync" | null | undefined;
}

export interface DraftMachineCardReachability {
  readonly reachable: boolean;
  readonly viaLabel?: string | null | undefined;
}

export interface DraftMachineCardRow extends DraftMachineCardState {
  readonly environmentId: string;
  readonly label: string;
  readonly machine: MachineDisplay;
  readonly primary: boolean;
  readonly selected: boolean;
  /** Why a card is dimmed, for its tooltip; null when it can be picked. */
  readonly hint: string | null;
}

/**
 * The cards shown above a new-thread composer: one per machine that can run the
 * project, primary first. A single machine needs no choice, so it gets no cards.
 */
export function draftMachineCards(input: {
  readonly config: Pick<SidebarWorkspacesConfig, "machines">;
  readonly choices: readonly DraftMachineCardChoice[];
  readonly reachability: Readonly<Record<string, DraftMachineCardReachability | undefined>>;
  readonly selectedEnvironmentId: string | null;
}): DraftMachineCardRow[] {
  if (input.choices.length <= 1) return [];
  return input.choices
    .map((choice) => {
      const reach = input.reachability[choice.environmentId];
      const state = draftMachineCardState({
        label: choice.label,
        connected: choice.connected,
        reachable: reach?.reachable ?? false,
        viaLabel: reach?.viaLabel ?? null,
        hasProject: choice.projectId !== null,
        hasUsableModels: choice.hasUsableModels,
        sync: choice.sync ?? null,
      });
      const via = reach?.viaLabel?.trim();
      return {
        ...state,
        environmentId: choice.environmentId,
        label: choice.label,
        machine: machineDisplayOf(input.config, choice.environmentId, choice.label),
        primary: choice.primary,
        selected: input.selectedEnvironmentId === choice.environmentId,
        hint: state.selectable
          ? null
          : state.status === "unreachable"
            ? `Can't reach ${choice.label}.`
            : via
              ? `Reachable through ${via}. Connect this device to ${choice.label} to start a thread here.`
              : `Connect this device to ${choice.label} to start a thread here.`,
      };
    })
    .sort((left, right) => {
      if (left.primary !== right.primary) return left.primary ? -1 : 1;
      if (left.selectable !== right.selectable) return left.selectable ? -1 : 1;
      return left.label.localeCompare(right.label);
    });
}

/** Sync state from a live replica status, in the card's three plain words. */
export function draftMachineCardSync(
  state: string | null | undefined,
): "synced" | "copying" | "out-of-sync" | null {
  switch (state) {
    case "watching":
      return "synced";
    case "pending":
    case "mounting":
      return "copying";
    case "conflict":
    case "paused":
    case "error":
      return "out-of-sync";
    default:
      return null;
  }
}
