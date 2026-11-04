import { useEnvironmentQuery } from "../../state/query";
import { meshLayoutAtoms } from "../../state/meshLayout";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { useNowMinute } from "../../hooks/useNowMinute";
import { MeshConfigDialog } from "./MeshConfigDialog";
import { linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  linkMeshMachines,
  meshConnectionText,
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
import { useMeshOverview } from "../../hooks/useMeshOverview";
import { useEnvironments } from "../../state/environments";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
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
import { linkSourceOptions, linkTargetOptions } from "./meshSettings.logic";

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
        failureToast("Could not link the machine", String(squashAtomCommandFailure(result)));
      }
    } catch (error) {
      failureToast("Could not link the machine", String(error));
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
  const { machines: allMachines } = useMeshOverview({ config: mesh.config });
  const now = Date.parse(useNowMinute());
  const { active: machines, forgotten } = partitionMeshMachines(
    allMachines,
    mesh.config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    now,
  );
  const sources = usePermittedLinkSources();
  const applyStatus = useEnvironmentQuery(
    mesh.source ? meshLayoutAtoms.configStatus({ environmentId: mesh.source, input: {} }) : null,
  );
  const [linkOpen, setLinkOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Mesh"
        headerAction={`${machines.length} ${machines.length === 1 ? "machine" : "machines"} · ${machines.filter((machine) => machine.connectedHere || machine.network?.state === "direct" || machine.network?.state === "relayed").length} online`}
      >
        <SettingsRow
          title="Configuration"
          control={
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={mesh.source === null}
                onClick={() => setEditing(true)}
              >
                Edit config
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={sources.length === 0}
                onClick={() => setLinkOpen(true)}
              >
                Link a machine
              </Button>
            </div>
          }
        />
      </SettingsSection>
      {machines.map((machine) => (
        <SettingsSection
          key={machine.environmentId}
          title={machine.label}
          titleAction={<MachineTag machine={machine} />}
        >
          <SettingsRow
            title={mesh.config?.machines[machine.environmentId]?.title ?? machine.label}
            status={
              machine.connectedHere
                ? "Online"
                : (meshConnectionText(machine, machines) ?? "Offline")
            }
          />
          {machine.version ? <SettingsRow title="Version" status={machine.version} /> : null}
          <details className="px-4 py-2 text-sm">
            <summary>Machine details</summary>
            <p>{mesh.config?.machines[machine.environmentId]?.reported?.platform.os}</p>
            <p>{meshConnectionText(machine, machines)}</p>
            {machine.lastError ? <p role="alert">{machine.lastError}</p> : null}
            <p>
              {machine.replicas} {machine.replicas === 1 ? "replica" : "replicas"}
            </p>
            {Object.entries(mesh.config?.projectMountStatus ?? {}).flatMap(([key, statuses]) =>
              statuses[machine.environmentId]
                ? [
                    <p key={key}>
                      {mesh.config?.projectTitles[key] ?? "Project"}:{" "}
                      {statuses[machine.environmentId]?.state} ·{" "}
                      {statuses[machine.environmentId]?.message}
                    </p>,
                  ]
                : [],
            )}
          </details>
        </SettingsSection>
      ))}
      {forgotten.length ? (
        <details>
          <summary>Forgotten machines ({forgotten.length})</summary>
          {forgotten.map((machine) => (
            <SettingsRow
              key={machine.environmentId}
              title={machine.label}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    mesh.edit((config) => forgetMachineFacts(config, machine.environmentId))
                  }
                >
                  Forget
                </Button>
              }
            />
          ))}
        </details>
      ) : null}
      <SettingsSection title="Last config apply">
        {applyStatus.error ? <p role="alert">{applyStatus.error}</p> : null}
        {applyStatus.data?.servers.flatMap((server) =>
          server.actions.map((action) => (
            <SettingsRow
              key={`${server.environmentId}:${action.id}`}
              title={action.description}
              status={action.state}
              description={action.reason}
            />
          )),
        )}
      </SettingsSection>
      <LinkWithDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        machines={machines}
        sources={sources}
        initialSource={sources[0]?.environmentId ?? null}
      />
      {editing && mesh.source ? (
        <MeshConfigDialog environmentId={mesh.source} onClose={() => setEditing(false)} />
      ) : null}
    </SettingsPageContainer>
  );
}
