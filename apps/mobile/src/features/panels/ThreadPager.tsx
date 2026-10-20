import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BackHandler,
  Keyboard,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { useThreadTabs } from "../tabs/useThreadTabs";
import {
  ThreadPageEdgesContext,
  ThreadPagerContext,
  type PageEdges,
  type ThreadPagerControls,
  type ThreadPagerTerminal,
} from "./threadPagerContext";
import { mergeTerminalTabIds, terminalIdFromTabKey, terminalTabKey } from "./terminalTabs";
import { ThreadFilesDrawer } from "./ThreadFilesDrawer";
import { WorkspaceDrawer } from "./WorkspaceDrawer";

const DURATION_MS = 220;
const ACTIVATE_PX = 20;
const FAIL_Y_PX = 14;
const FREE_EDGES: PageEdges = { prev: true, next: true };

/**
 * Chat swipes (sidebar fork). The chat and the thread's file tabs, in the
 * order they were opened, are full-screen pages that follow the finger. Past
 * the chat a swipe right is Back: Home slides in from underneath. Past the
 * last tab a swipe left pulls in the Files panel (open tabs, changes, all
 * files, git). Only the pages next to the current one are mounted.
 */
export function ThreadPager(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly cwd: string | null;
  /** A file another screen asked to show; `at` makes a repeat request count. */
  readonly request: {
    readonly path: string;
    readonly line: string | null;
    readonly at: number;
  } | null;
  readonly chat: ReactNode;
  readonly renderFile: (path: string, line: string | null) => ReactNode;
  /** Live shells of the thread, from the server, so desktop terminals show up too. */
  readonly terminals: ReadonlyArray<ThreadPagerTerminal>;
  readonly renderTerminal: (terminalId: string, active: boolean) => ReactNode;
  /** Kills a shell on the server. */
  readonly onCloseTerminal: (terminalId: string) => void;
}) {
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(width * 0.86, 420);
  const threadKey = `${props.environmentId}:${props.threadId}`;
  const threadTabs = useThreadTabs(threadKey);
  // Shells this device opened that the server has not listed yet.
  const [requestedTerminals, setRequestedTerminals] = useState<ReadonlyArray<string>>([]);
  const liveTerminalIds = useMemo(
    () => props.terminals.map((terminal) => terminal.terminalId),
    [props.terminals],
  );
  useEffect(() => {
    setRequestedTerminals((current) =>
      current.some((id) => liveTerminalIds.includes(id))
        ? current.filter((id) => !liveTerminalIds.includes(id))
        : current,
    );
  }, [liveTerminalIds]);
  const terminals = useMemo<ReadonlyArray<ThreadPagerTerminal>>(
    () =>
      mergeTerminalTabIds(liveTerminalIds, requestedTerminals).map(
        (terminalId) =>
          props.terminals.find((terminal) => terminal.terminalId === terminalId) ?? {
            terminalId,
            label: "Terminal",
          },
      ),
    [liveTerminalIds, props.terminals, requestedTerminals],
  );
  // Pages after the chat: terminals first, then the file tabs.
  const paths = useMemo(
    () => [
      ...terminals.map((terminal) => terminalTabKey(terminal.terminalId)),
      ...threadTabs.tabs.map((tab) => tab.path),
    ],
    [terminals, threadTabs.tabs],
  );

  const [active, setActive] = useState<{ path: string | null; line: string | null }>({
    path: null,
    line: null,
  });
  // A requested tab may not be stored yet; once it has been, its closing returns to the chat.
  const activeSeen = useRef(false);
  const activeIndex = active.path === null ? -1 : paths.indexOf(active.path);
  if (activeIndex >= 0) activeSeen.current = true;
  useEffect(() => {
    if (active.path !== null && activeIndex < 0 && activeSeen.current) {
      setActive({ path: null, line: null });
    }
  }, [active.path, activeIndex]);
  const index = activeIndex + 1;
  const last = paths.length;

  const [underlay, setUnderlay] = useState(false);
  const [panel, setPanel] = useState(false);

  const x = useSharedValue(0);
  const panelProgress = useSharedValue(0);
  const indexValue = useSharedValue(index);
  const lastValue = useSharedValue(last);
  const startIndex = useSharedValue(0);
  const startPanelOpen = useSharedValue(false);
  const touchStart = useSharedValue({ x: 0, y: 0 });
  const decided = useSharedValue(false);
  const edges = useSharedValue<PageEdges>(FREE_EDGES);
  const widthValue = useSharedValue(width);

  useEffect(() => {
    indexValue.value = index;
    lastValue.value = last;
    widthValue.value = width;
    x.value = withTiming(-index * width, { duration: DURATION_MS });
  }, [index, indexValue, last, lastValue, width, widthValue, x]);

  // Leaving the chat takes the keyboard down with it.
  useEffect(() => {
    if (index > 0) Keyboard.dismiss();
  }, [index]);

  const edgesByPath = useRef(new Map<string, PageEdges>());
  useEffect(() => {
    edges.value =
      active.path === null ? FREE_EDGES : (edgesByPath.current.get(active.path) ?? FREE_EDGES);
  }, [active.path, edges]);
  const reportersByPath = useRef(new Map<string, (next: PageEdges) => void>());
  const activePathRef = useRef(active.path);
  activePathRef.current = active.path;
  const edgeReporter = (path: string) => {
    let reporter = reportersByPath.current.get(path);
    if (!reporter) {
      reporter = (next: PageEdges) => {
        edgesByPath.current.set(path, next);
        if (activePathRef.current === path) edges.value = next;
      };
      reportersByPath.current.set(path, reporter);
    }
    return reporter;
  };

  // Opening a tab rewrites the tabs, so goTo reads them through a ref to stay stable.
  const openTabRef = useRef(threadTabs.open);
  openTabRef.current = threadTabs.open;
  const goTo = useCallback((path: string | null, line: string | null = null) => {
    const terminalId = terminalIdFromTabKey(path);
    if (terminalId !== null) {
      setRequestedTerminals((current) =>
        current.includes(terminalId) ? current : [...current, terminalId],
      );
    } else if (path !== null) openTabRef.current(path);
    activeSeen.current = false;
    setActive({ path, line });
  }, []);
  const onCloseTerminal = props.onCloseTerminal;
  const forgetTerminal = useCallback((terminalId: string) => {
    setRequestedTerminals((current) => current.filter((id) => id !== terminalId));
  }, []);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      forgetTerminal(terminalId);
      if (activePathRef.current === terminalTabKey(terminalId))
        setActive({ path: null, line: null });
      onCloseTerminal(terminalId);
    },
    [forgetTerminal, onCloseTerminal],
  );
  const controls = useMemo<ThreadPagerControls>(
    () => ({ goTo, terminals, closeTerminal, forgetTerminal }),
    [closeTerminal, forgetTerminal, goTo, terminals],
  );

  const requestAt = props.request?.at;
  const requestRef = useRef(props.request);
  requestRef.current = props.request;
  useEffect(() => {
    const request = requestRef.current;
    if (request) goTo(request.path, request.line);
  }, [goTo, requestAt]);

  const closePanel = useCallback(() => {
    panelProgress.value = withTiming(0, { duration: DURATION_MS }, (finished) => {
      if (finished) runOnJS(setPanel)(false);
    });
  }, [panelProgress]);

  const goHome = useCallback(() => {
    // Home already slid in under the finger; the stack swaps without its own animation.
    navigation.setOptions({ animation: "none" });
    requestAnimationFrame(() => {
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.dispatch(StackActions.replace("Home"));
    });
  }, [navigation]);

  // Back walks the same way the swipes do: panel, then file tabs, then Home.
  const backState = useRef({ panel, index });
  backState.current = { panel, index };
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (backState.current.panel) {
          closePanel();
          return true;
        }
        if (backState.current.index > 0) {
          setActive({ path: null, line: null });
          return true;
        }
        return false;
      });
      return () => subscription.remove();
    }, [closePanel]),
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.allTouches[0];
          if (touch) touchStart.value = { x: touch.absoluteX, y: touch.absoluteY };
          decided.value = false;
        })
        .onTouchesMove((event, state) => {
          if (decided.value) return;
          const touch = event.allTouches[0];
          if (!touch || event.numberOfTouches > 1) {
            decided.value = true;
            state.fail();
            return;
          }
          const dx = touch.absoluteX - touchStart.value.x;
          const dy = touch.absoluteY - touchStart.value.y;
          if (Math.abs(dy) > FAIL_Y_PX && Math.abs(dy) > Math.abs(dx)) {
            decided.value = true;
            state.fail();
            return;
          }
          if (Math.abs(dx) < ACTIVATE_PX) return;
          // A page that still scrolls sideways keeps the swipe (open panel aside).
          decided.value = true;
          if (panelProgress.value === 0 && !(dx > 0 ? edges.value.prev : edges.value.next)) {
            state.fail();
            return;
          }
          state.activate();
        })
        .onStart(() => {
          startIndex.value = indexValue.value;
          startPanelOpen.value = panelProgress.value > 0.5;
        })
        .onUpdate((event) => {
          const w = widthValue.value;
          const dx = event.translationX;
          const base = -startIndex.value * w;
          if (startPanelOpen.value) {
            panelProgress.value = Math.min(1, Math.max(0, 1 - dx / panelWidth));
            return;
          }
          if (dx > 0 && startIndex.value === 0) {
            if (x.value <= 0) runOnJS(setUnderlay)(true);
            x.value = dx;
            return;
          }
          if (dx < 0 && startIndex.value === lastValue.value) {
            if (panelProgress.value === 0) runOnJS(setPanel)(true);
            x.value = base;
            panelProgress.value = Math.min(1, -dx / panelWidth);
            return;
          }
          x.value = base + Math.max(-w, Math.min(w, dx));
        })
        .onEnd((event) => {
          const w = widthValue.value;
          const projected = event.translationX + event.velocityX * 0.15;
          if (startPanelOpen.value || panelProgress.value > 0) {
            const open = startPanelOpen.value
              ? projected < panelWidth * 0.4
              : -projected > panelWidth * 0.4;
            panelProgress.value = withTiming(open ? 1 : 0, { duration: DURATION_MS }, (done) => {
              if (done && !open) runOnJS(setPanel)(false);
            });
            return;
          }
          if (startIndex.value === 0 && x.value > 0) {
            const leave = projected > w * 0.35;
            x.value = withTiming(leave ? w : 0, { duration: DURATION_MS }, (done) => {
              if (!done) return;
              if (leave) runOnJS(goHome)();
              else runOnJS(setUnderlay)(false);
            });
            return;
          }
          let target = startIndex.value;
          if (projected < -w * 0.35) target = Math.min(lastValue.value, target + 1);
          else if (projected > w * 0.35) target = Math.max(0, target - 1);
          x.value = withTiming(-target * w, { duration: DURATION_MS });
          if (target !== startIndex.value) {
            runOnJS(goToIndex)(target);
          }
        }),
    // goToIndex reads the latest paths through a ref.
    [goHome, panelWidth],
  );
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  function goToIndex(target: number) {
    const path = target === 0 ? null : (pathsRef.current[target - 1] ?? null);
    setActive({ path, line: null });
  }

  const trackStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const underlayDimStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, 0.35 * (1 - x.value / widthValue.value)),
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: panelProgress.value * 0.45 }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - panelProgress.value) * panelWidth }],
  }));

  return (
    <ThreadPagerContext.Provider value={controls}>
      <GestureDetector gesture={gesture}>
        <View style={styles.fill} collapsable={false}>
          {underlay ? (
            <View
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
              testID="thread-home-underlay"
            >
              <WorkspaceDrawer currentThreadKey={threadKey} onClose={() => undefined} />
              <Reanimated.View style={[StyleSheet.absoluteFill, styles.dim, underlayDimStyle]} />
            </View>
          ) : null}
          {/* As wide as all pages: Android hands touches to native views (code, PDF)
              only inside their parents' bounds. */}
          <Reanimated.View style={[styles.track, { width: (last + 1) * width }, trackStyle]}>
            <View style={[styles.page, { left: 0, width }]} testID="thread-page-chat">
              {props.chat}
            </View>
            {paths.map((path, position) => {
              const page = position + 1;
              if (Math.abs(page - index) > 1) return null;
              const terminalId = terminalIdFromTabKey(path);
              return (
                <View
                  key={path}
                  style={[styles.page, { left: page * width, width }]}
                  testID={`thread-page-${page}`}
                >
                  <ThreadPageEdgesContext.Provider value={edgeReporter(path)}>
                    {terminalId !== null
                      ? props.renderTerminal(terminalId, page === index)
                      : props.renderFile(path, path === active.path ? active.line : null)}
                  </ThreadPageEdgesContext.Provider>
                </View>
              );
            })}
          </Reanimated.View>
          {panel ? (
            <>
              <Reanimated.View
                style={[StyleSheet.absoluteFill, styles.dim, backdropStyle]}
                pointerEvents="box-none"
              >
                <Pressable
                  accessibilityLabel="Close panel"
                  style={StyleSheet.absoluteFill}
                  onPress={closePanel}
                />
              </Reanimated.View>
              <Reanimated.View
                style={[styles.panel, { width: panelWidth }, panelStyle]}
                testID="thread-panel-right"
              >
                <ThreadFilesDrawer
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  cwd={props.cwd}
                  onClose={closePanel}
                />
              </Reanimated.View>
            </>
          ) : null}
        </View>
      </GestureDetector>
    </ThreadPagerContext.Provider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: "hidden" },
  dim: { backgroundColor: "#000" },
  track: { position: "absolute", top: 0, bottom: 0, left: 0 },
  page: { position: "absolute", top: 0, bottom: 0 },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    elevation: 16,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
  },
});
