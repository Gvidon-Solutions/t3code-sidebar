import {
  defaultDraftMachine,
  draftModelUnavailableReason,
  planThreadOnMachine,
  resolveLogicalProjectKey,
  representationRow,
  replicaProjectId,
  replicaDriverEnvironment,
} from "@t3tools/client-runtime/state/mesh-layout";
import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useReplicaStatuses, replicaStatusEnvironment } from "../../state/meshReplicas";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentId } from "@t3tools/contracts";
import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { useProjects } from "../../state/entities";
import type { DraftSessionState } from "../../composerDraftStore";

interface DraftEnvironmentRoutingInput {
  readonly selection: import("@t3tools/contracts").ModelSelection | null;
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly envLocked: boolean;
  readonly automaticEnvironment: boolean;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly providersByEnvironment: ReturnType<typeof useEnvironmentProviders>;
  readonly loadBalancingSettings: {
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  };
  readonly referencedThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly composerHasAttachments: boolean;
  readonly activeProjectKey: string | null;
  readonly activeProjectIsScratch: boolean;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly sendInFlightRef: { readonly current: boolean };
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const {
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  } = input;
  const allProjects = useProjects();
  const mesh = useMeshLayout();
  const statuses = useReplicaStatuses();
  const retryReplica = useAtomCommand(replicaStatusEnvironment.retry);
  const [mount, setMount] = useState<{ environmentId: EnvironmentId; logicalKey: string } | null>(
    null,
  );
  const mountReadyRef = useRef<((project: (typeof allProjects)[number]) => void) | null>(null);
  const config = mesh.config;
  const mountRep =
    mount &&
    config?.projectMounts[mount.logicalKey]?.find(
      (rep) => rep.environmentId === mount.environmentId,
    );
  const mountRow =
    mount && mountRep && config
      ? representationRow(config, statuses, mount.logicalKey, mountRep)
      : null;
  const registeredId =
    mount && config
      ? replicaProjectId(config, statuses, mount.logicalKey, mount.environmentId)
      : null;
  const finishMount = useEffectEvent((project: (typeof allProjects)[number]) => {
    mountReadyRef.current?.(project);
    mountReadyRef.current = null;
    setMount(null);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resumes the draft switch when the replica service registers its destination project
  useEffect(() => {
    if (
      !registeredId ||
      !allProjects.some(
        (project) => project.environmentId === mount?.environmentId && project.id === registeredId,
      )
    )
      return;
    const project = allProjects.find(
      (project) => project.environmentId === mount?.environmentId && project.id === registeredId,
    );
    // oxlint-disable-next-line react/set-state-in-effect -- completes the external replica-service registration subscription
    if (project) finishMount(project);
  }, [registeredId, mount, allProjects]);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const { openScratchProject } = useScratchProject();
  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = needsLoadBalancing
    ? logicalProjectEnvironments
        .filter((candidate) => {
          const environment = environmentById.get(candidate.environmentId);
          return (
            environment?.connection.phase === "connected" &&
            (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
            referencedThreadContexts.every(
              (record) => record.environmentId === candidate.environmentId,
            ) &&
            providersByEnvironment
              .get(candidate.environmentId)
              ?.some(
                (provider) =>
                  (activeProviderInstanceId === null ||
                    provider.instanceId === activeProviderInstanceId) &&
                  provider.driver === selectedProvider &&
                  (environment.serverConfig?.settings
                    ? resolveProjectProviderInstanceEnabled(
                        environment.serverConfig.settings,
                        candidate.projectId,
                        provider.instanceId,
                      )
                    : provider.enabled) &&
                  provider.installed &&
                  provider.status !== "error" &&
                  provider.auth.status !== "unauthenticated" &&
                  provider.availability !== "unavailable",
              )
          );
        })
        .map((candidate) => candidate.environmentId)
    : [];
  const loadBalancing = useLoadBalancedEnvironment(
    loadBalancingCandidates,
    loadBalancingSettings.loadBalancingWeights,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the resolved load-balanced environment into the draft store once the async pick settles
  useEffect(() => {
    if (!needsLoadBalancing || loadBalancing.pending || !draftId || sendInFlightRef.current) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId) return;
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    draftId,
    logicalProjectEnvironments,
    sendInFlightRef,
    setDraftThreadContext,
  ]);
  const onAutoEnvironment = () => {
    if (envLocked || !draftId) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description:
          "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      });
      return;
    }
    loadBalancing.refresh(
      logicalProjectEnvironments.map((environment) => environment.environmentId),
    );
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  };
  const onAutoEnvironmentStable = useStableCallback(onAutoEnvironment);
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  // A change in flight belongs to the draft and project it started on.
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  const environmentChangeRef = useRef<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const environmentChangeScopeRef = useRef("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the current change scope into a ref that async environment switches compare against
  useLayoutEffect(() => {
    environmentChangeScopeRef.current = environmentChangeScope;
  });
  // Leaving the scope, or unmounting, abandons a change still in flight.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons an in-flight environment change when the draft or project scope changes or unmounts
  useLayoutEffect(
    () => () => {
      if (environmentChangeRef.current?.scope === environmentChangeScope) {
        environmentChangeRef.current = null;
      }
    },
    [environmentChangeScope],
  );
  const readPendingEnvironmentChange = () => {
    const pending = environmentChangeRef.current;
    return pending !== null && pending.scope === environmentChangeScopeRef.current ? pending : null;
  };
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;

  const preferenceProject = allProjects.find(
    (project) =>
      project.environmentId === draftThread?.environmentId && project.id === draftThread?.projectId,
  );
  const preferenceKey = activeProjectIsScratch
    ? "scratch"
    : preferenceProject && config
      ? resolveLogicalProjectKey(preferenceProject, config, (project) =>
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
        )
      : activeProjectKey;
  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId, allowOffline = false) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const target = logicalProjectEnvironments.find(
      (env) => env.environmentId === nextEnvironmentId,
    );
    if (!target || (target.connected === false && !allowOffline)) return;
    setMount(null);
    mountReadyRef.current = null;
    try {
      window.localStorage.setItem(
        `t3.draftMachine.${preferenceKey ?? "scratch"}`,
        nextEnvironmentId,
      );
    } catch (error) {
      console.warn("Could not remember draft machine", error);
    }
    const request = { environmentId: target.environmentId, scope: environmentChangeScope };
    environmentChangeRef.current = request;
    setBusyEnvironmentChange(null);
    const retarget = (project: (typeof allProjects)[number]) => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        environmentChangeScopeRef.current !== request.scope ||
        sendInFlightRef.current ||
        !currentDraft ||
        currentDraft.promotedTo ||
        currentDraft.environmentId !== originalDraft.environmentId ||
        currentDraft.projectId !== originalDraft.projectId
      )
        return;
      const projectRef = scopeProjectRef(target.environmentId, project.id);
      if (activeProjectIsScratch) {
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
          projectRef,
          draftId,
          { environmentSelection: "manual", loadBalancedEnvironmentId: null },
        );
      } else {
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        });
      }
    };
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
    };
    if (target.projectId !== null) {
      const project = allProjects.find(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      );
      if (project) retarget(project);
      finish();
      return;
    }
    setBusyEnvironmentChange(request);
    if (!activeProjectIsScratch && config) {
      const source = allProjects.find(
        (project) =>
          project.environmentId === originalDraft.environmentId &&
          project.id === originalDraft.projectId,
      );
      if (!source) {
        finish();
        return;
      }
      const logicalKey = resolveLogicalProjectKey(source, config, (project) =>
        deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
      );
      mesh.edit(
        (current) =>
          planThreadOnMachine({
            config: current,
            logicalKey,
            targetEnvironmentId: target.environmentId,
            seed: {
              environmentId: source.environmentId,
              projectId: source.id,
              path: source.workspaceRoot,
            },
          }).config,
      );
      setMount({ environmentId: target.environmentId, logicalKey });
      mountReadyRef.current = (project) => {
        retarget(project);
        finish();
      };
      return;
    }
    void openScratchProject(target.environmentId, "Could not switch machine")
      .then((project) => {
        if (project) retarget(project);
      })
      .finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);
  const defaultApplied = useRef<DraftId | null>(null);
  const applyDefault = useEffectEvent(() => {
    if (
      !draftId ||
      !config ||
      defaultApplied.current === draftId ||
      draftThread?.environmentSelection === "manual"
    )
      return;
    defaultApplied.current = draftId;
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(`t3.draftMachine.${preferenceKey ?? "scratch"}`);
    } catch (error) {
      console.warn("Could not read draft machine", error);
    }
    const target = defaultDraftMachine(
      logicalProjectEnvironments.map((machine) => ({
        environmentId: machine.environmentId,
        connected: machine.connected !== false,
        primary:
          config.projectMounts[preferenceKey ?? ""]?.some(
            (rep) => rep.environmentId === machine.environmentId && rep.role === "primary",
          ) ?? machine.isPrimary,
        usable:
          input.selection !== null &&
          draftModelUnavailableReason(
            environmentById.get(machine.environmentId)?.serverConfig
              ? {
                  settings: environmentById.get(machine.environmentId)!.serverConfig!.settings,
                  providers: providersByEnvironment.get(machine.environmentId) ?? [],
                }
              : null,
            input.selection,
            machine.projectId,
          ) === null,
      })),
      remembered,
    );
    if (target && target !== draftThread?.environmentId)
      onEnvironmentChange(EnvironmentId.make(target), true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies the device's remembered machine after the mesh snapshot loads for a new persistent draft
  useEffect(() => {
    applyDefault();
  });

  return {
    pendingDraftMachineId: mount?.environmentId ?? null,
    mountingStatus: mountRow?.text ?? (mount ? "Preparing machine…" : null),
    retryMount:
      mountRow?.retry && config
        ? () => {
            const driver = replicaDriverEnvironment(config, mountRow.rep);
            if (!driver) {
              toastManager.add({
                type: "error",
                title: "Cannot retry replica",
                description: "Add an SSH route in Settings › Mesh.",
              });
              return;
            }
            if (driver)
              void retryReplica({
                environmentId: EnvironmentId.make(driver),
                input: { logicalKey: mount!.logicalKey, environmentId: mount!.environmentId },
              });
          }
        : null,
    needsLoadBalancing,
    loadBalancing,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
