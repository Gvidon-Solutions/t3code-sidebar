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
import type { EnvironmentId, SidebarWorkspacesConfig } from "@t3tools/contracts";
import type { MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useEnvironments } from "../../state/environments";
import { meshLayoutAtoms } from "../../state/mesh-layout";
import { useAtomCommand } from "../../state/use-atom-command";

const NO_SUBSCRIPTION = Atom.make<null>(null);

function readCache(preferences: { readonly meshLayoutCache?: string } | null) {
  return parseMeshLayoutCache(preferences?.meshLayoutCache ?? null);
}

/**
 * T3 Mesh (fork) on the phone: the same cached document, optimistic outbox and failover as web.
 * `source === null` keeps the legacy `sidebarWorkspaces` path.
 */
export function useMeshLayout() {
  const { environments } = useEnvironments();
  const applyEntries = useAtomCommand(meshLayoutAtoms.apply, { reportFailure: false });
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const persisted = readCache(preferences);
  const [state, setState] = useState<MeshLayoutClientState>(
    () => persisted ?? emptyMeshLayoutState(),
  );
  const stateRef = useRef(state);
  const hydrated = useRef(persisted !== null);
  const deviceIdRef = useRef<string | null>(preferences?.meshLayoutDeviceId ?? null);

  const sources = environments.map((environment) => ({
    environmentId: environment.environmentId,
    connected: environment.connection.phase === "connected",
    capabilities: environment.serverConfig?.environment.capabilities,
  }));
  const source = pickMeshSource(sources, null);

  const subscriptionAtom =
    source === null
      ? NO_SUBSCRIPTION
      : meshLayoutAtoms.subscribe({ environmentId: source, input: {} });
  const subscription = useAtomValue(subscriptionAtom);
  const remote: import("@t3tools/contracts").MeshLayoutSnapshot | null =
    source === null || subscription === null
      ? null
      : ((Option.getOrNull(AsyncResult.value(subscription)) as
          | import("@t3tools/contracts").MeshLayoutSnapshot
          | undefined) ?? null);

  const persist = (next: MeshLayoutClientState, deviceId: string) => {
    savePreferences({
      meshLayoutCache: serializeMeshLayoutCache(next),
      meshLayoutDeviceId: deviceId,
    });
  };

  // Hydrate from preferences after the async store settles.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the persisted cache into the sidebar state once the async store loads
  useEffect(() => {
    if (hydrated.current || persisted === null) return;
    hydrated.current = true;
    stateRef.current = persisted;
    setState(persisted);
    if (persisted.snapshot?.environmentId) {
      if (deviceIdRef.current === null) deviceIdRef.current = uuidv4();
    }
  }, [persisted]);

  const send = useEffectEvent(async (environmentId: EnvironmentId, entries: MeshLayoutDocument) => {
    const result = await applyEntries({ environmentId, input: { entries } });
    const deviceId = deviceIdRef.current ?? uuidv4();
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      if (!isPermanentMeshLayoutFailure(error)) return;
      const next = acknowledgeMeshLayoutEntries(stateRef.current, entries);
      stateRef.current = next;
      setState(next);
      persist(next, deviceId);
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
    persist(next, deviceId);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the live mesh snapshot and offline cache into the sidebar state
  useEffect(() => {
    if (source === null || remote === null) return;
    const deviceId = deviceIdRef.current ?? uuidv4();
    deviceIdRef.current = deviceId;
    const next = mergeMeshLayoutSnapshot(stateRef.current, {
      environmentId: remote.environmentId,
      document: remote.document as MeshLayoutDocument,
      config: remote.config,
    });
    stateRef.current = next;
    setState(next);
    persist(next, deviceId);
    if (Object.keys(next.outbox).length > 0) void send(source, next.outbox);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- send is an effect event; the snapshot and selected source drive this effect
  }, [remote, source]);

  const edit = (update: (config: SidebarWorkspacesConfig) => SidebarWorkspacesConfig): void => {
    if (source === null) return;
    const deviceId = deviceIdRef.current ?? uuidv4();
    deviceIdRef.current = deviceId;
    const result = editMeshLayout(stateRef.current, update, { deviceId, now: Date.now() });
    stateRef.current = result.state;
    setState(result.state);
    persist(result.state, deviceId);
    if (Object.keys(result.entries).length > 0) void send(source, result.entries);
  };

  return {
    source,
    state,
    config: state.snapshot?.config ?? null,
    connectedEnvironmentIds: new Set(
      sources
        .filter((environment) => environment.connected)
        .map((environment) => environment.environmentId),
    ),
    edit,
  } as const;
}
