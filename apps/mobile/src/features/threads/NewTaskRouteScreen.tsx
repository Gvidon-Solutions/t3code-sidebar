import { isDraftThreadRoute } from "./thread-route-state";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { AppBar } from "../../components/ui/AppBar";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useWorkspaceState } from "../../state/workspace";
import { useReplicaStatuses } from "../../state/meshReplicas";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { planThreadOnMachine, replicaProjectId } from "@t3tools/client-runtime/state/mesh-layout";
import { useSidebarWorkspaces } from "../workspaces/useSidebarWorkspaces";
import { mobileMachineChoices, mobilePendingReplicaItems } from "../workspaces/replicas.logic";
import type { HomeProjectScope } from "../home/homeThreadList";

import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  filterProjectScopes,
  getProjectScopeSelectionTarget,
  resolveNewTaskScratchOption,
} from "./new-task-project-selection";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

type NewTaskRouteParams = {
  readonly incomingShareId?: string | string[];
  readonly prompt?: string | string[];
  readonly repo?: string | string[];
  readonly pr?: string | string[];
  readonly provider?: string | string[];
  readonly model?: string | string[];
};

function deriveProjectEmptyState(catalogState: WorkspaceState): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment before creating a task.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? "Client not supported"
          : "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects from the saved environment.",
      loading: true,
    };
  }

  return {
    title: "No projects found",
    detail: "The connected environment did not report any projects.",
    loading: false,
  };
}

