// @effect-diagnostics nodeBuiltinImport:off - the suffix lookup shells out to git, as the law asks.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

import type {
  EnvironmentId,
  FilesLocateCandidate,
  FilesLocateInput,
  FilesLocateResult,
  FilesLocateTried,
  FilesLocateVia,
  FilesStatResult,
  ThreadId,
} from "@t3tools/contracts";
import { FILES_LOCATE_MAX_CANDIDATES } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as FilesRpc from "./FilesRpc.ts";
import * as FilesService from "./FilesService.ts";

/** Everything the resolver needs about the asking thread, supplied by the caller's handler. */
export interface LocateContext {
  /** The machine the thread (and the resolver) runs on. */
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  /** The thread's worktree, or the project root when it has none. May no longer exist. */
  readonly cwd?: string;
  readonly worktreePath?: string | null;
  readonly projectRoot?: string;
  readonly projectTitle?: string;
  /** Files the thread itself edited, wrote, or checkpointed. */
  readonly touchedPaths: ReadonlyArray<string>;
}

export class FileLocator extends Context.Service<
  FileLocator,
  {
    readonly locate: (
      input: FilesLocateInput,
      context: LocateContext,
    ) => Effect.Effect<FilesLocateResult>;
  }
>()("t3/files/FileLocator") {}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const TIER_TIMEOUT_MS = 1500;
const CROSS_MACHINE_TIMEOUT_MS = 2000;
const SUFFIX_DEADLINE_MS = 1500;
const SUFFIX_MAX_ENTRIES = 200_000;
const SUFFIX_MAX_DIRECTORIES = 20_000;

const PRUNED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  "out",
  "coverage",
  ".t3",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
]);

const T3_FILE_PREFIX = "t3-file://";

const parseT3FileLink = (value: string) => {
  if (!value.startsWith(T3_FILE_PREFIX)) return null;
  const rest = value.slice(T3_FILE_PREFIX.length);
  const separator = rest.indexOf("/");
  if (separator <= 0) return null;
  try {
    return {
      environmentId: rest.slice(0, separator) as EnvironmentId,
      absolutePath: decodeURIComponent(rest.slice(separator + 1)),
    };
  } catch {
    return null;
  }
};

const stripWrappingQuotes = (value: string) => {
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["<", ">"],
  ] as const;
  for (const [open, close] of pairs) {
    if (value.length > 1 && value.startsWith(open) && value.endsWith(close)) {
      return value.slice(1, -1);
    }
  }
  return value;
};

