import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { createUiRequestAtoms } from "@t3tools/client-runtime/state/ui-requests";
import { appliesVoiceCommand, decideUiRequest } from "@t3tools/client-runtime/ui-requests";
import { applyVoiceCommand } from "@t3tools/client-runtime/voice-mode";
import { EnvironmentId, ThreadId, type UiRequest, type VoiceCommand } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { fileRoutePathSegments } from "../files/filePath";
import { useSidebarWorkspaces } from "../workspaces/useSidebarWorkspaces";
import { voiceMode } from "./voiceMode";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

/**
 * Sidebar fork: agents asking clients to show something (`ui_open`), and
 * spoken commands for a voice conversation, per environment.
 */
const uiRequestEnvironment = createUiRequestAtoms(connectionAtomRuntime);

/** Request ids already acted on, so a remounted watcher never replays one. */
const handledRequestIds = new Set<string>();

export interface ShownThread {
  readonly environmentId: string;
  readonly threadId: string;
}

type HandleUiRequest = (environmentId: EnvironmentId, request: UiRequest) => void;
type HandleVoiceCommand = (environmentId: EnvironmentId, command: VoiceCommand) => void;

/** The thread this device holds a voice conversation in on `environmentId`, if any. */
function heldVoiceThreadId(environmentId: EnvironmentId): string | null {
  const voice = voiceMode.getState();
  return voice.phase !== "idle" && voice.target?.environmentId === environmentId
    ? voice.target.threadId
    : null;
}

/** Hands each new item of a latest-value stream over once; the first value is old news. */
function useNewOnce<T extends { readonly id: string }>(
  item: T | null,
  onItem: (item: T) => void,
): void {
  const seenIdRef = useRef<string | null | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- acts once on each new ui request from the server stream
  useEffect(() => {
    const id = item?.id ?? null;
    if (seenIdRef.current === undefined) {
      seenIdRef.current = id;
      if (id !== null) handledRequestIds.add(id);
      return;
    }
    if (item === null || id === seenIdRef.current) return;
    seenIdRef.current = id;
    if (handledRequestIds.has(item.id)) return;
    handledRequestIds.add(item.id);
    onItem(item);
  }, [item, onItem]);
}

/**
 * Follows one environment's latest request and hands each new one over once.
 * The value present when it subscribes is old news: a cached request from an
 * earlier subscription, never one asked of this screen.
 */
function UiRequestWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly onRequest: HandleUiRequest;
}) {
  const { environmentId, onRequest } = props;
  const request = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(uiRequestEnvironment.latestUiRequest({ environmentId, input: {} })),
    ),
  );
  useNewOnce(
    request,
    useCallback((item: UiRequest) => onRequest(environmentId, item), [environmentId, onRequest]),
  );
  return null;
}

/** Follows one environment's latest voice command, like `UiRequestWatcher`. */
function VoiceCommandWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly onCommand: HandleVoiceCommand;
}) {
  const { environmentId, onCommand } = props;
  const command = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(uiRequestEnvironment.latestVoiceCommand({ environmentId, input: {} })),
    ),
  );
  useNewOnce(
    command,
    useCallback((item: VoiceCommand) => onCommand(environmentId, item), [environmentId, onCommand]),
  );
  return null;
}

/**
 * Root-mounted (sidebar fork): acts on agents' requests to show something, per `decideUiRequest`.
 * The phone has no side panel, so the thread on screen opens files and its diff directly.
 * `shownThread` is the thread whose screen is in front, if any.
 */
export function UiRequestCoordinator(props: { readonly shownThread: ShownThread | null }) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const environments = useWorkspaceEnvironments();
  const { config, openWorkspace } = useSidebarWorkspaces();
  // Read when a request lands, so handlers stay stable across navigation.
  const shownThreadRef = useRef(props.shownThread);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest shown thread for the request handlers
  useEffect(() => {
    shownThreadRef.current = props.shownThread;
  });

  const open = useCallback(
    (environmentId: EnvironmentId, request: UiRequest) => {
      const { target } = request;
      switch (target.kind) {
        case "thread":
          selectDetail({ name: "Thread", params: { environmentId, threadId: target.threadId } });
          return;
        case "inbox":
          if (target.issueId === undefined) navigation.navigate("Inbox");
          else navigation.navigate("InboxIssue", { environmentId, issueId: target.issueId });
          return;
        case "home":
          navigation.dispatch(StackActions.popTo("Home"));
          return;
        case "workspace": {
          const wanted = target.workspace.toLowerCase();
          const workspace = config?.workspaces.find(
            (candidate) =>
              candidate.id === target.workspace || candidate.name.toLowerCase() === wanted,
          );
          if (!workspace) return;
          openWorkspace(workspace.id);
          navigation.dispatch(StackActions.popTo("Home"));
          return;
        }
        case "file":
          navigation.navigate("ThreadFile", {
            environmentId,
            threadId: request.threadId,
            path: fileRoutePathSegments(target.path),
            ...(target.line === undefined ? {} : { line: String(target.line) }),
          });
          return;
        case "diff":
          navigation.navigate("ThreadReview", {
            environmentId,
            threadId: ThreadId.make(request.threadId),
          });
          return;
      }
    },
    [config, navigation, openWorkspace, selectDetail],
  );

  const handle = useCallback<HandleUiRequest>(
    (environmentId, request) => {
      const shown = shownThreadRef.current;
      const decision = decideUiRequest({
        request,
        voiceThreadId: heldVoiceThreadId(environmentId),
        shownThreadId: shown?.environmentId === environmentId ? shown.threadId : null,
      });
      if (decision === "ignore") return;
      open(environmentId, request);
    },
    [open],
  );

  // Spoken commands for the conversation this device holds: end, mute, move.
  const handleVoiceCommand = useCallback<HandleVoiceCommand>(
    (environmentId, command) => {
      if (!appliesVoiceCommand({ command, voiceThreadId: heldVoiceThreadId(environmentId) })) {
        return;
      }
      void applyVoiceCommand(voiceMode, command.action, (target) => {
        selectDetail({ name: "Thread", params: { environmentId, threadId: target.threadId } });
      });
    },
    [selectDetail],
  );

  return environments
    .filter((environment) => environment.isEnabled)
    .flatMap((environment) => {
      const environmentId = EnvironmentId.make(environment.environmentId);
      return [
        <UiRequestWatcher
          key={`ui:${environmentId}`}
          environmentId={environmentId}
          onRequest={handle}
        />,
        <VoiceCommandWatcher
          key={`voice:${environmentId}`}
          environmentId={environmentId}
          onCommand={handleVoiceCommand}
        />,
      ];
    });
}
