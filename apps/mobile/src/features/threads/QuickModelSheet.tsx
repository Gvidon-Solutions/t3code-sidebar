import { useCallback, useEffect, useMemo, useState } from "react";
import { Animated, Modal, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import type { ModelOption } from "../../lib/modelOptions";
import {
  ThreadSettingsSessionProvider,
  useThreadSettingsSession,
  type ThreadSettingsSessionProps,
} from "./ThreadSettingsSheet";
import {
  effortChoicesFor,
  modelOptionDisplay,
  quickSwitchModels,
  type EffortChoice,
} from "./modelDisplay";

const SHEET_MAX_WIDTH = 560;

function QuickSwitchPill(props: {
  readonly option: ModelOption;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const display = modelOptionDisplay(props.option);
  return (
    <Pressable
      accessibilityLabel={display.effort ? `${display.name}, ${display.effort}` : display.name}
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      className={cn(
        "min-h-9 flex-row items-center gap-1.5 rounded-xl border px-2.5 active:opacity-70",
        props.selected ? "border-accent bg-secondary" : "border-border bg-grouped-card",
      )}
      onPress={props.onPress}
    >
      <ProviderIcon
        iconUrl={props.option.providerIconUrl}
        provider={props.option.providerDriver}
        size={14}
      />
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.selected ? "text-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
        style={{ maxWidth: 200 }}
      >
        {display.name}
      </Text>
      {display.effort ? (
        <Text className="shrink-0 text-3xs font-t3-medium text-foreground-muted">
          {display.effort}
        </Text>
      ) : null}
    </Pressable>
  );
}

function EffortButton(props: { readonly choice: EffortChoice; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={
        props.choice.kind === "option" && props.choice.description
          ? `${props.choice.label}. ${props.choice.description}`
          : props.choice.label
      }
      accessibilityRole="radio"
      accessibilityState={{ checked: props.choice.selected }}
      className={cn(
        "min-h-10 justify-center rounded-xl border px-3 py-1.5 active:opacity-70",
        props.choice.selected ? "border-accent bg-secondary" : "border-border bg-grouped-card",
      )}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.choice.selected ? "text-foreground" : "text-foreground-muted",
        )}
      >
        {props.choice.label}
      </Text>
      {props.choice.kind === "option" && props.choice.description ? (
        <Text className="text-3xs text-foreground-muted" numberOfLines={1}>
          {props.choice.description}
        </Text>
      ) : null}
    </Pressable>
  );
}

