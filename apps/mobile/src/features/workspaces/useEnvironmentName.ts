import {
  environmentNameOf,
  type EnvironmentName,
} from "@t3tools/client-runtime/state/machine-display";

import { useMeshLayout } from "./useMeshLayout";

/** How the phone names an environment: mesh config tag + title, else its saved host label. */
export function useEnvironmentName(environmentId: string, fallbackLabel: string): EnvironmentName {
  const mesh = useMeshLayout();
  return environmentNameOf(mesh.config, environmentId, fallbackLabel);
}
