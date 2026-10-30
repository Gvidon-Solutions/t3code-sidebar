import * as Haptics from "expo-haptics";
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { View, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { useAnimatedStyle, withTiming } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import type { ArrangeableFolder } from "./workspaceNavigator";

/**
 * Long-press drag for project folders (sidebar fork). Holding a folder lifts
 * it; moving the finger swaps the list for a compact one of folder headers,
 * where it drops into place. Releasing without moving opens the folder menu
 * instead, so long-press keeps both jobs.
 */

const ROW_HEIGHT = 44;
const LONG_PRESS_MS = 350;
/** Finger travel that turns a long-press into a drag. */
const LIFT_SLOP = 8;
/** Near the overlay's top or bottom edge a long list scrolls by itself. */
const EDGE = 56;
const EDGE_STEP = 8;

export interface FolderDragApi {
  readonly begin: (projectKey: string, windowY: number) => void;
  readonly move: (windowY: number) => void;
  /** Ends the drag; false when the finger never moved, so the caller opens the menu. */
  readonly end: (projectKey: string, commit: boolean) => boolean;
}

const FolderDragContext = createContext<FolderDragApi | null>(null);

interface Overlay {
  readonly entries: ReadonlyArray<ArrangeableFolder>;
  readonly from: number;
  readonly frameY: number;
  readonly frameHeight: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function targetIndex(overlay: Overlay, listTop: number, windowY: number): number {
  const y = windowY - overlay.frameY - listTop - ROW_HEIGHT / 2;
  return clamp(Math.round(y / ROW_HEIGHT), 0, overlay.entries.length - 1);
}

/** Wraps a folder list; folder rows inside it drag on long-press. */
export function FolderDragHost(props: {
  readonly getFolders: () => ReadonlyArray<ArrangeableFolder>;
  readonly onDrop: (projectKey: string, beforeKey: string | null, sequence: string[]) => void;
  readonly children: ReactNode;
}) {
  const frameRef = useRef<ViewInstance>(null);
  const drag = useRef<{ projectKey: string; startY: number; lifted: boolean } | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [listTop, setListTop] = useState(0);
  const [fingerY, setFingerY] = useState(0);

  // Gestures and the edge scroll run after render, so effect events read the
  // latest props and drag state while the context value stays the same.
  const getFolders = useEffectEvent(() => props.getFolders());
  const readFingerY = useEffectEvent(() => fingerY);
  const drop = useEffectEvent((projectKey: string) => {
    if (!overlay) return;
    const target = targetIndex(overlay, listTop, fingerY);
    if (target === overlay.from) return;
    const sequence = overlay.entries.map((entry) => entry.projectKey);
    const rest = sequence.filter((key) => key !== projectKey);
    props.onDrop(projectKey, rest[target] ?? null, sequence);
    void Haptics.selectionAsync();
  });

  const [api] = useState<FolderDragApi>(() => ({
    begin: (projectKey, windowY) => {
      drag.current = { projectKey, startY: windowY, lifted: false };
    },
    move: (windowY) => {
      const current = drag.current;
      if (!current) return;
      setFingerY(windowY);
      if (current.lifted || Math.abs(windowY - current.startY) < LIFT_SLOP) return;
      const entries = getFolders();
      const from = entries.findIndex((entry) => entry.projectKey === current.projectKey);
      if (from < 0 || entries.length < 2) return;
      current.lifted = true;
      frameRef.current?.measureInWindow((_x, frameY, _width, frameHeight) => {
        if (drag.current !== current) return;
        const total = entries.length * ROW_HEIGHT;
        // The lifted row starts under the finger; the rest fits the frame when it can.
        const top = current.startY - frameY - ROW_HEIGHT / 2 - from * ROW_HEIGHT;
        setListTop(
          total <= frameHeight
            ? clamp(top, 0, frameHeight - total)
            : clamp(top, frameHeight - total, 0),
        );
        setOverlay({ entries, from, frameY, frameHeight });
      });
    },
    end: (projectKey, commit) => {
      const current = drag.current;
      if (!current || current.projectKey !== projectKey) return false;
      drag.current = null;
      // `drop` still sees the overlay of the last render; this only clears the next one.
      setOverlay(null);
      if (!current.lifted) return false;
      if (commit) drop(projectKey);
      return true;
    },
  }));

  // Holding the finger near an edge of a list taller than the screen scrolls it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs a frame loop that auto-scrolls the list while a drag nears an edge
  useEffect(() => {
    if (!overlay) return;
    const total = overlay.entries.length * ROW_HEIGHT;
    if (total <= overlay.frameHeight) return;
    let frame = 0;
    const step = () => {
      const y = readFingerY() - overlay.frameY;
      const delta = y < EDGE ? EDGE_STEP : y > overlay.frameHeight - EDGE ? -EDGE_STEP : 0;
      if (delta !== 0) {
        setListTop((top) => clamp(top + delta, overlay.frameHeight - total, 0));
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [overlay]);

  const target = overlay ? targetIndex(overlay, listTop, fingerY) : 0;
  return (
    <FolderDragContext.Provider value={api}>
      <View ref={frameRef} collapsable={false} style={{ flex: 1 }}>
        {props.children}
        {overlay ? (
          <View pointerEvents="none" className="absolute inset-0 bg-screen">
            {overlay.entries.map((entry, index) => {
              if (index === overlay.from) return null;
              const shift =
                overlay.from < target
                  ? index > overlay.from && index <= target
                    ? -ROW_HEIGHT
                    : 0
                  : index >= target && index < overlay.from
                    ? ROW_HEIGHT
                    : 0;
              return (
                <DragRow
                  key={entry.projectKey}
                  entry={entry}
                  top={listTop + index * ROW_HEIGHT}
                  shift={shift}
                />
              );
            })}
            <View
              className="absolute left-2 right-2 rounded-xl border border-border bg-subtle"
              style={{
                top: fingerY - overlay.frameY - ROW_HEIGHT / 2,
                height: ROW_HEIGHT,
                elevation: 8,
              }}
            >
              <FolderLabel entry={overlay.entries[overlay.from]!} />
            </View>
          </View>
        ) : null}
      </View>
    </FolderDragContext.Provider>
  );
}

function DragRow(props: {
  readonly entry: ArrangeableFolder;
  readonly top: number;
  readonly shift: number;
}) {
  const { shift } = props;
  const style = useAnimatedStyle(
    () => ({ transform: [{ translateY: withTiming(shift, { duration: 120 }) }] }),
    [shift],
  );
  return (
    <Reanimated.View
      className="absolute left-2 right-2"
      style={[{ top: props.top, height: ROW_HEIGHT }, style]}
    >
      <FolderLabel entry={props.entry} />
    </Reanimated.View>
  );
}

function FolderLabel(props: { readonly entry: ArrangeableFolder }) {
  const { entry } = props;
  return (
    <View className={cn("flex-1 flex-row items-center gap-2 px-3", entry.quiet && "opacity-50")}>
      <ProjectFavicon
        environmentId={entry.project.environmentId}
        faviconPath={entry.project.faviconPath}
        projectIcon={entry.project.projectIcon}
        size={16}
        projectTitle={entry.project.title}
        workspaceRoot={entry.project.workspaceRoot}
      />
      <Text className="min-w-0 flex-1 text-[15px] font-t3-medium text-foreground" numberOfLines={1}>
        {entry.title}
      </Text>
      {entry.quiet ? (
        <SymbolView name="moon" size={12} tintColorClassName="accent-foreground-muted" />
      ) : null}
    </View>
  );
}

/** Whether folder rows here sit inside a `FolderDragHost`. */
export function useFolderDragAvailable(): boolean {
  return useContext(FolderDragContext) !== null;
}

/** Long-press on a folder row: drags when the finger moves, else calls `onMenu`. */
export function FolderDragHandle(props: {
  readonly projectKey: string;
  readonly onMenu: () => void;
  readonly children: ReactNode;
}) {
  const api = useContext(FolderDragContext);
  // Gesture callbacks fire after render, so effect events read the latest
  // props while the row keeps one gesture for its lifetime.
  const onStart = useEffectEvent((windowY: number) => api?.begin(props.projectKey, windowY));
  const onMove = useEffectEvent((windowY: number) => api?.move(windowY));
  const onFinalize = useEffectEvent((success: boolean) => {
    const dragged = api?.end(props.projectKey, success) ?? false;
    if (success && !dragged) props.onMenu();
  });
  const [gesture] = useState(() =>
    Gesture.Pan()
      .activateAfterLongPress(LONG_PRESS_MS)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onStart((event) => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onStart(event.absoluteY);
      })
      .onUpdate((event) => onMove(event.absoluteY))
      .onFinalize((_event, success) => onFinalize(success)),
  );
  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false}>{props.children}</View>
    </GestureDetector>
  );
}
