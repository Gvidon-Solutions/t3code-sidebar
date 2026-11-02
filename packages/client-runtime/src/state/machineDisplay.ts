import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

import { workspaceColor } from "./sidebarWorkspaces.ts";

// Machine naming for the mesh sidebar (fork feature). The machine entries in the
// layout name a machine; everything here falls back to the server's own label.

export interface MachineDisplay {
  readonly label: string;
  readonly tag: string;
  readonly color: string;
}

const MACHINE_TAG_MAX = 3;

const graphemes = (value: string): string[] =>
  typeof Intl.Segmenter === "function"
    ? Array.from(
        // oxlint-disable-next-line t3code/no-hermes-unsupported-apis -- Guarded by the typeof check.
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
        (part) => part.segment,
      )
    : Array.from(value);

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** A typed tag: no spaces, at most three characters, uppercase; null when nothing is left. */
export function normalizeMachineTag(raw: string): string | null {
  const tag = graphemes(raw.trim())
    .filter((part) => !/\s/u.test(part))
    .slice(0, MACHINE_TAG_MAX)
    .join("")
    .toUpperCase();
  return tag.length > 0 ? tag : null;
}

function defaultMachineTag(label: string, environmentId: string): string {
  const letters = graphemes(label).filter((part) => LETTER_OR_DIGIT.test(part));
  const source =
    letters.length > 0
      ? letters
      : graphemes(environmentId).filter((part) => LETTER_OR_DIGIT.test(part));
  return source.slice(0, 2).join("").toUpperCase() || "?";
}

/** How the sidebar shows a machine: the user's name, tag and colour, with stable fallbacks. */
export function machineDisplayOf(
  config: Pick<SidebarWorkspacesConfig, "machines">,
  environmentId: string,
  fallbackLabel: string,
): MachineDisplay {
  const machine = config.machines[environmentId];
  const label = machine?.label?.trim() || fallbackLabel.trim() || environmentId;
  return {
    label,
    tag: normalizeMachineTag(machine?.tag ?? "") ?? defaultMachineTag(label, environmentId),
    color: machine?.color?.trim() || workspaceColor({ id: environmentId }),
  };
}

export interface MachineDisplayPatch {
  readonly label?: string | null;
  readonly tag?: string | null;
  readonly color?: string | null;
}

/** Edits one machine entry; clearing every field removes the entry. Never mutates `config`. */
export function setMachineDisplay(
  config: SidebarWorkspacesConfig,
  environmentId: string,
  patch: MachineDisplayPatch,
): SidebarWorkspacesConfig {
  const next: { label?: string; tag?: string; color?: string } = {
    ...config.machines[environmentId],
  };
  if (patch.label !== undefined) {
    const label = patch.label?.trim();
    if (label) next.label = label;
    else delete next.label;
  }
  if (patch.tag !== undefined) {
    const tag = patch.tag === null ? null : normalizeMachineTag(patch.tag);
    if (tag) next.tag = tag;
    else delete next.tag;
  }
  if (patch.color !== undefined) {
    const color = patch.color?.trim();
    if (color) next.color = color;
    else delete next.color;
  }
  const machines = { ...config.machines };
  if (Object.keys(next).length === 0) delete machines[environmentId];
  else machines[environmentId] = next;
  return { ...config, machines };
}

/** True when rows in the list can come from more than one machine. */
export function spansMultipleEnvironments(environmentIds: Iterable<string>): boolean {
  let first: string | null = null;
  for (const environmentId of environmentIds) {
    if (first === null) first = environmentId;
    else if (environmentId !== first) return true;
  }
  return false;
}

/** Connected machines plus every machine id the layout still mentions, sorted by id. */
export function knownMachineIds(
  config: SidebarWorkspacesConfig,
  connectedEnvironmentIds: Iterable<string> = [],
): string[] {
  const ids = new Set<string>(connectedEnvironmentIds);
  for (const environmentId of Object.keys(config.machines)) ids.add(environmentId);
  for (const mounts of Object.values(config.projectMounts)) {
    for (const mount of mounts) {
      ids.add(mount.environmentId);
      if (mount.source) ids.add(mount.source);
    }
  }
  for (const statuses of Object.values(config.projectMountStatus)) {
    for (const environmentId of Object.keys(statuses)) ids.add(environmentId);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}
