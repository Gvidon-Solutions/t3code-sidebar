import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { MeshConfigError, type MeshConfigDocument } from "@t3tools/contracts";
import { configFromLayout, bindingsFromLayout } from "@t3tools/shared/meshConfig";
import type { Json } from "@t3tools/shared/meshLayout";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import { ProcessRunner } from "../processRunner.ts";
import { ServerConfig } from "../config.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import {
  platformRemoteCommand,
  bootstrapUnixProbe,
  bootstrapWindowsProbe,
  bootstrapFacts,
  bootstrapAskpass,
  bootstrapRemoteRuntime,
} from "../platform/ServerPlatform.ts";
import { MeshRuntimeArchive } from "./MeshRuntimeArchive.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import packageJson from "../../package.json" with { type: "json" };

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

export function bootstrapTarget(ssh: string) {
  const match = /^([a-zA-Z0-9_.-]+)@(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9_.-]+)(?::([0-9]+))?$/.exec(ssh);
  if (!match) throw new Error("Bootstrap SSH must be user@host[:port], without a password");
  const port = Number(match[3] ?? 22);
  if (port < 1 || port > 65535) throw new Error("Invalid bootstrap SSH port");
  return { user: match[1]!, host: match[2]!, port, destination: `${match[1]}@${match[2]}` };
}
export interface BootstrapCredential {
  kind: "agent" | "key" | "password";
  value?: string;
}
export class MeshBootstrap extends Context.Service<
  MeshBootstrap,
  {
    readonly credential: (
      name: string,
      credential: BootstrapCredential,
    ) => Effect.Effect<void, MeshConfigError>;
    readonly reconcile: (
      name: string,
      doc: MeshConfigDocument,
    ) => Effect.Effect<void, MeshConfigError>;
  }
