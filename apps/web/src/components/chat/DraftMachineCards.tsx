import {
  draftMachineCardSync,
  draftMachineCards,
  type DraftMachineCardRow,
} from "@t3tools/client-runtime/state/mesh-layout";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { ServerProvider } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveLogicalProjectKey } from "@t3tools/client-runtime/state/mesh-layout";
import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useMeshOverview } from "../../hooks/useMeshOverview";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentProviders } from "../../state/environments";
import { useReplicaStatuses } from "../../state/meshReplicas";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import { MachineTag } from "../workspaces/MachineTag";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

function hasUsableModel(providers: ReadonlyArray<ServerProvider> | undefined): boolean | null {
  if (providers === undefined) return null;
  return providers.some(
    (provider) =>
      provider.installed &&
      provider.auth.status !== "unauthenticated" &&
      provider.status !== "error" &&
      provider.availability !== "unavailable" &&
      provider.models.length > 0,
  );
}

/**
 * Fork: the machine choice for a new thread, centred above the composer. A project
 * with one machine shows no cards; the main copy is the default.
 */
export function DraftMachineCards(props: {
  readonly choices: ReadonlyArray<EnvironmentOption>;
  readonly activeProject: EnvironmentProject | null;
  readonly selectedEnvironmentId: string | null;
  readonly onSelect: (environmentId: EnvironmentOption["environmentId"]) => void;
}) {
  const mesh = useMeshLayout();
  const { machines } = useMeshOverview({ config: mesh.config });
  const providersByEnvironment = useEnvironmentProviders();
  const statuses = useReplicaStatuses();
  const loadCatalog = useAtomCommand(threadEnvironment.forkCatalog, { reportFailure: false });
  const [catalogs, setCatalogs] = useState<Readonly<Record<string, ReadonlyArray<ServerProvider>>>>(
    {},
  );
  const requestedCatalogs = useRef(new Set<string>());
  const projectSettings = useClientSettings(selectProjectGroupingSettings);
  const catalogKey = props.choices
    .filter((choice) => !choice.connected)
    .map((choice) => choice.environmentId)
    .join(",");
  const activeProjectEnvironmentId = props.activeProject?.environmentId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads each destination catalog over the mesh so a card can name missing models
  useEffect(() => {
    if (!activeProjectEnvironmentId) return;
    for (const environmentId of catalogKey.split(",").filter(Boolean)) {
      const key = `${activeProjectEnvironmentId}:${environmentId}`;
      if (requestedCatalogs.current.has(key)) continue;
      requestedCatalogs.current.add(key);
      void loadCatalog({
        environmentId: activeProjectEnvironmentId,
        input: { targetEnvironmentId: environmentId as EnvironmentOption["environmentId"] },
      }).then((result) => {
        if (result._tag === "Success") {
          setCatalogs((current) => ({ ...current, [environmentId]: result.value.providers }));
        } else {
          requestedCatalogs.current.delete(key);
        }
      });
    }
  }, [activeProjectEnvironmentId, catalogKey, loadCatalog]);

  if (!props.activeProject) return null;
  const fallbackLogicalKey = () =>
    deriveLogicalProjectKeyFromSettings(props.activeProject!, projectSettings);
  const logicalKey = mesh.config
    ? resolveLogicalProjectKey(props.activeProject, mesh.config, fallbackLogicalKey)
    : fallbackLogicalKey();
  const reachability = Object.fromEntries(
    machines.map((machine) => {
      const via =
        machine.network?.state === "relayed"
          ? (machines.find((other) => other.environmentId === machine.network?.via)?.label ?? null)
          : null;
      return [
        machine.environmentId,
        {
          reachable:
            machine.connectedHere ||
            machine.network?.state === "direct" ||
            machine.network?.state === "relayed",
          viaLabel: via,
        },
      ] as const;
    }),
  );
  const mounts = mesh.config?.projectMounts[logicalKey] ?? [];
  const rows = draftMachineCards({
    config: mesh.config ?? { machines: {} },
    choices: props.choices.map((choice) => {
      const live = statuses.find(
        (status) =>
          status.logicalKey === logicalKey && status.environmentId === choice.environmentId,
      );
      const stored = mesh.config?.projectMountStatus[logicalKey]?.[choice.environmentId];
      const mount = mounts.find((rep) => rep.environmentId === choice.environmentId);
      const projectId = choice.projectId ?? mount?.projectId ?? null;
      const sync =
        draftMachineCardSync(live?.state) ??
        draftMachineCardSync(stored?.state) ??
        (projectId !== null ? "synced" : null);
      return {
        environmentId: choice.environmentId,
        label: choice.label,
        projectId,
        primary:
          mounts.some(
            (mount) => mount.environmentId === choice.environmentId && mount.role === "primary",
          ) ||
          (mounts.length === 0 && choice.isPrimary),
        connected: choice.connected === true,
        hasUsableModels: hasUsableModel(
          providersByEnvironment.get(choice.environmentId) ?? catalogs[choice.environmentId],
        ),
        sync,
      };
    }),
    reachability,
    selectedEnvironmentId: props.selectedEnvironmentId,
  });
  if (rows.length === 0) return null;
  return (
    <div
      role="radiogroup"
      aria-label="Machine for this thread"
      data-draft-machine-cards
      className="mt-5 mb-1 flex w-full max-w-3xl flex-wrap items-stretch justify-center gap-2 px-4 pb-4"
    >
      {rows.map((row) => (
        <MachineCard
          key={row.environmentId}
          row={row}
          onSelect={() => props.onSelect(row.environmentId as EnvironmentOption["environmentId"])}
        />
      ))}
    </div>
  );
}

function MachineCard(props: { readonly row: DraftMachineCardRow; readonly onSelect: () => void }) {
  const { row } = props;
  const button = (
    <button
      type="button"
      role="radio"
      aria-checked={row.selected}
      aria-disabled={!row.selectable}
      disabled={!row.selectable}
      onClick={props.onSelect}
      data-draft-machine-card={row.environmentId}
      className={cn(
        "flex w-full flex-col gap-1 rounded-xl border px-3 py-2 text-left transition-colors",
        row.selected
          ? "border-primary/55 bg-primary/[0.06]"
          : "border-border/80 bg-card/80 hover:bg-foreground/[0.035]",
        !row.selectable && "cursor-default opacity-55 hover:bg-card/80",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <MachineTag machine={row.machine} />
        <span className="min-w-0 flex-1 truncate font-medium text-sm text-foreground">
          {row.label}
        </span>
        {row.primary ? (
          <span className="shrink-0 rounded bg-foreground/[0.06] px-1 py-0.5 font-semibold text-3xs uppercase tracking-wide text-muted-foreground">
            Main
          </span>
        ) : null}
        {row.selected ? (
          <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        ) : null}
      </span>
      <span className="truncate text-muted-foreground text-xs">{row.note ?? row.text}</span>
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex min-w-36 max-w-60 flex-1 basis-36" />}>
        {button}
      </TooltipTrigger>
      {row.hint ? <TooltipPopup>{row.hint}</TooltipPopup> : null}
    </Tooltip>
  );
}
