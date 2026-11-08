import { MeshBootstrap } from "./MeshBootstrap.ts";
import { MeshRollout } from "./MeshRollout.ts";
import { MeshAgentKit } from "./MeshAgentKit.ts";
import { MeshSsh } from "../replicas/MeshSsh.ts";
import type { Json } from "@t3tools/shared/meshLayout";
import { MeshConfigError, ReplicaError, type MeshConfigDocument } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeReplicaHarness } from "../replicas/replicas.testkit.ts";
import { ProjectReplicaService } from "../replicas/ProjectReplicaService.ts";
import { ReplicaRuntime } from "../replicas/ReplicaRuntime.ts";
import { MeshConfigPlanners } from "./MeshConfig.ts";
import * as Planners from "./MeshConfigPlanners.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";

const doc: MeshConfigDocument = {
  schema: 1,
  machines: {
    studio: { title: "Studio", label: "ST", color: "blue" },
    laptop: { title: "Laptop", label: "LT" },
  },
  links: { overrides: [{ between: ["studio", "laptop"], files: "none", replicas: false }] },
  projects: {
    defaults: { conflicts: "primary-wins", replica: "full" },
    overrides: [{ project: "App", ignore: ["/data"] }],
  },
  replicas: { ignore: ["*.log"], rules: [{ project: "App", on: "laptop", when: "always" }] },
};
const runtime = Layer.effect(
  ReplicaRuntime,
  Effect.map(ProjectReplicaService, (service) => ({ get: Effect.succeed(service) })),
);
const seed = Effect.gen(function* () {
  const mesh = yield* MeshLayoutService;
  const h = yield* mesh.nextHlc;
  yield* mesh.edit((config) => ({
    ...config,
    projectTitles: { repo: "App" },
    machines: {
      ...config.machines,
      source: { ...config.machines.source, label: "Studio", tag: "ST", color: "red" },
      replica: { ...config.machines.replica, label: "Laptop", title: "Old laptop" },
    },
  }));
  yield* mesh.apply({
    "mesh.machineBinding/source": { v: null, h },
    "mesh.machineBinding/replica": { v: null, h },
    "mesh.machineBinding/studio": { v: "source", h },
    "mesh.machineBinding/laptop": { v: "replica", h },
    "mesh.config": {
      v: { revision: h, doc: doc as Json, author: "source", writtenAt: "2026-01-01T00:00:00Z" },
      h,
    },
  });
});
it.effect(
  "installs display and permission policy and recreates real sessions when ignores/mode change",
  () => {
    const h = makeReplicaHarness();
    h.validation.flush = Effect.sync(() => h.setSession({ status: "watching" }));
    const dependencies = Layer.effect(
      ReplicaRuntime,
      Effect.map(ProjectReplicaService, (service) => ({
        get: Effect.succeed({
          ...service,
          reconcile: Effect.fail(
            new ReplicaError({
              reason: "unreachable",
              message: "An unrelated project cannot reconcile",
            }),
          ),
        }),
      })),
    ).pipe(Layer.provideMerge(h.layer));
    return Effect.gen(function* () {
      yield* seed;
      const mesh = yield* MeshLayoutService;
      const planners = yield* MeshConfigPlanners;
      const plan = (name: string) => planners.find((planner) => planner.name === name)!;
      const bootstrap = yield* plan("bootstrap").plan(
        {
          ...doc,
          machines: {
            ...doc.machines,
            cloudbox: {
              reach: { address: "https://cloudbox.example" },
              bootstrap: { ssh: "dev@cloudbox", hostKey: "ssh-ed25519 AAAA" },
            },
          },
        },
        undefined,
      );
      expect(bootstrap[0]?.description).toContain("host fingerprint SHA256:");
      expect(bootstrap[0]?.description).toContain("HTTPS pairing via https://cloudbox.example");
      const display = (yield* plan("machines").plan(doc, undefined)).find(
        (a) => a.machine === "laptop",
      )!;
      yield* plan("machines").reconcile(display, doc);
      expect((yield* mesh.read).config.machines.replica).toMatchObject({
        label: "Laptop",
        tag: "LT",
      });
      expect((yield* mesh.read).config.machines.source).toMatchObject({
        label: "Studio",
        tag: "ST",
        color: "blue",
      });
      expect((yield* mesh.read).document["machine/replica"]?.v).not.toHaveProperty("label");
      expect((yield* mesh.read).document["machine/replica"]?.v).not.toHaveProperty("title");
      const permission = (yield* plan("links").plan(doc, undefined)).find(
        (a) => a.server === "replica",
      )!;
      expect(permission.description).toContain("files=none, replicas=false, threads=true");
      const fullAccess = {
        ...doc,
        links: { overrides: [{ between: ["studio", "laptop"] as const, files: "all" as const }] },
      };
      expect((yield* plan("links").plan(fullAccess, undefined))[0]?.description).toContain(
        "files=all",
      );
      yield* plan("links").reconcile(permission, doc);
      expect((yield* mesh.read).document["mesh.linkPolicy/replica/studio"]?.v).toMatchObject({
        files: "none",
        replicas: false,
      });
      const replica = yield* ProjectReplicaService;
      yield* replica.reconcile;
      expect(h.created).toHaveLength(1);
      const updated = { ...doc, replicas: { ...doc.replicas, ignore: ["*.new.log"] } };
      const clock = yield* mesh.nextHlc;
      yield* mesh.apply({
        "mesh.config": {
          h: clock,
          v: { revision: clock, doc: updated as Json, author: "replica", writtenAt: "" },
        },
      });
      const ignore = (yield* plan("ignores").plan(updated, undefined))[0]!;
      yield* plan("ignores").reconcile(ignore, updated);
      expect(h.created).toHaveLength(2);
      expect(h.created[1]?.ignores).toEqual(expect.arrayContaining(["/data", "*.new.log"]));
      expect(
        (yield* mesh.read).config.projectMounts.repo?.find((r) => r.environmentId === "replica")
          ?.mode,
      ).toBe("full");
      yield* plan("conflicts").reconcile((yield* plan("conflicts").plan(doc, undefined))[0]!, doc);
      expect(h.created).toHaveLength(2);
      yield* mesh.edit((config) => ({
        ...config,
        projectMounts: {
          ...config.projectMounts,
          repo: config.projectMounts.repo!.map((rep) =>
            rep.role === "replica" ? { ...rep, ignores: ["/data", "/legacy-only"] } : rep,
          ),
        },
      }));
      yield* plan("ignores").reconcile(ignore, updated);
      expect(
        (yield* mesh.read).config.projectMounts.repo?.find((rep) => rep.role === "replica")
          ?.ignores,
      ).toEqual(["/data", "/legacy-only"]);
      for (const migrated of [true, false]) {
        const next = {
          ...updated,
          projects: {
            ...updated.projects,
            overrides: migrated ? [{ project: "App", ignore: ["/data"] }] : [],
          },
          replicas: {
            ...updated.replicas,
            ignore: migrated ? ["*.new.log", "/legacy-only"] : ["*.new.log"],
          },
        };
        const h = yield* mesh.nextHlc;
        yield* mesh.apply({
          "mesh.config": {
            h,
            v: { revision: h, doc: next as Json, author: "replica", writtenAt: "" },
          },
        });
        yield* plan("ignores").reconcile(ignore, next);
        expect(
          (yield* mesh.read).config.projectMounts.repo?.find((rep) => rep.role === "replica")
            ?.ignores,
        ).toEqual([]);
        if (!migrated) {
          yield* mesh.edit((config) => ({
            ...config,
            projectMounts: {
              ...config.projectMounts,
              repo: config.projectMounts.repo!.map((rep) => {
                if (rep.role !== "replica") return rep;
                const { ignores: _legacy, ...native } = rep;
                return native;
              }),
            },
          }));
          const placement = (yield* mesh.read).document["rep/repo/replica"];
          yield* plan("ignores").reconcile(ignore, next);
          expect((yield* mesh.read).document["rep/repo/replica"]).toEqual(placement);
        }
      }
      expect(h.created.at(-1)?.ignores).not.toContain("/legacy-only");
      expect(h.created.at(-1)?.ignores).not.toContain("/data");
    }).pipe(
      Effect.provide(
        Planners.layer.pipe(
          Layer.provide(
            Layer.succeed(MeshBootstrap, {
              credential: () => Effect.die("Unexpected credential call"),
              reconcile: () => Effect.die("Unexpected bootstrap call"),
            }),
          ),
          Layer.provide(
            Layer.succeed(MeshRollout, {
              trial: false,
              vote: () => Effect.die("Unexpected vote"),
              health: Effect.die("Unexpected health"),
              reconcile: Effect.die("Unexpected rollout"),
              checkTrial: Effect.die("Unexpected trial"),
              finishTrial: Effect.die("Unexpected finish"),
            }),
          ),
          Layer.provide(
            Layer.succeed(MeshAgentKit, {
              reconcile: () => Effect.void,
              legacyInstructions: Effect.succeed("legacy fixture"),
            }),
          ),
          Layer.provide(
            Layer.succeed(MeshSsh, { publicKey: "ssh-ed25519 AAAA", reconcile: () => Effect.void }),
          ),
          Layer.provideMerge(dependencies),
        ),
      ),
    );
  },
);
it.effect(
  "places rule-owned replicas and preserves their files and representation when a rule is removed",
  () => {
    const h = makeReplicaHarness();
    return Effect.gen(function* () {
      yield* seed;
      const mesh = yield* MeshLayoutService;
      yield* mesh.edit((config) => ({
        ...config,
        projectMounts: { repo: config.projectMounts.repo!.filter((r) => r.role === "primary") },
      }));
      const planners = yield* MeshConfigPlanners;
      const replicas = planners.find((planner) => planner.name === "replicas")!;
      const [place] = yield* replicas.plan(doc, undefined);
      expect(place).toMatchObject({ server: "replica", machine: "laptop", project: "repo" });
      yield* replicas.reconcile(place!, doc);
      expect(
        (yield* mesh.read).config.projectMounts.repo?.find((r) => r.environmentId === "replica"),
      ).toMatchObject({ role: "replica", mode: "full" });
      expect(yield* replicas.plan(doc, undefined)).toEqual([]);
      const withoutRules = { ...doc, replicas: { rules: [] } };
      expect(yield* replicas.plan(withoutRules, undefined)).toEqual([]);
      expect(
        (yield* mesh.read).config.projectMounts.repo?.some(
          (rep) => rep.environmentId === "replica",
        ),
      ).toBe(true);
      yield* mesh.edit((config) => ({
        ...config,
        projectMounts: {
          repo: [
            ...config.projectMounts.repo!,
            {
              environmentId: "replica",
              path: "/independent",
              role: "primary" as const,
              transport: "git" as const,
              createdAt: "",
            },
          ],
        },
      }));
      const promotedClock = yield* mesh.nextHlc;
      yield* mesh.apply({ "mesh.configReplica/repo/replica": { v: true, h: promotedClock } });
      expect(yield* replicas.plan(withoutRules, undefined)).toEqual([]);
      expect(
        (yield* mesh.read).config.projectMounts.repo?.find((r) => r.environmentId === "replica"),
      ).toMatchObject({ role: "primary", path: "/independent" });
      expect((yield* mesh.read).document["mesh.configReplica/repo/replica"]?.v).toBe(true);
    }).pipe(
      Effect.provide(
        Planners.layer.pipe(
          Layer.provide(
            Layer.succeed(MeshBootstrap, {
              credential: () => Effect.die("Unexpected credential call"),
              reconcile: () => Effect.die("Unexpected bootstrap call"),
            }),
          ),
          Layer.provide(
            Layer.succeed(MeshRollout, {
              trial: false,
              vote: () => Effect.die("Unexpected vote"),
              health: Effect.die("Unexpected health"),
              reconcile: Effect.die("Unexpected rollout"),
              checkTrial: Effect.die("Unexpected trial"),
              finishTrial: Effect.die("Unexpected finish"),
            }),
          ),
          Layer.provide(
            Layer.succeed(MeshAgentKit, {
              reconcile: () => Effect.void,
              legacyInstructions: Effect.succeed("legacy fixture"),
            }),
          ),
          Layer.provide(
            Layer.succeed(MeshSsh, { publicKey: "ssh-ed25519 AAAA", reconcile: () => Effect.void }),
          ),
          Layer.provideMerge(runtime.pipe(Layer.provideMerge(h.layer))),
        ),
      ),
    );
  },
);
it.effect(
  "reports unbound machines and keeps manual/conditional rules from creating replicas eagerly",
  () => {
    const h = makeReplicaHarness();
    return Effect.gen(function* () {
      yield* seed;
      const planners = yield* MeshConfigPlanners;
      const replicas = planners.find((planner) => planner.name === "replicas")!;
      for (const when of ["manual", "harness-unavailable"] as const)
        expect(
          yield* replicas.plan(
            { ...doc, replicas: { rules: [{ project: "App", on: "laptop", when }] } },
            undefined,
          ),
        ).toEqual([]);
      const machines = planners.find((planner) => planner.name === "machines")!;
      const error = yield* machines
        .reconcile(
          { id: "machines/cloudbox", machine: "cloudbox", server: "replica", description: "" },
          { ...doc, machines: { ...doc.machines, cloudbox: { title: "Cloudbox" } } },
        )
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(MeshConfigError);
      expect(error.message).toContain("has not joined");
      const mesh = yield* MeshLayoutService;
      const joined = { ...doc, machines: { ...doc.machines, cloudbox: { title: "Cloudbox" } } };
      const clock = yield* mesh.nextHlc;
      yield* mesh.apply({
        "machine/cloudbox-env": { v: { title: "Cloudbox" }, h: clock },
        "mesh.config": {
          h: clock,
          v: { revision: clock, doc: joined as Json, author: "replica", writtenAt: "" },
        },
      });
      yield* machines.reconcile(
        { id: "machines/cloudbox", machine: "cloudbox", server: "replica", description: "" },
        joined,
      );
      expect((yield* mesh.read).document["mesh.machineBinding/cloudbox"]?.v).toBe("cloudbox-env");
      expect((yield* mesh.read).config.machines["cloudbox-env"]?.title).toBe("Cloudbox");
    }).pipe(
      Effect.provide(
        Planners.layer.pipe(
          Layer.provide(
            Layer.succeed(MeshBootstrap, {
              credential: () => Effect.die("Unexpected credential call"),
              reconcile: () => Effect.die("Unexpected bootstrap call"),
            }),
          ),
          Layer.provide(
            Layer.succeed(MeshRollout, {
              trial: false,
              vote: () => Effect.die("Unexpected vote"),
              health: Effect.die("Unexpected health"),
              reconcile: Effect.die("Unexpected rollout"),
              checkTrial: Effect.die("Unexpected trial"),
              finishTrial: Effect.die("Unexpected finish"),
            }),
          ),
          Layer.provide(
            Layer.succeed(MeshAgentKit, {
              reconcile: () => Effect.void,
              legacyInstructions: Effect.succeed("legacy fixture"),
            }),
          ),
          Layer.provide(
            Layer.succeed(MeshSsh, { publicKey: "ssh-ed25519 AAAA", reconcile: () => Effect.void }),
          ),
          Layer.provideMerge(runtime.pipe(Layer.provideMerge(h.layer))),
        ),
      ),
    );
  },
);
