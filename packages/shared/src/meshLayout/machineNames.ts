import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

export function meshMachineLabel(
  config: Pick<SidebarWorkspacesConfig, "machines">,
  environmentId: string,
  fallback = "Unknown machine",
): string {
  const machine = config.machines[environmentId];
  const label = machine?.label?.trim() || fallback;
  const tag =
    machine?.tag?.trim() ||
    label
      .replace(/[^\p{L}\p{N}]/gu, "")
      .slice(0, 2)
      .toUpperCase();
  return tag ? `${label} (${tag})` : label;
}
