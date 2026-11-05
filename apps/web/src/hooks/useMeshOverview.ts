import { useMeshLayout } from "./useMeshLayout";
import * as Cause from "effect/Cause";
import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  buildMeshMachines,
  meshMachineFactTimes,
  type MeshLinkSource,
  type MeshMachine,
  type MeshMachineConnection,
  type MeshPeerStateView,
} from "@t3tools/client-runtime/state/mesh-machines";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  EnvironmentId,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";

import { useEnvironments } from "../state/environments";
import { meshLayoutAtoms } from "../state/meshLayout";
import { peerLinkEnvironment } from "../state/peerLinks";

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
                lastReachedAt: link.lastReachedAt === null ? null : String(link.lastReachedAt),
                lastError: link.lastError,
              })),
            },
          ];
    });
  }).pipe(Atom.withLabel(`web:mesh:peer-links:${key}`)),
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
  }).pipe(Atom.withLabel(`web:mesh:peer-states:${key}`)),
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

/**
 * T3 Mesh (fork): the machines Settings › Mesh and the sidebar footer show, from the replicated
 * layout plus every connected server's links and replication state.
 */
export function useMeshOverview(input: { readonly config: SidebarWorkspacesConfig | null }): {
  readonly machines: ReadonlyArray<MeshMachine>;
  readonly connections: ReadonlyArray<MeshMachineConnection>;
  readonly links: ReadonlyArray<MeshLinkSource>;
} {
  const mesh = useMeshLayout();
  const { environments } = useEnvironments();
  const connections = environments.map((environment): MeshMachineConnection => ({
    environmentId: environment.serverConfig?.environment.environmentId ?? environment.environmentId,
    label: environment.label,
    version: environment.serverConfig?.environment.serverVersion ?? null,
    ...(environment.serverConfig?.environment.platform
      ? { platform: environment.serverConfig.environment.platform }
      : {}),
    connected: environment.connection.phase === "connected",
    ...(environment.displayUrl === null ? {} : { urls: [environment.displayUrl] }),
  }));
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
  const rawLinks = useAtomValue(
    peerLinksSourcesAtom(linkSourceIds.length === 0 ? NO_IDS : JSON.stringify(linkSourceIds)),
  );
  const links = rawLinks.map((source) => ({
    ...source,
    environmentId:
      environments.find((environment) => environment.environmentId === source.environmentId)
        ?.serverConfig?.environment.environmentId ?? source.environmentId,
  }));
  const peerStates = useAtomValue(
    peerStatesAtom(statusSourceIds.length === 0 ? NO_IDS : JSON.stringify(statusSourceIds)),
  );
  const peerConnections = useAtomValue(
    peerConnectionsAtom(statusSourceIds.length === 0 ? NO_IDS : JSON.stringify(statusSourceIds)),
  );
  const config = input.config;
  const machines = buildMeshMachines({
    config: config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    connections,
    links,
    peerStates,
    peerConnections,
    factsObservedAt: meshMachineFactTimes(mesh.state?.snapshot?.document ?? {}),
  });
  return { machines, connections, links };
}
