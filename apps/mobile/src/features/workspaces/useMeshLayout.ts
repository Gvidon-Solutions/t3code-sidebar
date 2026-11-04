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
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import {
  createContext,
  createElement,
  use,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useEnvironments } from "../../state/environments";
import { meshLayoutAtoms } from "../../state/mesh-layout";
import { useAtomCommand } from "../../state/use-atom-command";
const emptyState = emptyMeshLayoutState();
const emptySnapshot = () => emptyState;
const noSubscription = () => () => {};
const NO_SUBSCRIPTION = Atom.make<null>(null);
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { uuidv4 } from "../../lib/uuid";
function useMeshLayoutOwner() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = null;
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
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
  const persistence = useRef({ preferences, savePreferences });
  const preferencesReady = preferences !== null;
  const loadedPreferences = useEffectEvent(() => preferences);
  const [store, setStore] = useState<MeshLayoutStore | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Creates the external store and owns its persistence and RPC lifetime.
  useEffect(() => {
    if (!preferencesReady) return;
    persistence.current.preferences = loadedPreferences();
    const deviceId = persistence.current.preferences?.meshLayoutDeviceId ?? uuidv4();
    const created = new MeshLayoutStore({
      deviceId,
      now: Date.now,
      environments: () => current.current.sources,
      primaryEnvironmentId: () => current.current.primaryEnvironmentId,
      persistence: {
        load: async () =>
          parseMeshLayoutCache(persistence.current.preferences?.meshLayoutCache ?? null),
        save: async (state) => {
          persistence.current.savePreferences({
            meshLayoutCache: serializeMeshLayoutCache(state),
            meshLayoutDeviceId: deviceId,
          });
        },
      },
      onPermanentFailure: (error) => console.error("Mesh layout failed", error),
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
  }, [current, listener, persistence, preferencesReady]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Preferences hydrate asynchronously after the native persistence service opens.
  useEffect(() => {
    persistence.current.preferences = preferences;
    persistence.current.savePreferences = savePreferences;
    const cached = parseMeshLayoutCache(preferences?.meshLayoutCache ?? null);
    if (cached) {
      store?.hydrate(cached);
      void store?.replayOutbox().catch((error) => console.error("Mesh cache replay failed", error));
    }
  }, [store, persistence, preferences, savePreferences]);
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
  }, [remote, current, listener]);
  return {
    connectedEnvironmentIds: new Set(
      sources
        .filter((environment) => environment.connected)
        .map((environment) => environment.environmentId),
    ),
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

const MeshLayoutContext = createContext<ReturnType<typeof useMeshLayoutOwner> | null>(null);
export function MeshLayoutProvider({ children }: { readonly children: ReactNode }) {
  const value = useMeshLayoutOwner();
  return createElement(MeshLayoutContext.Provider, { value }, children);
}
export function useMeshLayout() {
  const value = use(MeshLayoutContext);
  if (value === null) throw new Error("MeshLayoutProvider is missing");
  return value;
}
