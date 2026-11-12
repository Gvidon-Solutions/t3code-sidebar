export interface RolloutServiceState {
  readonly activeVersion?: string;
  readonly update?: {
    readonly status?: string;
    readonly reason?: string;
  };
}

export interface RolloutObservation {
  readonly name: string;
  readonly role: "first" | "second";
  readonly state?: RolloutServiceState | undefined;
  readonly error?: string | undefined;
}

export interface RolloutExpectation {
  readonly targetVersion: string;
  readonly secondVersion: string;
}

export type RolloutDecision =
  | { readonly status: "pending" }
  | {
      readonly status: "expected";
      readonly first: RolloutServiceState;
      readonly second: RolloutServiceState;
    }
  | {
      readonly status: "failed";
      readonly node: string;
      readonly role: "first" | "second";
      readonly reason: string;
    };

const terminalFailure = (state: RolloutServiceState) =>
  state.update?.status === "rolled-back" || state.update?.status === "failed";

const describeState = (state: RolloutServiceState | undefined) =>
  state === undefined
    ? "service state unavailable"
    : `activeVersion=${state.activeVersion ?? "unknown"} update=${state.update?.status ?? "none"}${
        state.update?.reason ? ` (${state.update.reason})` : ""
      }`;

const failure = (
  observation: RolloutObservation,
  state: RolloutServiceState | undefined,
  detail: string,
): RolloutDecision => ({
  status: "failed",
  node: observation.name,
  role: observation.role,
  reason: `${observation.role} machine ${observation.name} ${detail}; ${describeState(state)}`,
});

/**
 * Decides the expected bootstrap-rollout outcome without waiting on the second
 * machine when the first machine has already failed. A first-machine rollback
 * is never an accepted final state.
 */
export function rolloutDecision(
  observations: readonly RolloutObservation[],
  expected: RolloutExpectation,
): RolloutDecision {
  const first = observations.find((observation) => observation.role === "first");
  const second = observations.find((observation) => observation.role === "second");
  if (first === undefined || second === undefined)
    return {
      status: "failed",
      node: first?.name ?? second?.name ?? "unknown",
      role: first === undefined ? "first" : "second",
      reason: "rollout observations are incomplete",
    };
  for (const observation of [first, second])
    if (observation.error !== undefined)
      return failure(
        observation,
        observation.state,
        `could not read its service state (${observation.error})`,
      );

  if (first.state === undefined) return { status: "pending" };
  if (terminalFailure(first.state))
    return failure(
      first,
      first.state,
      `rolled back before the second machine was updated with ${first.state.update?.reason ? `reason ${first.state.update.reason}` : "no recorded reason"}`,
    );
  if (first.state.activeVersion !== expected.targetVersion) return { status: "pending" };
  if (second.state === undefined) return { status: "pending" };

  if (terminalFailure(second.state)) {
    if (second.state.activeVersion !== expected.secondVersion)
      return failure(
        second,
        second.state,
        `rolled back to an unexpected version from target ${expected.targetVersion}`,
      );
    return { status: "expected", first: first.state, second: second.state };
  }
  if (second.state.activeVersion === expected.targetVersion)
    return failure(second, second.state, "committed despite the injected health failure");
  return { status: "pending" };
}
