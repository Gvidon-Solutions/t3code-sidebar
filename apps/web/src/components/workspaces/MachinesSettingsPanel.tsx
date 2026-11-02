import {
  knownMachineIds,
  machineDisplayOf,
  setMachineDisplay,
  type MachineDisplayPatch,
} from "@t3tools/client-runtime/state/machine-display";
import { WORKSPACE_COLORS } from "@t3tools/client-runtime/state/sidebar-workspaces";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useMachineConfigWriter } from "./machinesConfig";

const COLOR_NAMES = ["Blue", "Coral", "Green", "Violet", "Amber", "Teal", "Rose", "Olive"];

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
            className={cn(
              "size-6 rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected && "ring-2 ring-foreground/60",
            )}
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

export function MachinesSettingsPanel() {
  const config = usePrimarySettings((settings) => settings.sidebarWorkspaces);
  const writeConfig = useMachineConfigWriter();
  const { environments } = useEnvironments();
  const environmentLabels = new Map<string, string>(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const machineIds = knownMachineIds(config, environmentLabels.keys());

  return (
    <SettingsPageContainer>
      <SettingsSection id="machines" title="Machines">
        <SettingsRow
          title="Names and tags"
          description="A short tag marks thread rows only when one list mixes threads from several machines. The name appears in its tooltip, and in Settings here."
        />
      </SettingsSection>
      {machineIds.length === 0 ? (
        <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">No machines yet.</p>
      ) : null}
      {machineIds.map((environmentId) => {
        const machine = config.machines[environmentId] ?? {};
        const serverLabel = environmentLabels.get(environmentId) ?? environmentId;
        const display = machineDisplayOf(config, environmentId, serverLabel);
        const connected = environmentLabels.has(environmentId);
        const writeMachine = (patch: MachineDisplayPatch) =>
          writeConfig((current) => setMachineDisplay(current, environmentId, patch));
        return (
          <SettingsSection
            key={environmentId}
            id={`machine-${environmentId}`}
            title={display.label}
            headerAction={
              <span className="text-xs text-muted-foreground">
                {connected ? "Connected" : "Not connected"}
              </span>
            }
          >
            <SettingsRow
              title="Label"
              description={`The server names itself ${serverLabel}. Leave empty to use that name.`}
              control={
                <Input
                  key={`label:${machine.label ?? ""}`}
                  aria-label={`Label for ${serverLabel}`}
                  defaultValue={machine.label ?? ""}
                  placeholder={serverLabel}
                  className="w-full @min-[32rem]/settings-row:w-56"
                  onBlur={(event) => writeMachine({ label: event.currentTarget.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              }
            />
            <SettingsRow
              title="Tag"
              description="Up to three characters, uppercase. Derived from the label when empty."
              control={
                <Input
                  key={`tag:${machine.tag ?? ""}`}
                  aria-label={`Tag for ${serverLabel}`}
                  defaultValue={machine.tag ?? ""}
                  placeholder={display.tag}
                  maxLength={3}
                  className="w-24 text-center"
                  onBlur={(event) => writeMachine({ tag: event.currentTarget.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              }
            />
            <SettingsRow
              title="Color"
              description="Used by the tag chip and its tooltip."
              control={
                <ColorPicker value={machine.color ?? display.color} onChange={writeMachine} />
              }
            />
            <SettingsRow
              title="Environment"
              description={environmentId}
              status={connected ? "Connected" : "Offline; its layout entries are still kept."}
            />
          </SettingsSection>
        );
      })}
    </SettingsPageContainer>
  );
}
