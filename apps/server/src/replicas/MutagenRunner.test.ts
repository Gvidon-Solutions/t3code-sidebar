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
      });
      expect(sessionStatus(staging!).progress).toBeCloseTo(4653056 / 1073741824);
      expect(sessions).toHaveLength(2);
      expect(sessionStatus(sessions[0]!)).toEqual({
        state: "watching",
        conflicts: [],
        problems: [],
      });
      expect(yield* decodeSessions("not-json").pipe(Effect.isFailure)).toBe(true);
      expect(yield* decodeSessions('[{"status":"watching"}]').pipe(Effect.isFailure)).toBe(true);
    }),
  );
  it.effect("reports pause, staging progress, conflicts and endpoint problems", () =>
    Effect.gen(function* () {
      const [session] = yield* decodeSessions(fixtureJson);
      expect(sessionStatus({ ...session!, paused: true }).state).toBe("paused");
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
      ).toMatchObject({ state: "mounting", progress: 0.5 });
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
        replica: { reach: { source: { ssh: "source" } } },
        source: { reach: { replica: { ssh: "replica" } } },
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
    ).toBe("source");
    expect(replicaDriver({ ...config, machines: {} }, replica)).toBeUndefined();
    const { source: _source, ...withoutSource } = replica;
    expect(replicaDriver(config, withoutSource)).toBeUndefined();
    expect(sessionIdentity("repo", "environment")).toEqual(sessionIdentity("repo", "environment"));
    expect(sessionIdentity("other", "environment").name).not.toBe(
      sessionIdentity("repo", "environment").name,
    );
  });
});

it("formats SSH aliases, ports and managed identity routes for Mutagen", () => {
  expect(sshEndpoint({ ssh: "peer" }, "env", "/source")).toBe("peer:/source");
  expect(sshEndpoint({ ssh: "user@peer:2222" }, "env", "/source")).toBe(
    "ssh://user@peer:2222/source",
  );
  expect(sshEndpoint({ ssh: "user@peer:2222", identityFile: "/key" }, "env", "/source")).toBe(
    "t3-mesh-env:/source",
  );
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
  expect(patterns.slice(0, 3)).toEqual(["cache", "!cache", "cache"]);
  expect(patterns.indexOf(".git")).toBeGreaterThan(patterns.indexOf("!.git"));
  expect(patterns.at(-1)).toBe(".t3-conflicts");
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
