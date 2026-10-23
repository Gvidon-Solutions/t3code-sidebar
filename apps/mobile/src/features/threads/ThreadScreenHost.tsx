import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { ThreadDetailScreen, type ThreadDetailScreenProps } from "./ThreadDetailScreen";

type ThreadScreenContent =
  | { readonly props: ThreadDetailScreenProps }
  | { readonly fallback: ReactNode };

function createThreadScreenStore() {
  let current: ThreadScreenContent | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (content: ThreadScreenContent) => {
      current = content;
      for (const listener of listeners) listener();
    },
  };
}
const ThreadScreenContext = createContext<ReturnType<typeof createThreadScreenStore> | null>(null);
// Sidebar fork: set while the Android thread pager shows the screen on its chat page.
const ThreadScreenInlineContext = createContext<((inline: boolean) => void) | null>(null);

function ThreadScreenOutlet() {
  const store = useContext(ThreadScreenContext)!;
  const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (content === null) return null;
  return "props" in content ? (
    <>
      {content.props.header}
      <ThreadDetailScreen {...content.props} />
    </>
  ) : (
    content.fallback
  );
}

// Controllers can change from draft to live without replacing the native screen,
// the keyboard host, or the editor. Publish before paint to avoid an intermediate frame.
export function ThreadScreenHost({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createThreadScreenStore);
  const [inline, setInline] = useState(false);
  return (
    <ThreadScreenContext.Provider value={store}>
      <ThreadScreenInlineContext.Provider value={setInline}>
        {children}
        {inline ? null : (
          <View className="flex-1 bg-screen android:overflow-hidden android:rounded-t-[28px] android:bg-thread-canvas">
            <ThreadScreenOutlet />
          </View>
        )}
      </ThreadScreenInlineContext.Provider>
    </ThreadScreenContext.Provider>
  );
}

/**
 * Sidebar fork: the thread screen in place, for the Android thread pager's chat
 * page. While mounted, the host leaves its own slot out.
 */
export function ThreadScreenInlineOutlet() {
  const setInline = useContext(ThreadScreenInlineContext)!;
  useLayoutEffect(() => {
    setInline(true);
    return () => setInline(false);
  }, [setInline]);
  return (
    <View className="flex-1 bg-screen android:bg-thread-canvas">
      <ThreadScreenOutlet />
    </View>
  );
}

export function ThreadScreenBinding(props: ThreadDetailScreenProps) {
  const store = useContext(ThreadScreenContext)!;
  useLayoutEffect(() => {
    store.publish({ props });
  });
  return null;
}

export function ThreadScreenFallback({ children }: { readonly children: ReactNode }) {
  const store = useContext(ThreadScreenContext)!;
  useLayoutEffect(() => {
    store.publish({ fallback: children });
  });
  return null;
}
