import { meshAuthorityOf } from "@t3tools/shared/meshLayout";
import { linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  setMachineDisplay,
  type MachineDisplayPatch,
} from "@t3tools/client-runtime/state/machine-display";
import {
  linkMeshMachines,
  deriveMeshFooterStatus,
  meshFooterText,
  meshMachineLastSync,
  setMachineReach,
} from "@t3tools/client-runtime/state/mesh-machines";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { WORKSPACE_COLORS } from "@t3tools/client-runtime/state/sidebar-workspaces";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Link2Icon, MonitorIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment } from "~/state/peerLinks";
import {
  usePreparedConnection,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useMeshOverview } from "../../hooks/useMeshOverview";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "../settings/useScopedSettings";
import { useEnvironments } from "../../state/environments";
import { AddEnvironmentDialog } from "../settings/AddEnvironmentDialog";
import { ScopedSwitch } from "../settings/ScopedSwitch";
import { searchableSetting } from "../settings/settingsSearch";
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
import { linkSourceOptions, linkTargetOptions, shouldOfferConnect } from "./meshSettings.logic";

const COLOR_NAMES = ["Blue", "Coral", "Green", "Violet", "Amber", "Teal", "Rose", "Olive"];
const NO_MACHINES = "No machines yet.";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

function ColorPicker(props: {
  readonly value: string;
  readonly onChange: (patch: MachineDisplayPatch) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {WORKSPACE_COLORS.map((color, index) => {
        const selected = props.value === color;
        return (
          <button
            key={color}
            type="button"
            aria-label={`Color ${COLOR_NAMES[index] ?? color}`}
            aria-pressed={selected}
            className={`size-6 rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
              selected ? "ring-2 ring-foreground/60" : ""
            }`}
            style={{ backgroundColor: color }}
            onClick={() => props.onChange({ color })}
          />
        );
      })}
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
        onClick={() => props.onChange({ color: null })}
      >
        Automatic
      </button>
    </div>
  );
}

