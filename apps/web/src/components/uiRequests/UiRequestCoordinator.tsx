import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  appliesVoiceCommand,
  decideUiRequest,
  uiTargetEnvironmentId,
} from "@t3tools/client-runtime/ui-requests";
import { applyVoiceCommand } from "@t3tools/client-runtime/voice-mode";
import {
  InboxIssueId,
  ThreadId,
  type EnvironmentId,
  type ScopedThreadRef,
  type UiRequest,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSummaries } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { latestUiRequestsAtom, latestVoiceCommandsAtom } from "../../state/uiRequests";
import { toastManager } from "../ui/toast";
import { showFileLocateDialog } from "../files/FileLocateDialogHost";
import { openLocatedFile } from "../../files/openLocatedFile";
import { openCommandPalette } from "../../commandPaletteBus";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../../threadRoutes";
import { voiceMode } from "../../voice/voiceMode";
import { useWorkspaceViewStore } from "../workspaces/workspaceViewStore";
import { findSidebarWorkspace, takeNewUiRequests } from "./uiRequests.logic";

/** Opens the asking thread's file or diff in its right panel. */
function openInPanel(
  threadRef: ScopedThreadRef,
  target: UiRequest["target"],
  targetEnvironmentId: EnvironmentId,
) {
  if (target.kind === "file") {
    if (target.resolved !== undefined) {
      const resolved = target.resolved;
      if (resolved.status === "found" && resolved.target !== undefined) {
        openLocatedFile(threadRef, {
          ...resolved.target,
          rawPath: target.path,
          ...(resolved.projectTitle === undefined ? {} : { projectTitle: resolved.projectTitle }),
        });
      } else {
        showFileLocateDialog(
          target.path,
          resolved,
          (choice) =>
            openLocatedFile(threadRef, {
              ...choice,
              ...(resolved.projectTitle === undefined
                ? {}
                : { projectTitle: resolved.projectTitle }),
            }),
          (term) => openCommandPalette({ query: term }),
        );
      }
      return;
    }
    if (target.environmentId === undefined) {
      useRightPanelStore.getState().openFile(threadRef, target.path, target.line);
      return;
    }
    const label =
      appAtomRegistry
        .get(environmentSummaries.identitiesAtom)
        .find((identity) => identity.environmentId === targetEnvironmentId)?.label ??
      String(targetEnvironmentId);
    useRightPanelStore.getState().openFile(threadRef, target.path, target.line, {
      environmentId: targetEnvironmentId,
      workspaceRoot: "/",
      projectName: label,
    });
  } else if (target.kind === "diff") {
    useRightPanelStore.getState().open(threadRef, "diff");
  }
}

function environmentLabel(environmentId: EnvironmentId): string {
  return (
    appAtomRegistry
      .get(environmentSummaries.identitiesAtom)
      .find((identity) => identity.environmentId === environmentId)?.label ?? String(environmentId)
  );
}

function isEnvironmentConnected(environmentId: EnvironmentId): boolean {
  return appAtomRegistry
    .get(environmentSummaries.connectedEnvironmentIdsAtom)
    .includes(environmentId);
}

/** Switches the workspace sidebar to a workspace named in any connected environment's config. */
function showWorkspace(environmentId: EnvironmentId, nameOrId: string) {
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const own = configs.get(environmentId)?.settings.sidebarWorkspaces.workspaces ?? [];
  const others = [...configs.values()].map(
    (config) => config.settings.sidebarWorkspaces.workspaces,
  );
  const workspace = findSidebarWorkspace([own, ...others], nameOrId);
  if (workspace === null) return;
  const view = useWorkspaceViewStore.getState();
  if (!view.tilesVisible) view.toggleTiles();
  view.setActiveWorkspace(workspace.id);
}

/** The thread a client holds a voice conversation in on `environmentId`, if any. */
function heldVoiceThreadId(environmentId: EnvironmentId): string | null {
  const voice = voiceMode.getState();
  return voice.phase !== "idle" && voice.target?.environmentId === environmentId
    ? voice.target.threadId
    : null;
}

