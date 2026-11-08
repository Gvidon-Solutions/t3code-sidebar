import { linkedTestDocument } from "../../testFixtures/MeshLayoutTestLayer.ts";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  EnvironmentId,
  type FilesError,
  type FilesReadResult,
  type FilesListResult,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
// @effect-diagnostics nodeBuiltinImport:off - sparse files make the hard size limit cheap to test.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as FilesService from "./FilesService.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(FilesService.layer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-files-service-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-files-" });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  directory: string,
  name: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem.writeFileString(path.join(directory, name), contents).pipe(Effect.orDie);
});

const reasonOf = (error: unknown) =>
  typeof error === "object" && error !== null && "reason" in error
    ? (error as { reason: string }).reason
    : undefined;

it.layer(layerTest, { excludeTestServices: true })("FilesService", (it) => {
  it.effect("reads a file inside and outside a project", () =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      const path = yield* Path.Path;
      const project = yield* makeTempDir;
      const elsewhere = yield* makeTempDir;
      yield* writeTextFile(project, "README.md", "# Project\n");
      yield* writeTextFile(elsewhere, "note.txt", "outside\n");

      expect(yield* files.read({ absolutePath: path.join(project, "README.md") })).toMatchObject({
        contents: "# Project\n",
        truncated: false,
      });
      expect(yield* files.read({ absolutePath: path.join(elsewhere, "note.txt") })).toMatchObject({
        contents: "outside\n",
        truncated: false,
      });
    }),
  );

  it.effect("reports missing files, folders, binary files and symlinks clearly", () =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* makeTempDir;
      const target = path.join(directory, "target.txt");
      yield* writeTextFile(directory, "target.txt", "linked\n");
      yield* writeTextFile(directory, "binary.bin", "a\u0000b");
      yield* fs.makeDirectory(path.join(directory, "folder")).pipe(Effect.orDie);
      yield* fs.symlink(target, path.join(directory, "link.txt")).pipe(Effect.orDie);

      const missing = yield* files
        .read({ absolutePath: path.join(directory, "missing.txt") })
        .pipe(Effect.flip);
      expect(reasonOf(missing)).toBe("not_found");
      const folder = yield* files
        .read({ absolutePath: path.join(directory, "folder") })
        .pipe(Effect.flip);
      expect(reasonOf(folder)).toBe("not_file");
      const binary = yield* files
        .read({ absolutePath: path.join(directory, "binary.bin") })
        .pipe(Effect.flip);
      expect(reasonOf(binary)).toBe("binary");
      const link = yield* files.read({ absolutePath: path.join(directory, "link.txt") });
      expect(link).toMatchObject({ contents: "linked\n", absolutePath: target });
      const relative = yield* files.read({ absolutePath: "README.md" }).pipe(Effect.flip);
      expect(reasonOf(relative)).toBe("invalid_path");
    }),
  );

  it.effect("truncates a preview at one MiB and refuses a file past the hard ceiling", () =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      const path = yield* Path.Path;
      const directory = yield* makeTempDir;
      const large = path.join(directory, "large.txt");
      const huge = path.join(directory, "huge.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(large, Buffer.alloc(1_500_000, 97)));
      yield* Effect.promise(() => NodeFSP.writeFile(huge, ""));
      yield* Effect.promise(() =>
        NodeFSP.truncate(huge, FilesService.FILES_READ_HARD_MAX_BYTES + 1),
      );

      const preview = yield* files.read({ absolutePath: large });
      expect(preview.truncated).toBe(true);
      expect(preview.byteLength).toBe(1_500_000);
      expect(preview.contents).toHaveLength(FilesService.FILES_READ_PREVIEW_BYTES);
      const tooLarge = yield* files.read({ absolutePath: huge }).pipe(Effect.flip);
      expect(reasonOf(tooLarge)).toBe("too_large");
    }),
  );

  it.effect("lists a folder and completes the last path segment", () =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* makeTempDir;
      yield* fs.makeDirectory(path.join(directory, "src")).pipe(Effect.orDie);
      yield* fs.makeDirectory(path.join(directory, ".hidden")).pipe(Effect.orDie);
      yield* writeTextFile(directory, "README.md", "#\n");
      yield* writeTextFile(directory, "src/index.ts", "");

      const all = yield* files.list({ partialPath: `${directory}/` });
      expect(all.parentPath).toBe(directory);
      expect(all.entries).toEqual([
        { name: ".hidden", absolutePath: path.join(directory, ".hidden"), kind: "directory" },
        { name: "src", absolutePath: path.join(directory, "src"), kind: "directory" },
        { name: "README.md", absolutePath: path.join(directory, "README.md"), kind: "file" },
      ]);

      const completed = yield* files.list({ partialPath: `${directory}/RE` });
      expect(completed.parentPath).toBe(directory);
      expect(completed.entries.map((entry) => entry.name)).toEqual(["README.md"]);

      const hidden = yield* files.list({ partialPath: `${directory}/.h` });
      expect(hidden.entries.map((entry) => entry.name)).toEqual([".hidden"]);

      const notDirectory = yield* files
        .list({ partialPath: `${path.join(directory, "README.md")}/` })
        .pipe(Effect.flip);
      expect(reasonOf(notDirectory)).toBe("not_directory");

      const limited = yield* files.list({ partialPath: `${directory}/`, limit: 1 });
      expect(limited.entries).toHaveLength(1);
    }),
  );

  it.effect("does not serve this server's own state files", () =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const stateFile = path.join(config.stateDir, "statev2.sqlite");
      yield* Effect.promise(() => NodeFSP.writeFile(stateFile, "secret"));

      const error = yield* files.read({ absolutePath: stateFile }).pipe(Effect.flip);
      expect(reasonOf(error)).toBe("permission_denied");
    }),
  );
});

