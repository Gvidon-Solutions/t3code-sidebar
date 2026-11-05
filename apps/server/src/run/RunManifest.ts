// @effect-diagnostics nodeBuiltinImport:off -- Managed launcher files and an atomic manifest are consumed by the standalone command shims.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { bindingsFromLayout, configFromLayout } from "@t3tools/shared/meshConfig";
import { forkParked } from "../serverActivation.ts";
import type { MeshLayoutSnapshot } from "../mesh/MeshLayoutService.ts";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import { ServerConfig } from "../config.ts";
import { DEFAULT_REMOTE_COMMANDS, encodeManifest } from "./RunProtocol.ts";
import { shellWord } from "./RunPlatform.ts";
class RunManifestError extends Schema.TaggedError<RunManifestError>()("RunManifestError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Could not update replica command shims.";
  }
}
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const mesh = yield* MeshLayoutService;
    const config = yield* ServerConfig;
    const platform = yield* HostProcess.Platform;
    const directory = NodePath.join(config.baseDir, "run");
    const shims = NodePath.join(directory, "shims");
    const write = Effect.fn("RunManifest.write")(function* (snapshot: MeshLayoutSnapshot) {
      const doc = configFromLayout(snapshot.document);
      const commands = doc?.replicas?.remoteCommands ?? DEFAULT_REMOTE_COMMANDS;
      const bindings = bindingsFromLayout(snapshot.document);
      const representations = Object.entries(snapshot.config.projectMounts).flatMap(([key, reps]) =>
        reps
          .filter((rep) => rep.environmentId === mesh.environmentId)
          .map((rep) => ({
            root: rep.path,
            lite: rep.role === "replica" && rep.mode !== "full",
            title: snapshot.config.projectTitles[key] || "Untitled project",
            machine:
              Object.keys(bindings).find((name) => bindings[name] === rep.source) ??
              "the primary machine",
          })),
      );
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(shims, { recursive: true, mode: 0o700 });
          for (const entry of await NodeFSP.readdir(shims))
            if (!commands.some((name) => entry === name || entry === `${name}.cmd`))
              await NodeFSP.unlink(NodePath.join(shims, entry));
          for (const name of commands) {
            await NodeFSP.writeFile(
              NodePath.join(shims, name),
              `#!/bin/sh\nexec ${shellWord(NodePath.join(directory, "bin", "t3"))} __replica-command ${shellWord(name)} "$@"\n`,
              { mode: 0o700 },
            );
            if (platform === "win32")
              await NodeFSP.writeFile(
                NodePath.join(shims, `${name}.cmd`),
                `@echo off\r\n"${NodePath.join(directory, "bin", "t3.cmd")}" __replica-command ${name} %*\r\n`,
              );
          }
          const temporary = NodePath.join(directory, `${NodeCrypto.randomUUID()}.json`);
          await NodeFSP.writeFile(temporary, encodeManifest({ representations, commands }), {
            mode: 0o600,
          });
          await NodeFSP.rename(temporary, NodePath.join(directory, "manifest.json"));
        },
        catch: (cause) => new RunManifestError({ cause }),
      });
    });
    yield* write(yield* mesh.read);
    yield* forkParked(
      mesh.changes.pipe(
        Stream.runForEach((snapshot) =>
          write(snapshot).pipe(
            Effect.catch((cause) => Effect.logError("Replica shims update failed", cause)),
          ),
        ),
      ),
    );
  }),
);
