import type { ModelSelection } from "@t3tools/contracts";

export function resolveMoveModel(
  current: ModelSelection,
  choices: readonly {
    readonly selection: ModelSelection;
    readonly isDefault?: boolean;
    readonly isUnavailable?: boolean;
  }[],
  targetDefault?: ModelSelection | null,
) {
  const available = choices.filter((choice) => !choice.isUnavailable);
  const exact = available.find(
    ({ selection }) =>
      selection.instanceId === current.instanceId && selection.model === current.model,
  );
  const preferred =
    targetDefault &&
    available.some(
      ({ selection }) =>
        selection.instanceId === targetDefault.instanceId &&
        selection.model === targetDefault.model,
    )
      ? targetDefault
      : null;
  return {
    selection: exact
      ? current
      : (preferred ??
        (available.find((choice) => choice.isDefault) ?? available[0])?.selection ??
        null),
    fallback: !exact,
  };
}