function QuickModelSheetContent(props: {
  readonly onClose: () => void;
  readonly onOpenAllModels: () => void;
}) {
  const session = useThreadSettingsSession();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const current = session.displayedModel;
  const display = current ? modelOptionDisplay(current) : null;
  const isFavorite = current ? session.favoriteKeys.has(current.key) : false;
  const quick = useMemo(
    () =>
      quickSwitchModels({
        groups: session.providerGroups,
        favoriteKeys: session.favoriteKeys,
        current,
      }),
    [current, session.favoriteKeys, session.providerGroups],
  );
  const effort = useMemo(
    () =>
      effortChoicesFor({
        option: current,
        descriptors: session.displayedDescriptors,
        selection: session.displayedModelSelection,
        reportedSelection: session.reportedModelSelection,
        groups: session.providerGroups,
      }),
    [
      current,
      session.displayedDescriptors,
      session.displayedModelSelection,
      session.providerGroups,
      session.reportedModelSelection,
    ],
  );
  const runtimeLabel =
    session.runtimeModeChoices.find((choice) => choice.mode === session.runtimeMode)?.label ??
    session.runtimeMode;

  const applyOptionChange = session.applyOptionChange;
  const selectModelNow = session.selectModelNow;
  const selectEffort = useCallback(
    (choice: EffortChoice) => {
      void Haptics.selectionAsync();
      if (choice.kind === "option") {
        applyOptionChange(choice.descriptorId, choice.id);
      } else {
        selectModelNow(choice.option);
      }
    },
    [applyOptionChange, selectModelNow],
  );

  return (
    <>
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel="Close model picker"
          accessibilityRole="button"
          className="absolute inset-0"
          onPress={props.onClose}
        />
        <View
          accessibilityViewIsModal
          className="self-center rounded-t-3xl bg-sheet-solid px-4 pt-2"
          style={{
            width: "100%",
            maxWidth: SHEET_MAX_WIDTH,
            maxHeight: windowHeight * 0.78,
            paddingBottom: Math.max(insets.bottom, 12),
          }}
        >
          <View className="mb-2 h-1 w-9 self-center rounded-full bg-border" />

          <View className="flex-row items-center gap-2 pb-1">
            <ProviderIcon
              iconUrl={current?.providerIconUrl}
              provider={current?.providerDriver}
              size={22}
            />
            <View className="min-w-0 flex-1">
              <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                {display?.name ?? "Choose model"}
              </Text>
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {[current?.providerLabel, current?.subtitle].filter(Boolean).join(" · ")}
                {display?.effort ? ` · ${display.effort}` : ""}
              </Text>
            </View>
            {current ? (
              <Pressable
                accessibilityLabel={
                  isFavorite
                    ? `Unpin ${display?.name ?? current.label}`
                    : `Pin ${display?.name ?? current.label}`
                }
                accessibilityRole="button"
                accessibilityState={{ disabled: !session.favoritesLoaded, selected: isFavorite }}
                className="size-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
                disabled={!session.favoritesLoaded}
                onPress={() => session.toggleFavorite(current)}
                style={{ opacity: session.favoritesLoaded ? 1 : 0.45 }}
              >
                <SymbolView
                  name={isFavorite ? "star.fill" : "star"}
                  size={16}
                  tintColorClassName={isFavorite ? "accent-icon" : "accent-icon-muted"}
                  type="monochrome"
                />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel="Close model picker"
              accessibilityRole="button"
              className="size-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
              onPress={props.onClose}
            >
              <SymbolView
                name="xmark"
                size={15}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            </Pressable>
          </View>

          <ScrollView
            bounces={false}
            contentContainerStyle={{ paddingBottom: 2 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={{ flexShrink: 1 }}
          >
            {effort ? (
              <View className="pt-2">
                <Text className="px-1 pb-1.5 text-xs font-t3-medium text-foreground-muted">
                  {effort.label}
                </Text>
                <View className="flex-row flex-wrap gap-1.5">
                  {effort.choices.map((choice) => (
                    <EffortButton
                      key={choice.key}
                      choice={choice}
                      onPress={() => selectEffort(choice)}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            <View className="flex-row items-baseline gap-2 px-1 pb-1.5 pt-3">
              <Text className="text-xs font-t3-medium text-foreground-muted">Quick switch</Text>
              <Text className="text-3xs text-foreground-muted">
                {quick.source === "pinned" ? "pinned" : "suggested"}
              </Text>
            </View>
            {quick.models.length === 0 ? (
              <Text className="px-1 pb-1 text-xs text-foreground-muted">
                No available models. Open All models to set one up.
              </Text>
            ) : (
              <ScrollView
                horizontal
                bounces={false}
                contentContainerStyle={{ gap: 6, paddingHorizontal: 1 }}
                showsHorizontalScrollIndicator={false}
              >
                {quick.models.map((option) => (
                  <QuickSwitchPill
                    key={option.key}
                    option={option}
                    selected={option.key === current?.key}
                    onPress={() => {
                      session.selectModelNow(option);
                    }}
                  />
                ))}
              </ScrollView>
            )}

            <View className="mt-2 border-t border-border-subtle">
              <Pressable
                accessibilityLabel={`Runtime: ${runtimeLabel}`}
                accessibilityRole="button"
                accessibilityState={{ expanded: runtimeOpen }}
                className="min-h-11 flex-row items-center gap-2 active:opacity-70"
                onPress={() => setRuntimeOpen((open) => !open)}
              >
                <Text className="flex-1 text-sm text-foreground">Runtime</Text>
                <Text className="text-sm text-foreground-muted">{runtimeLabel}</Text>
                <SymbolView
                  name={runtimeOpen ? "chevron.up" : "chevron.right"}
                  size={11}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
              </Pressable>
              {runtimeOpen ? (
                <View className="pb-1">
                  {session.runtimeModeChoices.map((choice) => (
                    <Pressable
                      key={choice.mode}
                      accessibilityLabel={`${choice.label}. ${choice.description}`}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: choice.mode === session.runtimeMode }}
                      className="min-h-10 flex-row items-center gap-2 active:opacity-70"
                      onPress={() => {
                        void Haptics.selectionAsync();
                        session.onUpdateRuntimeMode(choice.mode);
                        setRuntimeOpen(false);
                      }}
                    >
                      <View className="min-w-0 flex-1">
                        <Text className="text-sm text-foreground">{choice.label}</Text>
                        <Text className="text-3xs text-foreground-muted" numberOfLines={1}>
                          {choice.description}
                        </Text>
                      </View>
                      {choice.mode === session.runtimeMode ? (
                        <SymbolView
                          name="checkmark"
                          size={14}
                          tintColorClassName="accent-icon"
                          type="monochrome"
                          weight="semibold"
                        />
                      ) : null}
                    </Pressable>
                  ))}
                </View>
              ) : null}

              <Pressable
                accessibilityLabel="All models"
                accessibilityRole="button"
                className="min-h-11 flex-row items-center gap-2 border-t border-border-subtle active:opacity-70"
                onPress={props.onOpenAllModels}
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-sm text-foreground">All models</Text>
                  <Text className="text-3xs text-foreground-muted">Search, providers, legacy</Text>
                </View>
                <SymbolView
                  name="chevron.right"
                  size={11}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
              </Pressable>
            </View>

            <Text className="pb-1 pt-2 text-center text-3xs text-foreground-muted">
              Applies instantly · tap outside to close
            </Text>
          </ScrollView>
        </View>
      </View>
    </>
  );
}

/** Compact model and reasoning sheet opened by the composer's model chip. */
export function QuickModelSheet(
  props: ThreadSettingsSessionProps & {
    readonly onClose: () => void;
    readonly onOpenAllModels: () => void;
  },
) {
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [progress]);

  return (
    <Modal
      animationType="none"
      onRequestClose={props.onClose}
      statusBarTranslucent
      transparent
      visible
    >
      <View className="flex-1">
        <Animated.View
          className="absolute inset-0"
          style={{ opacity: progress, backgroundColor: "rgba(0,0,0,0.5)" }}
        />
        <Animated.View
          className="flex-1"
          style={{
            transform: [
              {
                translateY: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [300, 0],
                }),
              },
            ],
          }}
        >
          <ThreadSettingsSessionProvider {...props}>
            <QuickModelSheetContent
              onClose={props.onClose}
              onOpenAllModels={props.onOpenAllModels}
            />
          </ThreadSettingsSessionProvider>
        </Animated.View>
      </View>
    </Modal>
  );
}
