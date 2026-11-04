import { replicaDriver } from "../replicas/replicaModel.ts";
import { MeshConfigError, type MeshConfigDocument } from "@t3tools/contracts";
import {
  bindingsFromLayout,
  effectiveLinkPermissions,
  projectPolicy,
  replicaRules,
} from "@t3tools/shared/meshConfig";
import type { Json } from "@t3tools/shared/meshLayout";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ReplicaRuntime from "../replicas/ReplicaRuntime.ts";
import { MeshConfigPlanners, type ConfigAction, type ConfigPlanner } from "./MeshConfig.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const failure = (error: { message: string }) =>
  new MeshConfigError({ reason: "storage", message: error.message });
const write = Effect.fn("MeshConfigPlanners.write")(function* (key: string, value: Json) {
  const mesh = yield* MeshLayoutService;
  if (same((yield* mesh.read).document[key]?.v, value)) return;
  const h = yield* mesh.nextHlc.pipe(Effect.mapError(failure));
  yield* mesh.apply({ [key]: { v: value, h } }).pipe(Effect.mapError(failure));
});
const requireProject = (action: ConfigAction) =>
  action.project === undefined
    ? Effect.fail(
        new MeshConfigError({ reason: "validation", message: `Missing project for ${action.id}` }),
      )
    : Effect.succeed(action.project);
const titleOf = (titles: Readonly<Record<string, string>>, key: string) => titles[key];

