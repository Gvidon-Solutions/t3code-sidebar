import { useReplicaStatuses } from "../../state/meshReplicas";
import { useEnvironmentQuery } from "../../state/query";
import { meshLayoutAtoms } from "../../state/meshLayout";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { useNowMinute } from "../../hooks/useNowMinute";
import { MeshConfigDialog } from "./MeshConfigDialog";
import { linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  linkMeshMachines,
  meshConfigHistory,
  meshConfigApplyGroups,
  meshMachineDetailRows,
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
  const [detail, setDetail] = useState<string | null>(null);
  const live = useReplicaStatuses();
  const config = mesh.config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
  const selected = machines.find((machine) => machine.environmentId === detail);
  const groups = meshConfigApplyGroups(
    applyStatus.data,
    meshConfigHistory(mesh.state?.snapshot?.document ?? {}),
    now,
  );
  const online = (machine: (typeof machines)[number]) =>
    machine.connectedHere ||
    machine.network?.state === "direct" ||
    machine.network?.state === "relayed";
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Mesh"
        headerAction={`${machines.length} ${machines.length === 1 ? "machine" : "machines"} · ${machines.filter(online).length} online`}
      >
        <div className="flex gap-2 px-4 py-3">
          <Button size="sm" disabled={mesh.source === null} onClick={() => setEditing(true)}>
            Edit config
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={sources.length === 0}
            onClick={() => setLinkOpen(true)}
          >
            Link a machine
          </Button>
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
                <span
                  aria-hidden="true"
                  className={`size-1.5 shrink-0 rounded-full ${online(machine) ? "bg-success" : "bg-muted-foreground"}`}
                />
                <span className="text-xs text-muted-foreground">
                  {online(machine)
                    ? machine.network?.state === "relayed"
                      ? meshConnectionText(machine, machines)
                      : "Online"
                    : (meshConnectionText(machine, machines) ??
                      (machine.lastSeenAt ? `Offline since ${machine.lastSeenAt}` : "Offline"))}
                </span>
                <span className="text-xs text-muted-foreground">
                  {machine.version ?? "Version not reported"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {machine.platform?.os ?? "Platform not reported"}
                </span>
                <span aria-hidden="true">›</span>
              </button>
              {machine.unnamed ? (
                <div className="px-4 pb-2">
                  <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
                    Name it in config
                  </Button>
                </div>
              ) : null}
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
              <DialogDescription>Machine details</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Reach path</dt>
                  <dd>
                    {meshConnectionText(selected, machines) ??
                      (online(selected) ? "Connected directly" : "Offline")}
                  </dd>
                </div>
                {selected.lastError ? (
                  <div>
                    <dt>Last error</dt>
                    <dd role="alert">{selected.lastError}</dd>
                  </div>
                ) : null}
                {meshMachineDetailRows(selected, config, live).map((row) => (
                  <div key={row.label}>
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
              {selected.unnamed ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setDetail(null);
                    setEditing(true);
                  }}
                >
                  Name it in config
                </Button>
              ) : null}
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
              <span>{machine.label}</span>
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
      {applyStatus.error ? <p role="alert">{applyStatus.error}</p> : null}
      {groups.map((group) => (
        <SettingsSection key={group.revision} title={group.title}>
          <ul className="space-y-2 px-4 py-3 text-sm">
            {group.actions.map((action) => (
              <li key={`${action.server}:${action.id}`}>
                <span>
                  {action.description} ·{" "}
                  {action.state === "in_progress"
                    ? "In progress"
                    : action.state === "done"
                      ? "Done"
                      : "Failed"}
                </span>
                {action.reason ? (
                  <p className="text-xs text-muted-foreground">{action.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </SettingsSection>
      ))}
      <LinkWithDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        machines={machines}
        sources={sources}
        initialSource={sources[0]?.environmentId ?? null}
      />
      {editing && mesh.source ? (
        <MeshConfigDialog
          key={mesh.source}
          environmentId={mesh.source}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
