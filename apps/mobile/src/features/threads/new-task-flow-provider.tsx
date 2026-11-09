import {
  draftMachineDisplays,
  draftMachineStatus,
  logDraftMachineCollisions,
} from "@t3tools/client-runtime/state/mesh-layout";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { AsyncResult } from "effect/reactivity";
import {
  defaultDraftMachine,
  draftMachineCanHostCopy,
  draftMachineCardSync,
  draftMachineCatalogsKnown,
  draftMachineUsable,
  savedDraftMachineChoice,
  hasUsableDraftModels,
  draftMachineCards,
  draftModelUnavailableReason,
  planThreadOnMachine,
  resolveLogicalProjectKey,
  representationRow,
  replicaProjectId,
  replicaDriverEnvironment,
} from "@t3tools/client-runtime/state/mesh-layout";
import { EnvironmentId } from "@t3tools/contracts";
import { useReplicaStatuses, replicaStatusEnvironment } from "../../state/meshReplicas";
import { ActiveNewTaskContext } from "../../state/active-new-task";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { useNowMinuteMs } from "../../lib/clock";
import * as Dialog from "../../components/ui/Dialog";
import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import type {
  ModelSelection,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";

import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useMeshLayout } from "../workspaces/useMeshLayout";
import { useMeshOverview } from "../workspaces/useMeshOverview";
import type { TurnCommandMetadata } from "../../lib/commandMetadata";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
} from "../../lib/modelOptions";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appendComposerDraftAttachments,
  type ComposerDraftInsertion,
  type ComposerDraftWorkspaceSelection,
  composerDraftsLoadedAtom,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  isNewTaskDraftKey,
  removeComposerDraftAttachment,
  replaceComposerDraftAttachments,
  retargetNewTaskDraft,
  setComposerDraftText,
  setStickyComposerModelSelection,
  updateComposerDraftSettings,
  useComposerDraft,
  useStickyComposerModelSelection,
} from "../../state/use-composer-drafts";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { useBranches, usePaginatedBranches } from "../../state/queries";
import { vcsEnvironment } from "../../state/vcs";
import { type QueuedThreadMessage } from "../../state/thread-outbox";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type VcsRef } from "@t3tools/client-runtime/state/vcs";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectScope,
} from "../home/homeThreadList";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  resolvePendingTaskInteractionMode,
  resolveProviderInteractionMode,
} from "../../state/legacy-plan-mode";
import { useLegacyPlanModeState } from "./use-legacy-plan-mode-enabled";
import {
  resolveNewTaskDraftWorkspace,
  resolveNewTaskBranchWorktreePath,
  resolveNewTaskLocalWorkspaceSelection,
} from "./new-task-context-presentation";
import { resolveEnvironmentProjectMatch } from "./new-task-project-selection";
import { useNewTaskProjectDefaults } from "./use-new-task-project-defaults";
import { resolveNewThreadRuntimeMode } from "./thread-settings-options";
import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";
import {
  INACTIVE_FLOW_KEY,
  type NewTaskFlowState,
  newTaskFlowStateAtom,
  readNewTaskFlowState,
  resolveRouteDraft,
  type RouteDraftResolution,
  stampedEnvironmentProjectsLoading,
  updateNewTaskFlowState,
} from "./new-task-flow-state";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";

type WorkspaceMode = "local" | "worktree";

export function branchBadgeLabel(input: {
  readonly branch: VcsRef;
  readonly project: EnvironmentProject | null;
}): string | null {
  if (input.branch.current) {
    return "current";
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot) {
    return "worktree";
  }
  if (input.branch.isRemote) {
    return "remote";
  }
  if (input.branch.isDefault) {
    return "default";
  }
  return null;
}

