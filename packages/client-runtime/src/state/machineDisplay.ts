import type {
  MachineTagAppearance,
  SidebarMachine,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";

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
  return source
    .slice(0, source.length <= 3 ? 3 : 2)
    .join("")
    .toUpperCase();
}

/** How the sidebar shows a machine: the user's name, tag and colour, with stable fallbacks. */
export function machineDisplayOf(
  config: Pick<SidebarWorkspacesConfig, "machines">,
  environmentId: string,
  fallbackLabel: string,
): MachineDisplay {
  const machine = config.machines[environmentId];
  const label =
    [machine?.title, machine?.label, fallbackLabel === environmentId ? undefined : fallbackLabel]
      .map((value) => value?.trim())
      .find(
        (value) =>
          value &&
          !/^(?:[a-f\d]{8,64}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value) &&
          !["Unknown machine", "Unidentified machine"].includes(value),
      ) ?? "Unnamed machine";
  return {
    label,
    tag:
      normalizeMachineTag(machine?.tag ?? "") ??
      (label === "Unnamed machine" ? "" : defaultMachineTag(label, environmentId)),
    color: machine?.color?.trim() || workspaceColor({ id: environmentId }),
  };
}

export interface EnvironmentName extends MachineDisplay {
  /** True when the mesh config names this environment, so its tag belongs to it. */
  readonly inMesh: boolean;
}

/**
 * The one rule for naming an environment on any surface: the mesh config owns the name of a
 * machine it lists (tag + title). An environment outside the mesh keeps the label its
 * connection was saved with, which is its host name unless the person renamed it.
 */
export function environmentNameOf(
  config: Pick<SidebarWorkspacesConfig, "machines"> | null | undefined,
  environmentId: string,
  fallbackLabel: string,
): EnvironmentName {
  if (config !== null && config !== undefined && config.machines[environmentId] !== undefined) {
    return { ...machineDisplayOf(config, environmentId, fallbackLabel), inMesh: true };
  }
  const label = fallbackLabel.trim();
  return {
    label: label.length > 0 ? label : "Unnamed machine",
    tag: "",
    color: workspaceColor({ id: environmentId }),
    inMesh: false,
  };
}

export interface MachineDisplayPatch {
  readonly label?: string | null;
  readonly tag?: string | null;
  readonly color?: string | null;
  readonly aliases?: readonly string[] | null;
}