/**
 * Fork: acts on agents' `ui_open` requests from every connected environment, per
 * `decideUiRequest`: the voice thread's agent navigates at once, the shown thread's agent opens
 * files and diffs beside it, other threads are ignored. Mounted once at the app root.
 */
export function UiRequestCoordinator() {
  const entries = useAtomValue(latestUiRequestsAtom);
  const voiceCommands = useAtomValue(latestVoiceCommandsAtom);
  const router = useRouter();
  const seen = useRef(new Map<EnvironmentId, string | null>());
  const seenVoiceCommands = useRef(new Map<EnvironmentId, string | null>());

  // Spoken commands for the conversation this client holds: end, mute, move.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies voice commands from the server's ui-request stream to the voice session and router
  useEffect(() => {
    for (const { environmentId, request: command } of takeNewUiRequests(
      seenVoiceCommands.current,
      voiceCommands,
    )) {
      if (!appliesVoiceCommand({ command, voiceThreadId: heldVoiceThreadId(environmentId) })) {
        continue;
      }
      void applyVoiceCommand(voiceMode, command.action, (target) => {
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(environmentId, ThreadId.make(target.threadId)),
          ),
        });
      });
    }
  }, [voiceCommands, router]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- acts on new ui_open requests from the server stream by navigating the router
  useEffect(() => {
    const fresh = takeNewUiRequests(seen.current, entries);
    if (fresh.length === 0) return;

    const shownThreadRef = () => {
      const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const target = resolveThreadRouteTarget(params);
      const draft =
        target?.kind === "draft"
          ? useComposerDraftStore.getState().getDraftSession(target.draftId)
          : null;
      return resolveActiveThreadRouteRef(target, draft);
    };
    const notConnected = (environmentId: EnvironmentId) => {
      toastManager.add({
        type: "warning",
        title: `Not connected to ${environmentLabel(environmentId)}`,
        description: "Connect that machine to open what the agent asked for.",
        actionProps: {
          children: "Connections",
          onClick: () => {
            void router.navigate({ to: "/settings/connections" });
          },
        },
      });
    };
    const go = (environmentId: EnvironmentId, request: UiRequest) => {
      const { target } = request;
      const askingRef = scopeThreadRef(environmentId, request.threadId);
      const targetEnvironmentId = uiTargetEnvironmentId(target, environmentId);
      if (
        (target.kind === "thread" || target.kind === "file") &&
        !isEnvironmentConnected(targetEnvironmentId)
      ) {
        notConnected(targetEnvironmentId);
        return;
      }
      switch (target.kind) {
        case "thread":
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(targetEnvironmentId, target.threadId)),
          });
          return;
        case "inbox":
          void router.navigate({
            to: "/inbox",
            search:
              target.issueId === undefined
                ? {}
                : { environmentId, issueId: InboxIssueId.make(target.issueId) },
          });
          return;
        case "home":
          void router.navigate({ to: "/" });
          return;
        case "workspace":
          showWorkspace(environmentId, target.workspace);
          return;
        case "file":
        case "diff":
          openInPanel(askingRef, target, targetEnvironmentId);
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(askingRef),
          });
          return;
      }
    };

    for (const { environmentId, request } of fresh) {
      const shown = shownThreadRef();
      const decision = decideUiRequest({
        request,
        voiceThreadId: heldVoiceThreadId(environmentId),
        shownThreadId: shown?.environmentId === environmentId ? shown.threadId : null,
      });
      const askingRef = scopeThreadRef(environmentId, request.threadId);
      if (decision === "navigate") {
        go(environmentId, request);
      } else if (decision === "panel") {
        const targetEnvironmentId = uiTargetEnvironmentId(request.target, environmentId);
        if (!isEnvironmentConnected(targetEnvironmentId)) {
          notConnected(targetEnvironmentId);
          continue;
        }
        openInPanel(askingRef, request.target, targetEnvironmentId);
      }
    }
  }, [entries, router]);

  return null;
}