it.layer(layerTest, { excludeTestServices: true })("FilesService receiving link", (it) => {
  it.effect(
    "refuses read-only escapes and allows valid projects despite an unrelated missing root",
    () =>
      Effect.gen(function* () {
        const files = yield* FilesService.FilesService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(project, "inside.txt", "inside");
        yield* writeTextFile(outside, "secret.txt", "secret");
        yield* fs.symlink(outside, path.join(project, "escape")).pipe(Effect.orDie);
        const snapshot = {
          document: linkedTestDocument({ studio: "studio", laptop: "laptop" }),
          config: {
            ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
            projectMounts: {
              removed: [
                {
                  environmentId: "studio",
                  role: "primary" as const,
                  transport: "git" as const,
                  createdAt: "2026-01-01T00:00:00Z",
                  path: path.join(outside, "removed"),
                },
              ],
              app: [
                {
                  environmentId: "studio",
                  role: "primary" as const,
                  transport: "git" as const,
                  createdAt: "2026-01-01T00:00:00Z",
                  path: project,
                },
              ],
            },
          },
        };
        const invoke = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(McpInvocationContext, {
              environmentId: EnvironmentId.make("studio"),
              capabilities: new Set<import("../mcp/McpInvocationContext.ts").McpCapability>(),
              issuedAt: 0,
              requestNamespace: "test",
              thread: undefined,
              client: {
                sessionId: "link",
                label: "laptop",
                linked: true,
                access: "read-only",
                peerEnvironmentId: EnvironmentId.make("laptop"),
              },
            }),
            Effect.provideService(
              MeshLayoutService,
              MeshLayoutService.of({
                environmentId: "studio",
                read: Effect.succeed(snapshot),
                changes: Stream.empty,
                apply: () => Effect.succeed(snapshot),
                edit: () => Effect.succeed(snapshot),
                editLegacy: () => Effect.succeed(snapshot),
                nextHlc: Effect.succeed("0000000000000.00000.studio"),
              }),
            ),
          );
        expect(
          yield* invoke(files.read({ absolutePath: path.join(project, "inside.txt") })),
        ).toMatchObject({ contents: "inside" });
        for (const target of [
          path.join(outside, "secret.txt"),
          path.join(project, "escape", "secret.txt"),
        ]) {
          expect(
            reasonOf(yield* invoke(files.read({ absolutePath: target })).pipe(Effect.flip)),
          ).toBe("permission_denied");
        }
        expect(
          reasonOf(yield* invoke(files.list({ partialPath: `${outside}/` })).pipe(Effect.flip)),
        ).toBe("permission_denied");
      }),
  );
  it.effect("enforces config file permissions on the receiving server", () =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      const path = yield* Path.Path;
      const project = yield* makeTempDir;
      const outside = yield* makeTempDir;
      yield* writeTextFile(project, "inside.txt", "inside");
      yield* writeTextFile(outside, "secret.txt", "secret");
      const config = (files: "all" | "projects" | "none") => ({
        schema: 1,
        machines: { studio: { title: "Studio" }, laptop: { title: "Laptop" } },
        links: {
          default: { files },
          overrides: [{ between: ["studio", "laptop"], files }],
        },
      });
      const invoke = (
        permission: "all" | "projects" | "none",
        access: "full-access" | "read-only",
        filesLimit?: "projects" | "none",
        missingOperation?: "read" | "list",
      ) =>
        Effect.gen(function* () {
          const revision = {
            revision: "0000000000001.00000.studio",
            doc: config(permission),
            author: "studio",
            writtenAt: "2026-01-01T00:00:00Z",
          };
          const snapshot = {
            document: {
              "mesh.config": { v: revision, h: "0000000000001.00000.studio" },
              "mesh.machineBinding/studio": { v: "studio", h: "0000000000001.00000.studio" },
              "mesh.machineBinding/laptop": { v: "laptop", h: "0000000000001.00000.studio" },
            },
            config: {
              ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
              projectMounts: {
                app: [
                  {
                    environmentId: "studio",
                    role: "primary" as const,
                    transport: "git" as const,
                    createdAt: "2026-01-01T00:00:00Z",
                    path: project,
                  },
                ],
              },
            },
          };
          const missing = path.join(outside, "missing");
          const operation: Effect.Effect<FilesReadResult | FilesListResult, FilesError> =
            missingOperation === "list"
              ? files.list({ partialPath: `${missing}/` })
              : files.read({
                  absolutePath:
                    missingOperation === "read" ? missing : path.join(outside, "secret.txt"),
                });
          return yield* operation.pipe(
            Effect.provideService(McpInvocationContext, {
              environmentId: EnvironmentId.make("studio"),
              capabilities: new Set<import("../mcp/McpInvocationContext.ts").McpCapability>(),
              issuedAt: 0,
              requestNamespace: "test",
              thread: undefined,
              client: {
                sessionId: "link",
                label: "T3 Code · Laptop",
                peerEnvironmentId: EnvironmentId.make("laptop"),
                linked: true,
                access,
                ...(filesLimit ? { filesLimit } : {}),
              },
            }),
            Effect.provideService(
              MeshLayoutService,
              MeshLayoutService.of({
                environmentId: "studio",
                read: Effect.succeed(snapshot),
                changes: Stream.empty,
                apply: () => Effect.succeed(snapshot),
                edit: () => Effect.succeed(snapshot),
                editLegacy: () => Effect.succeed(snapshot),
                nextHlc: Effect.succeed("0000000000001.00000.studio"),
              }),
            ),
          );
        });
      expect(yield* invoke("all", "full-access")).toMatchObject({ contents: "secret" });
      expect(reasonOf(yield* invoke("all", "full-access", "projects").pipe(Effect.flip))).toBe(
        "permission_denied",
      );
      expect(reasonOf(yield* invoke("none", "full-access").pipe(Effect.flip))).toBe(
        "permission_denied",
      );
      for (const operation of ["read", "list"] as const)
        expect(
          reasonOf(yield* invoke("none", "full-access", undefined, operation).pipe(Effect.flip)),
        ).toBe("permission_denied");
      expect(reasonOf(yield* invoke("projects", "full-access").pipe(Effect.flip))).toBe(
        "permission_denied",
      );
      expect(reasonOf(yield* invoke("all", "read-only").pipe(Effect.flip))).toBe(
        "permission_denied",
      );
    }),
  );
});
