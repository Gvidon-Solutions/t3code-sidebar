import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  MeshLayoutStore,
  emptyMeshLayoutState,
  parseMeshLayoutCache,
  serializeMeshLayoutCache,
  pickMeshSource,
} from "@t3tools/client-runtime/state/mesh-layout-client";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MeshLayoutSnapshot } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import {
  createContext,
  createElement,
  use,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { meshLayoutAtoms } from "../state/meshLayout";
import { useAtomCommand } from "../state/use-atom-command";
const emptyState = emptyMeshLayoutState();
const emptySnapshot = () => emptyState;
const noSubscription = () => () => {};
const NO_SUBSCRIPTION = Atom.make<null>(null);
const CACHE_KEY = "t3code.meshLayout.cache";
const DEVICE_KEY = "t3code.meshLayout.deviceId";
function useMeshLayoutOwner() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const applyEntries = useAtomCommand(meshLayoutAtoms.apply, { reportFailure: false });
  const sources = environments.map((environment) => ({
    environmentId: environment.environmentId,
    connected: environment.connection.phase === "connected",
    capabilities: environment.serverConfig?.environment.capabilities,
  }));
  const source = pickMeshSource(sources, primaryEnvironmentId);
  const subscription = useAtomValue(
    source === null
      ? NO_SUBSCRIPTION
      : meshLayoutAtoms.subscribe({ environmentId: source, input: {} }),
  );
  const remote =
    subscription === null
      ? null
      : (Option.getOrNull(AsyncResult.value(subscription)) as MeshLayoutSnapshot | null);
  const listener = useRef<((snapshot: MeshLayoutSnapshot) => void) | null>(null);
  const current = useRef({ sources, primaryEnvironmentId, remote, applyEntries });
  const [store, setStore] = useState<MeshLayoutStore | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Creates the external store and owns its persistence and RPC lifetime.
  useEffect(() => {
    const deviceId =
      window.localStorage.getItem(DEVICE_KEY) ??
      `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(DEVICE_KEY, deviceId);
    const created = new MeshLayoutStore({
      deviceId,
      now: Date.now,
      environments: () => current.current.sources,
      primaryEnvironmentId: () => current.current.primaryEnvironmentId,
      persistence: {
        load: async () => parseMeshLayoutCache(window.localStorage.getItem(CACHE_KEY)),
        save: async (state) => {
          window.localStorage.setItem(CACHE_KEY, serializeMeshLayoutCache(state));
        },
      },
      onPermanentFailure: (error) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Workspace layout not saved",
            description: error instanceof Error ? error.message : "The mesh rejected the change.",
          }),
        ),
      rpc: {
        get: async () => {
          if (!current.current.remote) throw new Error("Waiting for mesh snapshot");
          return current.current.remote;
        },
        subscribe: (_id, callback) => {
          listener.current = callback;
          return () => {
            if (listener.current === callback) listener.current = null;
          };
        },
        apply: async (environmentId, entries) => {
          const result = await current.current.applyEntries({ environmentId, input: { entries } });
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) throw new Error("Mesh call interrupted");
            throw squashAtomCommandFailure(result);
          }
          return result.value;
        },
      },
    });
    setStore(created);
    void created.start().catch((error) => console.error("Mesh layout startup failed", error));
    return () => created.dispose();
  }, [current, listener]);
  const state = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? emptySnapshot,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Connection changes trigger source selection and offline outbox replay.
  useEffect(() => {
    current.current.sources = environments.map((environment) => ({
      environmentId: environment.environmentId,
      connected: environment.connection.phase === "connected",
      capabilities: environment.serverConfig?.environment.capabilities,
    }));
    current.current.primaryEnvironmentId = primaryEnvironmentId;
    current.current.applyEntries = applyEntries;
    void store
      ?.refreshEnvironments()
      .catch((error) => console.error("Mesh reconnect failed", error));
  }, [store, current, environments, primaryEnvironmentId, applyEntries]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Bridges the RPC atom stream into the shared layout store.
  useEffect(() => {
    current.current.remote = remote;
    if (remote) listener.current?.(remote);
  }, [remote, current]);
  return {
    source:
      source ??
      (state.snapshot
        ? (state.snapshot.environmentId as import("@t3tools/contracts").EnvironmentId)
        : null),
    state,
    config: state.snapshot?.config ?? null,
    edit: (update: Parameters<MeshLayoutStore["edit"]>[0]) => {
      void store
        ?.edit(update)
        .catch((error) => console.error("Mesh edit persistence failed", error));
    },
  } as const;
}

type MeshLayout = ReturnType<typeof useMeshLayoutOwner>;
const MeshLayoutContext = createContext<MeshLayout | null>(null);
export function MeshLayoutProvider({ children }: { readonly children: ReactNode }) {
  const value = useMeshLayoutOwner();
  return createElement(MeshLayoutContext.Provider, { value }, children);
}
/**
 * Mesh-aware components require the provider. A silent empty fallback would
 * hide a missing provider as "single machine, not a replica" and could offer
 * git actions on a replica, so this is a construction error.
 */
export function useMeshLayout(): MeshLayout {
  const value = use(MeshLayoutContext);
  if (value === null) throw new Error("MeshLayoutProvider is missing");
  return value;
}
