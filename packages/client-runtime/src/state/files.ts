import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** T3 Mesh (fork): read and list files on the machine that holds them. */
export function createFilesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:files:read",
      tag: WS_METHODS.filesRead,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:files:list",
      tag: WS_METHODS.filesList,
    }),
    stat: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:files:stat",
      tag: WS_METHODS.filesStat,
    }),
    locate: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:files:locate",
      tag: WS_METHODS.filesLocate,
    }),
  };
}