export const layer = Layer.effect(
  MeshConfigPlanners,
  Effect.gen(function* () {
    const mesh = yield* MeshLayoutService;
    const runtime = yield* ReplicaRuntime.ReplicaRuntime;
    const replicaService = runtime.get.pipe(Effect.mapError(failure));
    const snapshot = mesh.read;
    const resolve = Effect.fn("MeshConfigPlanners.resolve")(function* (
      name: string,
      doc: MeshConfigDocument,
    ) {
      const state = yield* snapshot;
      const bindings = bindingsFromLayout(state.document);
      const bound = bindings[name];
      if (bound) return bound;
      const candidates = Object.entries(state.config.machines).filter(([, facts]) =>
        [facts.label, facts.tag, ...(facts.aliases ?? [])].some(
          (alias) => alias === name || alias === doc.machines[name]?.title,
        ),
      );
      if (candidates.length !== 1)
        return yield* new MeshConfigError({
          reason: "validation",
          message: `Machine ${name} has not joined or has an ambiguous identity`,
        });
      const environmentId = candidates[0]![0];
      if (Object.values(bindings).includes(environmentId))
        return yield* new MeshConfigError({
          reason: "validation",
          message: `Machine ${name} is already bound under another name`,
        });
      yield* write(`mesh.machineBinding/${name}`, environmentId);
      return environmentId;
    });
    const machines: ConfigPlanner = {
      name: "machines",
      plan: Effect.fn("MeshConfigPlanners.machines.plan")(function* (doc, previous) {
        const bound = bindingsFromLayout((yield* snapshot).document);
        return Object.keys(doc.machines)
          .filter((name) => !previous || !same(previous.machines[name], doc.machines[name]))
          .map((name) => ({
            id: `machines/${name}`,
            machine: name,
            server: bound[name] ?? mesh.environmentId,
            description: `Apply display for ${name}`,
          }));
      }),
      reconcile: Effect.fn("MeshConfigPlanners.machines.reconcile")(function* (action, doc) {
        if (!action.machine)
          return yield* new MeshConfigError({
            reason: "validation",
            message: "Missing machine name",
          });
        const environmentId = yield* resolve(action.machine, doc);
        const key = `machine/${encodeURIComponent(environmentId)}`;
        const value = (yield* snapshot).document[key]?.v;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const facts = Object.fromEntries(
            Object.entries(value).filter(
              ([field]) => !["label", "tag", "color", "aliases"].includes(field),
            ),
          );
          yield* write(key, facts);
        }
      }),
    };
    const links: ConfigPlanner = {
      name: "links",
      plan: Effect.fn("MeshConfigPlanners.links.plan")(function* (doc) {
        const bound = bindingsFromLayout((yield* snapshot).document);
        return Object.entries(bound)
          .filter(([name]) => doc.machines[name])
          .flatMap(([a, server]) =>
            Object.keys(doc.machines)
              .filter((b) => b !== a)
              .map((b) => ({
                id: `links/${a}/${b}`,
                machine: b,
                server,
                description: `Enforce link permissions between ${a} and ${b}`,
              })),
          );
      }),
      reconcile: Effect.fn("MeshConfigPlanners.links.reconcile")(function* (action, doc) {
        const bound = bindingsFromLayout((yield* snapshot).document);
        const self = Object.keys(bound).find((name) => bound[name] === mesh.environmentId);
        if (!self || !action.machine)
          return yield* new MeshConfigError({
            reason: "validation",
            message: "Link endpoints are not bound",
          });
        yield* write(
          `mesh.linkPolicy/${encodeURIComponent(mesh.environmentId)}/${action.machine}`,
          effectiveLinkPermissions(doc, self, action.machine),
        );
      }),
    };
    const projectActions = Effect.fn("MeshConfigPlanners.projectActions")(function* (kind: string) {
      const state = (yield* snapshot).config;
      return Object.entries(state.projectMounts).flatMap(([key, reps]) => {
        const title = titleOf(state.projectTitles, key);
        return title && reps.some((rep) => rep.environmentId === mesh.environmentId)
          ? [
              {
                id: `${kind}/${key}`,
                server: mesh.environmentId,
                project: key,
                description: `Apply ${kind} to ${title}`,
              },
            ]
          : [];
      });
    });
    const ignores: ConfigPlanner = {
      name: "ignores",
      plan: Effect.fn("MeshConfigPlanners.ignores.plan")(() => projectActions("ignores")),
      reconcile: Effect.fn("MeshConfigPlanners.ignores.reconcile")(function* (action, doc) {
        const key = yield* requireProject(action);
        const state = (yield* snapshot).config;
        const title = titleOf(state.projectTitles, key);
        if (!title)
          return yield* new MeshConfigError({
            reason: "validation",
            message: "Project title is unavailable",
          });
        const policy = projectPolicy(doc, title);
        yield* mesh
          .edit((config) => ({
            ...config,
            projectMounts: {
              ...config.projectMounts,
              [key]: (config.projectMounts[key] ?? []).map((rep) =>
                rep.environmentId === mesh.environmentId && rep.role === "replica"
                  ? { ...rep, ignores: policy.ignore, mode: policy.replica }
                  : rep,
              ),
            },
          }))
          .pipe(Effect.mapError(failure));
        yield* (yield* replicaService).reconcile.pipe(Effect.mapError(failure));
      }),
    };
    const conflicts: ConfigPlanner = {
      name: "conflicts",
      plan: Effect.fn("MeshConfigPlanners.conflicts.plan")(() => projectActions("conflicts")),
      reconcile: Effect.fn("MeshConfigPlanners.conflicts.reconcile")(function* () {
        yield* (yield* replicaService).reconcile.pipe(Effect.mapError(failure));
      }),
    };
    const marker = (key: string, environmentId: string) =>
      `mesh.configReplica/${encodeURIComponent(key)}/${encodeURIComponent(environmentId)}`;
    const replicas: ConfigPlanner = {
      name: "replicas",
      plan: Effect.fn("MeshConfigPlanners.replicas.plan")(function* (doc) {
        const state = yield* snapshot;
        const bound = bindingsFromLayout(state.document);
        const actions: ConfigAction[] = [];
        for (const [key, title] of Object.entries(state.config.projectTitles)) {
          for (const rule of replicaRules(doc, title).filter((rule) => rule.when === "always")) {
            const server = bound[rule.on];
            if (!server) {
              actions.push({
                id: `replicas/unbound/${key}/${rule.on}`,
                server: mesh.environmentId,
                machine: rule.on,
                project: key,
                description: `Wait for ${rule.on} to join`,
              });
              continue;
            }
            const rep = state.config.projectMounts[key]?.find(
              (rep) => rep.environmentId === server,
            );
            if (!rep)
              actions.push({
                id: `replicas/place/${key}/${rule.on}`,
                server,
                machine: rule.on,
                project: key,
                description: `Place ${title} on ${rule.on}`,
              });
          }
          for (const [name, server] of Object.entries(bound)) {
            if (
              state.document[marker(key, server)]?.v !== true ||
              replicaRules(doc, title).some((rule) => rule.on === name)
            )
              continue;
            actions.push({
              id: `replicas/remove/${key}/${name}`,
              server: state.config.projectMounts[key]?.some((rep) => rep.environmentId === server)
                ? (replicaDriver(
                    state.config,
                    state.config.projectMounts[key]!.find((rep) => rep.environmentId === server)!,
                  ) ?? server)
                : server,
              machine: name,
              project: key,
              description: `Remove managed replica ${title} from ${name}`,
            });
          }
        }
        return actions;
      }),
      reconcile: Effect.fn("MeshConfigPlanners.replicas.reconcile")(function* (action, doc) {
        const key = yield* requireProject(action);
        if (!action.machine)
          return yield* new MeshConfigError({
            reason: "validation",
            message: "Missing replica machine",
          });
        const environmentId = yield* resolve(action.machine, doc);
        const title = (yield* snapshot).config.projectTitles[key];
        if (!title)
          return yield* new MeshConfigError({
            reason: "validation",
            message: "Project title is unavailable",
          });
        const remove = action.id.startsWith("replicas/remove/");
        if (
          remove &&
          !(yield* snapshot).config.projectMounts[key]?.some(
            (rep) => rep.environmentId === environmentId,
          )
        ) {
          yield* write(marker(key, environmentId), false);
          return;
        }
        const service = yield* replicaService;
        const policy = projectPolicy(doc, title);
        yield* service
          .place({
            project: title,
            machine: environmentId,
            role: "replica",
            ignores: policy.ignore,
            ...(remove ? { action: "remove" as const } : {}),
          })
          .pipe(Effect.mapError(failure));
        yield* write(marker(key, environmentId), !remove);
        if (!remove) {
          yield* mesh
            .edit((config) => ({
              ...config,
              projectMounts: {
                ...config.projectMounts,
                [key]: (config.projectMounts[key] ?? []).map((rep) =>
                  rep.environmentId === environmentId ? { ...rep, mode: policy.replica } : rep,
                ),
              },
            }))
            .pipe(Effect.mapError(failure));
          yield* service.reconcile.pipe(Effect.mapError(failure));
        }
      }),
    };
    return MeshConfigPlanners.of([machines, links, replicas, ignores, conflicts]);
  }),
);
