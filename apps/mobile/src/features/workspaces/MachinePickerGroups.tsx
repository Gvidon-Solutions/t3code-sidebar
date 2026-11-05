import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "../../components/ui/AppText";

export function MachinePickerGroups<T>({
  machines,
  available,
  children,
}: {
  machines: readonly T[];
  available: (machine: T) => boolean;
  children: (machine: T, index: number, count: number) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const ready = machines.filter(available);
  const unavailable = machines.filter((machine) => !available(machine));
  return (
    <View>
      {ready.map((machine, index) => children(machine, index, ready.length))}
      {unavailable.length ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            className="min-h-[48px] justify-center px-4 py-3"
          >
            <AppText>Unavailable ({unavailable.length})</AppText>
          </Pressable>
          {expanded
            ? unavailable.map((machine, index) => children(machine, index, unavailable.length))
            : null}
        </>
      ) : null}
    </View>
  );
}
