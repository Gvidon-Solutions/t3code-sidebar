import type { ModelSelection, ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  splitModelNameAndEffort,
  stripModelProviderPrefix,
} from "@t3tools/shared/model";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { selectableChoices } from "./thread-settings-options";

/** Same order the composer uses when it looks for a reasoning setting. */
const REASONING_EFFORT_OPTION_IDS = ["reasoningEffort", "effort", "reasoning", "variant"] as const;

const EFFORT_RANK = new Map([
  ["minimal", 0],
  ["low", 1],
  ["medium", 2],
  ["high", 3],
  ["extra high", 4],
  ["max", 5],
  ["thinking", 6],
]);

export type ModelDisplay = {
  readonly name: string;
  readonly effort: string | null;
};

/** The provider's model name, with vendor noise and a baked effort split off. */
export function resolveModelDisplay(input: {
  readonly name: string;
  readonly providerLabel?: string | null;
  readonly descriptors?: ReadonlyArray<ProviderOptionDescriptor>;
  readonly selection?: ModelSelection | null;
  readonly reportedSelection?: ModelSelection | null;
}): ModelDisplay {
  const parts = splitModelNameAndEffort(input.name);
  const descriptor = reasoningEffortDescriptor(input.descriptors);
  const effort =
    (descriptor
      ? getProviderOptionCurrentLabel(descriptor, input.selection, input.reportedSelection)
      : undefined) ?? parts.effort;
  return {
    name: stripModelProviderPrefix(parts.name, input.providerLabel),
    effort: effort ?? null,
  };
}

export function reasoningEffortDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = descriptors?.find((candidate) => candidate.id === id);
    if (descriptor?.type === "select") return descriptor;
  }
  return null;
}

/** Model rows and the composer share the same short name and effort token. */
export function modelOptionDisplay(option: ModelOption): ModelDisplay {
  const descriptors = option.capabilities
    ? getProviderOptionDescriptors({
        caps: option.capabilities,
        selections: option.selection.options,
      })
    : [];
  return resolveModelDisplay({
    name: option.label,
    providerLabel: option.providerLabel,
    descriptors,
    selection: option.selection,
  });
}

export type EffortChoice =
  | {
      readonly kind: "option";
      readonly key: string;
      readonly descriptorId: string;
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly selected: boolean;
    }
  | {
      readonly kind: "model";
      readonly key: string;
      readonly option: ModelOption;
      readonly label: string;
      readonly selected: boolean;
    };

/**
 * One reasoning control for both provider shapes: a real option descriptor
 * (Claude, Codex) or distinct model variants whose names bake in the effort
 * (Antigravity's "Gemini 3.8 Flash (High)"). Fewer than two choices means the
 * model has one fixed effort and there is nothing to switch.
 */
export function effortChoicesFor(input: {
  readonly option: ModelOption | null;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly selection: ModelSelection | null;
  readonly reportedSelection: ModelSelection | null;
  readonly groups: ReadonlyArray<ProviderGroup>;
}): {
  readonly source: "descriptor" | "model";
  readonly label: string;
  readonly choices: ReadonlyArray<EffortChoice>;
} | null {
  const descriptor = reasoningEffortDescriptor(input.descriptors);
  if (descriptor) {
    const current = getProviderOptionCurrentValue(
      descriptor,
      input.selection,
      input.reportedSelection,
    );
    const choices: EffortChoice[] = selectableChoices(descriptor).map((choice) => ({
      kind: "option",
      key: `${descriptor.id}:${choice.id}`,
      descriptorId: descriptor.id,
      id: choice.id,
      label: choice.label,
      ...(choice.description ? { description: choice.description } : {}),
      selected: current === choice.id,
    }));
    return choices.length > 1
      ? { source: "descriptor", label: descriptor.label || "Reasoning", choices }
      : null;
  }

  if (!input.option) return null;
  const current = modelOptionDisplay(input.option);
  if (!current.effort) return null;
  const base = current.name.toLocaleLowerCase();
  const variants = input.groups
    .flatMap((group) => group.models)
    .filter(
      (candidate) =>
        candidate.key === input.option!.key ||
        (!candidate.isHidden && !candidate.isUnavailable && !candidate.isLegacy),
    )
    .map((candidate) => ({ option: candidate, display: modelOptionDisplay(candidate) }))
    .filter(
      (candidate) =>
        candidate.display.effort !== null && candidate.display.name.toLocaleLowerCase() === base,
    );
  const seen = new Set<string>();
  const choices: EffortChoice[] = [];
  for (const candidate of variants) {
    const label = candidate.display.effort!;
    const key = label.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({
      kind: "model",
      key: `${candidate.option.key}:${key}`,
      option: candidate.option,
      label,
      selected: candidate.option.key === input.option.key,
    });
  }
  choices.sort(
    (left, right) =>
      (EFFORT_RANK.get(left.label.toLocaleLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
      (EFFORT_RANK.get(right.label.toLocaleLowerCase()) ?? Number.MAX_SAFE_INTEGER),
  );
  return choices.length > 1 ? { source: "model", label: "Reasoning", choices } : null;
}

/** Quick-switch models stay useful even before the user pins anything. */
export function quickSwitchModels(input: {
  readonly groups: ReadonlyArray<ProviderGroup>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly current: ModelOption | null;
  readonly limit?: number;
}): {
  readonly source: "pinned" | "suggested";
  readonly models: ReadonlyArray<ModelOption>;
} {
  const limit = input.limit ?? 6;
  const usable = input.groups
    .flatMap((group) => group.models)
    .filter((option) => !option.isHidden && !option.isUnavailable && !option.isLegacy);
  const pinned = usable.filter((option) => input.favoriteKeys.has(option.key));
  if (pinned.length > 0) {
    return { source: "pinned", models: pinned.slice(0, limit) };
  }
  const currentProvider = input.current?.providerKey ?? null;
  return {
    source: "suggested",
    models: usable
      .filter((option) => currentProvider === null || option.providerKey === currentProvider)
      .slice(0, limit),
  };
}
