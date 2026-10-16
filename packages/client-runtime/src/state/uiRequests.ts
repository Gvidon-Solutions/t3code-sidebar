import { UI_REQUESTS_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/** Fork: the latest request from an agent to show something, per environment. */
export function createUiRequestAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    latestUiRequest: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:ui-requests:latest",
      tag: UI_REQUESTS_WS_METHODS.subscribe,
    }),
  };
}
