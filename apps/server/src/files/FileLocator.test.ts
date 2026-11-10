// @effect-diagnostics nodeBuiltinImport:off - the test seeds real files for the resolver to find.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  EnvironmentId,
  FilesError,
  type FilesLocateInput,
  type FilesStatResult,
  type SidebarProjectMount,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import * as FileLocator from "./FileLocator.ts";
import * as FilesRpc from "./FilesRpc.ts";
import * as FilesService from "./FilesService.ts";

const studio = EnvironmentId.make("studio");
const cloudbox = EnvironmentId.make("cloudbox");

const writeFile = (root: string, relativePath: string, contents = "x\n") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(root, relativePath);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.orDie);
    yield* fs.writeFileString(target, contents).pipe(Effect.orDie);
    return target;
  });

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-locator-" });
});

interface Fixture {
  readonly self: EnvironmentId;
  readonly projectRoot: string;
  readonly replicaRoot?: string;
  readonly remoteStats?: ReadonlyMap<string, FilesStatResult>;
}

const statFromDisk = (input: { readonly absolutePath: string }) =>
  Effect.tryPromise({
    try: async () => {
      const info = await NodeFSP.stat(input.absolutePath);
      return {
        absolutePath: input.absolutePath,
        kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
        ...(info.isFile() ? { byteLength: info.size } : {}),
        mtimeMs: info.mtimeMs,
      } satisfies FilesStatResult;
    },
    catch: (cause) =>
      new FilesError({
        reason:
          (cause as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "operation_failed",
        absolutePath: input.absolutePath,
        cause,
      }),
  });

const buildLayer = (fixture: Fixture) => {
  const mounts: Record<string, ReadonlyArray<SidebarProjectMount>> = {
    "logical-project": [
      {
        environmentId: studio,
        path: fixture.projectRoot,
        role: "primary",
        transport: "git",
        createdAt: "",
      },
      ...(fixture.replicaRoot === undefined
        ? []
        : [
            {
              environmentId: cloudbox,
              path: fixture.replicaRoot,
              role: "replica" as const,
              transport: "mutagen" as const,
              source: studio,
              createdAt: "",
            },
          ]),
    ],
  };
  const config: SidebarWorkspacesConfig = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: { [studio]: {}, [cloudbox]: {} },
    projectMounts: mounts,
  };
  const filesRpc = Layer.mock(FilesRpc.FilesRpc)({
    read: () =>
      Effect.fail(new FilesError({ reason: "not_found", absolutePath: "/unused" })) as never,
    list: () =>
      Effect.fail(new FilesError({ reason: "not_found", absolutePath: "/unused" })) as never,
    readBytes: () =>
      Effect.fail(new FilesError({ reason: "not_found", absolutePath: "/unused" })) as never,
    stat: (input: { readonly environmentId?: EnvironmentId; readonly absolutePath: string }) => {
      const key = `${input.environmentId ?? fixture.self}:${input.absolutePath}`;
      const override = fixture.remoteStats?.get(key);
      return override === undefined ? statFromDisk(input) : Effect.succeed(override);
    },
  } as never);

  return FileLocator.layer.pipe(
    Layer.provideMerge(FilesService.layer),
    Layer.provide(filesRpc),
    Layer.provide(
      Layer.mock(MeshLayoutService)({
        environmentId: fixture.self,
        read: Effect.succeed({
          config,
          document: {},
        } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({ environmentId: fixture.self } as never),
      }),
    ),
  );
};

const baseLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-locate-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(baseLayer, { excludeTestServices: true })("FileLocator", (it) => {
  const locate = (
    fixture: Fixture,
    input: FilesLocateInput,
    context: Omit<FileLocator.LocateContext, "environmentId">,
  ) =>
    Effect.gen(function* () {
      const locator = yield* FileLocator.FileLocator;
      return yield* locator.locate(input, { environmentId: fixture.self, ...context });
    }).pipe(Effect.provide(buildLayer(fixture)));

  it.effect("F1 · resolves a package-relative path by its suffix in the worktree", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      yield* writeFile(projectRoot, "apps/web/src/lib/serverUiReconnect.ts");
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "src/lib/serverUiReconnect.ts", intent: "open" },
        {
          cwd: projectRoot,
          worktreePath: null,
          projectRoot,
          projectTitle: "Project",
          touchedPaths: [],
        },
      );
      expect(result.status).toBe("found");
      expect(result.target?.via).toBe("suffix");
      expect(result.target?.absolutePath).toBe(
        `${projectRoot}/apps/web/src/lib/serverUiReconnect.ts`,
      );
    }),
  );

  it.effect("F2 · resolves a bare basename in the worktree", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      yield* writeFile(projectRoot, "apps/web/src/lib/serverUiReconnect.ts");
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "serverUiReconnect.ts" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.via).toBe("basename");
    }),
  );

  it.effect("F1/C4 · an ambiguous suffix asks, and a thread-touched candidate wins", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const web = yield* writeFile(projectRoot, "apps/web/src/lib/amb.ts");
      const admin = yield* writeFile(projectRoot, "apps/admin/src/lib/amb.ts");
      const ambiguous = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "src/lib/amb.ts" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(ambiguous.status).toBe("choose");
      expect(ambiguous.candidates?.map((candidate) => candidate.absolutePath).sort()).toEqual(
        [web, admin].sort(),
      );

      const touched = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "src/lib/amb.ts" },
        {
          cwd: projectRoot,
          worktreePath: null,
          projectRoot,
          touchedPaths: ["apps/admin/src/lib/amb.ts"],
        },
      );
      expect(touched.status).toBe("found");
      expect(touched.target?.absolutePath).toBe(admin);
      expect(touched.target?.touchedByThread).toBe(true);
    }),
  );

  it.effect("F7 · reads a file inside an ignored-by-default folder by its exact path", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const target = yield* writeFile(projectRoot, "node_modules/pkg/index.js");
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "node_modules/pkg/index.js" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.absolutePath).toBe(target);
    }),
  );

  it.effect("F9 · falls back to the project root when the worktree is gone", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const target = yield* writeFile(projectRoot, "note.md");
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "note.md" },
        {
          cwd: `${projectRoot}-gone`,
          worktreePath: `${projectRoot}-gone`,
          projectRoot,
          touchedPaths: [],
        },
      );
      expect(result.status).toBe("found");
      expect(result.worktreeRemoved).toBe(true);
      expect(result.target?.absolutePath).toBe(target);
    }),
  );

  it.effect("F3/C5 · finds an exact foreign absolute path on another machine", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const remoteStats = new Map<string, FilesStatResult>([
        [
          `${cloudbox}:/srv/cloudbox/note.txt`,
          {
            absolutePath: "/srv/cloudbox/note.txt",
            kind: "file",
            byteLength: 12,
            mtimeMs: 1,
          },
        ],
      ]);
      const result = yield* locate(
        { self: studio, projectRoot, remoteStats },
        { rawPath: "/srv/cloudbox/note.txt" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.environmentId).toBe(cloudbox);
      expect(result.target?.via).toBe("other-machine");
    }),
  );

  it.effect("F3 · an explicitly named machine is the only one probed", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const remoteStats = new Map<string, FilesStatResult>([
        [
          `${cloudbox}:/srv/cloudbox/note.txt`,
          { absolutePath: "/srv/cloudbox/note.txt", kind: "file", byteLength: 3, mtimeMs: 1 },
        ],
      ]);
      const result = yield* locate(
        { self: studio, projectRoot, remoteStats },
        { rawPath: "/srv/cloudbox/note.txt", environmentId: cloudbox },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.via).toBe("explicit-machine");
      expect(result.target?.environmentId).toBe(cloudbox);
    }),
  );

  it.effect("F4 · maps an absolute path between representations", () =>
    Effect.gen(function* () {
      const replicaRoot = yield* tempDir;
      const projectRoot = "/srv/primary";
      const remoteStats = new Map<string, FilesStatResult>([
        [
          `${studio}:${projectRoot}/CLAUDE.md`,
          { absolutePath: `${projectRoot}/CLAUDE.md`, kind: "file", byteLength: 8, mtimeMs: 2 },
        ],
      ]);
      const result = yield* locate(
        { self: cloudbox, projectRoot, replicaRoot, remoteStats },
        { rawPath: `${projectRoot}/CLAUDE.md` },
        { cwd: replicaRoot, worktreePath: null, projectRoot: replicaRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.environmentId).toBe(studio);
      expect(result.target?.via).toBe("representation-map");
      expect(result.target?.notSynced).toBe(true);
    }),
  );

  it.effect("F5/F6 · reads an ignored file from the primary and marks it not synced", () =>
    Effect.gen(function* () {
      const replicaRoot = yield* tempDir;
      const projectRoot = "/srv/primary";
      const remoteStats = new Map<string, FilesStatResult>([
        [
          `${studio}:${projectRoot}/results/report.pdf`,
          {
            absolutePath: `${projectRoot}/results/report.pdf`,
            kind: "file",
            byteLength: 8,
            mtimeMs: 2,
          },
        ],
      ]);
      const result = yield* locate(
        { self: cloudbox, projectRoot, replicaRoot, remoteStats },
        { rawPath: "results/report.pdf" },
        { cwd: replicaRoot, worktreePath: null, projectRoot: replicaRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.environmentId).toBe(studio);
      expect(result.target?.via).toBe("representation-map");
      expect(result.target?.notSynced).toBe(true);
    }),
  );

  it.effect("F10 · opens an absolute path outside the project, read-only", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const elsewhere = yield* tempDir;
      const target = yield* writeFile(elsewhere, "note.txt");
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: target },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.inProject).toBe(false);
    }),
  );

  it.effect("F16/F17 · strips a position and handles spaces and unicode", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      yield* writeFile(projectRoot, "dir with space/a b.txt");
      yield* writeFile(projectRoot, "юникод/файл.md");
      const spaced = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "dir with space/a b.txt:12:3" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(spaced.status).toBe("found");
      expect(spaced.target?.line).toBe(12);
      expect(spaced.target?.column).toBe(3);

      const unicode = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "юникод/файл.md" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(unicode.status).toBe("found");
    }),
  );

  it.effect("F8/F16F · a missing path reports the places it tried", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "missing/does-not-exist.ts" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("notFound");
      expect(result.tried.map((entry) => entry.tier)).toEqual(
        expect.arrayContaining(["exact", "suffix", "representation-map"]),
      );
    }),
  );

  it.effect("F18 · strips a diff prefix", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const target = yield* writeFile(projectRoot, "apps/web/x.ts");
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "a/apps/web/x.ts" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.absolutePath).toBe(target);
    }),
  );

  it.effect("M1 · a pathful query maps to another representation before basename fallback", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const replicaRoot = yield* tempDir;
      yield* writeFile(projectRoot, "apps/report.pdf");
      const remote = yield* writeFile(replicaRoot, "dist/report.pdf");
      const result = yield* locate(
        { self: studio, projectRoot, replicaRoot },
        { rawPath: "dist/report.pdf" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.environmentId).toBe(cloudbox);
      expect(result.target?.absolutePath).toBe(remote);
    }),
  );

  it.effect("M1 · a pathful query never opens an unrelated same-basename file", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      yield* writeFile(projectRoot, "apps/report.pdf");
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "dist/report.pdf" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("notFound");
    }),
  );

  it.effect("M2 · an absolute path under a removed worktree maps to the project root", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const target = yield* writeFile(projectRoot, "src/app.ts");
      const worktree = `${projectRoot}-gone`;
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: `${worktree}/src/app.ts` },
        { cwd: worktree, worktreePath: worktree, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.worktreeRemoved).toBe(true);
      expect(result.target?.absolutePath).toBe(target);
    }),
  );

  it.effect("M3 · a touched match survives the candidate cap", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const entries: string[] = [];
      for (let index = 0; index < 60; index += 1) {
        const directory = `d${String(index).padStart(2, "0")}`;
        yield* writeFile(projectRoot, `${directory}/amb.ts`);
        entries.push(`${directory}/amb.ts`);
      }
      const target = `${projectRoot}/d59/amb.ts`;
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: "amb.ts" },
        { cwd: projectRoot, worktreePath: null, projectRoot, touchedPaths: ["d59/amb.ts"] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.absolutePath).toBe(target);
      expect(result.target?.touchedByThread).toBe(true);
    }),
  );

  it.effect("M4 · a file in the worktree displays relative to it", () =>
    Effect.gen(function* () {
      const projectRoot = yield* tempDir;
      const worktree = yield* tempDir;
      const target = yield* writeFile(worktree, "src/app.ts");
      const result = yield* locate(
        { self: studio, projectRoot },
        { rawPath: target },
        { cwd: worktree, worktreePath: worktree, projectRoot, touchedPaths: [] },
      );
      expect(result.status).toBe("found");
      expect(result.target?.displayPath).toBe("src/app.ts");
      expect(result.target?.root).toBe(worktree);
    }),
  );
});
