import {
  environmentNameOf,
  type EnvironmentName,
} from "@t3tools/client-runtime/state/machine-display";

import { useMeshLayoutOptional } from "./useMeshLayout";

/** How this client names an environment: mesh config tag + title, else its saved host label. */
export function useEnvironmentName(environmentId: string, fallbackLabel: string): EnvironmentName {
  const { config } = useMeshLayoutOptional();
  return environmentNameOf(config, environmentId, fallbackLabel);
}
