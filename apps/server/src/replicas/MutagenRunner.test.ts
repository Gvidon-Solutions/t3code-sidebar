import stagingFixture from "./fixtures/mutagen-0.18.1-staging.json" with { type: "json" };
import fixture from "./fixtures/mutagen-0.18.1.json" with { type: "json" };
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeSessions } from "./MutagenRunner.ts";
import {
  replicaIgnorePatterns,
  replicaDriver,
  sessionIdentity,
  sessionStatus,
  sshEndpoint,
} from "./replicaModel.ts";
import { SidebarWorkspacesConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const fixtureJson = JSON.stringify(fixture);

const decodeConfig = Schema.decodeSync(SidebarWorkspacesConfig);

describe("Mutagen 0.18.1", () => {
  it.effect("decodes the sanitized read-only capture and rejects malformed output", () =>
    Effect.gen(function* () {
      const sessions = yield* decodeSessions(fixtureJson);
      const [staging] = yield* decodeSessions(JSON.stringify(stagingFixture));
      expect(sessionStatus(staging!)).toMatchObject({
        state: "mounting",
        progress: expect.any(Number),
        lag: { filesBehind: 1, bytesBehind: 1073741824 - 4653056 },
      });
      expect(sessionStatus(staging!).progress).toBeCloseTo(4653056 / 1073741824);
      expect(sessions).toHaveLength(2);
      expect(sessionStatus(sessions[0]!)).toEqual({
        state: "watching",
        conflicts: [],
        problems: [],
        lag: { filesBehind: 0, bytesBehind: 0 },
      });
      expect(yield* decodeSessions("not-json").pipe(Effect.isFailure)).toBe(true);
      expect(yield* decodeSessions('[{"status":"watching"}]').pipe(Effect.isFailure)).toBe(true);
    }),
  );
  it.effect("reports pause, staging progress, conflicts and endpoint problems", () =>
    Effect.gen(function* () {
      const [session] = yield* decodeSessions(fixtureJson);
      expect(sessionStatus({ ...session!, paused: true }).state).toBe("paused");
      expect(sessionStatus({ ...session!, paused: true })).not.toHaveProperty("lag");
      expect(sessionStatus({ ...session!, status: "connecting-alpha" })).not.toHaveProperty("lag");
      expect(
        sessionStatus({
          ...session!,
          status: "staging-beta",
          beta: {
            path: "/beta",
            stagingProgress: {
              receivedSize: 5,
              expectedSize: 10,
              receivedFiles: 0,
              expectedFiles: 1,
            },
          },
        }),
      ).toMatchObject({
        state: "mounting",
        progress: 0.5,
        lag: { filesBehind: 1, bytesBehind: 5 },
      });
      expect(
        sessionStatus({
          ...session!,
          status: "staging-alpha",
          alpha: {
            path: "/alpha",
            stagingProgress: {
              receivedSize: 5,
              expectedSize: 10,
              receivedFiles: 1,
              expectedFiles: 3,
            },
          },
        }),
      ).toHaveProperty("lag", { filesBehind: 2 });
      expect(sessionStatus({ ...session!, conflicts: [{ root: "src/a.ts" }] })).toMatchObject({
        state: "conflict",
        conflicts: ["src/a.ts"],
      });
      expect(
        sessionStatus({
          ...session!,
          alpha: {
            path: "/alpha",
            scanProblems: [{ path: "private", error: "permission denied" }],
          },
        }),
      ).toMatchObject({
        state: "watching",
        problems: [],
        skipped: 1,
        skippedPaths: [{ path: "private", error: "permission denied" }],
        message: "1 file skipped (unreadable files)",
      });
      for (const sessionWithBlocker of [
        { ...session!, lastError: "connection lost" },
        { ...session!, beta: { path: "/beta", connected: false } },
        {
          ...session!,
          alpha: {
            path: "/alpha",
            transitionProblems: [{ path: "file", error: "permission denied" }],
          },
        },
      ]) {
        expect(sessionStatus(sessionWithBlocker)).toMatchObject({
          state: "error",
          message: expect.any(String),
        });
        expect(sessionStatus(sessionWithBlocker).message?.length).toBeGreaterThan(0);
      }
      expect(sessionStatus({ ...session!, lastError: "disconnected" }).state).toBe("error");
    }),
  );
  it("selects exactly one driver, preferring the replica's route", () => {
    const config = decodeConfig({
      machines: {
        replica: {},
        source: {},
      },
    });
    const replica = {
      environmentId: "replica",
      source: "source",
      path: "/test",
      role: "replica",
      transport: "mutagen",
      createdAt: "",
    } as const;
    expect(replicaDriver(config, replica)).toBe("replica");
    expect(
      replicaDriver({ ...config, machines: { source: config.machines.source! } }, replica),
    ).toBe("replica");
    expect(replicaDriver({ ...config, machines: {} }, replica)).toBe("replica");
    const { source: _source, ...withoutSource } = replica;
    expect(replicaDriver(config, withoutSource)).toBeUndefined();
    expect(sessionIdentity("repo", "environment")).toEqual(sessionIdentity("repo", "environment"));
    expect(sessionIdentity("other", "environment").name).not.toBe(
      sessionIdentity("repo", "environment").name,
    );
  });
});

it("uses managed host names for Mutagen endpoints", () => {
  expect(sshEndpoint({ ssh: "t3-studio" }, "env", "/source")).toBe("t3-studio:/source");
});

it("keeps user ignore order and duplicate overrides while protecting VCS and conflict copies", () => {
  const patterns = replicaIgnorePatterns([
    ".git",
    "cache",
    "!cache",
    "cache",
    "!.git",
    "!.t3-conflicts",
  ]);
  expect(patterns.filter((pattern) => pattern.includes("cache"))).toEqual([
    "cache",
    "!cache",
    "cache",
  ]);
  expect(patterns.indexOf(".git")).toBeGreaterThan(patterns.indexOf("!.git"));
  expect(patterns.at(-1)).toBe("/.t3-conflicts");
  expect(replicaIgnorePatterns(patterns)).toEqual(patterns);
});

it.effect("counts scan diagnostics omitted by Mutagen and bounds the paths sent to clients", () =>
  Effect.gen(function* () {
    const [session] = yield* decodeSessions(fixtureJson);
    const [decoded] = yield* decodeSessions(
      JSON.stringify([
        {
          ...session!,
          alpha: {
            ...session!.alpha,
            scanProblems: Array.from({ length: 12 }, (_, i) => ({
              path: `link-${i}`,
              error: "invalid symbolic link: target is absolute",
            })),
            excludedScanProblems: 8,
          },
        },
      ]),
    );
    expect(sessionStatus(decoded!)).toMatchObject({ state: "watching", skipped: 20, problems: [] });
    expect(sessionStatus(decoded!).skippedPaths).toHaveLength(10);
  }),
);
