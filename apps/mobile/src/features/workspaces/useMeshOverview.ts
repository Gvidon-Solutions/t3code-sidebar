import * as Cause from "effect/Cause";
import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  buildMeshMachines,
  type MeshLinkSource,
  type MeshMachine,
  type MeshMachineConnection,
  type MeshPeerStateView,
} from "@t3tools/client-runtime/state/mesh-machines";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  EnvironmentId,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { meshLayoutAtoms } from "../../state/mesh-layout";
import { peerLinkEnvironment } from "../../state/peerLinks";

const NO_IDS = "[]";

const peerLinksSourcesAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<MeshLinkSource> => {
    const ids = JSON.parse(key) as ReadonlyArray<string>;
    return ids.flatMap((environmentId) => {
      const result = get(
        peerLinkEnvironment.list({
          environmentId: EnvironmentId.make(environmentId),
          input: {},
        }),
      );
      if (result._tag === "Failure")
        return [{ environmentId, links: [], error: String(Cause.squash(result.cause)) }];
      const data = AsyncResult.getOrElse(result, () => null);
      return data === null
        ? []
        : [
            {
              environmentId,
              links: data.links.map((link) => ({
                environmentId: link.environmentId,
                label: link.label,
                urls: link.urls,
                status: link.status,
                lastError: link.lastError,
              })),
            },
          ];
    });
  }).pipe(Atom.withLabel(`mobile:mesh:peer-links:${key}`)),
);

const peerStatesAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<MeshPeerStateView> => {
    const ids = JSON.parse(key) as ReadonlyArray<string>;
    return ids.flatMap((environmentId) => {
      const result = get(
        meshLayoutAtoms.status({
          environmentId: EnvironmentId.make(environmentId),
          input: {},
        }),
      );
      if (result._tag === "Failure")
        return [
          {
            environmentId,
            lastExchangeAt: null,
            lastError: String(Cause.squash(result.cause)),
            sentSeq: 0,
            receivedSeq: 0,
          },
        ];
      const data = AsyncResult.getOrElse(result, () => null);
      return data === null ? [] : data.peers;
    });
  }).pipe(Atom.withLabel(`mobile:mesh:peer-states:${key}`)),
);

const peerConnectionsAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const ids = JSON.parse(key) as readonly string[];
    return ids.flatMap((environmentId) => {
      const value = get(
        meshLayoutAtoms.status({ environmentId: EnvironmentId.make(environmentId), input: {} }),
      );
      return AsyncResult.getOrElse(value, () => null)?.connections ?? [];
    });
  }),
);

/** The phone's copy of the Settings › Mesh model, from the layout and its connected servers. */
export function useMeshOverview(input: { readonly config: SidebarWorkspacesConfig | null }): {
  readonly machines: ReadonlyArray<MeshMachine>;
  readonly connections: ReadonlyArray<MeshMachineConnection>;
  readonly links: ReadonlyArray<MeshLinkSource>;
} {
  const { environments } = useEnvironments();
  const connections = useMemo(
    () =>
      environments.map((environment): MeshMachineConnection => ({
        environmentId: environment.environmentId,
        label: environment.label,
        version: environment.serverConfig?.environment.serverVersion ?? null,
        connected: environment.connection.phase === "connected",
        ...(environment.displayUrl === null ? {} : { urls: [environment.displayUrl] }),
      })),
    [environments],
  );
  const linkSourceIds = environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        offersLinkedEnvironments(environment.serverConfig),
    )
    .map((environment) => environment.environmentId);
  const statusSourceIds = environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.meshLayout === true,
    )
    .map((environment) => environment.environmentId);
  const links = useAtomValue(
    peerLinksSourcesAtom(linkSourceIds.length === 0 ? NO_IDS : JSON.stringify(linkSourceIds)),
  );
  const peerStates = useAtomValue(
    peerStatesAtom(statusSourceIds.length === 0 ? NO_IDS : JSON.stringify(statusSourceIds)),
  );
  const peerConnections = useAtomValue(
    peerConnectionsAtom(statusSourceIds.length === 0 ? NO_IDS : JSON.stringify(statusSourceIds)),
  );
  const config = input.config;
  const machines = useMemo(
    () =>
      buildMeshMachines({
        config: config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
        connections,
        links,
        peerStates,
        peerConnections,
      }),
    [config, connections, links, peerStates, peerConnections],
  );
  return { machines, connections, links };
}
