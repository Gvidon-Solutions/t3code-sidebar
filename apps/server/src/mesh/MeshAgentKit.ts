import { agentSkillDirectories } from "../platform/ServerPlatform.ts";
import { MeshConfigError, type MeshConfigDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

const begin = "<!-- t3-mesh begin -->";
const end = "<!-- t3-mesh end -->";
const files = [".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md"];

export function instructionBlock(original: string, body: string) {
  if (body.includes(begin) || body.includes(end))
    throw new Error("Managed instruction body contains reserved markers");
  const start = original.indexOf(begin);
  const stop = original.indexOf(end);
  if (
    start < 0 !== stop < 0 ||
    (start >= 0 &&
      (stop < start ||
        original.indexOf(begin, start + begin.length) >= 0 ||
        original.indexOf(end, stop + end.length) >= 0))
  )
    throw new Error("Malformed t3-mesh instruction block");
  const block = `${begin}\n${body}\n${end}`;
  return start < 0
    ? `${original}${original && !original.endsWith("\n") ? "\n" : ""}${block}\n`
    : original.slice(0, start) + block + original.slice(stop + end.length);
}

/**
 * The retired installer wrote a "> ..." header plus the shared instructions verbatim; on first
 * adoption that copy is dropped so agents do not read it twice. Owner text outside it stays.
 */
export function withoutLegacyInstructions(original: string, instructions: string | undefined) {
  const text = instructions?.trim();
  if (!text || original.includes(begin) || original.includes(end)) return original;
  const at = original.indexOf(text);
  if (at < 0) return original;
  const head = original.slice(0, at).replace(/(^|\n)> [^\n]*\n[ \t]*\n?[ \t\r]*$/, "$1");
  const rest = original.slice(at + text.length).replace(/^[\r\n]+/, "");
  const kept =
    head.trim() === "" ? rest : rest === "" ? head : `${head.replace(/\s*$/, "\n\n")}${rest}`;
  return kept.trim() === "" ? "" : kept;
}

function meshInstructions(doc: MeshConfigDocument) {
  const machines = Object.entries(doc.machines)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, machine]) => `${name}${machine.label ? ` (${machine.label})` : ""}`);
  return [
    `Mesh machines: ${machines.join(", ") || "none configured"}.`,
    "Read ~/.agents/skills/t3/SKILL.md before operating the mesh.",
    "Projects have primary and replica representations. In a lite replica, run builds, tests, git and dependency tools with t3 run -- <command>; the environment stays on the primary.",
    ...(doc.agents?.instructions ? [doc.agents.instructions] : []),
  ].join("\n\n");
}

export class MeshAgentKit extends Context.Service<
  MeshAgentKit,
  {
    readonly legacyInstructions: Effect.Effect<string | undefined, MeshConfigError>;
    readonly reconcile: (doc: MeshConfigDocument) => Effect.Effect<void, MeshConfigError>;
  }
>()("t3/mesh/MeshAgentKit") {}

export const layer = Layer.effect(
  MeshAgentKit,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = yield* HostProcess.Environment;
    const home = env.T3_MESH_AGENT_HOME ?? (yield* HostProcess.HomeDirectory);
    const executable = yield* HostProcess.ExecutablePath;
    const platform = yield* HostProcess.Platform;
    const packaged = path.join(path.dirname(executable), "agent-kit/skills/t3");
    const source =
      env.T3_MESH_AGENT_SOURCE ??
      (yield* Effect.gen(function* () {
        if (yield* fs.exists(packaged)) return packaged;
        const bundled = yield* path.fromFileUrl(new URL("./agent-kit/skills/t3", import.meta.url));
        if (yield* fs.exists(bundled)) return bundled;
        return yield* path.fromFileUrl(new URL("../../../../agent-kit/skills/t3", import.meta.url));
      }));
    const copySkill = Effect.fn("MeshAgentKit.copySkill")(function* (
      from: string,
      to: string,
    ): Effect.fn.Return<void, import("effect/PlatformError").PlatformError> {
      yield* fs.makeDirectory(to, { recursive: true });
      for (const entry of yield* fs.readDirectory(from)) {
        if (entry === "global" || entry === "node_modules" || entry.endsWith(".test.mjs")) continue;
        const sourcePath = path.join(from, entry);
        const targetPath = path.join(to, entry);
        if ((yield* fs.stat(sourcePath)).type === "Directory")
          yield* copySkill(sourcePath, targetPath);
        else yield* fs.copyFile(sourcePath, targetPath);
      }
    });
    const reconcile = Effect.fn("MeshAgentKit.reconcile")(
      function* (doc: MeshConfigDocument) {
        if (!(yield* fs.exists(path.join(source, "SKILL.md"))))
          return yield* new MeshConfigError({
            reason: "storage",
            message: "Bundled t3 skill is missing",
          });
        for (const destination of agentSkillDirectories(home, platform)) {
          yield* fs.makeDirectory(destination, { recursive: true });
          yield* copySkill(source, destination);
        }
        if (doc.agents?.manageInstructions === false) return;
        const body = meshInstructions(doc);
        // Validate all files before changing any instruction file.
        const writes = yield* Effect.forEach(files, (file) =>
          Effect.gen(function* () {
            const filePath = path.join(home, file);
            const original = (yield* fs.exists(filePath)) ? yield* fs.readFileString(filePath) : "";
            const contents = yield* Effect.try({
              try: () =>
                instructionBlock(
                  withoutLegacyInstructions(original, doc.agents?.instructions),
                  body,
                ),
              catch: () =>
                new MeshConfigError({
                  reason: "validation",
                  message: `Invalid managed instruction markers in ${file}`,
                }),
            });
            return { filePath, original, contents };
          }),
        );
        for (const { filePath, original, contents } of writes) {
          if (original === contents) continue;
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* writeFileStringAtomically({ filePath, contents }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
        }
      },
      Effect.mapError((error) =>
        error._tag === "MeshConfigError"
          ? error
          : new MeshConfigError({
              reason: "storage",
              message: `Agent kit installation failed: ${error.message}`,
            }),
      ),
    );
    const legacyFile =
      env.T3_MESH_LEGACY_GLOBAL ?? path.join(home, ".agents/skills/t3/global/GLOBAL.md");
    const legacyInstructions = Effect.gen(function* () {
      return (yield* fs.exists(legacyFile)) ? yield* fs.readFileString(legacyFile) : undefined;
    }).pipe(
      Effect.mapError(
        () =>
          new MeshConfigError({
            reason: "storage",
            message: "Cannot read installed legacy agent instructions",
          }),
      ),
    );
    return MeshAgentKit.of({ reconcile, legacyInstructions });
  }),
);
