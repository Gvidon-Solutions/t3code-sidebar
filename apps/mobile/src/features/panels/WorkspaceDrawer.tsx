import { projectEnvironment } from "../../state/projects";
import { uuidv4 } from "../../lib/uuid";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG, EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "../../lib/cn";
import { verticalHitSlop } from "../../lib/touchTargets";
import { useNavigationThreadShells, useProjects, useServerConfigs } from "../../state/entities";
import { useHomeListOptions } from "../home/home-list-options";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { DONE_STATUS_LABEL, STATUS_LABEL_BY_STATUS } from "../threads/thread-list-v2-items";
import { resolveThreadListV2Status, threadHasUnseenCompletion } from "../threads/threadListV2";
import { useWorkspaceHome } from "../workspaces/useWorkspaceHome";
import { useMeshLayout } from "../workspaces/useMeshLayout";
import { FolderDragHost } from "../workspaces/WorkspaceFolderDrag";
import {
  WorkspaceDock,
  WorkspaceFolderRow,
  WorkspaceAgentsRow,
  WorkspaceMoreRow,
  WorkspaceSectionRow,
  WorkspaceTitle,
} from "../workspaces/WorkspaceChrome";
import type { WorkspaceHomeListItem } from "../workspaces/workspaceNavigator";
import { WorkspaceThreadLine } from "../workspaces/WorkspaceThreadLine";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { replicaStatusEnvironment, useReplicaStatuses } from "../../state/meshReplicas";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  planThreadOnMachine,
  removeRepresentation,
  replicaDriverEnvironment,
  replicaProjectId,
  setPrimary,
  type PendingReplicaRow,
} from "@t3tools/client-runtime/state/mesh-layout";
import {
  machineSubactions,
  mobileMachineChoices,
  type MobilePendingReplicaItem,
} from "../workspaces/replicas.logic";
import { MachinesSheet } from "../workspaces/MachinesSheet";

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * The left chat panel (sidebar fork): the open workspace's folders and threads,
 * with the workspace tiles below, as Home shows them. Tapping a thread swaps
 * the chat to it; + in a folder starts a new thread there.
 */
