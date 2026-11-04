import { MeshSsh } from "../../replicas/MeshSsh.ts";
// @effect-diagnostics nodeBuiltinImport:off -- os.release reports the operating system build, absent from the platform references.
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { PeerConnectionStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { sshDirectory } from "./PeerPlatform.ts";
import packageJson from "../../../package.json" with { type: "json" };

export const PeerFacts = Schema.Struct({
  version: Schema.String,
  platform: Schema.Struct({ os: Schema.String, arch: Schema.String, release: Schema.String }),
  user: Schema.NullOr(Schema.String),
  meshPublicKey: Schema.optionalKey(Schema.String),
  connections: Schema.optionalKey(Schema.Array(PeerConnectionStatus)),
  sshd: Schema.NullOr(Schema.Struct({ port: Schema.Int, hostKeys: Schema.Array(Schema.String) })),
});
export type PeerFacts = typeof PeerFacts.Type;

export class PeerFactsReporter extends Context.Service<
  PeerFactsReporter,
  {
    readonly collect: Effect.Effect<PeerFacts>;
  }
>()("t3/peer/connection/PeerFacts/PeerFactsReporter") {}

export const collectPeerFacts = Effect.fn("PeerFacts.collect")(function* (
  options: { readonly sshDir?: string; readonly version?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const user = yield* HostProcess.Username;
  const directory = options.sshDir ?? sshDirectory(platform, environment);
  const read = Effect.fn("PeerFacts.readPublicFile")((path: string) =>
    fs
      .readFileString(path)
      .pipe(
        Effect.catch((error) =>
          (error.reason._tag === "NotFound"
            ? Effect.void
            : Effect.logWarning("System SSH fact could not be read", { path, error })
          ).pipe(Effect.as("")),
        ),
      ),
  );
  const names = yield* fs
    .readDirectory(directory)
    .pipe(
      Effect.catch((error) =>
        (error.reason._tag === "NotFound"
          ? Effect.void
          : Effect.logWarning("System SSH directory could not be read", { directory, error })
        ).pipe(Effect.as([] as readonly string[])),
      ),
    );
  const hostKeys = (yield* Effect.forEach(
    names.filter((name) => /^ssh_host_\S+_key\.pub$/.test(name)).sort(),
    (name) => read(NodePath.join(directory, name)),
  ))
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  const seen = new Set<string>();
  const readPort = Effect.fn("PeerFacts.readSshdPort")(function* (
    path: string,
  ): Effect.fn.Return<number | undefined> {
    if (seen.has(path) || seen.size >= 32) return undefined;
    seen.add(path);
    const config = yield* read(path);
    for (const line of config.split("\n")) {
      if (/^\s*Match\s/i.test(line)) break;
      const port = /^\s*Port\s+(\d+)\s*(?:#.*)?$/i.exec(line)?.[1];
      if (port && Number(port) > 0 && Number(port) <= 65_535) return Number(port);
      const include = /^\s*Include\s+([^#]*)/i.exec(line)?.[1];
      if (!include) continue;
      for (const token of include.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
        const pattern = token[1] ?? token[2] ?? token[3]!;
        const files = yield* Effect.tryPromise(async () => {
          const paths: string[] = [];
          for await (const included of NodeFSP.glob(NodePath.resolve(directory, pattern))) {
            paths.push(included);
            if (paths.length >= 256) break;
          }
          return paths.sort();
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("SSH config Include could not be read", { error }).pipe(
              Effect.as([] as string[]),
            ),
          ),
        );
        for (const included of files) {
          const value = yield* readPort(included);
          if (value !== undefined) return value;
        }
      }
    }
    return undefined;
  });
  const port = (yield* readPort(NodePath.join(directory, "sshd_config"))) ?? 22;
  return {
    version: options.version ?? packageJson.version,
    platform: { os: platform, arch: architecture, release: NodeOS.release() },
    user,
    sshd: hostKeys.length ? { port, hostKeys } : null,
  } satisfies PeerFacts;
});

export const layer = () =>
  Layer.effect(
    PeerFactsReporter,
    Effect.gen(function* () {
      const ssh = yield* MeshSsh;
      const collect = collectPeerFacts().pipe(
        Effect.map((facts) => ({ ...facts, meshPublicKey: ssh.publicKey })),
        Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
      );
      return { collect };
    }),
  );

export const layerOf = (facts: PeerFacts) =>
  Layer.succeed(PeerFactsReporter, { collect: Effect.succeed(facts) });
