import {
  machineTagBackground,
  type MachineDisplay,
} from "@t3tools/client-runtime/state/machine-display";
import type { DraftMachineCardRow } from "@t3tools/client-runtime/state/mesh-layout";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

function MachineChip(props: { readonly machine: MachineDisplay }) {
  if (props.machine.tag.trim() === "") return null;
  return (
    <View
      className="shrink-0 rounded px-1 py-0.5"
      style={{ backgroundColor: machineTagBackground(props.machine.color) }}
    >
      <Text className="text-[10px] font-t3-bold uppercase text-foreground">
        {props.machine.tag}
      </Text>
    </View>
  );
}

/** Fork: the centred machine choice above a new-thread composer. */
export function DraftMachineCards(props: {
  readonly rows: ReadonlyArray<DraftMachineCardRow>;
  readonly onSelect: (environmentId: string) => void;
}) {
  if (props.rows.length === 0) return null;
  return (
    <View
      accessibilityRole="radiogroup"
      className="w-full flex-row flex-wrap justify-center gap-2 px-2 pb-2"
    >
      {props.rows.map((row) => (
        <Pressable
          key={row.environmentId}
          accessibilityRole="radio"
          accessibilityState={{ checked: row.selected, disabled: !row.selectable }}
          accessibilityLabel={`${row.label}, ${row.primary ? "Main, " : ""}${row.text}`}
          accessibilityHint={row.hint ?? undefined}
          disabled={!row.selectable}
          onPress={() => props.onSelect(row.environmentId)}
          testID={`draft-machine-card-${row.environmentId}`}
          className={cn(
            "min-w-[150px] max-w-[240px] flex-1 gap-0.5 rounded-xl border px-3 py-2",
            row.selected ? "border-primary bg-primary/10" : "border-border bg-card",
            !row.selectable && "opacity-55",
          )}
        >
          <View className="flex-row items-center gap-1.5">
            <MachineChip machine={row.machine} />
            <Text
              className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
              numberOfLines={1}
            >
              {row.label}
            </Text>
            {row.primary ? (
              <Text className="shrink-0 rounded bg-foreground/10 px-1 py-0.5 text-[9px] font-t3-bold uppercase text-foreground-muted">
                Main
              </Text>
            ) : null}
            {row.selected ? (
              <SymbolView name="checkmark" size={13} tintColorClassName="accent-primary" />
            ) : null}
          </View>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {row.note ?? row.text}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