function MachineEditor(props: {
  readonly machine: ReturnType<typeof useMeshOverview>["machines"][number];
  readonly otherMachines: ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly tag: string;
  }>;
  readonly now: number;
  readonly onEdit: (patch: MachineDisplayPatch) => void;
  readonly onReach: (
    target: string,
    reach: { ssh: string; identityFile?: string | null } | null,
  ) => void;
  readonly onUnlink: (source: string, target: string) => void;
  readonly onConnect: () => void;
}) {
  const machine = props.machine;
  const configured = machine.reach;
  return (
    <SettingsSection
      id={`machine-${machine.environmentId}`}
      title={machine.label}
      titleAction={<MachineTag machine={machine} />}
      headerAction={
        <div className="flex flex-wrap items-center justify-end gap-1.5 text-xs text-muted-foreground">
          <span className="rounded-full border border-border px-2 py-0.5">
            This device: {machine.connectedHere ? "connected" : "not connected"}
          </span>
          {machine.linkedWith.length > 0 ? (
            <span className="rounded-full border border-border px-2 py-0.5">
              Linked with: {machine.linkedWith.map((entry) => entry.tag).join(", ")}
            </span>
          ) : null}
          {machine.conflicts > 0 ? (
            <span className="rounded-full border border-destructive/40 px-2 py-0.5 text-destructive">
              {machine.conflicts} {machine.conflicts === 1 ? "conflict" : "conflicts"}
            </span>
          ) : null}
        </div>
      }
    >
      <SettingsRow
        title="Label"
        description="The machine's name in the sidebar. Its server label is used when empty."
        control={
          <Input
            key={`label:${machine.label}`}
            aria-label={`Label for ${machine.label}`}
            defaultValue={machine.label}
            className="w-full @min-[32rem]/settings-row:w-56"
            onBlur={(event) => props.onEdit({ label: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        }
      />
      <SettingsRow
        title="Tag"
        description="Up to three characters. Shown on thread rows when one list mixes machines."
        control={
          <Input
            key={`tag:${machine.tag}`}
            aria-label={`Tag for ${machine.label}`}
            defaultValue={machine.tag}
            maxLength={3}
            className="w-24 text-center"
            onBlur={(event) => props.onEdit({ tag: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        }
      />
      <SettingsRow
        title="Color"
        description="Used by the tag chip and its tooltip."
        control={<ColorPicker value={machine.color} onChange={props.onEdit} />}
      />
      <SettingsRow title="Version" status={machine.version ?? "Unknown"} />
      <SettingsRow
        title="Last layout sync"
        description={props.now === 0 ? undefined : meshMachineLastSync(machine, props.now)}
        status={machine.lastError ?? undefined}
      />
      <SettingsRow
        title="Replicas"
        status={`${machine.replicas} ${machine.replicas === 1 ? "replica" : "replicas"}, ${
          machine.primaries
        } ${machine.primaries === 1 ? "primary" : "primaries"}`}
      />
      {shouldOfferConnect(machine) ? (
        <SettingsRow
          title="Connect this device"
          description={machine.urls.join(", ")}
          control={
            <Button size="xs" variant="outline" onClick={props.onConnect}>
              <PlusIcon className="size-3" />
              Connect
            </Button>
          }
        />
      ) : null}
      {props.otherMachines.map((other) => (
        <SettingsRow
          key={`reach:${other.environmentId}`}
          title={`SSH route to ${other.label} (${other.tag})`}
          description="Used by replicas and agents that run commands on the other machine."
          control={
            <div className="flex w-full flex-col gap-2 @min-[32rem]/settings-row:w-72">
              <Input
                key={`reach-ssh:${other.environmentId}:${configured[other.environmentId]?.ssh ?? ""}`}
                aria-label={`SSH destination for ${other.environmentId}`}
                defaultValue={configured[other.environmentId]?.ssh ?? ""}
                placeholder="user@host or an ssh alias"
                onBlur={(event) =>
                  props.onReach(other.environmentId, {
                    ssh: event.currentTarget.value,
                    identityFile: configured[other.environmentId]?.identityFile ?? null,
                  })
                }
              />
              <Input
                key={`reach-key:${other.environmentId}:${configured[other.environmentId]?.identityFile ?? ""}`}
                aria-label={`Identity file for ${other.environmentId}`}
                defaultValue={configured[other.environmentId]?.identityFile ?? ""}
                placeholder="Identity file (optional)"
                onBlur={(event) =>
                  props.onReach(other.environmentId, {
                    ssh: configured[other.environmentId]?.ssh ?? "",
                    identityFile: event.currentTarget.value,
                  })
                }
              />
            </div>
          }
        />
      ))}
      {machine.linkedWith.length > 0 ? (
        <SettingsRow
          title="Links"
          description={machine.linkedWith
            .map((entry) => `${entry.label} (${entry.tag})`)
            .join(", ")}
          control={
            <div className="flex flex-wrap gap-2">
              {machine.linkedWith.map((entry) => (
                <Button
                  key={entry.environmentId}
                  size="xs"
                  variant="destructive-outline"
                  onClick={() => props.onUnlink(entry.environmentId, machine.environmentId)}
                >
                  Unlink {entry.tag}
                </Button>
              ))}
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

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
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWrite = useScopedSettingsWriteAllowed();
  const config = mesh.config ?? settings.sidebarWorkspaces;
  const { machines, links } = useMeshOverview({ config });
  const updateConfig = (edit: (current: typeof config) => typeof config) => {
    if (mesh.source !== null) mesh.edit(edit);
    else updateSettings({ sidebarWorkspaces: edit(config) });
  };
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: "unlink environment" });
  const sources = usePermittedLinkSources();
  const [linkOpen, setLinkOpen] = useState(false);
  const [connectMachine, setConnectMachine] = useState<
    ReturnType<typeof useMeshOverview>["machines"][number] | null
  >(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const now = Date.parse(useNowMinute());
  const meshOn = settings.linkedEnvironmentsEnabled && settings.meshEnabled;
  const otherMachines = (environmentId: string) =>
    machines
      .filter((machine) => machine.environmentId !== environmentId)
      .map((machine) => ({
        environmentId: machine.environmentId,
        label: machine.label,
        tag: machine.tag,
      }));
  const search = searchableSetting("machines-names");
  const footer = meshFooterText(deriveMeshFooterStatus({ enabled: meshOn, machines, now }));
  const { environments } = useEnvironments();
  const forget = async (sourceEnvironmentId: string, target: string) => {
    const confirmed = await (requestConfirmDialog(
      `Unlink ${target} from ${sourceEnvironmentId}? The layout they share stays on both machines.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    const result = await unlink({
      environmentId: sourceEnvironmentId as EnvironmentId,
      input: { environmentId: target as EnvironmentId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Could not unlink the machine", String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={search.id}
        title={search.title}
        icon={<MonitorIcon className="size-4" />}
      >
        <SettingsRow
          serverScoped
          settingKeys={["linkedEnvironmentsEnabled", "meshEnabled"]}
          title="Use the mesh on this machine"
          description="Enables linked environments and keeps the workspace layout in sync with linked machines."
          control={
            <ScopedSwitch
              settingKeys={["linkedEnvironmentsEnabled", "meshEnabled"]}
              checked={meshOn}
              disabled={!canWrite}
              onCheckedChange={(checked) =>
                updateSettings({
                  linkedEnvironmentsEnabled: Boolean(checked),
                  meshEnabled: Boolean(checked),
                })
              }
              aria-label="Use the mesh on this machine"
            />
          }
        />
        <SettingsRow
          title={`Authority: ${machines.find((m) => m.environmentId === meshAuthorityOf(config))?.label ?? "Automatic"}`}
          description="File conflicts keep this machine's version, or the primary's when it has no representation. Losing versions are saved in .t3-conflicts."
          control={
            <Select
              value={meshAuthorityOf(config) ?? ""}
              disabled={!canWrite}
              onValueChange={(value) => {
                if (value) updateConfig((current) => ({ ...current, meshAuthority: value }));
              }}
            >
              <SelectTrigger aria-label="Mesh authority">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {machines.map((machine) => (
                  <SelectItem key={machine.environmentId} value={machine.environmentId}>
                    {machine.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Link with a machine"
          description="Pair two machines this app is connected to without copying codes. With one of them missing here, paste a code from its Connections settings instead."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={sources.length === 0}
              onClick={() => setLinkOpen(true)}
            >
              <Link2Icon className="size-3" />
              Link with…
            </Button>
          }
        />
        {footer === null ? null : <SettingsRow title="Status" description={footer} />}
      </SettingsSection>
      {machines.length === 0 ? (
        <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">{NO_MACHINES}</p>
      ) : null}
      {config === null
        ? null
        : machines.map((machine) => (
            <MachineEditor
              key={machine.environmentId}
              machine={machine}
              otherMachines={otherMachines(machine.environmentId)}
              now={now}
              onEdit={(patch) =>
                updateConfig((current) => setMachineDisplay(current, machine.environmentId, patch))
              }
              onReach={(target, reach) =>
                updateConfig((current) =>
                  setMachineReach(current, machine.environmentId, target, reach),
                )
              }
              onUnlink={(source, target) => {
                if (
                  links.some(
                    (entry) =>
                      entry.environmentId === source &&
                      entry.links.some((peer) => peer.environmentId === target),
                  )
                )
                  void forget(source, target);
                else void forget(target, source);
              }}
              onConnect={() => {
                setConnectError(null);
                setConnectMachine(machine);
              }}
            />
          ))}
      <LinkWithDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        machines={machines}
        sources={sources}
        initialSource={sources[0]?.environmentId ?? null}
      />
      {connectMachine === null ? null : (
        <AddEnvironmentDialog
          open
          hideTrigger
          routeTarget={null}
          error={connectError}
          savedEnvironments={environments}
          initialHost={connectMachine.urls[0] ?? ""}
          onOpenChange={(open) => {
            if (!open) setConnectMachine(null);
          }}
          onErrorChange={setConnectError}
        />
      )}
    </SettingsPageContainer>
  );
}
