import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SidebarWorkspacesConfig } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlugZapIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useMeshOverview } from "../../hooks/useMeshOverview";
import { usePrimarySettings } from "../../hooks/useSettings";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  dismissMeshConnectIds,
  dismissMeshConnectPrompt,
  planMeshConnect,
  pruneMeshConnectDismissed,
  shouldShowMeshConnectPrompt,
} from "@t3tools/client-runtime/state/mesh-layout";

export const MESH_CONNECT_PROMPT_DISMISSED_KEY = "t3code.meshConnectPrompt.dismissed";

/**
 * Fork: one calm first-run prompt when the mesh knows machines this device is not
 * connected to. It switches saved connections back on and sends the rest to Connections.
 */
export function MeshConnectPrompt(props: { readonly config: SidebarWorkspacesConfig | null }) {
  const enabled = usePrimarySettings(
    (settings) => settings.meshEnabled && settings.linkedEnvironmentsEnabled,
  );
  const { machines } = useMeshOverview({ config: props.config });
  const { environments } = useEnvironments();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<readonly string[]>(() => {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(MESH_CONNECT_PROMPT_DISMISSED_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  if (!enabled) return null;
  const connected = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => String(environment.environmentId)),
  );
  const currentDismissed = pruneMeshConnectDismissed(
    dismissed,
    machines.map((machine) => machine.environmentId),
  );
  const plan = planMeshConnect({
    machines: machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
    })),
    connectedEnvironmentIds: connected,
    entries: new Map(
      [...catalog.entries].map(([environmentId, entry]) => [
        String(environmentId),
        { enabled: entry.enabled },
      ]),
    ),
  });
  if (!shouldShowMeshConnectPrompt(plan, currentDismissed)) return null;
  const rememberDismissed = (environmentIds: ReadonlyArray<string>) => {
    const next = dismissMeshConnectIds(currentDismissed, environmentIds);
    setDismissed(next);
    try {
      window.localStorage.setItem(MESH_CONNECT_PROMPT_DISMISSED_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn("Could not remember the dismissed mesh prompt", error);
    }
  };
  const dismiss = () => {
    const next = dismissMeshConnectPrompt(currentDismissed, plan);
    setDismissed(next);
    try {
      window.localStorage.setItem(MESH_CONNECT_PROMPT_DISMISSED_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn("Could not remember the dismissed mesh prompt", error);
    }
  };
  const connectAll = async () => {
    const settled = plan.missing.map((machine) => machine.environmentId);
    const failed: string[] = [];
    for (const machine of plan.reconnect) {
      const result = await setEnabled({
        environmentId: machine.environmentId as EnvironmentId,
        enabled: true,
      });
      if (result._tag === "Success") settled.push(machine.environmentId);
      else failed.push(machine.label);
    }
    if (settled.length > 0) rememberDismissed(settled);
    if (failed.length > 0) {
      toastManager.add({
        type: "error",
        title: "Couldn't connect every machine",
        description: `Ask an agent to fix the connection to ${failed.join(", ")}.`,
      });
    }
    if (plan.missing.length > 0) {
      void navigate({ to: "/settings/connections" });
    }
  };
  return (
    <div
      data-mesh-connect-prompt
      className="mx-2 mb-1 rounded-lg border border-border/80 bg-card/70 p-2.5"
    >
      <div className="flex items-start gap-2">
        <PlugZapIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm text-foreground">
            Connect to all machines in your mesh
          </p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {plan.missing.length > 0
              ? "This device is not connected to every machine yet."
              : "Bring this device's other machines online."}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="xs" onClick={() => void connectAll()}>
              Connect all
            </Button>
            <Button size="xs" variant="ghost" onClick={dismiss}>
              Not now
            </Button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
          onClick={dismiss}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