function NewTaskHeader(props: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly canAddProject: boolean;
  readonly searchText: string;
  readonly onSearchTextChange: (text: string) => void;
}) {
  const navigation = useNavigation();
  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.getParent()?.goBack();
  };
  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle ?? undefined}
        sidebar={false}
        options={{ headerBackVisible: true }}
        hideBottomBorder
        onBack={goBack}
        actions={
          props.canAddProject
            ? [
                {
                  accessibilityLabel: "Add project",
                  icon: "plus",
                  onPress: () => navigation.dispatch(StackActions.push("AddProject")),
                },
              ]
            : []
        }
        search={{
          value: props.searchText,
          onChangeText: props.onSearchTextChange,
          placeholder: "Search projects",
        }}
      />
    </>
  );
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const [searchText, setSearchText] = useState("");
  const { projectScopes, selectedEnvironmentId, setProject } = useNewTaskFlow();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { getShare, releaseShareReservation } = useIncomingShare();
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "Choose a project for what you shared"
      : incomingShare.attachments.length === 1
        ? `Choose a project for the ${incomingShare.attachments[0]?.type === "image" ? "image" : "file"} you shared`
        : `Choose a project for the ${incomingShare.attachments.length} ${incomingShare.attachments.every((attachment) => attachment.type === "image") ? "images" : "files"} you shared`
    : null;
  const screenTitle = incomingShare ? "Start a task" : "Choose project";
  const projectEmptyState = deriveProjectEmptyState(catalogState);
  const serverConfigs = useServerConfigs();
  const listScopes = pickableProjectGroups(projectScopes).filter(
    (scope) =>
      !scope.projects.every((project) =>
        isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot),
      ),
  );
  const visibleScopes = filterProjectScopes(listScopes, searchText);
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const connectedEnvironmentIds = new Set(
    connectedEnvironments
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
  );
  const { config: replicaConfig, updateConfig: updateReplicaConfig } = useSidebarWorkspaces();
  const replicaStatuses = useReplicaStatuses();
  const [pendingMachineStart, setPendingMachineStart] = useState<{
    readonly projectKey: string;
    readonly environmentId: string;
  } | null>(null);
  const machineChoices = mobileMachineChoices(
    replicaConfig ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    connectedEnvironments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.environmentLabel,
      connected: environment.connectionState === "connected",
      supportsMesh:
        serverConfigs.get(environment.environmentId)?.environment.capabilities.meshLayout === true,
    })),
  );
  const pendingMachineItem =
    pendingMachineStart === null
      ? undefined
      : mobilePendingReplicaItems(
          replicaConfig ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
          replicaStatuses,
          pendingMachineStart.projectKey,
        ).find((item) => item.environmentId === pendingMachineStart.environmentId);
  async function selectProject(project: EnvironmentProject): Promise<void> {
    if (incomingShare?.destination && !reservedDestinationProject) {
      try {
        await releaseShareReservation(incomingShare.id, incomingShare.destination);
      } catch (error) {
        Dialog.alert(
          "Could not change project",
          error instanceof Error
            ? error.message
            : "The shared content reservation could not be updated.",
        );
        return;
      }
    }
    const root = navigation.getState()?.routeNames.includes("NewTaskProject")
      ? navigation
      : navigation.getParent();
    const rootState = root?.getState();
    const threadRoute = rootState?.routes[rootState.index - 1];
    // Sidebar fork: reusing the draft underneath would drop a share it was not
    // opened for: the share then waited in the inbox and never reached a composer.
    const previousShareId = (
      threadRoute?.params as { draft?: { incomingShareId?: string } } | undefined
    )?.draft?.incomingShareId;
    if (
      isDraftThreadRoute(threadRoute) &&
      (!incomingShare || previousShareId === incomingShare.id)
    ) {
      setProject(project);
      root?.goBack();
      return;
    }
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          incomingShareId: incomingShare?.id,
        },
      },
    });
  }

  const startOnMachine = (scope: HomeProjectScope, environmentId: string) => {
    const plan = planThreadOnMachine({
      config: replicaConfig ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      logicalKey: scope.key,
      targetEnvironmentId: environmentId,
      seed: {
        environmentId: scope.representative.environmentId,
        path: scope.representative.workspaceRoot,
        projectId: scope.representative.id,
      },
    });
    if (plan.config !== replicaConfig) updateReplicaConfig(() => plan.config);
    if (plan.projectId !== null) {
      const project = projects.find(
        (candidate) =>
          String(candidate.environmentId) === environmentId &&
          String(candidate.id) === plan.projectId,
      );
      if (project) void selectProject(project);
      return;
    }
    setPendingMachineStart({ projectKey: scope.key, environmentId });
  };
  const openMachinePicker = (scope: HomeProjectScope) => {
    const supported = machineChoices.filter((choice) => !choice.disabled);
    if (supported.length === 0) {
      Dialog.alert(
        "No machines to start on",
        "Connect another machine, or update its server to use the mesh.",
      );
      return;
    }
    Dialog.alert(`Start ${scope.title} on`, "Pick the machine that runs the thread.", [
      ...supported.map((choice) => ({
        text: `${choice.tag}  ${choice.label}`,
        onPress: () => startOnMachine(scope, choice.environmentId),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the flow once the machine registers the mounted project
  useEffect(() => {
    if (pendingMachineStart === null || replicaConfig === null) return;
    const projectId = replicaProjectId(
      replicaConfig,
      replicaStatuses,
      pendingMachineStart.projectKey,
      pendingMachineStart.environmentId,
    );
    if (projectId === null) return;
    const project = projects.find(
      (candidate) =>
        String(candidate.environmentId) === pendingMachineStart.environmentId &&
        String(candidate.id) === projectId,
    );
    if (!project) return;
    // oxlint-disable-next-line react/set-state-in-effect -- clears the intent after the external layout arrives
    setPendingMachineStart(null);
    void selectProject(project);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- selectProject is stable enough for this one-shot
  }, [pendingMachineStart, projects, replicaConfig, replicaStatuses]);
  const openScratch = useAtomCommand(projectEnvironment.openScratch, {
    reportFailure: false,
  });
  const scratchOption =
    reservedDestinationProject === null
      ? resolveNewTaskScratchOption({
          environments: connectedEnvironments,
          serverConfigs,
          selectedEnvironmentId,
        })
      : null;
  const canStartScratch = scratchOption?.ready === true;
  const scratchEnvironment =
    scratchOption === null
      ? null
      : (connectedEnvironments.find(
          (environment) => environment.environmentId === scratchOption.environmentId,
        ) ?? null);
  const scratchStartInFlightRef = useRef(false);

  async function startScratch(): Promise<void> {
    if (!canStartScratch || !scratchOption || scratchStartInFlightRef.current) return;
    const environmentId = scratchOption.environmentId;
    scratchStartInFlightRef.current = true;
    const result = await openScratch({ environmentId, input: {} });
    if (result._tag === "Failure") {
      scratchStartInFlightRef.current = false;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Could not start without a project",
          error instanceof Error
            ? error.message
            : "The folder for threads without a project could not be created.",
        );
      }
      return;
    }
    // selectProject handles its own failures, so this never throws.
    await selectProject(result.value);
    scratchStartInFlightRef.current = false;
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigates to the incoming share's reserved destination draft once its project loads and the screen is focused
  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      // Reset on return so reserved-draft resume can retry without leaving project rows disabled.
      resumedDestinationKeyRef.current = null;
      return;
    }
    const destinationKey = `${incomingShare.id}:${destination.environmentId}:${destination.projectId}`;
    if (resumedDestinationKeyRef.current === destinationKey) {
      return;
    }
    if (!reservedDestinationProject) {
      return;
    }
    resumedDestinationKeyRef.current = destinationKey;
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: reservedDestinationProject.environmentId,
          projectId: reservedDestinationProject.id,
          title: reservedDestinationProject.title,
          incomingShareId: incomingShare.id,
        },
      },
    });
  }, [incomingShare, isFocused, reservedDestinationProject, selectDetail]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NewTaskHeader
        title={screenTitle}
        subtitle={incomingShareSubtitle}
        canAddProject={catalogState.hasReadyEnvironment}
        searchText={searchText}
        onSearchTextChange={setSearchText}
      />

      <ScreenContent>
        {pendingMachineItem ? (
          <View className="mx-4 mt-2 flex-row items-center gap-2 rounded-2xl bg-grouped-card px-4 py-2.5">
            <View className="h-4 items-center justify-center rounded bg-foreground/10 px-1">
              <Text className="font-mono text-[10px] font-t3-bold uppercase text-foreground">
                {pendingMachineItem.tag}
              </Text>
            </View>
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={2}>
              {pendingMachineItem.text}
            </Text>
          </View>
        ) : null}
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && visibleScopes.length === 0
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {scratchOption !== null && listScopes.length > 0 ? (
            Platform.OS === "android" ? (
              <View collapsable={false} className="overflow-hidden rounded-[28px] bg-grouped-card">
                <NavigationRow
                  className="bg-grouped-card"
                  title={`No project · ${scratchEnvironment?.environmentLabel ?? ""}`}
                  subtitle="Start a task without a project"
                  disabled={!canStartScratch}
                  onPress={() => void startScratch()}
                  leading={
                    <SymbolView
                      name="text.bubble"
                      size={22}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  }
                />
              </View>
            ) : (
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`No project · ${scratchEnvironment?.environmentLabel ?? ""}`}
                  disabled={!canStartScratch}
                  onPress={() => void startScratch()}
                  className={cn(
                    "flex-row items-center gap-3 bg-grouped-card px-4 py-3.5",
                    !canStartScratch && "opacity-45",
                  )}
                >
                  <View className="h-7 w-7 items-center justify-center">
                    <SymbolView
                      name="text.bubble"
                      size={18}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-bold leading-snug">
                      No project · {scratchEnvironment?.environmentLabel}
                    </Text>
                    <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                      Start a task without a project
                    </Text>
                  </View>
                  <SymbolView
                    name="chevron.right"
                    size={14}
                    tintColorClassName="accent-chevron"
                    type="monochrome"
                  />
                </Pressable>
              </View>
            )
          ) : null}
          {listScopes.length === 0 ? (
            <View
              collapsable={false}
              className={cn(
                "items-center gap-3 px-6 py-8",
                Platform.OS !== "android" && "rounded-[24px] bg-grouped-card",
              )}
            >
              {projectEmptyState.loading ? (
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              ) : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {projectEmptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {projectEmptyState.detail}
              </Text>
              {Platform.OS === "android" ? (
                <>
                  <Button
                    label={catalogState.hasReadyEnvironment ? "Add new project" : "Add environment"}
                    tone="primary"
                    onPress={() =>
                      catalogState.hasReadyEnvironment
                        ? navigation.dispatch(StackActions.push("AddProject"))
                        : navigation.navigate("ConnectionsNew")
                    }
                  />
                  {canStartScratch ? (
                    <Button
                      label="Start without a project"
                      tone="secondary"
                      onPress={() => void startScratch()}
                    />
                  ) : null}
                </>
              ) : !catalogState.hasReadyEnvironment ? (
                <View className="mt-1">
                  <Button
                    label="Add environment"
                    tone="primary"
                    onPress={() => navigation.navigate("ConnectionsNew")}
                  />
                </View>
              ) : (
                <>
                  <View className="mt-1">
                    <Button
                      label="Add new project"
                      tone="primary"
                      onPress={() => navigation.dispatch(StackActions.push("AddProject"))}
                    />
                  </View>
                  {canStartScratch ? (
                    <Button
                      label="Start without a project"
                      tone="secondary"
                      onPress={() => void startScratch()}
                    />
                  ) : null}
                </>
              )}
            </View>
          ) : visibleScopes.length === 0 ? (
            <View className="items-center gap-2 px-6 py-8">
              <Text className="text-center text-lg font-t3-bold text-foreground">
                No matching projects
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                Try a different project name or workspace path.
              </Text>
            </View>
          ) : (
            <View
              collapsable={false}
              className={
                Platform.OS === "android"
                  ? "overflow-hidden rounded-[28px] bg-grouped-card"
                  : "overflow-hidden rounded-[24px] bg-grouped-card"
              }
            >
              {visibleScopes.map((scope, scopeIndex) => {
                const hasMultipleProjects = scope.projects.length > 1;
                const selectionTarget = getProjectScopeSelectionTarget(
                  scope,
                  selectedEnvironmentId,
                  connectedEnvironmentIds,
                );
                if (Platform.OS === "android") {
                  return (
                    <NavigationRow
                      className="bg-grouped-card"
                      key={scope.key}
                      title={scope.title}
                      subtitle={
                        hasMultipleProjects
                          ? `${scope.projects.length} workspaces`
                          : selectionTarget.workspaceRoot
                      }
                      subtitleNumberOfLines={1}
                      subtitleEllipsizeMode="middle"
                      disabled={reservedDestinationProject !== null}
                      onPress={() => void selectProject(selectionTarget)}
                      onLongPress={() => openMachinePicker(scope)}
                      leading={
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={24}
                          projectTitle={scope.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      }
                    />
                  );
                }
                return (
                  <View
                    key={scope.key}
                    className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={scope.title}
                      disabled={reservedDestinationProject !== null}
                      onPress={() => void selectProject(selectionTarget)}
                      onLongPress={() => openMachinePicker(scope)}
                      className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                    >
                      <View className="h-7 w-7 items-center justify-center">
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={20}
                          projectTitle={scope.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className={cn("text-base leading-snug", "font-t3-bold")}>
                          {scope.title}
                        </Text>
                        <Text
                          className="text-xs leading-snug text-foreground-muted"
                          ellipsizeMode="middle"
                          numberOfLines={1}
                        >
                          {hasMultipleProjects
                            ? `${scope.projects.length} workspaces`
                            : selectionTarget.workspaceRoot}
                        </Text>
                      </View>
                      <SymbolView
                        name="chevron.right"
                        size={14}
                        tintColorClassName="accent-chevron"
                        type="monochrome"
                      />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
