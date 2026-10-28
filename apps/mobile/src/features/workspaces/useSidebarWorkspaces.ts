import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  addWorkspace,
  deleteWorkspace,
  effectiveDefaultWorkspaceId,
  moveProjectInWorkspace,
  reorderWorkspaces,
  setProjectFoldMode,
  toggleProjectWorkspace,
  updateWorkspace,
  type WorkspaceProjectIdentity,
  type WorkspaceSequenceOf,
  type ProjectFoldMode,
} from "@t3tools/client-runtime/state/sidebar-workspaces";
import type { EnvironmentId, SidebarWorkspacesConfig } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Workspace sidebar (fork feature) on the phone. The config is the shared `sidebarWorkspaces`
 * server setting; the open workspace and folded folders are local preferences. Null `config`
 * means no connected server has workspaces, and Home stays upstream's plain list.
 */
export function useSidebarWorkspaces() {
  const serverConfigs = useServerConfigs();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "sidebar workspaces update",
    reportFailure: true,
  });

  // Every server that uses workspaces gets writes; the first (by id) is read.
  const sources = useMemo(() => {
    const entries: Array<{ environmentId: EnvironmentId; config: SidebarWorkspacesConfig }> = [];
    for (const [environmentId, serverConfig] of serverConfigs) {
      const config = serverConfig.settings.sidebarWorkspaces;
      if (config.workspaces.length > 0) entries.push({ environmentId, config });
    }
    return entries.sort((a, b) => a.environmentId.localeCompare(b.environmentId));
  }, [serverConfigs]);
  const config = sources[0]?.config ?? null;

  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const storedWorkspaceId = preferences?.sidebarWorkspaceId;
  const currentWorkspaceId =
    config === null
      ? null
      : storedWorkspaceId !== undefined &&
          config.workspaces.some((workspace) => workspace.id === storedWorkspaceId)
        ? storedWorkspaceId
        : effectiveDefaultWorkspaceId(config);
  const toggles = useMemo(
    () => new Set(preferences?.workspaceToggles ?? []),
    [preferences?.workspaceToggles],
  );

  const openWorkspace = useCallback(
    (workspaceId: string) => savePreferences({ sidebarWorkspaceId: workspaceId }),
    [savePreferences],
  );
  /** Flips a folder, section or "show more" away from its default (or back). */
  const toggle = useCallback(
    (key: string) =>
      savePreferences({
        transform: (current) => {
          const flipped = new Set(current.workspaceToggles ?? []);
          if (!flipped.delete(key)) flipped.add(key);
          return { workspaceToggles: [...flipped] };
        },
      }),
    [savePreferences],
  );
  const updateConfig = useCallback(
    (edit: (config: SidebarWorkspacesConfig) => SidebarWorkspacesConfig) => {
      for (const source of sources) {
        void updateSettings({
          environmentId: source.environmentId,
          input: { patch: { sidebarWorkspaces: edit(source.config) } },
        });
      }
    },
    [sources, updateSettings],
  );
  /** "Show in workspaces": ticks or unticks one workspace (never the last). */
  const toggleProjectIn = useCallback(
    (project: WorkspaceProjectIdentity, workspaceId: string, sequenceOf?: WorkspaceSequenceOf) =>
      updateConfig((current) => toggleProjectWorkspace(current, project, workspaceId, sequenceOf)),
    [updateConfig],
  );
  /**
   * Moves a project into "Quiet projects" or out of it by hand in the open
   * workspace, or back to folding by itself there.
   */
  const setFoldMode = useCallback(
    (projectKey: string, mode: ProjectFoldMode) => {
      if (currentWorkspaceId === null) return;
      updateConfig((current) => setProjectFoldMode(current, currentWorkspaceId, projectKey, mode));
    },
    [currentWorkspaceId, updateConfig],
  );
  /** Drops `projectKey` before `beforeKey` (null: last) among `sequence`, the open workspace's folders. */
  const reorderProject = useCallback(
    (projectKey: string, beforeKey: string | null, sequence: ReadonlyArray<string>) => {
      if (currentWorkspaceId === null) return;
      updateConfig((current) =>
        moveProjectInWorkspace(current, currentWorkspaceId, sequence, projectKey, beforeKey),
      );
    },
    [currentWorkspaceId, updateConfig],
  );
  /** The workspace edits the desktop offers, writing to every server that has workspaces. */
  const edit = useMemo(
    () => ({
      /** Adds `Workspace N`, opens it, and returns its id. */
      add: () => {
        if (config === null) return null;
        const added = addWorkspace(config).config.workspaces;
        const workspace = added[added.length - 1]!;
        updateConfig((current) => ({ ...current, workspaces: [...current.workspaces, workspace] }));
        openWorkspace(workspace.id);
        return workspace.id;
      },
      update: (workspaceId: string, patch: Parameters<typeof updateWorkspace>[2]) =>
        updateConfig((current) => updateWorkspace(current, workspaceId, patch)),
      move: (workspaceId: string, by: -1 | 1) =>
        updateConfig((current) => {
          const index = current.workspaces.findIndex((workspace) => workspace.id === workspaceId);
          return {
            ...current,
            workspaces: [
              ...reorderWorkspaces(current.workspaces, workspaceId, by < 0 ? index - 1 : index + 2),
            ],
          };
        }),
      makeDefault: (workspaceId: string) =>
        updateConfig((current) => ({ ...current, defaultWorkspace: workspaceId })),
      remove: (workspaceId: string) =>
        updateConfig((current) => deleteWorkspace(current, workspaceId)),
    }),
    [config, openWorkspace, updateConfig],
  );

  return {
    config,
    currentWorkspaceId,
    toggles,
    openWorkspace,
    toggle,
    toggleProjectIn,
    setFoldMode,
    reorderProject,
    edit,
  } as const;
}