/** Edits one machine entry; clearing every field removes the entry. Never mutates `config`. */
export function setMachineDisplay(
  config: SidebarWorkspacesConfig,
  environmentId: string,
  patch: MachineDisplayPatch,
): SidebarWorkspacesConfig {
  const next: { -readonly [K in keyof SidebarMachine]: SidebarMachine[K] } = {
    ...config.machines[environmentId],
  };
  if (patch.aliases !== undefined) {
    const aliases = [
      ...new Map(
        (patch.aliases ?? [])
          .map((alias) => alias.trim())
          .filter(Boolean)
          .map((alias) => [alias.normalize("NFKC").toLowerCase(), alias]),
      ).values(),
    ];
    if (aliases.length) next.aliases = aliases;
    else delete next.aliases;
  }
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

/**
 * The tag's tinted background: `color` at `alpha` for #rgb/#rrggbb colors, a neutral tint for
 * anything else (named or functional CSS colors), so a hand-typed color never breaks the chip.
 */
export function machineTagBackground(color: string, alpha = 0.14): string {
  const hex = color.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(hex) ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return `rgba(128, 128, 128, ${alpha})`;
  const value = Number.parseInt(full, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export type ResolvedMachineTagAppearance = {
  readonly style: "tinted" | "solid" | "outline";
  readonly textColor: "machine" | "neutral";
};

const DEFAULT_MACHINE_TAG_APPEARANCE: ResolvedMachineTagAppearance = {
  style: "tinted",
  textColor: "machine",
};

/**
 * The mesh config's appearance with defaults applied. An absent field or an unknown value
 * keeps the default look, so clients older than a newer config still draw a tag.
 */
export function resolveMachineTagAppearance(
  config: Pick<SidebarWorkspacesConfig, "appearance"> | null | undefined,
): ResolvedMachineTagAppearance {
  const machineTags: MachineTagAppearance | undefined = config?.appearance?.machineTags;
  const style = machineTags?.style;
  const textColor = machineTags?.textColor;
  return {
    style: style === "solid" || style === "outline" ? style : DEFAULT_MACHINE_TAG_APPEARANCE.style,
    textColor: textColor === "neutral" ? "neutral" : DEFAULT_MACHINE_TAG_APPEARANCE.textColor,
  };
}

interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

const NEUTRAL_RGB: Rgb = { red: 128, green: 128, blue: 128 };

function parseHexRgb(color: string): Rgb | null {
  const hex = color.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(hex) ? [...hex].map((part) => part + part).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const value = Number.parseInt(full, 16);
  return { red: (value >> 16) & 255, green: (value >> 8) & 255, blue: value & 255 };
}

const toHex = ({ red, green, blue }: Rgb) =>
  `#${[red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;

/** WCAG relative luminance of an sRGB colour, used only to keep tag text readable. */
export function relativeLuminance({ red, green, blue }: Rgb): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

const scaleRgb = (rgb: Rgb, factor: number): Rgb => ({
  red: rgb.red * factor,
  green: rgb.green * factor,
  blue: rgb.blue * factor,
});
const lightenRgb = (rgb: Rgb, amount: number): Rgb => ({
  red: rgb.red + (255 - rgb.red) * amount,
  green: rgb.green + (255 - rgb.green) * amount,
  blue: rgb.blue + (255 - rgb.blue) * amount,
});

/** The minimum relative luminance that reads on a dark background. */
const DARK_TEXT_MIN_LUMINANCE = 0.55;
/** The maximum relative luminance that reads on a light background. */
const LIGHT_TEXT_MAX_LUMINANCE = 0.18;

function adjustTextLuminance(rgb: Rgb, theme: "light" | "dark"): Rgb {
  const luminance = relativeLuminance(rgb);
  if (theme === "light" && luminance > LIGHT_TEXT_MAX_LUMINANCE) {
    let low = 0;
    let high = 1;
    for (let step = 0; step < 16; step += 1) {
      const middle = (low + high) / 2;
      if (relativeLuminance(scaleRgb(rgb, middle)) > LIGHT_TEXT_MAX_LUMINANCE) high = middle;
      else low = middle;
    }
    return scaleRgb(rgb, low);
  }
  if (theme === "dark" && luminance < DARK_TEXT_MIN_LUMINANCE) {
    let low = 0;
    let high = 1;
    for (let step = 0; step < 16; step += 1) {
      const middle = (low + high) / 2;
      if (relativeLuminance(lightenRgb(rgb, middle)) < DARK_TEXT_MIN_LUMINANCE) low = middle;
      else high = middle;
    }
    return lightenRgb(rgb, high);
  }
  return rgb;
}

export interface MachineTagPalette {
  /** Absent for the outline style. */
  readonly backgroundColor: string | undefined;
  /** Absent unless the outline style draws a border. */
  readonly borderColor: string | undefined;
  /** Machine-coloured text; absent means the client's normal foreground belongs there. */
  readonly color: string | undefined;
}

/**
 * The one palette for a machine tag. Tinted keeps the machine tint and coloured text; solid
 * fills with the machine colour and picks black or white by contrast; outline keeps the
 * background and draws a machine-coloured border. In either theme a machine colour that is
 * too pale or too dark for the background is moved in lightness only, keeping its hue.
 */
export function machineTagPalette(
  machineColor: string,
  appearance: ResolvedMachineTagAppearance,
  theme: "light" | "dark",
): MachineTagPalette {
  const rgb = parseHexRgb(machineColor) ?? NEUTRAL_RGB;
  const text =
    appearance.textColor === "machine" ? toHex(adjustTextLuminance(rgb, theme)) : undefined;
  if (appearance.style === "solid") {
    return {
      backgroundColor: machineColor.trim() || toHex(NEUTRAL_RGB),
      borderColor: undefined,
      color: relativeLuminance(rgb) < 0.179 ? "#ffffff" : "#000000",
    };
  }
  if (appearance.style === "outline") {
    return {
      backgroundColor: undefined,
      borderColor: toHex(adjustTextLuminance(rgb, theme)),
      color: text,
    };
  }
  return {
    backgroundColor: machineTagBackground(machineColor),
    borderColor: undefined,
    color: text,
  };
}

export function shortMachineHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const endpoint = new URL(url);
    const host = endpoint.hostname;
    const short = /^[\d.]+$/.test(host) || host.includes(":") ? host : host.split(".")[0]!;
    return endpoint.port ? `${short}:${endpoint.port}` : short;
  } catch {
    return null;
  }
}
