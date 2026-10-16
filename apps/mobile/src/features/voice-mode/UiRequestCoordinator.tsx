import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { createUiRequestAtoms } from "@t3tools/client-runtime/state/ui-requests";
import { decideUiRequest, describeUiTarget } from "@t3tools/client-runtime/ui-requests";
import { EnvironmentId, ThreadId, type UiRequest } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef } from "react";
import { Alert } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { fileRoutePathSegments } from "../files/filePath";
import { useSidebarWorkspaces } from "../workspaces/useSidebarWorkspaces";
import { voiceMode } from "./voiceMode";

/** Sidebar fork: agents asking clients to show something (`ui_open`), per environment. */
const uiRequestEnvironment = createUiRequestAtoms(connectionAtomRuntime);

/** Request ids already acted on, so a remounted watcher never replays one. */
const handledRequestIds = new Set<string>();

export interface ShownThread {
  readonly environmentId: string;
  readonly threadId: string;
}

type HandleUiRequest = (environmentId: EnvironmentId, request: UiRequest) => void;

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
  const seenIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = request?.id ?? null;
    if (seenIdRef.current === undefined) {
      seenIdRef.current = id;
      if (id !== null) handledRequestIds.add(id);
      return;
    }
    if (request === null || id === seenIdRef.current) return;
    seenIdRef.current = id;
    if (handledRequestIds.has(request.id)) return;
    handledRequestIds.add(request.id);
    onRequest(environmentId, request);
  }, [environmentId, onRequest, request]);
  return null;
}

/**
 * Root-mounted (sidebar fork): acts on agents' requests to show something,
 * as `decideUiRequest` rules for this phone. The thread holding this device's
 * voice conversation is obeyed at once; the thread on screen opens files and
 * its diff directly (the phone has no side panel) and offers anything else.
 * `shownThread` is the thread whose screen is in front, if any.
 */
export function UiRequestCoordinator(props: { readonly shownThread: ShownThread | null }) {
  const navigation = useNavigation();
  const environments = useWorkspaceEnvironments();
  const { config, openWorkspace } = useSidebarWorkspaces();
  // Read when a request lands, so handlers stay stable across navigation.
  const shownThreadRef = useRef(props.shownThread);
  useEffect(() => {
    shownThreadRef.current = props.shownThread;
  });

  const open = useCallback(
    (environmentId: EnvironmentId, request: UiRequest) => {
      const { target } = request;
      switch (target.kind) {
        case "thread":
          navigation.navigate("Thread", { environmentId, threadId: target.threadId });
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
    [config, navigation, openWorkspace],
  );

  const handle = useCallback<HandleUiRequest>(
    (environmentId, request) => {
      const voice = voiceMode.getState();
      const shown = shownThreadRef.current;
      const decision = decideUiRequest({
        request,
        voiceThreadId:
          voice.phase !== "idle" && voice.target?.environmentId === environmentId
            ? voice.target.threadId
            : null,
        shownThreadId: shown?.environmentId === environmentId ? shown.threadId : null,
      });
      if (decision === "ignore") return;
      if (decision === "offer") {
        Alert.alert(`Agent wants to open ${describeUiTarget(request.target)}`, undefined, [
          { text: "Later", style: "cancel" },
          { text: "Go", onPress: () => open(environmentId, request) },
        ]);
        return;
      }
      open(environmentId, request);
    },
    [open],
  );

  return environments
    .filter((environment) => environment.isEnabled)
    .map((environment) => (
      <UiRequestWatcher
        key={environment.environmentId}
        environmentId={EnvironmentId.make(environment.environmentId)}
        onRequest={handle}
      />
    ));
}
