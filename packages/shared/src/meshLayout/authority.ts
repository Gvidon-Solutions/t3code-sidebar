import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

export function meshAuthorityOf(
  config: Pick<SidebarWorkspacesConfig, "meshAuthority" | "meshWriters">,
): string | undefined {
  return config.meshAuthority || [...(config.meshWriters ?? [])].sort()[0];
}

export function conflictWinner(
  config: SidebarWorkspacesConfig,
  primary: string,
  replica: string,
): "alpha" | "beta" {
  return meshAuthorityOf(config) === replica ? "beta" : "alpha";
}
