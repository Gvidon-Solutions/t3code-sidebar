import { MeshConfigError, type MeshConfigDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ServerSettingsService } from "../serverSettings.ts";

const begin = "<!-- t3-mesh begin -->";
const end = "<!-- t3-mesh end -->";

/** Harnesses whose skill and instruction files the agent kit owns. */
const harnesses = [
  { binary: "claude", driver: "claudeAgent", home: ".claude", instruction: ".claude/CLAUDE.md" },
  { binary: "codex", driver: "codex", home: ".codex", instruction: ".codex/AGENTS.md" },
  {
    binary: "opencode",
    driver: "opencode",
    home: ".config/opencode",
    instruction: ".config/opencode/AGENTS.md",
  },
] as const;

/** A provider instance config is driver-shaped, so read only the absolute binary it names. */
function instanceBinaryPath(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null || !("binaryPath" in config)) return undefined;
  const binaryPath = (config as { binaryPath?: unknown }).binaryPath;
  return typeof binaryPath === "string" && binaryPath.trim() !== "" ? binaryPath : undefined;
}

const sharedSkill = ".agents/skills/t3";
const skillMarker = ".t3-managed";
const skillMarkerContents = "This directory is managed by T3 Code.\n";

/** A skill the retired kit wrote: our frontmatter name and our command layout. */
export function isRecognizablyT3Skill(skillText: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillText);
  return frontmatter !== null && /^name:\s*["']?t3["']?\s*$/m.test(frontmatter[1]!);
}

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

/** Removes only our managed block, leaving every other byte of an instruction file intact. */
export function withoutManagedBlock(original: string): string {
  const start = original.indexOf(begin);
  const stop = original.indexOf(end);
  if (start < 0 || stop < start) return original;
  const joined = original.slice(0, start) + original.slice(stop + end.length);
  return joined.trim() === "" ? "" : joined;
}

/**
 * The retired installer wrote the shared instructions verbatim; on first adoption that copy is
 * dropped so agents do not read them twice. Only a whole paragraph (or run of paragraphs) bounded
 * by the start/end of the file or blank lines is a candidate, so owner text is never edited
 * mid-line and an adjacent blockquote stays untouched.
 */
export function withoutLegacyInstructions(
  original: string,
  instructions: string | undefined,
): string {
  const text = instructions?.trim();
  if (!text) return original;
  // The managed block is the one-shot boundary: once it exists, legacy text is owner history.
  if (original.includes(begin) || original.includes(end)) return original;
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\r?\n/g, "\\r?\\n");
  const paragraph = new RegExp(
    `(?:^|\\r?\\n[ \\t]*\\r?\\n)${escaped}(?=\\r?\\n[ \\t]*\\r?\\n|(?:\\r?\\n)?$)`,
  );
  const match = paragraph.exec(original);
  if (!match) return original;
  const start = match.index;
  const matchEnd = start + match[0].length;
  let head = original.slice(0, start);
  let rest = original.slice(matchEnd);
  if (start === 0) {
    rest = rest.replace(/^\r?\n[ \t]*\r?\n/, "");
    if (rest === "\n" || rest === "\r\n") rest = "";
  }
  if (head.trim() === "") head = "";
  const kept = `${head}${rest}`;
  return kept.trim() === "" ? "" : kept;
}

