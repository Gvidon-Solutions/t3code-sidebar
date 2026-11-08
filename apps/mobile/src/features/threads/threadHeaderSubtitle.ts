import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

/**
 * The thread header's second line. With more than one machine it names the
 * thread's machine tag, like the web header; a single machine keeps the
 * environment's own label so nothing is repeated.
 */
export function threadHeaderSubtitle(input: {
  readonly config: SidebarWorkspacesConfig | null;
  readonly environmentId: string | null;
  readonly environmentLabel: string | null;
  readonly projectTitle: string | null;
  readonly delegatedParent: string | null;
}): string {
  const machineCount = Object.keys(input.config?.machines ?? {}).length;
  const machine =
    input.environmentId === null
      ? null
      : machineDisplayOf(
          input.config ?? { machines: {} },
          input.environmentId,
          input.environmentLabel ?? "Machine",
        );
  const machineText =
    machineCount > 1
      ? machine?.tag.trim()
        ? machine.tag
        : (machine?.label ?? input.environmentLabel)
      : input.environmentLabel;
  return [input.projectTitle, machineText, input.delegatedParent].filter(Boolean).join(" · ");
}
