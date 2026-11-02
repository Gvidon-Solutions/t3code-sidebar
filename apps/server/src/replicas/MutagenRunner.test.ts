import stagingFixture from "./fixtures/mutagen-0.18.1-staging.json" with { type: "json" };
import fixture from "./fixtures/mutagen-0.18.1.json" with { type: "json" };
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeSessions } from "./MutagenRunner.ts";
import { replicaDriver, sessionIdentity, sessionStatus, sshEndpoint } from "./replicaModel.ts";
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
      ).toMatchObject({ state: "error", problems: ["private: permission denied"] });
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
