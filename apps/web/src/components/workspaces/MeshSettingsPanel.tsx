import { minuteTickToEpochMs } from "@t3tools/client-runtime/clock";
import { useReplicaStatuses } from "../../state/meshReplicas";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { useNowMinute } from "../../hooks/useNowMinute";
import { linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  linkMeshMachines,
  meshMachineDetailRows,
  offlineMachineText,
  partitionMeshMachines,
  forgetMachineFacts,
} from "@t3tools/client-runtime/state/mesh-machines";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { useState } from "react";

import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment } from "~/state/peerLinks";
import {
  usePreparedConnection,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useNavigate } from "@tanstack/react-router";
import { useMeshOverview } from "../../hooks/useMeshOverview";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomValue } from "@effect/atom-react";
import { planMeshConnect } from "@t3tools/client-runtime/state/mesh-layout";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { MachineTag } from "./MachineTag";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import { meshProjectRows, meshSetupPrompt } from "@t3tools/client-runtime/state/mesh-machines";
import {
  linkSourceOptions,
  linkTargetOptions,
  meshUpdateProblems,
  meshUpdatePrompt,
  offlineMachinePrompt,
  plainFailureText,
  refusedLinkPrompt,
  replicaProblemPrompt,
  showsLinkSourcePicker,
} from "./meshSettings.logic";
import { AgentFixActions } from "./AgentFixActions";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

function usePermittedLinkSources(): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly label: string;
}> {
  const { environments } = useEnvironments();
  const permitted = useEnvironmentsWithScope(environments, AuthAccessWriteScope);
  return linkSourceOptions(environments).filter((source) => permitted.has(source.environmentId));
}

function LinkWithDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly machines: ReturnType<typeof useMeshOverview>["machines"];
  readonly sources: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly initialSource: EnvironmentId | null;
}) {
  const [source, setSource] = useState<EnvironmentId | null>(props.initialSource);
  const [target, setTarget] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  const targetMachine = props.machines.find((machine) => machine.environmentId === target) ?? null;
  const targetEnvironmentId = (targetMachine?.environmentId as EnvironmentId | undefined) ?? null;
  const connected = usePreparedConnection(targetEnvironmentId);
  const mayMint = useEnvironmentScope(targetEnvironmentId, AuthAccessWriteScope);
  const canMint =
    targetMachine !== null &&
    targetMachine.environmentId !== source &&
    targetMachine.connectedHere &&
    Option.isSome(connected) &&
    mayMint;
  const link = useAtomCommand(peerLinkEnvironment.link, { label: "link environment" });
  const selectedSource = source ?? props.sources[0]?.environmentId ?? null;
  const ready =
    selectedSource !== null && url.trim().length > 0 && (canMint || pairingCode.trim().length > 0);
  const reset = () => {
    setTarget(null);
    setUrl("");
    setPairingCode("");
  };
  const submit = async () => {
    if (!ready || selectedSource === null) return;
    setBusy(true);
    setLinkFailure(null);
    try {
      const result = await linkMeshMachines({
        source: selectedSource,
        target:
          targetMachine === null
            ? null
            : {
                environmentId: targetMachine.environmentId as EnvironmentId,
                label: targetMachine.label,
              },
        url,
        code: pairingCode,
        mintOnTarget: canMint,
        mintCode: async (id) => {
          const minted = await mintPairingCodeOn(id, "full-access");
          if (Result.isFailure(minted)) throw new Error(linkRequestFailureMessage(minted.failure));
          return minted.success;
        },
        link: (environmentId, input) => link({ environmentId, input }),
      });
      setBusy(false);
      if (result._tag === "Success") {
        toastManager.add({ type: "success", title: `Linked ${result.value.label}` });
        reset();
        props.onOpenChange(false);
      } else if (!isAtomCommandInterrupted(result)) {
        const reason = plainFailureText(squashAtomCommandFailure(result));
        setLinkFailure(reason);
        failureToast("Couldn't link", reason);
      }
    } catch (error) {
      const reason = plainFailureText(error);
      setLinkFailure(reason);
      failureToast("Couldn't link", reason);
    }
    setBusy(false);
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        if (!next) reset();
        props.onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link with a machine</DialogTitle>
          <DialogDescription>
            The mesh shares one layout. Full access is needed so the machines can exchange it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {showsLinkSourcePicker(props.sources) ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Link from</span>
                <Select
                  value={selectedSource}
                  onValueChange={(value) => {
                    setSource(value as EnvironmentId);
                    reset();
                  }}
                >
                  <SelectTrigger aria-label="Link from">
                    <SelectValue>
                      {(value: EnvironmentId | null) =>
                        props.sources.find((entry) => entry.environmentId === value)?.label ??
                        "Pick a machine"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {props.sources.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            ) : null}
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">Link to</span>
              <Select
                value={target}
                onValueChange={(value) => {
                  setTarget(value);
                  const machine = props.machines.find((entry) => entry.environmentId === value);
                  setUrl(machine?.urls[0] ?? "");
                }}
              >
                <SelectTrigger aria-label="Link to">
                  <SelectValue>
                    {(value: string | null) =>
                      props.machines.find((entry) => entry.environmentId === value)?.label ??
                      "Pick a machine"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="manual">Another machine</SelectItem>
                  {linkTargetOptions(props.machines, selectedSource).map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">Address</span>
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://machine.example.ts.net"
                spellCheck={false}
              />
              {targetMachine !== null && targetMachine.urls.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {targetMachine.urls.map((known) => (
                    <button
                      key={known}
                      type="button"
                      className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setUrl(known)}
                    >
                      Use {known}
                    </button>
                  ))}
                </span>
              ) : null}
            </label>
            {canMint ? (
              <p className="text-xs text-muted-foreground">
                A pairing code is created on {targetMachine?.label} for you.
              </p>
            ) : (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Pairing code</span>
                <Input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder="From that machine's Connections, or t3 pair there"
                  autoComplete="one-time-code"
                  spellCheck={false}
                />
              </label>
            )}
          </div>
        </DialogPanel>
        {linkFailure ? (
          <div className="px-6 pb-2">
            <p role="alert" className="text-sm text-destructive">
              Couldn't link: {linkFailure}
            </p>
            <AgentFixActions
              environmentId={selectedSource}
              accessibleLabel="Fix linking this machine with an agent"
              prompt={refusedLinkPrompt({
                source:
                  props.sources.find((entry) => entry.environmentId === selectedSource)?.label ??
                  "this machine",
                target: targetMachine?.label ?? url,
                reason: linkFailure,
              })}
            />
          </div>
        ) : null}
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button disabled={busy || !ready} onClick={() => void submit()}>
            {busy ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function MeshSettingsPanel() {
  const mesh = useMeshLayout();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const agentEnvironmentId = mesh.source ?? primaryEnvironmentId;
  const { machines: allMachines } = useMeshOverview({ config: mesh.config });
  const now = minuteTickToEpochMs(useNowMinute());
  const { active: machines, forgotten } = partitionMeshMachines(
    allMachines,
    mesh.config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    now,
  );
  const sources = usePermittedLinkSources();
  const { environments } = useEnvironments();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const [linkOpen, setLinkOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const live = useReplicaStatuses();
  const config = mesh.config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
  const selected = machines.find((machine) => machine.environmentId === detail);
  const online = (machine: (typeof machines)[number]) =>
    machine.connectedHere ||
    machine.network?.state === "direct" ||
    machine.network?.state === "relayed";
  const machineStatus = (machine: (typeof machines)[number]) =>
    online(machine)
      ? machine.network?.state === "relayed"
        ? "Online through another machine"
        : "Online"
      : (offlineMachineText(machine.lastSeenAt) ?? "Offline");
  const updateProblems = meshUpdateProblems(mesh.state?.snapshot?.document ?? {});
  const problems = machines
    .filter((machine) => !online(machine))
    .map((machine) => `${machine.label} is offline`);
  const setupPrompt = meshSetupPrompt(
    machines.map((machine) => ({
      label: machine.label,
      online: online(machine),
      detail: machineStatus(machine),
    })),
    problems,
  );
  const openAgent = (prompt: string) => {
    void navigate({
      to: "/new",
      search: (agentEnvironmentId ? { prompt, env: agentEnvironmentId } : { prompt }) as never,
    });
  };
  const connectPlan = planMeshConnect({
    machines: machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
    })),
    connectedEnvironmentIds: new Set(
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => String(environment.environmentId)),
    ),
    entries: new Map(
      [...catalog.entries].map(([environmentId, entry]) => [
        String(environmentId),
        { enabled: entry.enabled },
      ]),
    ),
  });
  const connectAll = async () => {
    const failed: string[] = [];
    for (const machine of connectPlan.reconnect) {
      const result = await setEnabled({
        environmentId: machine.environmentId as EnvironmentId,
        enabled: true,
      });
      if (result._tag !== "Success") failed.push(machine.label);
    }
    if (failed.length > 0) {
      failureToast(
        "Couldn't connect every machine",
        `Ask an agent to fix the connection to ${failed.join(", ")}.`,
      );
    }
    if (connectPlan.missing.length > 0) void navigate({ to: "/settings/connections" });
  };
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Mesh"
        headerAction={`${machines.length} ${machines.length === 1 ? "machine" : "machines"} · ${machines.filter(online).length} online`}
      >
        <div className="flex flex-wrap gap-2 px-4 py-3">
          <Button size="sm" disabled={mesh.source === null} onClick={() => openAgent(setupPrompt)}>
            Set up the mesh with an agent
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={sources.length === 0}
            onClick={() => setLinkOpen(true)}
          >
            Link a machine
          </Button>
          {connectPlan.needed ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void connectAll();
              }}
            >
              Connect to all machines
            </Button>
          ) : null}
        </div>
        <ul className="divide-y divide-border/60">
          {machines.map((machine) => (
            <li key={machine.environmentId}>
              <button
                type="button"
                aria-label={`Open ${machine.label} details`}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => setDetail(machine.environmentId)}
              >
                <MachineTag machine={machine} />
                <span className="min-w-0 flex-1 truncate font-medium">{machine.label}</span>
                <span className="text-xs text-muted-foreground">{machineStatus(machine)}</span>
                <span aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      </SettingsSection>
      {selected ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDetail(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{selected.label}</DialogTitle>
              <DialogDescription>{machineStatus(selected)}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {!online(selected) ? (
                <div className="mb-3 space-y-2 rounded-lg border border-border/60 p-3">
                  <p className="text-sm text-muted-foreground">
                    {selected.label} · {machineStatus(selected)}
                  </p>
                  <AgentFixActions
                    environmentId={agentEnvironmentId}
                    accessibleLabel={`Fix ${selected.label} offline with an agent`}
                    prompt={offlineMachinePrompt(
                      selected.label,
                      machineStatus(selected),
                      selected.lastSeenAt == null && selected.lastExchangeAt == null,
                    )}
                  />
                </div>
              ) : null}
              <ul className="space-y-2 text-sm">
                {meshProjectRows(config, selected.environmentId, live).map((project) => (
                  <li key={project.key} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">{project.sentence}</span>
                    {project.canRetry ? (
                      <AgentFixActions
                        environmentId={agentEnvironmentId}
                        accessibleLabel={`Fix the copy of ${project.title} on ${selected.label} with an agent`}
                        prompt={replicaProblemPrompt(project.title, selected.label)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Diagnostics
                </summary>
                <dl className="mt-2 space-y-2 text-xs text-muted-foreground">
                  {meshMachineDetailRows(selected, config, live).map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>
                        {row.exact ? (
                          <Tooltip>
                            <TooltipTrigger render={<span tabIndex={0} />}>
                              {row.value}
                            </TooltipTrigger>
                            <TooltipPopup>{row.exact}</TooltipPopup>
                          </Tooltip>
                        ) : (
                          row.value
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
      {forgotten.length ? (
        <details>
          <summary>Forgotten machines ({forgotten.length})</summary>
          {forgotten.map((machine) => (
            <div
              key={machine.environmentId}
              className="flex items-center justify-between px-4 py-2"
            >
              <span>{machine.label} · forgotten</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  mesh.edit((config) => forgetMachineFacts(config, machine.environmentId))
                }
              >
                Forget
              </Button>
            </div>
          ))}
        </details>
      ) : null}
      {updateProblems.length > 0 ? (
        <SettingsSection title="Problems">
          <ul className="space-y-3 px-4 py-3 text-sm">
            {updateProblems.map((problem) => {
              const label = machineDisplayOf(
                config,
                problem.environmentId,
                problem.environmentId,
              ).label;
              return (
                <li key={problem.revision} className="space-y-2">
                  <p>
                    Update to {problem.target} failed on {label}: {problem.reason}
                  </p>
                  <AgentFixActions
                    environmentId={agentEnvironmentId}
                    accessibleLabel={`Fix the update failure on ${label} with an agent`}
                    prompt={meshUpdatePrompt(problem, label)}
                  />
                </li>
              );
            })}
          </ul>
        </SettingsSection>
      ) : null}
      <LinkWithDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        machines={machines}
        sources={sources}
        initialSource={sources[0]?.environmentId ?? null}
      />
    </SettingsPageContainer>
  );
}