export function WorkspaceDrawer(props: {
  readonly currentThreadKey: string;
  readonly onClose: () => void;
}) {
  const meshLayout = useMeshLayout();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  const threads = useNavigationThreadShells();
  const { options } = useHomeListOptions(NO_ENVIRONMENTS);
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        ...(meshLayout.config === null
          ? {}
          : {
              layout: meshLayout.config,
              connectedEnvironmentIds: meshLayout.connectedEnvironmentIds,
            }),
        projects,
        environmentId: null,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [meshLayout.config, meshLayout.connectedEnvironmentIds, options.projectGroupingMode, projects],
  );
  const workspaceHome = useWorkspaceHome({ projectScopes, threads });
  const replicaStatuses = useReplicaStatuses();
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const replicaConfig = workspaceHome.config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
  const machineChoices = mobileMachineChoices(
    replicaConfig,
    connectedEnvironments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.environmentLabel,
      connected: environment.connectionState === "connected",
      supportsMesh:
        serverConfigs.get(environment.environmentId)?.environment.capabilities.replicas === true,
    })),
  );
  const machineActions = machineSubactions(machineChoices);
  const retryReplicaCommand = useAtomCommand(replicaStatusEnvironment.retry, {
    label: "replica retry",
    reportFailure: true,
  });
  const [machinesProjectKey, setMachinesProjectKey] = useState<string | null>(null);
  const [pendingStart, setPendingStart] = useState<{
    readonly projectKey: string;
    readonly environmentId: string;
  } | null>(null);
  const seedOfProject = (projectKey: string) => {
    const scope = projectScopes.find((candidate) => candidate.key === projectKey);
    const member = scope?.projects[0];
    return member
      ? { environmentId: member.environmentId, path: member.workspaceRoot, projectId: member.id }
      : null;
  };
  const planOnMachine = (projectKey: string, environmentId: string) => {
    const seed = seedOfProject(projectKey);
    if (!seed) return null;
    return planThreadOnMachine({
      config: replicaConfig,
      logicalKey: projectKey,
      targetEnvironmentId: environmentId,
      seed,
    });
  };
  const retryPendingItem = (item: MobilePendingReplicaItem) => {
    if (item.retryEnvironmentId === null) return;
    void retryReplicaCommand({
      environmentId: EnvironmentId.make(item.retryEnvironmentId),
      input: { logicalKey: item.projectKey, environmentId: item.environmentId },
    });
  };
  const retryReplicaRow = (row: PendingReplicaRow) => {
    const driver = replicaDriverEnvironment(replicaConfig, row.rep);
    if (driver === null) return;
    void retryReplicaCommand({
      environmentId: EnvironmentId.make(driver),
      input: { logicalKey: row.logicalKey, environmentId: row.rep.environmentId },
    });
  };
  const environmentIds = useMemo(
    () => new Set(threads.map((thread) => thread.environmentId)),
    [threads],
  );
  const { buildItems } = workspaceHome;
  const items = useMemo(() => {
    // oxlint-disable-next-line react/purity -- Snooze state is read when the drawer's list rebuilds; it does not tick.
    const now = new Date().toISOString();
    return buildItems({
      base: [],
      searching: false,
      settlementEnvironmentIds: environmentIds,
      snoozeEnvironmentIds: environmentIds,
      queuedThreadKeys: NO_KEYS,
      selectedThreadKey: props.currentThreadKey,
      toRow: (item) => ({
        type: "v2-thread",
        key: `${item.thread.environmentId}:${item.thread.id}`,
        item,
        snoozeWakeLabelText:
          item.snoozed && item.thread.snoozedUntil != null
            ? snoozeWakeLabel(item.thread.snoozedUntil, { now })
            : undefined,
        timeLabel: "",
        snoozePresetMinute: undefined,
        showTrailingDivider: false,
        hasQueuedMessages: false,
        canMoveUp: false,
        canMoveDown: false,
      }),
    });
  }, [buildItems, environmentIds, props.currentThreadKey]);

  const { onClose } = props;
  const startThread = useCallback(
    (project: EnvironmentProject) => {
      onClose();
      selectDetail({
        name: "Thread",
        params: {
          draft: {
            requestId: uuidv4(),
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            title: project.title,
          },
        },
      });
    },
    [onClose, selectDetail],
  );

  const openScratchProject = useAtomCommand(projectEnvironment.openScratch, {
    reportFailure: true,
  });
  const startFolderThread = (project: EnvironmentProject) => {
    if (!project.isScratch) {
      startThread(project);
      return;
    }
    const environmentId = connectedEnvironments.find(
      (environment) => environment.connectionState === "connected",
    )?.environmentId;
    if (environmentId === undefined) return;
    void openScratchProject({ environmentId, input: {} }).then((result) => {
      if (result._tag === "Success") startThread(result.value);
    });
  };
  const startOnMachine = (projectKey: string, environmentId: string) => {
    const scope = projectScopes.find((candidate) => candidate.key === projectKey);
    if (scope?.projects.some((project) => project.isScratch)) {
      void openScratchProject({ environmentId: EnvironmentId.make(environmentId), input: {} }).then(
        (result) => {
          if (result._tag === "Success") startThread(result.value);
        },
      );
      return;
    }
    const plan = planOnMachine(projectKey, environmentId);
    if (!plan) return;
    if (plan.config !== replicaConfig) workspaceHome.updateConfig(() => plan.config);
    if (plan.projectId !== null) {
      const project = projects.find(
        (candidate) =>
          String(candidate.environmentId) === environmentId &&
          String(candidate.id) === plan.projectId,
      );
      if (project) startThread(project);
      return;
    }
    setPendingStart({ projectKey, environmentId });
  };
  const addReplicaOn = (projectKey: string, environmentId: string) => {
    const plan = planOnMachine(projectKey, environmentId);
    if (plan && plan.config !== replicaConfig) workspaceHome.updateConfig(() => plan.config);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the draft once the machine registers the mounted project
  useEffect(() => {
    if (pendingStart === null || workspaceHome.config === null) return;
    const projectId = replicaProjectId(
      workspaceHome.config,
      replicaStatuses,
      pendingStart.projectKey,
      pendingStart.environmentId,
    );
    if (projectId === null) return;
    const project = projects.find(
      (candidate) =>
        String(candidate.environmentId) === pendingStart.environmentId &&
        String(candidate.id) === projectId,
    );
    if (!project) return;
    // oxlint-disable-next-line react/set-state-in-effect -- clears the intent after the external layout arrives
    setPendingStart(null);
    startThread(project);
  }, [pendingStart, projects, replicaStatuses, startThread, workspaceHome.config]);

  const renderItem = ({ item }: { readonly item: WorkspaceHomeListItem }) => {
    switch (item.type) {
      case "ws-section":
        return <WorkspaceSectionRow item={item} onToggle={workspaceHome.toggle} />;
      case "ws-folder":
        return workspaceHome.config && workspaceHome.currentWorkspaceId ? (
          <WorkspaceFolderRow
            item={item}
            workspaces={workspaceHome.config.workspaces}
            onToggle={workspaceHome.toggle}
            onToggleWorkspace={workspaceHome.toggleProjectIn}
            onFoldMode={workspaceHome.setFoldMode}
            onNewThread={startFolderThread}
            mesh={workspaceHome.meshActionsFor(item.projectKey)}
            machineSubactions={machineActions}
            onNewThreadOnMachine={startOnMachine}
            onOpenMachines={setMachinesProjectKey}
            onRetryReplica={retryPendingItem}
          />
        ) : null;
      case "ws-more":
        return <WorkspaceMoreRow item={item} onToggle={workspaceHome.toggle} />;
      case "ws-agents":
        return <WorkspaceAgentsRow item={item} onToggle={workspaceHome.toggle} />;
      case "ws-thread": {
        const thread = item.item.thread;
        const key = `${thread.environmentId}:${thread.id}`;
        const selected = key === props.currentThreadKey;
        const status = resolveThreadListV2Status(thread);
        const unread = status === "ready" && threadHasUnseenCompletion(thread);
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            className={cn(selected && "bg-subtle")}
            hitSlop={verticalHitSlop(32)}
            onPress={() => {
              onClose();
              if (selected) return;
              navigation.dispatch(
                StackActions.replace("Thread", {
                  environmentId: String(thread.environmentId),
                  threadId: String(thread.id),
                }),
              );
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <WorkspaceThreadLine
              thread={thread}
              status={STATUS_LABEL_BY_STATUS[status] ?? (unread ? DONE_STATUS_LABEL : null)}
              unread={unread}
              settled={item.item.variant === "slim"}
              showPin={thread.pinnedAt != null && !item.item.pinned}
              projectLabel={item.projectLabel}
              machineTag={item.machineTag}
              timeLabel={item.timeLabel}
              working={status === "working"}
              hasQueuedMessages={false}
              selected={selected}
              nested={item.nested === true}
              voice={item.voice === true}
            />
          </Pressable>
        );
      }
      default:
        return null;
    }
  };

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      {workspaceHome.workspace ? <WorkspaceTitle workspace={workspaceHome.workspace} /> : null}
      <FolderDragHost
        getFolders={workspaceHome.arrangeFolders}
        onDrop={workspaceHome.reorderProject}
      >
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 12 }}
        />
      </FolderDragHost>
      {workspaceHome.config ? (
        <WorkspaceDock
          workspaces={workspaceHome.config.workspaces}
          currentWorkspaceId={workspaceHome.currentWorkspaceId}
          activity={workspaceHome.activity}
          onOpen={workspaceHome.openWorkspace}
          bottomInset={insets.bottom}
          reportsHeight={false}
        />
      ) : null}
      {machinesProjectKey !== null ? (
        <MachinesSheet
          config={replicaConfig}
          projectKey={machinesProjectKey}
          title={
            projectScopes.find((scope) => scope.key === machinesProjectKey)?.title ??
            machinesProjectKey
          }
          liveStatuses={replicaStatuses}
          machines={machineChoices}
          onClose={() => setMachinesProjectKey(null)}
          onAddReplica={(environmentId) => addReplicaOn(machinesProjectKey, environmentId)}
          onMakePrimary={(environmentId) =>
            workspaceHome.updateConfig((current) =>
              setPrimary(current, machinesProjectKey, environmentId),
            )
          }
          onRemove={(environmentId) =>
            workspaceHome.updateConfig((current) =>
              removeRepresentation(current, machinesProjectKey, environmentId),
            )
          }
          onRetry={retryReplicaRow}
        />
      ) : null}
    </View>
  );
}
