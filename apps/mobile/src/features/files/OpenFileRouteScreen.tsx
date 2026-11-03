import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAtomValue } from "@effect/atom-react";
import { addRecentFile, parseT3FileLink } from "@t3tools/client-runtime/files";
import { EnvironmentId } from "@t3tools/contracts";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { filesEnvironment } from "../../state/files";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import { useMeshLayout } from "../workspaces/useMeshLayout";
import { fileRoutePathSegments } from "./filePath";

const RECENT_LIMIT = 12;

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function OpenFileRouteScreen(
  props: StaticScreenProps<{
    readonly environmentId?: string;
    readonly threadId?: string;
    readonly cwd?: string;
    readonly projectName?: string;
  }>,
) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const { config } = useMeshLayout();
  const environments = useWorkspaceEnvironments().map((environment) => ({
    ...environment,
    display: machineDisplayOf(
      config ?? { machines: {} },
      environment.environmentId,
      environment.environmentLabel,
    ),
  }));
  const connectedIds = useAtomValue(connectedEnvironmentIdsAtom);
  const initialEnvironmentId =
    (props.route.params.environmentId as EnvironmentId | undefined) ??
    environments[0]?.environmentId ??
    ("unknown" as EnvironmentId);
  const [selectedEnvironmentId, setSelectedEnvironmentId] =
    useState<EnvironmentId>(initialEnvironmentId);
  const [value, setValue] = useState(props.route.params.cwd ?? "~/");
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recents, setRecents] = useState<ReadonlyArray<string>>([]);

  const selectedLabel =
    environments.find((entry) => entry.environmentId === selectedEnvironmentId)?.display.label ??
    String(selectedEnvironmentId);
  const targetConnected = connectedIds.includes(selectedEnvironmentId);
  const callEnvironmentId = targetConnected ? selectedEnvironmentId : (connectedIds[0] ?? null);

  const machineLink = parseT3FileLink(value.trim());
  const listPath = (() => {
    const raw = value.trim();
    if (raw === "") return null;
    if (machineLink !== null) return machineLink.absolutePath;
    if (isAbsolutePath(raw) || raw.startsWith("~/") || raw.startsWith("~\\") || raw === "~") {
      return raw;
    }
    const root = props.route.params.cwd;
    return root === undefined ? null : `${root.replace(/[\\/]+$/, "")}/${raw}`;
  })();

  const listQuery = useEnvironmentQuery(
    callEnvironmentId !== null && listPath !== null
      ? filesEnvironment.list({
          environmentId: callEnvironmentId,
          input: { partialPath: listPath, limit: 40 },
        })
      : null,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this device's recent files for the selected machine
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(`t3code:recent-files:${selectedEnvironmentId}`)
      .then((raw) => {
        if (cancelled) return;
        setRecentError(null);
        if (raw === null) {
          setRecents([]);
          return;
        }
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setRecents(parsed.filter((entry): entry is string => typeof entry === "string"));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRecents([]);
          setRecentError(String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEnvironmentId]);

  const openPath = (environmentId: EnvironmentId, absolutePath: string) => {
    const next = addRecentFile(recents, absolutePath, RECENT_LIMIT);
    setRecents(next);
    void AsyncStorage.setItem(`t3code:recent-files:${environmentId}`, JSON.stringify(next)).catch(
      (error: unknown) => setRecentError(String(error)),
    );
    const otherMachine = environmentId !== props.route.params.environmentId;
    navigation.navigate("ThreadFile", {
      environmentId: String(environmentId),
      sourceEnvironmentId: props.route.params.environmentId,
      ...(otherMachine
        ? { cwd: "/", projectName: selectedLabel }
        : props.route.params.threadId !== undefined
          ? { threadId: props.route.params.threadId }
          : {
              ...(props.route.params.cwd === undefined ? {} : { cwd: props.route.params.cwd }),
              ...(props.route.params.projectName === undefined
                ? {}
                : { projectName: props.route.params.projectName }),
            }),
      path: fileRoutePathSegments(absolutePath),
    });
  };

  const open = () => {
    const target = machineLink ?? {
      environmentId: selectedEnvironmentId,
      absolutePath: listPath,
    };
    if (target.absolutePath === null) return;
    openPath(target.environmentId, target.absolutePath);
  };

  const entries = useMemo(() => listQuery.data?.entries ?? [], [listQuery.data]);

  return (
    <SettingsScreen title="Open file">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4 pb-[18px]"
      >
        <Text className="text-sm text-foreground-muted">
          Any file on a connected machine, inside a project or outside one.
        </Text>
        <View className="flex-row flex-wrap gap-2">
          {environments.map((environment) => {
            const connected = connectedIds.includes(environment.environmentId);
            return (
              <Chip
                size="touch"
                key={environment.environmentId}
                label={`${environment.display.tag} ${environment.display.label}`}
                selected={environment.environmentId === selectedEnvironmentId}
                disabled={!connected}
                onPress={() => {
                  setSelectedEnvironmentId(environment.environmentId);
                  setValue(
                    environment.environmentId === props.route.params.environmentId &&
                      props.route.params.cwd !== undefined
                      ? props.route.params.cwd
                      : "~/",
                  );
                }}
              />
            );
          })}
        </View>
        {!targetConnected ? (
          <Text className="text-sm text-warning-foreground">
            Not connected to {selectedLabel}. Connect it from the environment list.
          </Text>
        ) : null}
        <AppTextInput
          autoCapitalize="none"
          autoCorrect={false}
          value={value}
          accessibilityLabel="File path"
          className="min-h-[45px]"
          placeholder="/srv/app/README.md or ~/notes.md"
          onChangeText={setValue}
          onSubmitEditing={open}
          returnKeyType="go"
        />
        {entries.length > 0 ? (
          <View className="overflow-hidden rounded-2xl bg-grouped-card">
            {entries.map((entry) => (
              <Pressable
                key={entry.absolutePath}
                accessibilityRole="button"
                accessibilityLabel={`${entry.name}, ${entry.kind}`}
                className="min-h-[45px] flex-row items-center justify-between gap-3 px-4 py-3 active:opacity-60"
                onPress={() => {
                  if (entry.kind === "directory") {
                    setValue(`${entry.absolutePath}/`);
                    return;
                  }
                  if (!targetConnected) return;
                  openPath(selectedEnvironmentId, entry.absolutePath);
                }}
              >
                <Text
                  className="min-w-0 flex-1 font-mono text-sm text-foreground"
                  numberOfLines={1}
                >
                  {entry.name}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {entry.kind === "directory" ? "folder" : entry.kind}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Button label="Open file" onPress={open} disabled={!targetConnected} fullWidth />
        <View className="gap-2">
          <Text className="text-xs font-t3-medium text-foreground-muted">
            Recent on {selectedLabel}
          </Text>
          {recentError === null ? null : (
            <Text accessibilityRole="alert" className="text-sm text-warning-foreground">
              Could not save or load recent files: {recentError}
            </Text>
          )}
          {recents.length === 0 ? (
            <Text className="text-sm text-foreground-muted">No files opened here yet.</Text>
          ) : (
            recents.map((file) => (
              <Pressable
                key={file}
                accessibilityRole="button"
                accessibilityLabel={file}
                className="min-h-[45px] justify-center rounded-xl bg-grouped-card px-3 py-2 active:opacity-60"
                onPress={() => {
                  if (!targetConnected) return;
                  openPath(selectedEnvironmentId, file);
                }}
              >
                <Text className="font-mono text-xs text-foreground" numberOfLines={1}>
                  {file}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}