type NewTaskFlowContextValue = {
  readonly activeNewTask: { readonly pendingKey: string | null } | null;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModelKey: string | null;
  readonly workspaceMode: WorkspaceMode;
  readonly isGitRepo: boolean;
  readonly isGitRepoKnown: boolean;
  readonly canChooseWorkspace: boolean;
  readonly selectedBranchName: string | null;
  readonly selectedWorktreePath: string | null;
  readonly resolveWorkspaceSelection: (
    selection: ComposerDraftWorkspaceSelection | undefined,
  ) => ComposerDraftWorkspaceSelection;
  readonly startFromOrigin: boolean;
  readonly pullRequestReference: string | undefined;
  readonly draftKey: string | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly submitting: boolean;
  readonly branchesLoading: boolean;
  readonly availableBranches: ReadonlyArray<VcsRef>;
  readonly currentCheckoutBranchName: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly planModeEnabled: boolean;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly display?: import("@t3tools/client-runtime/state/machine-display").MachineDisplay;
    readonly status?: string;
    readonly disabled?: boolean;
    readonly projectId: string | null;
    readonly primary: boolean;
    readonly connected: boolean;
    readonly hasUsableModels: boolean | null;
    readonly canHostCopy: boolean;
    readonly usable: boolean;
    readonly sync: "synced" | "copying" | "out-of-sync" | null;
  }>;
  readonly machineCards: import("@t3tools/client-runtime/state/mesh-layout").DraftMachineCardRow[];
  readonly selectedProject: EnvironmentProject | null;
  /** The machines the selected project's environment links to, whose threads it can read. */
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly isScratchDraft: boolean;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly setProject: (project: EnvironmentProject) => void;
  /** The flow's project, read when a continuation resumes after an await. */
  readonly getSelectedProjectKey: () => string | null;
  /**
   * The draft id of the route this flow serves when that draft, or its
   * project, is gone. Only the topmost draft route is served, so a screen
   * compares this with its own draft id.
   */
  readonly missingRouteDraftId: string | null;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  readonly switchEnvironment: (
    environmentId: EnvironmentId,
    options?: { readonly remember?: boolean },
  ) => Promise<boolean>;
  readonly switchingToEnvironmentId: EnvironmentId | null;
  readonly mountingStatus: string | null;
  readonly mountTarget: {
    readonly environmentId: EnvironmentId;
    readonly logicalKey: string;
  } | null;
  readonly retryMount: (() => void) | null;
  readonly setSelectedModelKey: (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
  readonly setWorkspaceMode: (mode: WorkspaceMode) => void;
  readonly selectBranch: (branch: VcsRef) => void;
  readonly setStartFromOrigin: (value: boolean) => void;
  readonly buildPendingTaskMessage: (
    metadata: TurnCommandMetadata,
    options?: {
      readonly currentCheckoutBranch?: string | null;
    },
  ) => QueuedThreadMessage | null;
  readonly setPrompt: (value: string) => void;
  readonly replaceAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  /** Appends draft attachments; returns how many the live cap rejected. */
  readonly appendAttachments: (
    attachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ) => number;
  readonly removeAttachment: (imageId: string) => void;
  readonly clearAttachments: () => void;
  readonly setSubmitting: (value: boolean) => void;
  readonly loadBranches: () => void;
  readonly setRuntimeMode: (value: RuntimeMode) => void;
  readonly setInteractionMode: (value: ProviderInteractionMode) => void;
  readonly setSelectedModelOptions: (
    value: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(
  props: React.PropsWithChildren<{
    active?: boolean;
    /** Identifies the draft route this flow serves; a new key starts a fresh flow. */
    flowKey?: string;
    routeDraftId?: string;
  }>,
) {
  const meshLayout = useMeshLayout();
  const statuses = useReplicaStatuses();
  const meshOverview = useMeshOverview({ config: meshLayout.config });
  const retryReplica = useAtomCommand(replicaStatusEnvironment.retry);
  const [pendingMount, setPendingMount] = useState<{
    environmentId: EnvironmentId;
    logicalKey: string;
  } | null>(null);

  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const projects = useProjects();
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const groupingSettings = useMobileProjectGroupingSettings();
  const { enabled: legacyPlanModeEnabled } = useLegacyPlanModeState();

  const projectScopes = sortHomeProjectScopes({
    scopes: buildHomeProjectScopes({
      ...(meshLayout.config === null
        ? {}
        : {
            layout: meshLayout.config,
            connectedEnvironmentIds: meshLayout.connectedEnvironmentIds,
          }),
      projects,
      environmentId: null,
      projectGroupingMode: groupingSettings.sidebarProjectGroupingMode,
    }),
    threads,
    pendingTasks: [],
    projectSortOrder: "updated_at",
  });

  const flowKey = props.flowKey ?? INACTIVE_FLOW_KEY;
  const storedFlowState = useAtomValue(newTaskFlowStateAtom(flowKey));
  const draftsLoaded = useAtomValue(composerDraftsLoadedAtom);
  // A draft route opened from a list row, a deep link, or restored state binds
  // its draft here until the flow's first write stores the binding.
  const routeDraft = useComposerDraft(
    storedFlowState.draftKey === null ? (props.routeDraftId ?? null) : null,
  );
  // Readiness of the environment the route's draft is stamped to; another
  // environment's projects loading first says nothing about it.
  const stampedEnvironmentId = routeDraft.project?.environmentId ?? null;
  const connectionsReady = useConnectionsReady();
  const stampedEnvironmentConnection =
    useWorkspaceEnvironments().find(
      (environment) => environment.environmentId === stampedEnvironmentId,
    )?.connectionState ?? null;
  const stampedEnvironmentShell = useEnvironmentShellReadiness(stampedEnvironmentId);
  const stampedEnvironmentLoading = stampedEnvironmentProjectsLoading({
    connectionsReady,
    connectionState: stampedEnvironmentConnection,
    shellCacheRead: stampedEnvironmentShell.cacheRead,
    shellStatus: stampedEnvironmentShell.status,
    shellHasError: stampedEnvironmentShell.hasError,
  });
  const resolveRoute = (
    flow: NewTaskFlowState,
    loaded: boolean,
    stamp: Parameters<typeof resolveRouteDraft>[0]["stamp"],
  ): RouteDraftResolution =>
    resolveRouteDraft({
      flow,
      routeDraftId: props.routeDraftId,
      draftsLoaded: loaded,
      stamp,
      projects,
      stampedEnvironmentLoading,
    });
  const routeDraftResolution = resolveRoute(storedFlowState, draftsLoaded, routeDraft.project);
  const flowState =
    routeDraftResolution.kind === "open" ? routeDraftResolution.flow : storedFlowState;
  const {
    environmentId: selectedEnvironmentIdOverride,
    projectKey: selectedProjectKey,
    draftKey: activeDraftKey,
    submitting,
    expandedProvider,
  } = flowState;
  // Continuations read the flow at use time, with the route's draft applied.
  const readFlow = (): NewTaskFlowState => {
    const stored = readNewTaskFlowState(flowKey);
    const resolution = resolveRoute(
      stored,
      appAtomRegistry.get(composerDraftsLoadedAtom),
      props.routeDraftId === undefined
        ? undefined
        : getComposerDraftSnapshot(props.routeDraftId).project,
    );
    return resolution.kind === "open" ? resolution.flow : stored;
  };
  // Every flow write stores the route's draft binding along with it, so the
  // binding outlives the draft's project stamp (submit clears it).
  const updateFlow = (patch: Partial<NewTaskFlowState>) =>
    updateNewTaskFlowState(flowKey, { ...readFlow(), ...patch });
  const selectedEnvironmentId =
    selectedEnvironmentIdOverride !== null &&
    projects.some((project) => project.environmentId === selectedEnvironmentIdOverride)
      ? selectedEnvironmentIdOverride
      : (projects[0]?.environmentId ?? null);
  const projectsForEnvironment = pipe(
    projects,
    Arr.filter((project) => project.environmentId === selectedEnvironmentId),
  );

  // A route draft still waiting for its environment has no project yet: the
  // fallback would show, and could send to, another environment's project.
  const selectedProject =
    routeDraftResolution.kind === "pending"
      ? null
      : (projectsForEnvironment.find(
          (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
        ) ??
        projectsForEnvironment[0] ??
        null);

  const linkedEnvironments = useLinkedEnvironments(selectedProject?.environmentId ?? null);
  const storedStickyModelSelection = useStickyComposerModelSelection();
  const modelSelectionNow = useNowMinuteMs();
  const serverConfigs = useServerConfigs();
  const [switchingToEnvironmentId, setSwitchingToEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const projectDefaults = useNewTaskProjectDefaults(selectedProject);
  const selectedEnvironmentServerConfig = switchingToEnvironmentId
    ? (serverConfigs.get(switchingToEnvironmentId) ?? null)
    : projectDefaults.serverConfig;
  const isScratchDraft = projectDefaults.isScratch;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const selectedProjectDraftKey = selectedProject ? activeDraftKey : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates the persistent draft in the new-task flow store once a project is selected, before the composer mounts
  useEffect(() => {
    // A route that names a draft binds that draft, or returns to the picker.
    if (
      props.active === false ||
      props.routeDraftId !== undefined ||
      activeDraftKey !== null ||
      selectedProject === null
    ) {
      return;
    }
    // Creates the persistent draft once the project selection is ready; the key must exist before the composer mounts.
    updateNewTaskFlowState(flowKey, {
      draftKey: createNewTaskDraft({
        environmentId: selectedProject.environmentId,
        projectId: selectedProject.id,
      }),
    });
  }, [activeDraftKey, flowKey, selectedProject, props.active, props.routeDraftId]);
  const activePendingKey =
    props.active === false
      ? null
      : props.routeDraftId
        ? `draft-task:${props.routeDraftId}`
        : selectedProjectDraftKey
          ? `draft-task:${selectedProjectDraftKey}`
          : null;
  const activeNewTask = props.active === false ? null : { pendingKey: activePendingKey };
  const selectedProjectDraft = useComposerDraft(selectedProjectDraftKey);
  const prompt = selectedProjectDraft.text;
  const attachments = selectedProjectDraft.attachments;
  const projectGitStatus = useEnvironmentQuery(
    props.active !== false && selectedProject !== null && selectedProject.workspaceRoot !== ""
      ? vcsEnvironment.status({
          environmentId: selectedProject.environmentId,
          input: { cwd: selectedProject.workspaceRoot },
        })
      : null,
  );
  const currentCheckoutBranchName = projectGitStatus.data?.refName ?? null;
  // The unfiltered ref list also provides repository capability while offline.
  const projectBranches = useBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: selectedProject?.workspaceRoot || null,
  });
  const knownIsGitRepo = projectGitStatus.data?.isRepo ?? projectBranches.data?.isRepo ?? null;
  const isGitRepo = knownIsGitRepo ?? true;
  const projectSettings = projectDefaults.projectSettings;
  const canChooseWorkspace = !isScratchDraft;
  const defaultWorkspaceMode: WorkspaceMode = projectDefaults.defaultWorkspaceMode;
  const branchState = usePaginatedBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: selectedProject?.workspaceRoot || null,
  });
  const branchesLoading = branchState.isPending && branchState.data === null;
  const allBranchRefs = branchState.refs;
  const availableBranches = pipe(
    allBranchRefs,
    Arr.filter((branch) => !branch.isRemote),
  );

  const resolveWorkspaceSelection = (selection: ComposerDraftWorkspaceSelection | undefined) =>
    resolveNewTaskDraftWorkspace({
      selection,
      canChooseWorkspace,
      defaultMode: defaultWorkspaceMode,
      defaultModeSettled: projectDefaults.defaultWorkspaceModeSettled,
      isGitRepo,
      branches: allBranchRefs,
      projectCwd: selectedProject?.workspaceRoot ?? null,
    });
  const workspaceSelection = resolveWorkspaceSelection(selectedProjectDraft.workspaceSelection);
  const workspaceMode = workspaceSelection.mode;
  const selectedBranchName = workspaceSelection.branch;
  const selectedWorktreePath = workspaceSelection.worktreePath;
  // Keep the user's explicit choice separate from the resolved display value:
  // only the explicit flag is ever written back to the draft, so the resolved
  // value keeps tracking the server setting when the config loads late.
  const draftStartFromOrigin = selectedProjectDraft.workspaceSelection?.startFromOrigin;
  const startFromOrigin =
    isGitRepo && (draftStartFromOrigin ?? projectSettings.settings.newWorktreesStartFromOrigin);
  const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
  const managedPolicy = selectedEnvironmentServerConfig?.managedPolicy;
  const runtimeMode = resolveNewThreadRuntimeMode(
    selectedProjectDraft.runtimeMode,
    defaultRuntimeMode,
    managedPolicy,
  );

  // Antigravity keeps unavailable selections so sign-out or a catalog change
  // cannot switch the user's model.
  const draftModelSelection = selectedProjectDraft.modelSelection ?? null;
  const projectDefaultModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    projectSettings.settings.defaultModelSelection,
    selectedProject?.id ?? null,
  );
  const stickyModelSelection = storedStickyModelSelection;
  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        selectedEnvironmentServerConfig,
        draftModelSelection ?? projectDefaultModelSelection ?? stickyModelSelection,
        undefined,
        selectedProject?.id ?? null,
        false,
        true,
      ),
    [
      selectedEnvironmentServerConfig,
      draftModelSelection,
      projectDefaultModelSelection,
      stickyModelSelection,
      selectedProject?.id,
    ],
  );

  const selectedDefaultModel = resolveNewTaskModelSelection({
    draftSelection: draftModelSelection,
    projectDefaultSelection: projectDefaultModelSelection,
    stickySelection: stickyModelSelection,
    modelOptions,
  });
  const selectedModel = resolveNewThreadModelSelection({
    defaultSelection: selectedDefaultModel,
    explicitSelection:
      draftModelSelection ?? (projectDefaultModelSelection ? null : stickyModelSelection),
    fallbackSelection: selectedEnvironmentServerConfig?.settings.fallbackModelSelection ?? null,
    providers: selectedEnvironmentServerConfig?.providers ?? [],
    ...(selectedEnvironmentServerConfig
      ? { settings: selectedEnvironmentServerConfig.settings }
      : {}),
    projectId: selectedProject?.id ?? null,
    now: modelSelectionNow,
  }).selection;
  const selectedModelForCards = useMemo(() => selectedModel, [selectedModel]);
  const selectedModelKey = selectedModel
    ? `${selectedModel.instanceId}:${selectedModel.model}`
    : null;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.instanceId === selectedModel.instanceId &&
        option.selection.model === selectedModel.model,
    ) ?? null;
  const selectedProviderStatus =
    selectedEnvironmentServerConfig?.providers.find(
      (provider) => provider.instanceId === selectedModel?.instanceId,
    ) ?? null;
  const planModeEnabled =
    legacyPlanModeEnabled && selectedProviderStatus?.showInteractionModeToggle !== false;
  const interactionMode = planModeEnabled
    ? (selectedProjectDraft.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE)
    : DEFAULT_PROVIDER_INTERACTION_MODE;
  const setSelectedModelKey = (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => {
    if (!key || !selectedProjectDraftKey) {
      return;
    }
    const option = modelOptions.find((candidate) => candidate.key === key);
    if (!option) {
      return;
    }
    const selection = withRememberedModelOptions(
      options ? { ...option.selection, options } : option.selection,
    );
    const provider = selectedEnvironmentServerConfig?.providers.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    updateComposerDraftSettings(selectedProjectDraftKey, {
      modelSelection: selection,
      ...(provider?.showInteractionModeToggle === false
        ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
        : {}),
    });
    setStickyComposerModelSelection(selection);
  };
  const setSelectedModelOptions = (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
    if (!selectedModel || !selectedProjectDraftKey) {
      return;
    }
    rememberModelOptions(selectedModel.instanceId, selectedModel.model, options ?? []);
    const nextSelection: ModelSelection = options
      ? { ...selectedModel, options }
      : {
          instanceId: selectedModel.instanceId,
          model: selectedModel.model,
        };
    updateComposerDraftSettings(selectedProjectDraftKey, {
      modelSelection: nextSelection,
    });
    setStickyComposerModelSelection(nextSelection);
  };

  const providerGroups = groupByProvider(modelOptions);
  const setPrompt = (value: string) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    setComposerDraftText(selectedProjectDraftKey, value);
  };
  const replaceAttachments = (nextAttachments: ReadonlyArray<DraftComposerAttachment>) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, nextAttachments);
  };
  const appendAttachments = (
    nextAttachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ): number => {
    if (!selectedProjectDraftKey) {
      return 0;
    }
    return appendComposerDraftAttachments(selectedProjectDraftKey, nextAttachments, {
      appendReference: true,
      insertion,
    });
  };
  const removeAttachment = (imageId: string) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    removeComposerDraftAttachment(selectedProjectDraftKey, imageId);
  };
  const clearAttachments = () => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, []);
  };

  const carryDraftContentTo = (project: EnvironmentProject): string => {
    const target = { environmentId: project.environmentId, projectId: project.id };
    const current = readFlow().draftKey;
    if (current !== null && isNewTaskDraftKey(current)) {
      retargetNewTaskDraft(current, target);
      return current;
    }
    return createNewTaskDraft(target);
  };

  const setProject = (project: EnvironmentProject) => {
    updateFlow({
      draftKey: carryDraftContentTo(project),
      environmentId: project.environmentId,
      projectKey: scopedProjectKey(project.environmentId, project.id),
    });
  };

  const selectEnvironment = (environmentId: EnvironmentId) => {
    const match = resolveEnvironmentProjectMatch(
      projects.filter((project) => project.environmentId === environmentId),
      selectedProject,
    );
    updateFlow({
      draftKey: match ? carryDraftContentTo(match) : readFlow().draftKey,
      environmentId,
      projectKey: match ? scopedProjectKey(match.environmentId, match.id) : null,
    });
  };

  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const latestSwitchRef = useRef<object | null>(null);
  const preferenceScope = projectScopes.find((scope) =>
    scope.projects.some(
      (project) =>
        project.environmentId === selectedProject?.environmentId &&
        project.id === selectedProject?.id,
    ),
  );
  const preferenceKey = isScratchDraft ? "scratch" : preferenceScope?.key;
  const rememberDraftMachine = (environmentId: EnvironmentId) => {
    const saved = savedDraftMachineChoice({
      remember: true,
      preferenceKey: preferenceKey ?? null,
      environmentId,
    });
    if (!saved) return;
    savePreferences({
      transform: (current) => ({
        draftMachines: { ...current.draftMachines, [saved.preferenceKey]: saved.environmentId },
      }),
    });
  };
  const switchEnvironment = async (
    environmentId: EnvironmentId,
    options: { readonly remember?: boolean } = {},
  ): Promise<boolean> => {
    // Remember only after the switch is accepted: a machine this server cannot
    // mount must never replace the person's saved choice.
    const remember = options.remember !== false;
    setPendingMount(null);
    if (environmentId === selectedEnvironmentId) {
      latestSwitchRef.current = null;
      setSwitchingToEnvironmentId(null);
      if (remember) rememberDraftMachine(environmentId);
      return true;
    }
    if (!isScratchDraft) {
      if (!selectedProject || !meshLayout.config) return false;
      const scope = projectScopes.find((scope) =>
        scope.projects.some(
          (project) =>
            project.id === selectedProject.id &&
            project.environmentId === selectedProject.environmentId,
        ),
      );
      if (!scope) return false;
      const logicalKey = resolveLogicalProjectKey(
        selectedProject,
        meshLayout.config,
        () => scope.key,
      );
      const plan = planThreadOnMachine({
        config: meshLayout.config,
        logicalKey,
        targetEnvironmentId: environmentId,
        seed: {
          environmentId: selectedProject.environmentId,
          projectId: selectedProject.id,
          path: selectedProject.workspaceRoot,
        },
      });
      const target = projects.find(
        (project) => project.environmentId === environmentId && project.id === plan.projectId,
      );
      if (target) {
        setProject(target);
        if (remember) rememberDraftMachine(environmentId);
        return true;
      }
      // An older server cannot host a copy; offering to mount there would leave
      // the draft "preparing" forever, so refuse the switch instead.
      if (serverConfigs.get(environmentId)?.environment.capabilities.replicas !== true) {
        return false;
      }
      meshLayout.edit(
        (current) =>
          planThreadOnMachine({
            config: current,
            logicalKey,
            targetEnvironmentId: environmentId,
            seed: {
              environmentId: selectedProject.environmentId,
              projectId: selectedProject.id,
              path: selectedProject.workspaceRoot,
            },
          }).config,
      );
      setPendingMount({ environmentId, logicalKey });
      setSwitchingToEnvironmentId(environmentId);
      if (remember) rememberDraftMachine(environmentId);
      return true;
    }
    const request = {};
    latestSwitchRef.current = request;
    setSwitchingToEnvironmentId(environmentId);
    const result = await openScratch({ environmentId, input: {} });
    if (latestSwitchRef.current !== request) return false;
    latestSwitchRef.current = null;
    setSwitchingToEnvironmentId(null);
    if (result._tag === "Success") {
      setProject(result.value);
      if (remember) rememberDraftMachine(environmentId);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not switch machine",
        error instanceof Error
          ? error.message
          : "The folder for threads without a project could not be created.",
      );
    }
    return false;
  };

  const setWorkspaceMode = (mode: WorkspaceMode) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    if (!selectedProject) {
      return;
    }
    const localSelection = resolveNewTaskLocalWorkspaceSelection({
      branches: availableBranches,
      projectCwd: selectedProject.workspaceRoot,
    });
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode,
        branch: mode === "local" ? localSelection.branch : selectedBranchName,
        worktreePath: mode === "local" ? localSelection.worktreePath : selectedWorktreePath,
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
        // Refs have not named the current branch yet; the selection follows it.
        ...(mode === "local" && localSelection.awaitsCurrentBranch
          ? { followsCurrentCheckout: true }
          : {}),
      },
    });
  };

  const selectBranch = (branch: VcsRef) => {
    if (!selectedProject || !selectedProjectDraftKey) {
      return;
    }
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: branch.name,
        worktreePath: resolveNewTaskBranchWorktreePath({
          workspaceMode,
          projectCwd: selectedProject.workspaceRoot,
          branchWorktreePath: branch.worktreePath,
        }),
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
      },
    });
  };

  const setStartFromOrigin = (value: boolean) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: selectedBranchName,
        worktreePath: selectedWorktreePath,
        startFromOrigin: value,
        ...(selectedBranchName === null && workspaceSelection.followsCurrentCheckout
          ? { followsCurrentCheckout: true }
          : {}),
      },
    });
  };

  const refreshBranches = branchState.refresh;
  const loadBranches = () => {
    if (!selectedProject) {
      return;
    }
    setPendingConnectionError(null);
    refreshBranches();
  };

  const setRuntimeMode = (value: RuntimeMode) => {
    if (selectedProjectDraftKey) {
      updateComposerDraftSettings(selectedProjectDraftKey, { runtimeMode: value });
    }
  };
  const setInteractionMode = (value: ProviderInteractionMode) => {
    if (selectedProjectDraftKey) {
      updateComposerDraftSettings(selectedProjectDraftKey, {
        interactionMode: resolveProviderInteractionMode(selectedProviderStatus, value),
      });
    }
  };

  const buildPendingTaskMessage = (
    metadata: TurnCommandMetadata,
    options?: { readonly currentCheckoutBranch?: string | null },
  ): QueuedThreadMessage | null => {
    if (!selectedProject || !selectedProjectDraftKey) {
      return null;
    }
    const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
    const text = draft.text.trim();
    const draftModelSelection =
      resolveSelectableModelSelection(
        selectedEnvironmentServerConfig,
        draft.modelSelection ?? null,
        selectedProject.id,
      ) ?? selectedModel;
    if ((text.length === 0 && draft.attachments.length === 0) || !draftModelSelection) {
      return null;
    }
    if (
      threadContextsOutsideEnvironment({
        text: draft.text,
        records: draft.context?.records ?? [],
        environmentId: selectedProject.environmentId,
        linkedEnvironments,
      }).length > 0
    ) {
      return null;
    }
    const workspaceSelection = resolveWorkspaceSelection(draft.workspaceSelection);
    const mode = workspaceSelection.mode;
    return {
      environmentId: selectedProject.environmentId,
      threadId: ThreadId.make(metadata.threadId),
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments: draft.attachments,
      context: draft.context,
      modelSelection: draftModelSelection,
      runtimeMode: resolveNewThreadRuntimeMode(
        draft.runtimeMode,
        defaultRuntimeMode,
        managedPolicy,
      ),
      interactionMode: resolvePendingTaskInteractionMode({
        planModeEnabled: legacyPlanModeEnabled,
        draftInteractionMode: draft.interactionMode,
        provider: selectedEnvironmentServerConfig?.providers.find(
          (candidate) => candidate.instanceId === draftModelSelection.instanceId,
        ),
      }),
      creation: {
        projectId: selectedProject.id,
        projectTitle: selectedProject.title,
        projectCwd: selectedProject.workspaceRoot,
        workspaceMode: mode,
        ...(mode === "worktree" && workspaceSelection?.pullRequestReference
          ? { pullRequestReference: workspaceSelection.pullRequestReference }
          : {}),
        // Queued local tasks use drain-time checkout; snapshot branches only for immediate sends or explicit choices.
        branch: resolveProjectThreadCreationBranch({
          workspaceMode: mode,
          selectedBranch: workspaceSelection?.branch ?? null,
          currentCheckoutBranch: options?.currentCheckoutBranch ?? null,
        }),
        worktreePath: mode === "worktree" ? null : (workspaceSelection?.worktreePath ?? null),
        ...((workspaceSelection?.startFromOrigin ?? startFromOrigin)
          ? { startFromOrigin: true }
          : {}),
      },
      createdAt: metadata.createdAt,
    };
  };

  const machineIdentities = draftMachineDisplays(
    meshLayout.config ?? { machines: {} },
    [
      ...new Set([
        ...serverConfigs.keys(),
        ...Object.keys(savedConnectionsById),
        ...Object.keys(meshLayout.config?.machines ?? {}),
      ]),
    ].map((id) => {
      const environmentId = EnvironmentId.make(id);
      return {
        environmentId,
        descriptorLabel: serverConfigs.get(environmentId)?.environment.label,
        label: savedConnectionsById[environmentId]?.environmentLabel,
        url:
          savedConnectionsById[environmentId]?.displayUrl ??
          savedConnectionsById[environmentId]?.httpBaseUrl,
      };
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports ambiguous machine identities once per collision set to the diagnostics log
  useEffect(() => {
    logDraftMachineCollisions(machineIdentities.collisions);
  }, [machineIdentities.collisions]);
  const environments = machineIdentities.rows
    .filter(
      (display) =>
        !isScratchDraft ||
        !!serverConfigs.get(EnvironmentId.make(display.environmentId))?.scratchWorkspaceRoot,
    )
    .map((display) => {
      const environmentId = EnvironmentId.make(display.environmentId);
      const connection = connectedEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      const connected = connection?.connectionState === "connected";
      const hasProject = isScratchDraft
        ? projects.some(
            (project) =>
              project.environmentId === environmentId &&
              project.workspaceRoot === serverConfigs.get(environmentId)?.scratchWorkspaceRoot,
          )
        : preferenceScope?.projects.some((project) => project.environmentId === environmentId) ||
          meshLayout.config?.projectMounts[preferenceKey ?? ""]?.some(
            (rep) => rep.environmentId === environmentId && rep.projectId,
          );
      const meshMachine = meshOverview.machines.find(
        (machine) => machine.environmentId === environmentId,
      );
      const reachable =
        connected ||
        meshMachine?.network?.state === "direct" ||
        meshMachine?.network?.state === "relayed";
      const via =
        meshMachine?.network?.state === "relayed"
          ? (meshOverview.machines.find(
              (machine) => machine.environmentId === meshMachine.network?.via,
            )?.label ?? null)
          : null;
      const projectId = (preferenceScope?.projects.find(
        (project) => project.environmentId === environmentId,
      )?.id ??
        meshLayout.config?.projectMounts[preferenceKey ?? ""]?.find(
          (rep) => rep.environmentId === environmentId,
        )?.projectId ??
        null) as import("@t3tools/contracts").ProjectId | null;
      const serverConfig = serverConfigs.get(environmentId) ?? null;
      const supportsReplicas = serverConfig
        ? serverConfig.environment.capabilities.replicas === true
        : null;
      const canHostCopy = draftMachineCanHostCopy({
        hasProject: projectId !== null,
        supportsReplicas,
        isScratchDraft,
      });
      const hasUsableModels = connected ? hasUsableDraftModels(serverConfig, projectId) : null;
      return {
        environmentId,
        environmentLabel: display.label,
        display,
        status:
          !connected && reachable
            ? via
              ? `Available through ${via}`
              : "Available through the mesh"
            : draftMachineStatus({
                connected,
                hasProject: !!hasProject,
                error: connection?.connectionError,
              }),
        // An older server that already holds the project is still selectable.
        disabled: !connected || !canHostCopy,
        projectId,
        canHostCopy,
        usable: draftMachineUsable({
          connected,
          hasUsableModels,
          selectedModelUsable:
            selectedModel !== null &&
            draftModelUnavailableReason(serverConfig, selectedModel, projectId) === null,
          canHostCopy,
        }),
        primary:
          meshLayout.config?.projectMounts[preferenceKey ?? ""]?.some(
            (rep) => rep.environmentId === environmentId && rep.role === "primary",
          ) ?? environmentId === meshLayout.source,
        connected,
        hasUsableModels,
        sync:
          draftMachineCardSync(
            statuses.find(
              (status) =>
                status.logicalKey === (preferenceKey ?? "") &&
                status.environmentId === environmentId,
            )?.state,
          ) ??
          draftMachineCardSync(
            meshLayout.config?.projectMountStatus[preferenceKey ?? ""]?.[environmentId]?.state,
          ) ??
          (preferenceScope?.projects.some((project) => project.environmentId === environmentId)
            ? "synced"
            : null),
      };
    });
  const machineCards = draftMachineCards({
    config: meshLayout.config ?? { machines: {} },
    choices: environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.environmentLabel,
      projectId: environment.projectId,
      primary: environment.primary,
      connected: environment.connected,
      hasUsableModels: environment.hasUsableModels,
      canHostCopy: environment.canHostCopy,
      config: serverConfigs.get(environment.environmentId) ?? null,
      sync: environment.sync,
    })),
    reachability: Object.fromEntries(
      meshOverview.machines.map((machine) => [
        machine.environmentId,
        {
          reachable:
            machine.connectedHere ||
            machine.network?.state === "direct" ||
            machine.network?.state === "relayed",
          viaLabel:
            machine.network?.state === "relayed"
              ? (meshOverview.machines.find((other) => other.environmentId === machine.network?.via)
                  ?.label ?? null)
              : null,
        },
      ]),
    ),
    selectedEnvironmentId:
      switchingToEnvironmentId ?? pendingMount?.environmentId ?? selectedEnvironmentId ?? null,
    selection: selectedModelForCards,
    draftHasProject: !isScratchDraft,
  });
  const mountRep =
    pendingMount &&
    meshLayout.config?.projectMounts[pendingMount.logicalKey]?.find(
      (rep) => rep.environmentId === pendingMount.environmentId,
    );
  const mountRow =
    pendingMount && mountRep && meshLayout.config
      ? representationRow(meshLayout.config, statuses, pendingMount.logicalKey, mountRep)
      : null;
  const registeredId =
    pendingMount && meshLayout.config
      ? replicaProjectId(
          meshLayout.config,
          statuses,
          pendingMount.logicalKey,
          pendingMount.environmentId,
        )
      : null;
  const finishMount = useEffectEvent((project: EnvironmentProject) => {
    setProject(project);
    setPendingMount(null);
    setSwitchingToEnvironmentId(null);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retargets the persistent draft when the replica service registers its destination project
  useEffect(() => {
    if (!pendingMount || !registeredId) return;
    const project = projects.find(
      (project) =>
        project.environmentId === pendingMount.environmentId && project.id === registeredId,
    );
    if (!project) return;
    // oxlint-disable-next-line react/set-state-in-effect -- completes the external replica-service registration subscription
    finishMount(project);
  }, [pendingMount, registeredId, projects]);

  const defaultApplied = useRef<string | null>(null);
  const applyMachineDefault = useEffectEvent(() => {
    if (
      !activeDraftKey ||
      !preferenceKey ||
      !meshLayout.config ||
      !AsyncResult.isSuccess(preferencesResult) ||
      defaultApplied.current === activeDraftKey
    )
      return;
    // A default chosen before the provider catalogs arrive would mark every
    // machine unusable and pin the draft to its main copy for good.
    const catalogsKnown = draftMachineCatalogsKnown(
      environments.map((machine) => ({
        environmentId: machine.environmentId,
        connected: machine.connected,
      })),
      new Set(
        [...serverConfigs.entries()]
          .filter(([, serverConfig]) => serverConfig.providers !== undefined)
          .map(([environmentId]) => environmentId),
      ),
    );
    if (!catalogsKnown) return;
    defaultApplied.current = activeDraftKey;
    const target = defaultDraftMachine(
      environments.map((machine) => ({
        environmentId: machine.environmentId,
        connected: machine.connected,
        usable: machine.usable,
        primary: machine.primary,
      })),
      preferences.draftMachines?.[preferenceKey] ?? null,
    );
    if (target && target !== selectedEnvironmentId)
      void switchEnvironment(EnvironmentId.make(target), { remember: false });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies a hydrated per-device machine preference to a new persistent draft
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- synchronizes the draft target with hydrated device preferences
    applyMachineDefault();
  });
  const value = {
    activeNewTask,
    projectScopes,
    selectedEnvironmentId,
    selectedProjectKey,
    selectedModelKey,
    workspaceMode,
    isGitRepo,
    isGitRepoKnown: knownIsGitRepo !== null,
    canChooseWorkspace,
    selectedBranchName,
    selectedWorktreePath,
    resolveWorkspaceSelection,
    startFromOrigin,
    draftKey: selectedProjectDraftKey,
    pullRequestReference: selectedProjectDraft.workspaceSelection?.pullRequestReference,
    prompt,
    attachments,
    submitting,
    branchesLoading,
    availableBranches,
    currentCheckoutBranchName,
    runtimeMode,
    interactionMode,
    planModeEnabled,
    expandedProvider,
    environments,
    machineCards,
    selectedProject,
    linkedEnvironments,
    isScratchDraft,
    modelOptions,
    selectedModel,
    selectedModelOption,
    selectedProviderStatus,
    providerGroups,
    setProject,
    getSelectedProjectKey: () => readFlow().projectKey,
    missingRouteDraftId:
      routeDraftResolution.kind === "missing" ? (props.routeDraftId ?? null) : null,
    selectEnvironment,
    switchEnvironment,
    switchingToEnvironmentId,
    mountingStatus: mountRow?.text ?? null,
    mountTarget:
      pendingMount ??
      (isScratchDraft && switchingToEnvironmentId
        ? { environmentId: switchingToEnvironmentId, logicalKey: "scratch" }
        : null),
    retryMount:
      mountRow?.retry && meshLayout.config
        ? () => {
            const driver = replicaDriverEnvironment(meshLayout.config!, mountRow.rep);
            if (!driver) {
              Dialog.alert(
                "Cannot retry copy",
                "Ask an agent to fix the connection between these machines.",
              );
              return;
            }
            if (driver)
              void retryReplica({
                environmentId: EnvironmentId.make(driver),
                input: {
                  logicalKey: pendingMount!.logicalKey,
                  environmentId: pendingMount!.environmentId,
                },
              });
          }
        : null,
    setSelectedModelKey,
    setWorkspaceMode,
    selectBranch,
    setStartFromOrigin,
    buildPendingTaskMessage,
    setPrompt,
    replaceAttachments,
    appendAttachments,
    removeAttachment,
    clearAttachments,
    setSubmitting: (value: boolean) => updateFlow({ submitting: value }),
    loadBranches,
    setRuntimeMode,
    setInteractionMode,
    setSelectedModelOptions,
    setExpandedProvider: (value: string | null) => updateFlow({ expandedProvider: value }),
  } satisfies NewTaskFlowContextValue;

  return (
    <ActiveNewTaskContext value={activeNewTask}>
      <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>
    </ActiveNewTaskContext>
  );
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}