const decodeIfEncoded = (value: string) => {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export interface NormalisedLocatePath {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly explicitEnvironmentId?: EnvironmentId;
}

/** The one place a raw link, chat path or agent string becomes a path and a position. */
export const normaliseLocatePath = (rawPath: string, home: string): NormalisedLocatePath => {
  let value = stripWrappingQuotes(rawPath.trim());
  const machine = parseT3FileLink(value);
  if (machine !== null) value = machine.absolutePath;
  value = decodeIfEncoded(value.replace(/^file:\/\//i, ""));
  const hashIndex = value.indexOf("#");
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  if (hashIndex >= 0) value = value.slice(0, hashIndex);
  const position = splitFilePathPosition(value, hash);
  const cleaned = position.path.replace(/[.,;]+$/, "");
  const expanded = cleaned.startsWith("~/") ? expandHomePath(cleaned, home) : cleaned;
  return {
    path: expanded,
    ...(position.line === undefined ? {} : { line: position.line }),
    ...(position.column === undefined ? {} : { column: position.column }),
    ...(machine === null ? {} : { explicitEnvironmentId: machine.environmentId }),
  };
};

const stripDiffPrefix = (relativePath: string) => {
  const match = /^[ab][\\/](.+)$/.exec(relativePath);
  return match?.[1] ?? null;
};

interface Representation {
  readonly environmentId: string;
  readonly path: string;
  readonly role: "primary" | "replica";
}

interface LogicalProject {
  readonly logical: string;
  readonly reps: ReadonlyArray<Representation>;
}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const files = yield* FilesService.FilesService;
  const filesRpc = yield* FilesRpc.FilesRpc;
  const mesh = yield* MeshLayoutService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const home = yield* HostProcess.HomeDirectory;

  const statLocal = (absolutePath: string) =>
    files.stat({ absolutePath }).pipe(
      Effect.catch((error) =>
        error.reason === "not_found" || error.reason === "not_file"
          ? Effect.succeed(null)
          : Effect.logDebug("FileLocator local stat failed", {
              reason: error.reason,
              path: absolutePath,
            }).pipe(Effect.as(null)),
      ),
    );

  const statOn = Effect.fn("FileLocator.statOn")(function* (
    targetEnvironmentId: EnvironmentId,
    absolutePath: string,
    timeoutMs: number,
  ) {
    if (targetEnvironmentId === (yield* environment.getDescriptor).environmentId) {
      return yield* statLocal(absolutePath);
    }
    return yield* filesRpc.stat({ environmentId: targetEnvironmentId, absolutePath }).pipe(
      Effect.timeout(`${timeoutMs} millis`),
      Effect.catch((error) =>
        Effect.logDebug("FileLocator remote stat failed", {
          environmentId: targetEnvironmentId,
          reason: "reason" in error ? error.reason : "timeout",
          path: absolutePath,
        }).pipe(Effect.as(null)),
      ),
    );
  });

  const gitFiles = (root: string) =>
    Effect.tryPromise({
      try: async () => {
        const { stdout } = await execFile(
          "git",
          ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
          { timeout: TIER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
        );
        return stdout.split("\0").filter((entry) => entry.length > 0);
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));

  const walkFiles = (root: string) =>
    Effect.tryPromise({
      try: async () => {
        const found: string[] = [];
        const queue: string[] = [root];
        let directories = 0;
        let entries = 0;
        while (queue.length > 0 && entries < SUFFIX_MAX_ENTRIES) {
          const directory = queue.shift()!;
          directories += 1;
          if (directories > SUFFIX_MAX_DIRECTORIES) break;
          let dirents;
          try {
            dirents = await NodeFSP.readdir(directory, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const dirent of dirents) {
            entries += 1;
            if (entries >= SUFFIX_MAX_ENTRIES) break;
            const child = path.join(directory, dirent.name);
            if (dirent.isDirectory()) {
              if (!PRUNED_DIRECTORIES.has(dirent.name) && !dirent.name.startsWith(".")) {
                queue.push(child);
              }
            } else if (dirent.isFile()) {
              found.push(path.relative(root, child));
            }
          }
        }
        return found;
      },
      catch: () => [] as ReadonlyArray<string>,
    }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

  const treeFiles = Effect.fn("FileLocator.treeFiles")(function* (root: string) {
    const tracked = yield* gitFiles(root);
    if (tracked !== null) return tracked;
    return yield* walkFiles(root).pipe(
      Effect.timeout(`${SUFFIX_DEADLINE_MS} millis`),
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );
  });

  const logicalOfRepresentation = (
    projectMounts: Record<string, ReadonlyArray<Representation>>,
    contextEnvironmentId: EnvironmentId,
    candidates: ReadonlyArray<string | undefined>,
  ): LogicalProject | null => {
    const wanted = candidates.filter((value): value is string => value !== undefined);
    if (wanted.length === 0) return null;
    for (const [logical, reps] of Object.entries(projectMounts)) {
      if (
        reps.some(
          (rep) =>
            rep.environmentId === contextEnvironmentId &&
            wanted.some((root) => path.resolve(rep.path) === path.resolve(root)),
        )
      ) {
        return { logical, reps };
      }
    }
    for (const [logical, reps] of Object.entries(projectMounts)) {
      if (
        reps.some(
          (rep) =>
            rep.environmentId === contextEnvironmentId &&
            wanted.some((root) => isWithinRoot(path, path.resolve(root), rep.path)),
        )
      ) {
        return { logical, reps };
      }
    }
    return null;
  };

  const logicalContaining = (
    projectMounts: Record<string, ReadonlyArray<Representation>>,
    absolutePath: string,
  ) => {
    for (const [logical, reps] of Object.entries(projectMounts)) {
      for (const rep of reps) {
        if (isWithinRoot(path, absolutePath, rep.path)) {
          return { logical, remainder: path.relative(rep.path, absolutePath), reps };
        }
      }
    }
    return null;
  };

  const machineRank = (
    targetEnvironmentId: EnvironmentId,
    self: EnvironmentId,
    reps: ReadonlyArray<Representation>,
  ) => {
    if (targetEnvironmentId === self) return 0;
    return reps.find((entry) => entry.environmentId === targetEnvironmentId)?.role === "primary"
      ? 1
      : 2;
  };

  const sortByMachine = <T extends { readonly environmentId: EnvironmentId }>(
    values: ReadonlyArray<T>,
    self: EnvironmentId,
    reps: ReadonlyArray<Representation>,
  ) =>
    [...values].sort((left, right) => {
      const byMachine =
        machineRank(left.environmentId, self, reps) - machineRank(right.environmentId, self, reps);
      return byMachine !== 0 ? byMachine : left.environmentId.localeCompare(right.environmentId);
    });

  const locate: FileLocator["Service"]["locate"] = Effect.fn("FileLocator.locate")(
    function* (input, context) {
      const snapshot = yield* mesh.read;
      const self = context.environmentId;
      const tried: FilesLocateTried[] = [];
      const trial = (tier: string, environmentId?: EnvironmentId, detail?: string) => {
        tried.push({
          tier,
          ...(environmentId === undefined ? {} : { environmentId }),
          ...(detail === undefined ? {} : { detail }),
        });
      };
      const normalised = normaliseLocatePath(input.rawPath, home);
      const explicit = input.environmentId ?? normalised.explicitEnvironmentId;
      const { line, column } = normalised;

      // A deleted or merged worktree resolves against the project root instead.
      let worktreeRemoved = false;
      let effectiveCwd = context.cwd;
      if (
        context.worktreePath !== null &&
        context.worktreePath !== undefined &&
        context.projectRoot !== undefined &&
        path.resolve(context.worktreePath) !== path.resolve(context.projectRoot)
      ) {
        const worktreeStat = yield* statLocal(context.worktreePath);
        if (worktreeStat === null || worktreeStat.kind !== "directory") {
          worktreeRemoved = true;
          effectiveCwd = context.projectRoot;
        }
      }

      const baseResult = {
        environmentId: self,
        ...(context.projectTitle === undefined ? {} : { projectTitle: context.projectTitle }),
        ...(effectiveCwd === undefined ? {} : { cwd: effectiveCwd }),
        ...(worktreeRemoved ? { worktreeRemoved: true } : {}),
      } as const;

      const threadRep = logicalOfRepresentation(snapshot.config.projectMounts, self, [
        context.cwd,
        context.worktreePath ?? undefined,
        context.projectRoot,
      ]);
      const representationRoots = threadRep?.reps ?? [];

      const touched = new Set<string>();
      for (const value of context.touchedPaths) {
        if (path.isAbsolute(value)) {
          touched.add(path.resolve(value));
          continue;
        }
        if (context.cwd !== undefined) touched.add(path.resolve(context.cwd, value));
        if (context.projectRoot !== undefined) {
          touched.add(path.resolve(context.projectRoot, value));
        }
      }

      const rootOf = (absolutePath: string, environmentId: EnvironmentId) => {
        const roots = [
          ...(environmentId === self
            ? [effectiveCwd, context.worktreePath ?? undefined, context.projectRoot]
            : []),
          ...Object.values(snapshot.config.projectMounts)
            .flat()
            .filter((rep) => rep.environmentId === environmentId)
            .map((rep) => rep.path),
        ].filter((value): value is string => value !== undefined);
        return roots
          .filter((root) => isWithinRoot(path, absolutePath, root))
          .sort((left, right) => right.length - left.length)[0];
      };

      const inProject = (absolutePath: string, environmentId: EnvironmentId) => {
        if (environmentId === self) {
          if (
            context.projectRoot !== undefined &&
            isWithinRoot(path, absolutePath, context.projectRoot)
          )
            return true;
          if (context.cwd !== undefined && isWithinRoot(path, absolutePath, context.cwd))
            return true;
          if (
            context.worktreePath !== null &&
            context.worktreePath !== undefined &&
            isWithinRoot(path, absolutePath, context.worktreePath)
          )
            return true;
        }
        return Object.values(snapshot.config.projectMounts)
          .flat()
          .filter((rep) => rep.environmentId === environmentId)
          .some((rep) => isWithinRoot(path, absolutePath, rep.path));
      };

      const displayPathOf = (absolutePath: string, environmentId: EnvironmentId) => {
        const root = rootOf(absolutePath, environmentId);
        if (root === undefined) return absolutePath;
        const relative = isWithinRoot(path, absolutePath, root)
          ? path.relative(root, absolutePath)
          : null;
        return relative === null || relative === "" ? absolutePath : relative;
      };

      const candidateOf = (
        stat: FilesStatResult,
        environmentId: EnvironmentId,
        via: FilesLocateVia,
        notSynced = false,
      ): FilesLocateCandidate => ({
        environmentId,
        absolutePath: stat.absolutePath,
        kind: stat.kind === "other" ? "file" : stat.kind,
        via,
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
        inProject: inProject(stat.absolutePath, environmentId),
        ...(notSynced ? { notSynced: true } : {}),
        ...(stat.byteLength === undefined ? {} : { byteLength: stat.byteLength }),
        ...(stat.mtimeMs === undefined ? {} : { mtimeMs: stat.mtimeMs }),
        touchedByThread: touched.has(path.resolve(stat.absolutePath)),
        displayPath: displayPathOf(stat.absolutePath, environmentId),
        ...(rootOf(stat.absolutePath, environmentId) === undefined
          ? {}
          : { root: rootOf(stat.absolutePath, environmentId) }),
      });

      const rankWithin = (
        candidates: ReadonlyArray<FilesLocateCandidate>,
      ): ReadonlyArray<FilesLocateCandidate> => {
        const cwdRoot = effectiveCwd === undefined ? undefined : path.resolve(effectiveCwd);
        return [...candidates].sort((left, right) => {
          const touchedDelta = Number(right.touchedByThread) - Number(left.touchedByThread);
          if (touchedDelta !== 0) return touchedDelta;
          const leftInCwd =
            cwdRoot !== undefined && isWithinRoot(path, path.resolve(left.absolutePath), cwdRoot);
          const rightInCwd =
            cwdRoot !== undefined && isWithinRoot(path, path.resolve(right.absolutePath), cwdRoot);
          if (leftInCwd !== rightInCwd) return leftInCwd ? -1 : 1;
          const mtimeDelta = (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0);
          return mtimeDelta !== 0
            ? mtimeDelta
            : left.absolutePath.length - right.absolutePath.length;
        });
      };

      const resultFor = (candidates: ReadonlyArray<FilesLocateCandidate>): FilesLocateResult => {
        const ranked = rankWithin(candidates).slice(0, FILES_LOCATE_MAX_CANDIDATES);
        const best = ranked[0];
        if (best === undefined) {
          return { status: "notFound", tried, ...baseResult };
        }
        if (ranked.length === 1) {
          return { status: "found", target: best, tried, ...baseResult };
        }
        const touchedCandidates = ranked.filter((candidate) => candidate.touchedByThread);
        const touchedOnly = touchedCandidates[0];
        if (touchedCandidates.length === 1 && touchedOnly !== undefined) {
          return { status: "found", target: touchedOnly, tried, ...baseResult };
        }
        return { status: "choose", target: best, candidates: ranked, tried, ...baseResult };
      };

      const found = (candidate: FilesLocateCandidate): FilesLocateResult => ({
        status: "found",
        target: candidate,
        tried,
        ...baseResult,
      });

      const statMapped = Effect.fn("FileLocator.statMapped")(function* (
        reps: ReadonlyArray<Representation>,
        remainder: string,
        via: FilesLocateVia,
        notSyncedForPrimary: boolean,
      ) {
        const targets = reps.map((rep) => ({
          environmentId: rep.environmentId as EnvironmentId,
          absolutePath: remainder === "." ? rep.path : path.join(rep.path, remainder),
          role: rep.role,
        }));
        const hits = yield* Effect.forEach(
          targets,
          (target) =>
            statOn(target.environmentId, target.absolutePath, CROSS_MACHINE_TIMEOUT_MS).pipe(
              Effect.map((stat) => (stat === null ? null : { stat, target })),
            ),
          { concurrency: "unbounded" },
        );
        return hits.flatMap((hit) =>
          hit === null
            ? []
            : [
                candidateOf(
                  hit.stat,
                  hit.target.environmentId,
                  via,
                  notSyncedForPrimary &&
                    hit.target.environmentId !== self &&
                    hit.target.role === "primary",
                ),
              ],
        );
      });

      const suffixCandidates = Effect.fn("FileLocator.suffixCandidates")(function* (
        root: string,
        query: string,
        mode: "suffix" | "basename",
      ) {
        const realRoot = yield* statLocal(root);
        if (realRoot === null || realRoot.kind !== "directory") return [];
        const entries = yield* treeFiles(realRoot.absolutePath);
        const normalisedQuery = query.replaceAll("\\", "/").replace(/^\.\//, "");
        const suffix = `/${normalisedQuery}`;
        const matches = entries
          .map((entry) => entry.replaceAll("\\", "/"))
          .filter((candidate) =>
            mode === "suffix"
              ? candidate === normalisedQuery || candidate.endsWith(suffix)
              : path.basename(candidate) === normalisedQuery,
          )
          .map((entry) => ({ entry, absolutePath: path.join(realRoot.absolutePath, entry) }))
          .sort(
            (left, right) =>
              Number(touched.has(path.resolve(right.absolutePath))) -
                Number(touched.has(path.resolve(left.absolutePath))) ||
              left.entry.length - right.entry.length,
          )
          .slice(0, FILES_LOCATE_MAX_CANDIDATES);
        const stats = yield* Effect.forEach(matches, (match) => statLocal(match.absolutePath), {
          concurrency: 8,
        });
        return stats.flatMap((stat) =>
          stat === null || stat.kind !== "file"
            ? []
            : [candidateOf(stat, self, mode === "suffix" ? "suffix" : "basename")],
        );
      });

      const notFound = (): FilesLocateResult => ({ status: "notFound", tried, ...baseResult });

      const fromRepresentations = Effect.fn("FileLocator.fromRepresentations")(function* (
        query: string,
      ) {
        if (threadRep === null) return null;
        trial("representation-map", undefined, threadRep.logical);
        const remainder = query.replace(/^\.\//, "");
        const notSyncedForPrimary = threadRep.reps.some(
          (rep) => rep.environmentId === self && rep.role === "replica",
        );
        const hits = yield* statMapped(
          threadRep.reps,
          remainder,
          "representation-map",
          notSyncedForPrimary,
        );
        if (hits.length === 0) return null;
        const sorted = sortByMachine(hits, self, threadRep.reps);
        const best = sorted[0]!;
        const sameRank = sorted.filter(
          (hit) =>
            machineRank(hit.environmentId, self, threadRep.reps) ===
            machineRank(best.environmentId, self, threadRep.reps),
        );
        return sameRank.length === 1 ? found(best) : resultFor(sameRank);
      });

      if (explicit !== undefined) {
        trial("explicit-machine", explicit);
        const absolute = path.isAbsolute(normalised.path)
          ? normalised.path
          : effectiveCwd === undefined
            ? normalised.path
            : path.resolve(effectiveCwd, normalised.path);
        const stat = yield* statOn(explicit, absolute, CROSS_MACHINE_TIMEOUT_MS);
        return stat === null ? notFound() : found(candidateOf(stat, explicit, "explicit-machine"));
      }

      if (path.isAbsolute(normalised.path)) {
        const absolute = normalised.path;
        trial("exact", self);
        const exact = yield* statLocal(absolute);
        if (exact !== null) return found(candidateOf(exact, self, "exact"));

        if (
          worktreeRemoved &&
          context.worktreePath !== undefined &&
          context.worktreePath !== null &&
          context.projectRoot !== undefined &&
          isWithinRoot(path, absolute, context.worktreePath)
        ) {
          const remainder = path.relative(context.worktreePath, absolute);
          trial("representation-map", self, "worktree-removed");
          const projectStat = yield* statLocal(path.resolve(context.projectRoot, remainder));
          if (projectStat !== null) {
            return found(candidateOf(projectStat, self, "representation-map"));
          }
          const remapped = yield* fromRepresentations(remainder);
          if (remapped !== null) return remapped;
        }

        const mapped = logicalContaining(snapshot.config.projectMounts, absolute);
        if (mapped !== null) {
          trial("representation-map", undefined, mapped.logical);
          const notSyncedForPrimary = representationRoots.some(
            (rep) => rep.environmentId === self && rep.role === "replica",
          );
          const hits = yield* statMapped(
            mapped.reps,
            mapped.remainder,
            "representation-map",
            notSyncedForPrimary,
          );
          if (hits.length > 0) {
            const sorted = sortByMachine(hits, self, mapped.reps);
            const best = sorted[0]!;
            const sameRank = sorted.filter(
              (hit) =>
                machineRank(hit.environmentId, self, mapped.reps) ===
                machineRank(best.environmentId, self, mapped.reps),
            );
            return sameRank.length === 1 ? found(best) : resultFor(sameRank);
          }
        }

        const others = Object.keys(snapshot.config.machines)
          .map((value) => value as EnvironmentId)
          .filter((value) => value !== self);
        if (others.length > 0) {
          trial("other-machine");
          const hits = yield* Effect.forEach(
            others,
            (environmentId) =>
              statOn(environmentId, absolute, CROSS_MACHINE_TIMEOUT_MS).pipe(
                Effect.map((stat) => (stat === null ? null : { stat, environmentId })),
              ),
            { concurrency: "unbounded" },
          );
          const candidates = hits.flatMap((hit) =>
            hit === null ? [] : [candidateOf(hit.stat, hit.environmentId, "other-machine")],
          );
          if (candidates.length > 0) return resultFor(candidates);
        }
        return notFound();
      }

      const relativePath = normalised.path;
      if (effectiveCwd !== undefined) {
        const attempts = [path.resolve(effectiveCwd, relativePath)];
        const stripped = stripDiffPrefix(relativePath);
        if (stripped !== null) attempts.push(path.resolve(effectiveCwd, stripped));
        trial("exact", self);
        for (const attempt of attempts) {
          const stat = yield* statLocal(attempt);
          if (stat !== null) return found(candidateOf(stat, self, "exact"));
        }
      }

      if (effectiveCwd !== undefined && context.projectRoot !== undefined) {
        const projectAttempt = path.resolve(context.projectRoot, relativePath);
        if (path.resolve(effectiveCwd) !== path.resolve(context.projectRoot)) {
          trial("project-root", self);
          const stat = yield* statLocal(projectAttempt);
          if (stat !== null) return found(candidateOf(stat, self, "project-root"));
        }
      }

      if (effectiveCwd !== undefined) {
        const ancestors: string[] = [];
        let current = path.dirname(path.resolve(effectiveCwd));
        const stop = context.projectRoot === undefined ? null : path.resolve(context.projectRoot);
        for (let depth = 0; depth < 12; depth += 1) {
          if (stop !== null && path.resolve(current) === stop) break;
          ancestors.push(current);
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
        if (ancestors.length > 0) {
          trial("ancestor", self);
          for (const ancestor of ancestors) {
            const stat = yield* statLocal(path.resolve(ancestor, relativePath));
            if (stat !== null) return found(candidateOf(stat, self, "ancestor"));
          }
        }

        const searchRoot = path.resolve(effectiveCwd);
        if (relativePath.includes("/") || relativePath.includes("\\")) {
          trial("suffix", self);
          const hits = yield* suffixCandidates(searchRoot, relativePath, "suffix");
          if (hits.length > 0) return resultFor(hits);
        }
        const remapped = yield* fromRepresentations(relativePath);
        if (remapped !== null) return remapped;
        if (!relativePath.includes("/") && !relativePath.includes("\\")) {
          trial("basename", self);
          const basenameHits = yield* suffixCandidates(
            searchRoot,
            path.basename(relativePath.replace(/[\\/]+$/, "")),
            "basename",
          );
          if (basenameHits.length > 0) return resultFor(basenameHits);
        }
      }

      trial("sibling-worktrees", undefined, "not searched; offers Search in project");
      return notFound();
    },
  );

  return FileLocator.of({ locate });
});

export const layer = Layer.effect(FileLocator, make);
