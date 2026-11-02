import {
  acknowledgeMeshLayoutEntries,
  editMeshLayout,
  emptyMeshLayoutState,
  isPermanentMeshLayoutFailure,
  mergeMeshLayoutSnapshot,
  parseMeshLayoutCache,
  pickMeshSource,
  serializeMeshLayoutCache,
  type MeshLayoutClientState,
} from "@t3tools/client-runtime/state/mesh-layout-client";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MeshLayoutSnapshot as MeshLayoutRpcSnapshot,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import type { MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { meshLayoutAtoms } from "../state/meshLayout";
import { useAtomCommand } from "../state/use-atom-command";

const CACHE_KEY = "t3code.meshLayout.cache";
const DEVICE_KEY = "t3code.meshLayout.deviceId";
const NO_SUBSCRIPTION = Atom.make<null>(null);

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    console.warn("[MESH] Could not read local storage.", error);
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    console.warn("[MESH] Could not write local storage.", error);
  }
}

function readDeviceId(): string {
  const stored = readStorage(DEVICE_KEY);
  if (stored) return stored;
  const generated = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  writeStorage(DEVICE_KEY, generated);
  return generated;
}

function readCache(): MeshLayoutClientState {
  return parseMeshLayoutCache(readStorage(CACHE_KEY)) ?? emptyMeshLayoutState();
}

function persist(state: MeshLayoutClientState): void {
  writeStorage(CACHE_KEY, serializeMeshLayoutCache(state));
}

function reportFailure(error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Workspace layout not saved",
      description: error instanceof Error ? error.message : "The mesh rejected the change.",
    }),
  );
}

/**
 * T3 Mesh (fork): reads the shared layout from a connected mesh-capable server and writes every
 * workspace edit as CRDT entries, keeping an offline outbox. `source === null` means no such
 * server is connected, and the caller keeps the legacy `sidebarWorkspaces` path.
 */
export function useMeshLayout() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const applyEntries = useAtomCommand(meshLayoutAtoms.apply, { reportFailure: false });
  const [state, setState] = useState<MeshLayoutClientState>(readCache);
  const stateRef = useRef(state);
  const deviceIdRef = useRef<string | null>(null);
  if (deviceIdRef.current === null) deviceIdRef.current = readDeviceId();

  const sources = environments.map((environment) => ({
    environmentId: environment.environmentId,
    connected: environment.connection.phase === "connected",
    capabilities: environment.serverConfig?.environment.capabilities,
  }));
  const source = pickMeshSource(sources, primaryEnvironmentId);

  const subscriptionAtom =
    source === null
      ? NO_SUBSCRIPTION
      : meshLayoutAtoms.subscribe({ environmentId: source, input: {} });
  const subscription = useAtomValue(subscriptionAtom);
  const remote: MeshLayoutRpcSnapshot | null =
    source === null || subscription === null
      ? null
      : ((Option.getOrNull(AsyncResult.value(subscription)) as MeshLayoutRpcSnapshot | undefined) ??
        null);

  const send = useEffectEvent(async (environmentId: EnvironmentId, entries: MeshLayoutDocument) => {
    const result = await applyEntries({ environmentId, input: { entries } });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      if (!isPermanentMeshLayoutFailure(error)) return;
      const next = acknowledgeMeshLayoutEntries(stateRef.current, entries);
      stateRef.current = next;
      setState(next);
      persist(next);
      reportFailure(error);
      return;
    }
    const next = acknowledgeMeshLayoutEntries(
      mergeMeshLayoutSnapshot(stateRef.current, {
        environmentId: result.value.environmentId,
        document: result.value.document as MeshLayoutDocument,
        config: result.value.config,
      }),
      entries,
    );
    stateRef.current = next;
    setState(next);
    persist(next);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the live mesh snapshot and offline cache into the sidebar state
  useEffect(() => {
    if (source === null || remote === null) return;
    const next = mergeMeshLayoutSnapshot(stateRef.current, {
      environmentId: remote.environmentId,
      document: remote.document as MeshLayoutDocument,
      config: remote.config,
    });
    stateRef.current = next;
    setState(next);
    persist(next);
    if (Object.keys(next.outbox).length > 0) void send(source, next.outbox);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- send is an effect event; the snapshot and selected source drive this effect
  }, [remote, source]);

  const edit = (update: (config: SidebarWorkspacesConfig) => SidebarWorkspacesConfig): void => {
    if (source === null) return;
    const deviceId = deviceIdRef.current ?? readDeviceId();
    const result = editMeshLayout(stateRef.current, update, { deviceId, now: Date.now() });
    stateRef.current = result.state;
    setState(result.state);
    persist(result.state);
    if (Object.keys(result.entries).length > 0) void send(source, result.entries);
  };

  return {
    source,
    state,
    config: state.snapshot?.config ?? null,
    edit,
  } as const;
}
