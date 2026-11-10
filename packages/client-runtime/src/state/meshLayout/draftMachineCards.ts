import type { ModelSelection, ProjectId, SidebarWorkspacesConfig } from "@t3tools/contracts";
import { draftMachineModelUsable, type ProviderCatalog } from "./draftMachine.ts";

import { machineDisplayOf, type MachineDisplay } from "../machineDisplay.ts";

/** How a new-thread machine card describes the copy the draft would use. */
export type DraftMachineCardStatus =
  | "available"
  | "synced"
  | "copying"
  | "out-of-sync"
  | "will-copy"
  | "no-models"
  | "cannot-host"
  | "unreachable"
  | "offline";

export interface DraftMachineCardStateInput {
  readonly label: string;
  /** This client has a connection to the machine. */
  readonly connected: boolean;
  /** The mesh can reach the machine, even when this client is not connected to it. */
  readonly reachable: boolean;
  readonly viaLabel?: string | null | undefined;
  /** The mesh reports the machine offline, not merely absent from this client. */
  readonly offline?: boolean;
  /** The machine's offline age, e.g. "Offline · 3 min", for the tooltip. */
  readonly offlineText?: string | null | undefined;
  /** The machine already holds the draft's project. */
  readonly hasProject: boolean;
  /** False for a scratch draft, which has no project and therefore no copies. */
  readonly draftHasProject?: boolean;
  /** Null when the machine's provider catalog is unknown to this client. */
  readonly hasUsableModels: boolean | null;
  /** False when the draft's selected model is missing there; null when no model is chosen. */
  readonly hasSelectedModel?: boolean | null;
  /** False when this server cannot host a copy of the project (older server, no replicas). */
  readonly canHostCopy?: boolean;
  readonly sync?: "synced" | "copying" | "out-of-sync" | null | undefined;
}

export interface DraftMachineCardState {
  readonly status: DraftMachineCardStatus;
  readonly text: string;
  readonly selectable: boolean;
  /** Plain guidance when the draft's selected model cannot run on this machine. */
  readonly guidance: string | null;
}

/** The longest card sentence a card keeps on one line at 1280 and 390. */
export const DRAFT_MACHINE_CARD_TEXT_MAX = 24;

/** Short visible phrases; the full sentence lives in the tooltip/aria-description. */
export const draftMachineCardTexts = {
  unreachable: "Not connected here",
  offline: "Offline",
  cannotHost: "Can't host a copy",
  noModels: "No models here",
  copying: "Copying…",
  outOfSync: "Out of sync",
  available: "Available",
  willCopy: "Will set up a copy",
  synced: "Synced",
  modelMissing: "Model not available here",
  notConnected: "Not connected here",
} as const;

/**
 * One card's plain sentence. A machine that the mesh reaches but this client cannot
 * connect to is not called "not connected": it is named by the way it is reachable.
 */
export function draftMachineCardState(input: DraftMachineCardStateInput): DraftMachineCardState {
  const guidance = input.hasSelectedModel === false ? draftMachineCardTexts.modelMissing : null;
  const withGuidance = (state: Omit<DraftMachineCardState, "guidance">): DraftMachineCardState => ({
    ...state,
    guidance,
  });
  if (!input.connected && !input.reachable) {
    return withGuidance({
      status: input.offline === true ? "offline" : "unreachable",
      text:
        input.offline === true ? draftMachineCardTexts.offline : draftMachineCardTexts.unreachable,
      selectable: false,
    });
  }
  // A machine reached through the mesh still describes its copy; this device just
  // cannot start a thread there until it connects to that machine directly.
  const selectable = input.connected;
  const draftHasProject = input.draftHasProject !== false;
  if (draftHasProject && !input.hasProject && input.canHostCopy === false) {
    return withGuidance({
      status: "cannot-host",
      text: draftMachineCardTexts.cannotHost,
      selectable: false,
    });
  }
  if (input.hasUsableModels === false) {
    return withGuidance({
      status: "no-models",
      text: draftMachineCardTexts.noModels,
      selectable: false,
    });
  }
  if (input.sync === "copying") {
    return withGuidance({ status: "copying", text: draftMachineCardTexts.copying, selectable });
  }
  if (input.sync === "out-of-sync") {
    return withGuidance({
      status: "out-of-sync",
      text: draftMachineCardTexts.outOfSync,
      selectable,
    });
  }
  // A draft without a project has no copies to make; only the machine and its model matter.
  if (!draftHasProject) {
    return withGuidance({ status: "available", text: draftMachineCardTexts.available, selectable });
  }
  if (!input.hasProject) {
    return withGuidance({ status: "will-copy", text: draftMachineCardTexts.willCopy, selectable });
  }
  return withGuidance({ status: "synced", text: draftMachineCardTexts.synced, selectable });
}

export interface DraftMachineCardChoice {
  readonly environmentId: string;
  readonly label: string;
  readonly projectId: string | null;
  readonly primary: boolean;
  readonly connected: boolean;
  readonly hasUsableModels: boolean | null;
  readonly hasSelectedModel?: boolean | null;
  /** The machine's provider catalog, when this client knows it. */
  readonly config?: ProviderCatalog | null;
  readonly canHostCopy?: boolean;
  readonly sync?: "synced" | "copying" | "out-of-sync" | null | undefined;
}