export function meshInstructions(
  doc: MeshConfigDocument,
  local?: { readonly title: string; readonly label: string },
) {
  const machines = Object.entries(doc.machines)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, machine]) => `${name}${machine.label ? ` (${machine.label})` : ""}`);
  return [
    ...(local ? [`This machine: ${local.title} (${local.label}).`] : []),
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
    readonly reconcile: (
      doc: MeshConfigDocument,
      local?: { readonly title: string; readonly label: string },
    ) => Effect.Effect<void, MeshConfigError>;
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
    const resolveExecutable = yield* SpawnExecutableResolution;
    const settings = yield* ServerSettingsService;
    const packaged = path.join(path.dirname(executable), "agent-kit/skills/t3");
    const source =
      env.T3_MESH_AGENT_SOURCE ??
      (yield* Effect.gen(function* () {
        if (yield* fs.exists(packaged)) return packaged;
        const bundled = yield* path.fromFileUrl(new URL("./agent-kit/skills/t3", import.meta.url));
        if (yield* fs.exists(bundled)) return bundled;
        return yield* path.fromFileUrl(new URL("../../../../agent-kit/skills/t3", import.meta.url));
      }));
    const skillFileName = (name: string) =>
      name === "global" || name === "node_modules" || name.endsWith(".test.mjs");
    const listSkillFiles = Effect.fn("MeshAgentKit.listSkillFiles")(function* (
      from: string,
      relative = "",
    ): Effect.fn.Return<ReadonlyArray<string>, import("effect/PlatformError").PlatformError> {
      const files: string[] = [];
      for (const entry of yield* fs.readDirectoryEntries(from)) {
        if (skillFileName(entry.name)) continue;
        const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.type === "Directory")
          files.push(...(yield* listSkillFiles(path.join(from, entry.name), childRelative)));
        else if (entry.type === "File") files.push(childRelative);
      }
      return files;
    });
    const listExisting = Effect.fn("MeshAgentKit.listExisting")(function* (
      directory: string,
      relative = "",
    ): Effect.fn.Return<
      ReadonlyArray<{ readonly relative: string; readonly type: string }>,
      import("effect/PlatformError").PlatformError
    > {
      const entries: { relative: string; type: string }[] = [];
      for (const entry of yield* fs.readDirectoryEntries(directory)) {
        const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
        entries.push({ relative: childRelative, type: entry.type });
        if (entry.type === "Directory")
          entries.push(...(yield* listExisting(path.join(directory, entry.name), childRelative)));
      }
      return entries;
    });
    const conflictText = (target: string) => `${target} is not a T3-managed t3 skill`;
    // The retired kit wrote the same files without a marker. Adopt only that exact layout;
    // anything else in the directory belongs to somebody else.
    const adoptableSkill = Effect.fn("MeshAgentKit.adoptableSkill")(function* (directory: string) {
      const skill = yield* fs.lstat(path.join(directory, "SKILL.md")).pipe(Effect.option);
      const control = yield* fs
        .lstat(path.join(directory, "scripts/t3ctl.mjs"))
        .pipe(Effect.option);
      if (Option.isNone(skill) || skill.value.type !== "File") return false;
      if (Option.isNone(control) || control.value.type !== "File") return false;
      return isRecognizablyT3Skill(yield* fs.readFileString(path.join(directory, "SKILL.md")));
    });
    const syncSkill = Effect.fn("MeshAgentKit.syncSkill")(function* (
      from: string,
      to: string,
      conflicts: string[],
    ): Effect.fn.Return<void, import("effect/PlatformError").PlatformError> {
      const existing = yield* fs.lstat(to).pipe(Effect.option);
      if (Option.isSome(existing)) {
        if (existing.value.type !== "Directory") {
          conflicts.push(conflictText(to));
          return;
        }
        const marker = yield* fs.lstat(path.join(to, skillMarker)).pipe(Effect.option);
        if (Option.isNone(marker) || marker.value.type !== "File") {
          if (!(yield* adoptableSkill(to))) {
            conflicts.push(conflictText(to));
            return;
          }
          yield* fs.writeFileString(path.join(to, skillMarker), skillMarkerContents);
        }
      } else {
        yield* fs.makeDirectory(to, { recursive: true });
        yield* fs.writeFileString(path.join(to, skillMarker), skillMarkerContents);
      }
      const desired = new Set(yield* listSkillFiles(from));
      const desiredDirectories = new Set<string>();
      for (const relative of desired) {
        const segments = relative.split("/");
        for (let index = 1; index < segments.length; index++)
          desiredDirectories.add(segments.slice(0, index).join("/"));
      }
      const entries = [...(yield* listExisting(to))].sort((left, right) =>
        right.relative.localeCompare(left.relative),
      );
      for (const entry of entries) {
        if (entry.relative === skillMarker) continue;
        const target = path.join(to, entry.relative);
        if (entry.type === "Directory")
          if (!desiredDirectories.has(entry.relative))
            yield* fs.remove(target, { recursive: true });
        if (
          (entry.type === "File" || entry.type === "SymbolicLink") &&
          !desired.has(entry.relative)
        )
          yield* fs.remove(target);
      }
      for (const relative of desired) {
        const target = path.join(to, relative);
        let symlinked = false;
        const segments = relative.split("/");
        let ancestor = to;
        for (let index = 0; index < segments.length - 1; index++) {
          ancestor = path.join(ancestor, segments[index]!);
          const info = yield* fs.lstat(ancestor).pipe(Effect.option);
          if (Option.isSome(info) && info.value.type === "SymbolicLink") {
            conflicts.push(`${ancestor} is a symbolic link`);
            symlinked = true;
            break;
          }
        }
        if (symlinked) continue;
        const info = yield* fs.lstat(target).pipe(Effect.option);
        if (Option.isSome(info) && info.value.type !== "File") {
          conflicts.push(`${target} is a symbolic link or not a file`);
          continue;
        }
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.copyFile(path.join(from, relative), target);
      }
    });
    const reconcile = Effect.fn("MeshAgentKit.reconcile")(
      function* (
        doc: MeshConfigDocument,
        local?: { readonly title: string; readonly label: string },
      ) {
        if (!(yield* fs.exists(path.join(source, "SKILL.md"))))
          return yield* new MeshConfigError({
            reason: "storage",
            message: "Bundled t3 skill is missing",
          });
        const conflicts: string[] = [];
        const shared = path.join(home, sharedSkill);
        yield* syncSkill(source, shared, conflicts);

        const current = yield* settings.getSettings.pipe(
          Effect.mapError(
            (error) =>
              new MeshConfigError({
                reason: "storage",
                message: `Cannot read provider settings for the agent kit: ${error.message}`,
              }),
          ),
        );
        const providerBinaryExists = Effect.fn("MeshAgentKit.providerBinaryExists")(function* (
          harness: (typeof harnesses)[number],
        ) {
          for (const instance of Object.values(current.providerInstances)) {
            if (instance.driver !== harness.driver) continue;
            const binaryPath = instanceBinaryPath(instance.config);
            if (binaryPath === undefined) continue;
            const resolved = resolveExecutable(binaryPath, platform, env) ?? binaryPath;
            if (yield* fs.exists(resolved)) return true;
          }
          return false;
        });
        const installed = new Map<(typeof harnesses)[number], boolean>();
        for (const harness of harnesses) {
          installed.set(
            harness,
            resolveExecutable(harness.binary, platform, env) !== undefined ||
              (yield* providerBinaryExists(harness)) ||
              (yield* fs.exists(path.join(home, harness.home))),
          );
        }

        // Skill directories follow installed harnesses; an unmanaged directory is never replaced.
        for (const harness of harnesses) {
          const destination = path.join(home, harness.home, "skills/t3");
          if (installed.get(harness)) {
            yield* syncSkill(source, destination, conflicts);
            continue;
          }
          const existing = yield* fs.lstat(destination).pipe(Effect.option);
          if (Option.isNone(existing)) continue;
          if (existing.value.type !== "Directory") {
            conflicts.push(`Agent kit left existing files unchanged: ${conflictText(destination)}`);
            continue;
          }
          const marker = yield* fs.lstat(path.join(destination, skillMarker)).pipe(Effect.option);
          if (Option.isNone(marker) || marker.value.type !== "File") {
            conflicts.push(`Agent kit left existing files unchanged: ${conflictText(destination)}`);
            continue;
          }
          yield* fs.remove(destination, { recursive: true });
        }
        if (doc.agents?.manageInstructions === false) {
          if (conflicts.length > 0)
            return yield* new MeshConfigError({
              reason: "validation",
              message: `Agent kit left existing files unchanged: ${conflicts.join("; ")}`,
            });
          return;
        }
        const body = meshInstructions(doc, local);
        // Validate all files before changing any instruction file.
        const writes = yield* Effect.forEach(harnesses, (harness) =>
          Effect.gen(function* () {
            const filePath = path.join(home, harness.instruction);
            const info = yield* fs.lstat(filePath).pipe(Effect.option);
            if (Option.isSome(info) && info.value.type !== "File") {
              conflicts.push(
                info.value.type === "SymbolicLink"
                  ? `${filePath} is a symbolic link`
                  : `${filePath} is not a regular file`,
              );
              return undefined;
            }
            const original = Option.isSome(info) ? yield* fs.readFileString(filePath) : "";
            if (!installed.get(harness)) {
              const contents = withoutManagedBlock(original);
              return { filePath, original, contents };
            }
            const contents = yield* Effect.try({
              try: () =>
                instructionBlock(
                  withoutLegacyInstructions(original, doc.agents?.instructions),
                  body,
                ),
              catch: () =>
                new MeshConfigError({
                  reason: "validation",
                  message: `Invalid managed instruction markers in ${harness.instruction}`,
                }),
            });
            return { filePath, original, contents };
          }),
        );
        for (const write of writes) {
          if (write === undefined) continue;
          const { filePath, original, contents } = write;
          if (original === contents) continue;
          if (contents === "") {
            yield* fs.remove(filePath);
            continue;
          }
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* writeFileStringAtomically({ filePath, contents }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
        }
        if (conflicts.length > 0)
          return yield* new MeshConfigError({
            reason: "validation",
            message: `Agent kit left existing files unchanged: ${conflicts.join("; ")}`,
          });
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
