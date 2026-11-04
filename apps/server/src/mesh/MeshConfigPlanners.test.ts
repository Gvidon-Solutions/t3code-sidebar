import type { Json } from "@t3tools/shared/meshLayout";
import { MeshConfigError, type MeshConfigDocument } from "@t3tools/contracts";
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
      replica: { ...config.machines.replica, label: "Laptop" },
    },
  }));
  yield* mesh.apply({
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
    const dependencies = runtime.pipe(Layer.provideMerge(h.layer));
    return Effect.gen(function* () {
      yield* seed;
      const mesh = yield* MeshLayoutService;
      const planners = yield* MeshConfigPlanners;
      const plan = (name: string) => planners.find((planner) => planner.name === name)!;
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
      const permission = (yield* plan("links").plan(doc, undefined)).find(
        (a) => a.server === "replica",
      )!;
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
    }).pipe(Effect.provide(Planners.layer.pipe(Layer.provideMerge(dependencies))));
  },
);
it.effect("places and removes only rule-owned replicas, including removal after a restart", () => {
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
    const [remove] = yield* replicas.plan(withoutRules, undefined);
    expect(remove?.id).toContain("replicas/remove/");
    h.setSession({ status: "watching", conflicts: [{ root: "unsynced.txt" }] });
    expect((yield* replicas.reconcile(remove!, withoutRules).pipe(Effect.flip)).message).toContain(
      "unsynced.txt",
    );
    expect((yield* mesh.read).document["mesh.configReplica/repo/replica"]?.v).toBe(true);
    h.setSession({ status: "watching", conflicts: [] });
    yield* replicas.reconcile(remove!, withoutRules);
    expect(
      (yield* mesh.read).config.projectMounts.repo?.some((r) => r.environmentId === "replica"),
    ).toBe(false);
    expect(yield* replicas.plan(withoutRules, undefined)).toEqual([]);
    const clock = yield* mesh.nextHlc;
    yield* mesh.apply({ "mesh.configReplica/repo/replica": { v: true, h: clock } });
    const [orphan] = yield* replicas.plan(withoutRules, undefined);
    expect(orphan).toMatchObject({ server: "replica", machine: "laptop" });
    yield* replicas.reconcile(orphan!, withoutRules);
    expect(yield* replicas.plan(withoutRules, undefined)).toEqual([]);
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
    const [promoted] = yield* replicas.plan(withoutRules, undefined);
    yield* replicas.reconcile(promoted!, withoutRules);
    expect(
      (yield* mesh.read).config.projectMounts.repo?.find((r) => r.environmentId === "replica"),
    ).toMatchObject({ role: "primary", path: "/independent" });
    expect((yield* mesh.read).document["mesh.configReplica/repo/replica"]?.v).toBe(false);
  }).pipe(
    Effect.provide(
      Planners.layer.pipe(Layer.provideMerge(runtime.pipe(Layer.provideMerge(h.layer)))),
    ),
  );
});
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
    }).pipe(
      Effect.provide(
        Planners.layer.pipe(Layer.provideMerge(runtime.pipe(Layer.provideMerge(h.layer)))),
      ),
    );
  },
);