>()("t3/mesh/MeshBootstrap") {}
export const layer = Layer.effect(
  MeshBootstrap,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const env = yield* HostProcess.Environment;
    const clientPlatform = yield* HostProcess.Platform;
    const mesh = yield* MeshLayoutService;
    const links = yield* PeerLinks;
    const archive = yield* MeshRuntimeArchive;
    const credentials = new Map<string, { credential: BootstrapCredential; expiresAt: number }>();
    yield* Stream.fromSchedule(Schedule.spaced("1 minute")).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          for (const [name, entry] of credentials)
            if (entry.expiresAt <= now) {
              delete entry.credential.value;
              credentials.delete(name);
            }
        }),
      ),
      Effect.forkScoped,
    );
    const lock = yield* Semaphore.make(1);
    const report = Effect.fn("MeshBootstrap.report")(
      function* (name: string, step: string, state: string, reason?: string) {
        const h = yield* mesh.nextHlc;
        yield* mesh.apply({
          [`mesh.bootstrapStatus/${name}/${encodeURIComponent(mesh.environmentId)}/${step}`]: {
            h,
            v: {
              id: `bootstrap/${name}/${mesh.environmentId}/${step}`,
              machine: name,
              server: mesh.environmentId,
              description: `Bootstrap ${name}: ${step}`,
              state,
              ...(reason ? { reason } : {}),
            } as Json,
          },
        });
      },
      Effect.mapError(
        () =>
          new MeshConfigError({
            reason: "storage",
            message: "Cannot persist bootstrap step status",
          }),
      ),
    );
    const credential = Effect.fn("MeshBootstrap.credential")(
      function* (name: string, value: BootstrapCredential) {
        if ((value.kind === "key" || value.kind === "password") && !value.value)
          return yield* new MeshConfigError({
            reason: "validation",
            message: "A nonempty one-time credential is required",
          });
        const state = yield* mesh.read;
        if (
          bindingsFromLayout(state.document)[name] ||
          !configFromLayout(state.document)?.machines[name]?.bootstrap
        )
          return yield* new MeshConfigError({
            reason: "validation",
            message: "Credential requires an unjoined configured bootstrap machine",
          });
        const previous = credentials.get(name);
        if (previous) delete previous.credential.value;
        credentials.set(name, {
          credential: value,
          expiresAt: DateTime.toEpochMillis(yield* DateTime.now) + 5 * 60_000,
        });
        const h = yield* mesh.nextHlc;
        yield* mesh.apply({ [`mesh.bootstrapWake/${name}`]: { h, v: h } });
      },
      Effect.mapError((error) =>
        error._tag === "MeshConfigError"
          ? error
          : new MeshConfigError({
              reason: "storage",
              message: "Cannot schedule bootstrap credential",
            }),
      ),
    );
    const reconcile = Effect.fn("MeshBootstrap.reconcile")(
      function* (name: string, doc: MeshConfigDocument) {
        if (bindingsFromLayout((yield* mesh.read).document)[name]) return;
        const machine = doc.machines[name];
        const bootstrap = machine?.bootstrap;
        if (!machine || !bootstrap) return;
        const target = yield* Effect.try({
          try: () => bootstrapTarget(bootstrap.ssh),
          catch: () =>
            new MeshConfigError({ reason: "validation", message: "Invalid bootstrap SSH address" }),
        });
        const provided = credentials.get(name);
        const secret =
          provided && provided.expiresAt > DateTime.toEpochMillis(yield* DateTime.now)
            ? provided.credential
            : { kind: "agent" as const };
        credentials.delete(name);
        let phase = "connect";
        yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs.makeTempDirectoryScoped({
              directory: config.baseDir,
              prefix: "bootstrap-",
            });
            const askpassPlan = bootstrapAskpass(clientPlatform, directory);
            const askpass = path.join(directory, askpassPlan.name);
            if (secret.kind === "password") {
              if (askpassPlan.command) {
                const compiled = yield* runner.run({
                  ...askpassPlan.command,
                  timeout: "30 seconds",
                });
                if (compiled.code !== 0)
                  return yield* new MeshConfigError({
                    reason: "storage",
                    message: "Cannot prepare the native SSH password helper",
                  });
              } else yield* fs.writeFileString(askpass, askpassPlan.content);
              if (askpassPlan.mode !== undefined) yield* fs.chmod(askpass, askpassPlan.mode);
            }
            const knownHosts = path.join(config.baseDir, "mesh/bootstrap-known-hosts");
            yield* fs.makeDirectory(path.dirname(knownHosts), { recursive: true, mode: 0o700 });
            const ssh = Effect.fn("MeshBootstrap.ssh")(function* (command: string, stdin?: string) {
              const result = yield* runner.run({
                command: "ssh",
                args: [
                  "-o",
                  `BatchMode=${secret.kind === "password" ? "no" : "yes"}`,
                  "-o",
                  "NumberOfPasswordPrompts=1",
                  "-o",
                  "ConnectTimeout=10",
                  "-o",
                  "ServerAliveInterval=15",
                  "-o",
                  "ServerAliveCountMax=2",
                  "-o",
                  "StrictHostKeyChecking=accept-new",
                  "-o",
                  `UserKnownHostsFile=${knownHosts}`,
                  ...(secret.kind === "key" && secret.value
                    ? ["-i", secret.value, "-o", "IdentitiesOnly=yes"]
                    : []),
                  "-p",
                  String(target.port),
                  "--",
                  target.destination,
                  command,
                ],
                env: {
                  ...env,
                  ...(secret.kind === "password"
                    ? {
                        SSH_ASKPASS: askpass,
                        SSH_ASKPASS_REQUIRE: "force",
                        DISPLAY: "t3-bootstrap",
                        T3_BOOTSTRAP_PASSWORD: secret.value ?? "",
                      }
                    : {}),
                },
                ...(stdin !== undefined ? { stdin } : {}),
                timeout: "5 minutes",
                maxOutputBytes: 1024 * 1024,
              });
              if (result.code !== 0)
                return yield* new MeshConfigError({
                  reason: "storage",
                  message: /Permission denied/i.test(result.stderr)
                    ? "SSH authentication refused; provide a fresh one-time credential"
                    : /Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(result.stderr)
                      ? "Bootstrap SSH host key verification failed"
                      : `Bootstrap SSH command failed (exit ${result.code})`,
                });
              return result.stdout;
            });
            yield* report(name, phase, "in_progress");
            const windowsHint = bootstrap.os === "win32" || bootstrap.os === "windows";
            const detected = yield* ssh(
              windowsHint ? bootstrapWindowsProbe : bootstrapUnixProbe,
            ).pipe(Effect.result);
            const output =
              detected._tag === "Success" ? detected.success : yield* ssh(bootstrapWindowsProbe);
            yield* report(name, phase, "done");
            phase = "detect";
            yield* report(name, phase, "in_progress");
            const { platform, arch, home } = yield* Effect.try({
              try: () => bootstrapFacts(output, windowsHint || detected._tag === "Failure"),
              catch: () =>
                new MeshConfigError({
                  reason: "validation",
                  message: "Unsupported bootstrap OS, architecture or home",
                }),
            });
            yield* report(name, phase, "done");
            phase = "download";
            yield* report(name, phase, "in_progress");
            const version = doc.t3?.version ?? packageJson.version;
            const remote = bootstrapRemoteRuntime(
              platform,
              home,
              version,
              typeof bootstrap.baseDir === "string" ? bootstrap.baseDir : undefined,
            );
            const { baseDir, executable } = remote;
            const leaseToken = yield* mesh.nextHlc;
            yield* ssh(remote.acquire(leaseToken));
            yield* Effect.gen(function* () {
              const installed = yield* ssh(remote.installed);
              if (!installed.includes("installed")) {
                const bytes = yield* archive.download(version, platform, arch, (stage) =>
                  Effect.gen(function* () {
                    if (stage !== phase) yield* report(name, phase, "done");
                    phase = stage;
                    yield* report(name, phase, "in_progress");
                  }),
                );
                yield* ssh(remote.extract, Buffer.from(bytes).toString("base64"));
              }
              yield* report(name, phase, "done");
              phase = "verify";
              yield* report(name, phase, "in_progress");
              const runtimeVersion = yield* ssh(
                platformRemoteCommand(platform, [executable, "--version"]),
              );
              if (runtimeVersion.trim() !== `t3 v${version}`)
                return yield* new MeshConfigError({
                  reason: "validation",
                  message: "Downloaded runtime reports a different mesh version",
                });
              yield* report(name, phase, "done");
              phase = "service";
              yield* report(name, phase, "in_progress");
              const port = typeof bootstrap.port === "number" ? bootstrap.port : 3774;
              yield* ssh(
                platformRemoteCommand(platform, [
                  executable,
                  "__mesh-install",
                  Buffer.from(
                    yield* encodeJson({
                      baseDir,
                      version,
                      port,
                      ...(env.T3CODE_RELEASE_BASE_URL
                        ? { releaseBaseUrl: env.T3CODE_RELEASE_BASE_URL }
                        : {}),
                    }),
                  ).toString("base64"),
                ]),
              );
              yield* report(name, phase, "done");
              phase = "start";
              yield* report(name, phase, "in_progress");
              const output = yield* ssh(
                platformRemoteCommand(platform, [executable, "pair", "--base-dir", baseDir]),
              ).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }));
              yield* report(name, phase, "done");
              phase = "pair";
              yield* report(name, phase, "in_progress");
              const token = /^Token: (\S+)/m.exec(output)?.[1];
              if (!token)
                return yield* new MeshConfigError({
                  reason: "storage",
                  message: "Bootstrap pairing token was not returned",
                });
              const url =
                typeof machine.reach === "object" && typeof machine.reach.address === "string"
                  ? machine.reach.address
                  : `http://${target.host}:${port}`;
              const linked = yield* links.link({ url, pairingCode: token, access: "full-access" });
              yield* report(name, phase, "done");
              phase = "bind";
              yield* report(name, phase, "in_progress");
              const h = yield* mesh.nextHlc;
              yield* mesh.apply({
                [`mesh.machineBinding/${name}`]: { h, v: linked.environmentId },
                [`mesh.machineClaim/${encodeURIComponent(linked.environmentId)}`]: {
                  h,
                  v: { name, machine } as Json,
                },
                [`mesh.bootstrapOwner/${name}`]: { h, v: mesh.environmentId },
              });
              yield* report(name, phase, "done");
            }).pipe((effect) =>
              Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const result = yield* Effect.exit(restore(effect));
                  yield* ssh(remote.release(leaseToken));
                  if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
                  return result.value;
                }),
              ),
            );
          }),
        ).pipe(
          Effect.catch((error) =>
            report(
              name,
              phase,
              "failed",
              error._tag === "MeshConfigError" ? error.message : "Bootstrap step failed",
            ).pipe(Effect.andThen(Effect.fail(error))),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              delete secret.value;
            }),
          ),
        );
      },
      lock.withPermits(1),
      Effect.mapError((error) =>
        error._tag === "MeshConfigError"
          ? error
          : new MeshConfigError({ reason: "storage", message: "Bootstrap reconciliation failed" }),
      ),
    );
    return MeshBootstrap.of({ credential, reconcile });
  }),
);
