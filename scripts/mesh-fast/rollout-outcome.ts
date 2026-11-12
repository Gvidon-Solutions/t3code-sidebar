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

export const READ_FAILURE_THRESHOLD = 3;

export interface ServiceReadOutcome<T> {
  readonly state?: T | undefined;
  readonly missing?: boolean | undefined;
  readonly error?: string | undefined;
  readonly permanent?: boolean | undefined;
}

export interface ReadFailureProgress {
  readonly failures: number;
  readonly lastError?: string | undefined;
}

export interface ReadProgressDecision {
  readonly failures: number;
  readonly lastError?: string | undefined;
  readonly pending: boolean;
  readonly error?: string | undefined;
}

/**
 * Tolerates a short run of transient read failures (a partially written JSON
 * file or a busy `docker exec`) without retrying the rollout itself. A valid
 * read or a missing state resets the streak; a reliably classified permission
 * or invalid-path error stays terminal immediately.
 */
export function readProgress<T>(
  previous: ReadFailureProgress,
  outcome: ServiceReadOutcome<T>,
  threshold = READ_FAILURE_THRESHOLD,
): ReadProgressDecision {
  if (outcome.state !== undefined || outcome.missing === true || outcome.error === undefined)
    return { failures: 0, pending: true };
  const failures = previous.failures + 1;
  const lastError = outcome.error;
  if (outcome.permanent === true || failures >= threshold)
    return { failures, lastError, pending: false, error: lastError };
  return { failures, lastError, pending: true };
}

/** Keeps the last observation and read cause when the outer deadline expires. */
export function rolloutTimeoutMessage(
  decision: RolloutDecision,
  observations: readonly RolloutObservation[],
  lastReadErrors: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): string {
  const errors = Object.entries(lastReadErrors)
    .flatMap(([node, error]) => (error === undefined ? [] : [`${node}: ${error}`]))
    .join("; ");
  return `rollout did not reach the expected outcome within ${timeoutMs}ms: ${JSON.stringify({
    decision,
    observations,
    ...(errors ? { lastReadErrors: errors } : {}),
  })}`;
}

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

  if (second.state.update?.status === "rolled-back") {
    if (second.state.activeVersion !== expected.secondVersion)
      return failure(
        second,
        second.state,
        `rolled back to an unexpected version from target ${expected.targetVersion}`,
      );
    return { status: "expected", first: first.state, second: second.state };
  }
  if (second.state.update?.status === "failed")
    return failure(
      second,
      second.state,
      "reported a failed update instead of the deliberate rollback",
    );
  if (second.state.activeVersion === expected.targetVersion)
    return failure(second, second.state, "committed despite the injected health failure");
  return { status: "pending" };
}