export interface DraftMachineCardReachability {
  readonly reachable: boolean;
  readonly viaLabel?: string | null | undefined;
  readonly offline?: boolean;
  readonly offlineText?: string | null | undefined;
}

export interface DraftMachineCardRow extends DraftMachineCardState {
  readonly environmentId: string;
  readonly label: string;
  readonly machine: MachineDisplay;
  readonly primary: boolean;
  readonly selected: boolean;
  /** Why a card is dimmed, in visible words; null when it can be picked. */
  readonly note: string | null;
  /** The full explanation, including the copy state, for the tooltip. */
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
  readonly selection?: ModelSelection | null;
  /** False for a scratch draft, which has no project and therefore no copies. */
  readonly draftHasProject?: boolean;
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
        offline: reach?.offline ?? false,
        offlineText: reach?.offlineText ?? null,
        hasProject: choice.projectId !== null,
        draftHasProject: input.draftHasProject ?? true,
        hasUsableModels: choice.hasUsableModels,
        hasSelectedModel:
          choice.hasSelectedModel ??
          draftMachineModelUsable(
            choice.config ?? null,
            input.selection ?? null,
            choice.projectId as ProjectId | null,
          ),
        canHostCopy: choice.canHostCopy ?? true,
        sync: choice.sync ?? null,
      });
      const via = reach?.viaLabel?.trim();
      const reachableThroughMesh = !choice.connected && (reach?.reachable ?? false);
      const note =
        state.status === "cannot-host"
          ? null
          : state.selectable
            ? (state.guidance ?? null)
            : state.status === "no-models" ||
                state.status === "unreachable" ||
                state.status === "offline"
              ? null
              : reachableThroughMesh
                ? `Available through ${via ?? "the mesh"}`
                : draftMachineCardTexts.notConnected;
      const hint =
        state.status === "cannot-host"
          ? `This server can't host a copy of the project. Update it to a version that supports the mesh.`
          : state.status === "offline"
            ? (reach?.offlineText ?? draftMachineCardTexts.offline)
            : state.status === "unreachable"
              ? `Can't reach ${choice.label}. Connect this device to ${choice.label} to start a thread here.`
              : state.status === "no-models"
                ? `${choice.label} has no usable models for this project. Add or enable a provider there.`
                : state.guidance !== null
                  ? `The selected model isn't available on ${choice.label}. Pick another machine or choose a model that exists there.`
                  : reachableThroughMesh
                    ? `The mesh reaches ${choice.label}${via ? ` through ${via}` : ""}. Connect this device to start a thread here.`
                    : note !== null
                      ? `This device is not connected to ${choice.label}. Connect this device to start a thread here.`
                      : null;
      return {
        ...state,
        environmentId: choice.environmentId,
        label: choice.label,
        machine: machineDisplayOf(input.config, choice.environmentId, choice.label),
        primary: choice.primary,
        selected: input.selectedEnvironmentId === choice.environmentId,
        note,
        hint,
      };
    })
    .sort((left, right) => {
      if (left.primary !== right.primary) return left.primary ? -1 : 1;
      if (left.selectable !== right.selectable) return left.selectable ? -1 : 1;
      return left.label.localeCompare(right.label);
    });
}

/**
 * The next selectable card in arrow-key order, skipping disabled cards and
 * wrapping around. Null when no card can be picked.
 */
export function nextSelectableMachineCard(
  cards: ReadonlyArray<{ readonly environmentId: string; readonly selectable: boolean }>,
  currentEnvironmentId: string | null,
  direction: 1 | -1,
): string | null {
  if (!cards.some((card) => card.selectable)) return null;
  const current = cards.findIndex((card) => card.environmentId === currentEnvironmentId);
  const start = current < 0 ? (direction === 1 ? -1 : 0) : current;
  for (let offset = 1; offset <= cards.length; offset += 1) {
    const index = (((start + direction * offset) % cards.length) + cards.length) % cards.length;
    const card = cards[index]!;
    if (card.selectable) return card.environmentId;
  }
  return null;
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

/** One catalog request key per (project, destination); bounded by live machines. */
export function draftMachineCatalogRequests(input: {
  readonly activeProjectEnvironmentId: string | null;
  readonly environmentIds: ReadonlyArray<string>;
}): string[] {
  if (input.activeProjectEnvironmentId === null) return [];
  return [...new Set(input.environmentIds)].map(
    (environmentId) => `${input.activeProjectEnvironmentId}:${environmentId}`,
  );
}

/** Keys to keep: a connected destination or a changed project drops its old request. */
export function retainedCatalogRequests(
  current: Iterable<string>,
  wanted: ReadonlySet<string>,
): string[] {
  return [...current].filter((key) => wanted.has(key));
}

/** Nothing is unconnected: the component must not poll catalogs at all. */
export function shouldRefreshDraftMachineCatalogs(input: {
  readonly activeProjectEnvironmentId: string | null;
  readonly environmentIds: ReadonlyArray<string>;
}): boolean {
  return draftMachineCatalogRequests(input).length > 0;
}
