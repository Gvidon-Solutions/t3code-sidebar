import { useNavigation } from "@react-navigation/native";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  projectFoldModeOf,
  projectOrderOf,
  resolveProjectWorkspaceIds,
} from "@t3tools/client-runtime/state/sidebar-workspaces";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useHomeListOptions } from "../home/home-list-options";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { useSidebarWorkspaces } from "../workspaces/useSidebarWorkspaces";
import { arrangeWorkspaceFolders } from "../workspaces/workspaceNavigator";
import { useCreateVoiceThread } from "./useCreateVoiceThread";
import { voiceMode, voiceModeSupported } from "./voiceMode";
import { pickTalkProject, resolveVoiceModelSelection } from "./voiceThreads";

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();
/** Diameter of the Talk button, so the FAB layout can center it on the new-thread button. */
export const TALK_BUTTON_SIZE = 44;

/**
 * Sidebar fork: Home's "Talk" button, beside the new-thread button. Starts a
 * voice thread in the open workspace's top project (see `pickTalkProject`),
 * else in "No project", opens it and starts talking. Hidden while no connected
 * environment can hold a conversation.
 */
export function HomeTalkButton() {
  const navigation = useNavigation();
  const serverConfigs = useServerConfigs();
  const environments = useWorkspaceEnvironments();
  const projects = useProjects();
  const { config, currentWorkspaceId } = useSidebarWorkspaces();
  const { options } = useHomeListOptions(NO_ENVIRONMENTS);
  const createVoiceThread = useCreateVoiceThread();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: true });
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);

  const voiceEnvironmentIds = useMemo(() => {
    const ids = new Set<EnvironmentId>();
    for (const environment of environments) {
      if (environment.connectionState !== "connected") continue;
      const serverConfig = serverConfigs.get(environment.environmentId);
      if (resolveVoiceModelSelection(serverConfig, null, null)) ids.add(environment.environmentId);
    }
    return ids;
  }, [environments, serverConfigs]);

  const canTalkIn = useCallback(
    (project: EnvironmentProject) =>
      voiceEnvironmentIds.has(project.environmentId) &&
      resolveVoiceModelSelection(serverConfigs.get(project.environmentId), null, project.id) !==
        null,
    [serverConfigs, voiceEnvironmentIds],
  );

  // Read on press: the order and quiet state follow every thread's activity,
  // which this button should not re-render for.
  const resolveProject = useCallback(async (): Promise<EnvironmentProject | null> => {
    const isScratch = (project: EnvironmentProject) =>
      isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot);
    if (config !== null && currentWorkspaceId !== null) {
      const scopes = buildHomeProjectScopes({
        projects,
        environmentId: null,
        projectGroupingMode: options.projectGroupingMode,
      }).filter(
        (scope) =>
          !scope.projects.some(isScratch) &&
          resolveProjectWorkspaceIds(
            {
              projectKey: scope.key,
              workspaceRoots: scope.projects.map((project) => project.workspaceRoot),
              isScratch: false,
            },
            config,
          ).includes(currentWorkspaceId),
      );
      const scopeByKey = new Map(scopes.map((scope) => [scope.key, scope]));
      const folders = arrangeWorkspaceFolders({
        folders: scopes.map((scope) => ({
          projectKey: scope.key,
          title: scope.title,
          project: scope.representative,
          projectCreatedAt: scope.representative.createdAt ?? null,
          memberKeys: scope.projectRefs.map((ref) =>
            scopedProjectKey(ref.environmentId, ref.projectId),
          ),
          isScratch: false,
        })),
        threads: appAtomRegistry.get(environmentThreadShells.navigationThreadShellsAtom),
        quietAfterDays: config.quietAfterDays,
        foldModeOf: (projectKey) => projectFoldModeOf(config, currentWorkspaceId, projectKey),
        projectOrder: projectOrderOf(config, currentWorkspaceId),
        now: Date.now(),
      });
      const picked = pickTalkProject({
        folders: folders.map((folder) => ({
          quiet: folder.quiet,
          projects: scopeByKey.get(folder.projectKey)?.projects ?? [folder.project],
        })),
        canTalkIn,
      });
      if (picked) return picked;
    }
    const scratch = projects.find((project) => isScratch(project) && canTalkIn(project));
    if (scratch) return scratch;
    const [environmentId] = voiceEnvironmentIds;
    if (environmentId === undefined) return null;
    const opened = await openScratch({ environmentId, input: {} });
    return opened._tag === "Success" ? opened.value : null;
  }, [
    canTalkIn,
    config,
    currentWorkspaceId,
    openScratch,
    options.projectGroupingMode,
    projects,
    serverConfigs,
    voiceEnvironmentIds,
  ]);

  const talk = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    const start = async () => {
      const project = await resolveProject();
      if (!project) return;
      const serverConfig = serverConfigs.get(project.environmentId);
      const modelSelection = resolveVoiceModelSelection(serverConfig, null, project.id);
      if (!modelSelection) return;
      const target = await createVoiceThread({
        project,
        modelSelection,
        runtimeMode: serverConfig?.settings.defaultRuntimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
      });
      if (!target) return;
      navigation.navigate("Thread", {
        environmentId: target.environmentId,
        threadId: target.threadId,
      });
      void voiceMode.start(target);
    };
    // Promise.finally, not try/finally: the React Compiler cannot lower the latter.
    await start().finally(() => {
      startingRef.current = false;
      setStarting(false);
    });
  }, [createVoiceThread, navigation, resolveProject, serverConfigs]);

  if (!voiceModeSupported || voiceEnvironmentIds.size === 0) return null;
  return (
    <Pressable
      accessibilityHint="Starts a voice conversation in a new thread"
      accessibilityLabel="Talk"
      accessibilityRole="button"
      accessibilityState={{ busy: starting, disabled: starting }}
      className="items-center justify-center rounded-full bg-secondary shadow-lg active:opacity-70"
      disabled={starting}
      onPress={() => void talk()}
      style={{
        width: TALK_BUTTON_SIZE,
        height: TALK_BUTTON_SIZE,
        opacity: starting ? 0.5 : 1,
      }}
    >
      <SymbolView name="mic" size={20} tintColorClassName="accent-secondary-foreground" />
    </Pressable>
  );
}
