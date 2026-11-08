import {
  sshWrapper,
  sshDirectory,
  authorizedKeysLocations,
  windowsSshWrapperInstall,
} from "../platform/ServerPlatform.ts";
import {
  MeshConfigError,
  type MeshConfigDocument,
  type SidebarMachineReported,
} from "@t3tools/contracts";
import {
  bindingsFromLayout,
  effectiveLinkPermissions,
  resolveSshHost,
} from "@t3tools/shared/meshConfig";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Semaphore from "effect/Semaphore";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import { managedBlock, routeFailure, sshFiles } from "./sshBlocks.ts";

export class MeshSsh extends Context.Service<
  MeshSsh,
  {
    readonly publicKey: string;
    readonly reconcile: (
      doc: MeshConfigDocument,
      machine?: string,
    ) => Effect.Effect<void, MeshConfigError>;
  }
>()("t3/replicas/MeshSsh") {}

const isMeshConfigError = Schema.is(MeshConfigError);
type SshRoutes = NonNullable<SidebarMachineReported["sshRoutes"]>;

export const layer = Layer.effect(
  MeshSsh,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    const runner = yield* ProcessRunner.ProcessRunner;
    const mesh = yield* MeshLayoutService;
    const blockLock = yield* Semaphore.make(1);
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const directory = path.join(baseDir, "mesh", "ssh");
    const sshHome = env.T3_MESH_SSH_HOME ?? home;
    const sshDir = path.join(sshHome, ".ssh");
    const identity = path.join(directory, "id_ed25519");
    const knownHosts = path.join(directory, "known_hosts");
    const configFile = path.join(sshDir, "config");
    const sshdConfigFile = path.join(
      env.T3_MESH_SSHD_DIR ?? sshDirectory(platform, env),
      "sshd_config",
    );
    const sshdConfig = (yield* fs.exists(sshdConfigFile))
      ? yield* fs.readFileString(sshdConfigFile)
      : "";
    const authorizedFiles = authorizedKeysLocations(platform, sshHome, env, sshdConfig);
    const mapError = (cause: unknown) =>
      new MeshConfigError({
        reason: "storage",
        message: `Managed SSH operation failed: ${String(cause)}`,
      });
    const prepare = Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      if (!(yield* fs.exists(identity))) {
        const result = yield* runner.run({
          command: "ssh-keygen",
          args: ["-q", "-t", "ed25519", "-N", "", "-f", identity],
          timeout: "10 seconds",
        });
        if (result.code !== 0)
          return yield* new MeshConfigError({
            reason: "storage",
            message: "Mesh SSH key generation failed",
          });
      }
      yield* fs.chmod(identity, 0o600);
      return (yield* fs.readFileString(`${identity}.pub`)).trim();
    });
    const publicKey = yield* prepare.pipe(Effect.mapError(mapError));
    if (env.T3_MESH_SSH_HOME || platform === "win32") {
      const bin = path.join(directory, "bin");
      yield* fs.makeDirectory(bin, { recursive: true, mode: 0o700 });
      if (platform === "win32") {
        for (const command of windowsSshWrapperInstall(bin, configFile)) {
          const output = yield* runner.run({ ...command, timeout: "30 seconds" });
          if (output.code !== 0)
            return yield* new MeshConfigError({
              reason: "storage",
              message: "Windows managed SSH transport compilation failed",
            });
        }
      } else
        for (const program of ["ssh", "scp"] as const) {
          const wrapper = sshWrapper(platform, process.execPath, configFile, program);
          yield* fs.writeFileString(path.join(bin, wrapper.name), wrapper.contents);
          yield* fs.chmod(path.join(bin, wrapper.name), 0o700);
        }
    }
    const write = Effect.fn("MeshSsh.write")(function* (
      filePath: string,
      lines: readonly string[],
    ) {
      if (!(yield* fs.exists(sshDir)))
        yield* fs.makeDirectory(sshDir, { recursive: true, mode: 0o700 });
      const original = (yield* fs.exists(filePath)) ? yield* fs.readFileString(filePath) : "";
      const contents = yield* Effect.try(() => managedBlock(original, lines));
      if (contents !== original) {
        yield* writeFileStringAtomically({ filePath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        yield* fs.chmod(filePath, 0o600);
      }
    });
    const publishRoutes = Effect.fn("MeshSsh.publishRoutes")(function* (
      update: (routes: SshRoutes, checkedAt: string) => SshRoutes,
    ) {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* mesh.edit((current) => {
        const local = current.machines[mesh.environmentId];
        if (!local?.reported) return current;
        const sshRoutes = update(local.reported.sshRoutes ?? {}, checkedAt);
        if (JSON.stringify(sshRoutes) === JSON.stringify(local.reported.sshRoutes)) return current;
        return {
          ...current,
          machines: {
            ...current.machines,
            [mesh.environmentId]: {
              ...local,
              reported: { ...local.reported, sshRoutes, reportedAt: checkedAt },
            },
          },
        };
      });
      if (!result.config.machines[mesh.environmentId]?.reported)
        return yield* new MeshConfigError({
          reason: "storage",
          message: "Local machine facts are unavailable; cannot publish SSH route checks",
        });
    });
    return MeshSsh.of({
      publicKey,
      reconcile: Effect.fn("MeshSsh.reconcile")(
        function* (doc, machine) {
          const state = yield* mesh.read;
          const bindings = bindingsFromLayout(state.document);
          const self = Object.keys(bindings).find((name) => bindings[name] === mesh.environmentId);
          if (!self)
            return yield* new MeshConfigError({
              reason: "validation",
              message: "Local machine is not bound",
            });
          // Relayed peers authenticate with their own SSH keys after the pipe crosses a linked neighbor.
          const peers = Object.entries(bindings).flatMap(([name, environmentId]) => {
            const facts = state.config.machines[environmentId];
            const settings = doc.machines[name];
            return name !== self &&
              facts &&
              settings &&
              effectiveLinkPermissions(doc, self, name).replicas
              ? [{ name, environmentId, facts, settings }]
              : [];
          });
          const mode = doc.ssh?.mode ?? "managed";
          const targets = Object.entries(bindings).filter(
            ([name]) => name !== self && doc.machines[name] !== undefined,
          );
          if (targets.length || state.config.machines[mesh.environmentId]?.reported?.sshRoutes)
            yield* publishRoutes((previous, checkedAt) =>
              Object.fromEntries(
                targets.map(([name, environmentId]) => {
                  const reason =
                    mode === "off"
                      ? "SSH is off; cross-machine replicas are disabled"
                      : !effectiveLinkPermissions(doc, self, name).replicas
                        ? "Replica permission is disabled"
                        : !state.config.machines[environmentId]
                          ? "Peer facts are unavailable"
                          : "SSH route has not been checked";
                  const prior = previous[environmentId];
                  const route =
                    reason === "SSH route has not been checked" && prior?.status !== "unknown"
                      ? prior
                      : prior?.status === "unknown" && prior.reason === reason
                        ? prior
                        : undefined;
                  return [
                    environmentId,
                    route ?? { status: "unknown" as const, reason, checkedAt },
                  ];
                }),
              ),
            );
          yield* blockLock.withPermit(
            Effect.gen(function* () {
              const files = yield* Effect.try(() =>
                sshFiles(peers, {
                  platform,
                  baseDir,
                  identity,
                  knownHosts,
                  runtime:
                    process.argv[1]?.endsWith(".ts") || process.argv[1]?.endsWith(".mjs")
                      ? [process.execPath, path.resolve(process.argv[1])]
                      : [process.execPath],
                }),
              );
              yield* write(configFile, mode === "managed" ? files.config : []);
              for (const file of authorizedFiles)
                yield* write(file, mode === "managed" ? files.authorized : []);
              yield* write(knownHosts, mode === "managed" ? files.known : []);
            }),
          );
          if (!machine) return;
          if (mode === "off")
            return yield* new MeshConfigError({
              reason: "validation",
              message: "SSH is off; cross-machine replicas are disabled",
            });
          const peer = peers.find((peer) => peer.name === machine);
          if (!peer)
            return yield* new MeshConfigError({
              reason: "validation",
              message: "Replica permission is disabled or peer facts are unavailable",
            });
          const check = Effect.gen(function* () {
            if (mode === "managed" && !peer.facts.reported?.sshd)
              return yield* new MeshConfigError({ reason: "storage", message: "no sshd" });
            const host = mode === "existing" ? peer.settings.ssh?.host : `t3-${machine}`;
            const validatedHost = yield* Effect.try({
              try: () => resolveSshHost(host),
              catch: (cause) =>
                new MeshConfigError({ reason: "validation", message: String(cause) }),
            });
            const result = yield* runner.run({
              command: "ssh",
              args: [
                ...(mode === "managed" || env.T3_MESH_SSH_HOME ? ["-F", configFile] : []),
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "--",
                validatedHost,
                "true",
              ],
              timeout: "15 seconds",
              timeoutBehavior: "timedOutResult",
            });
            if (result.code !== 0)
              return yield* new MeshConfigError({
                reason: "storage",
                message: routeFailure(result.stderr, result.timedOut),
              });
          }).pipe(Effect.mapError((cause) => (isMeshConfigError(cause) ? cause : mapError(cause))));
          yield* check.pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                publishRoutes((previous, checkedAt) => ({
                  ...previous,
                  [peer.environmentId]: { status: "failed", reason: error.message, checkedAt },
                })).pipe(Effect.andThen(Effect.fail(error))),
              onSuccess: () =>
                publishRoutes((previous, checkedAt) => ({
                  ...previous,
                  [peer.environmentId]: { status: "ok", checkedAt },
                })),
            }),
          );
        },
        Effect.mapError((cause) => (isMeshConfigError(cause) ? cause : mapError(cause))),
      ),
    });
  }),
);
