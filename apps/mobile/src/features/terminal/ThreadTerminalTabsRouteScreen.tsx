import {
  AuthTerminalOperateScope,
  DEFAULT_TERMINAL_ID,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, useMemo } from "react";

import { readEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useThreadSelection } from "../../state/use-thread-selection";
import { mergeTerminalTabIds, terminalIdFromTabKey } from "../panels/terminalTabs";
import { ThreadPagerContext, type ThreadPagerControls } from "../panels/threadPagerContext";
import { buildTerminalMenuSessions } from "./terminalMenu";
import { ThreadTerminalRouteScreen } from "./ThreadTerminalRouteScreen";

type Params = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId?: string;
};

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.trim() || null;

/**
 * The terminal screen where there is no thread pager: tablets, foldables and
 * iOS (sidebar fork). It gives the terminal the same tab strip, keys and menu
 * as a pager page: a terminal tab swaps the shell shown here, Chat goes back,
 * a file tab opens the file, and closing a tab kills its shell.
 */
export function ThreadTerminalTabsRouteScreen(props: StaticScreenProps<Params>) {
  const navigation = useNavigation();
  const params = props.route.params;
  const environmentIdRaw = first(params.environmentId);
  const threadIdRaw = first(params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = threadIdRaw ? ThreadId.make(threadIdRaw) : null;
  const terminalId = first(params.terminalId) ?? DEFAULT_TERMINAL_ID;
  const { selectedThreadProject } = useThreadSelection();
  const { sessions } = useKnownTerminalSessions({ environmentId, threadId });
  const closeCommand = useAtomCommand(terminalEnvironment.close, "terminal close");

  const liveSessions = useMemo(
    () =>
      buildTerminalMenuSessions({
        knownSessions: sessions ?? [],
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
      }),
    [selectedThreadProject?.workspaceRoot, sessions],
  );
  const terminals = useMemo(() => {
    const labels = new Map(
      liveSessions.map((session) => [session.terminalId, session.displayLabel]),
    );
    return mergeTerminalTabIds(
      liveSessions.map((session) => session.terminalId),
      [terminalId],
    ).map((id) => ({ terminalId: id, label: labels.get(id) ?? "Terminal" }));
  }, [liveSessions, terminalId]);

  const showTerminal = useCallback(
    (nextTerminalId: string | null) => {
      if (nextTerminalId === null) {
        if (navigation.canGoBack()) navigation.goBack();
        return;
      }
      navigation.dispatch(CommonActions.setParams({ terminalId: nextTerminalId }));
    },
    [navigation],
  );
  const controls = useMemo<ThreadPagerControls>(
    () => ({
      terminals,
      goTo: (path) => {
        if (path === null) {
          showTerminal(null);
          return;
        }
        const nextTerminalId = terminalIdFromTabKey(path);
        if (nextTerminalId !== null) {
          showTerminal(nextTerminalId);
          return;
        }
        if (environmentIdRaw === null || threadIdRaw === null) return;
        navigation.dispatch(
          StackActions.push("ThreadFile", {
            environmentId: environmentIdRaw,
            threadId: threadIdRaw,
            path: path.split("/").filter(Boolean),
          }),
        );
      },
      closeTerminal: (closedTerminalId) => {
        if (
          environmentId !== null &&
          threadId !== null &&
          readEnvironmentScope(environmentId, AuthTerminalOperateScope)
        ) {
          void closeCommand({
            environmentId,
            input: { threadId, terminalId: closedTerminalId, deleteHistory: true },
          });
        }
        if (closedTerminalId !== terminalId) return;
        const fallback = terminals.find((terminal) => terminal.terminalId !== closedTerminalId);
        showTerminal(fallback?.terminalId ?? null);
      },
      // The screen moves on to another shell itself once one exits.
      forgetTerminal: () => undefined,
    }),
    [
      closeCommand,
      environmentId,
      environmentIdRaw,
      navigation,
      showTerminal,
      terminalId,
      terminals,
      threadId,
      threadIdRaw,
    ],
  );

  return (
    <ThreadPagerContext.Provider value={controls}>
      <ThreadTerminalRouteScreen
        key={terminalId}
        embedded={{ active: true }}
        route={{ params: { ...params, terminalId } }}
      />
    </ThreadPagerContext.Provider>
  );
}
