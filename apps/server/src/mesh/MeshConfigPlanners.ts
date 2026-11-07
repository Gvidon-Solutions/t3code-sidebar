import { MeshBootstrap } from "./MeshBootstrap.ts";
import { MeshRollout } from "./MeshRollout.ts";
import { MeshAgentKit } from "./MeshAgentKit.ts";
import { MeshSsh } from "../replicas/MeshSsh.ts";
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
    const ssh = yield* MeshSsh;
    const agents = yield* MeshAgentKit;
    const bootstrap = yield* MeshBootstrap;
    const rollout = yield* MeshRollout;
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
        [facts.title, facts.label, facts.tag, ...(facts.aliases ?? [])].some(
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
            description:
              previous?.machines[name]?.label !== doc.machines[name]?.label
                ? `Machine label ${previous?.machines[name]?.label ?? name} → ${doc.machines[name]?.label ?? name}`
                : `Machine ${doc.machines[name]?.title ?? name}`,
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
              ([field]) => !["label", "title", "tag", "color", "aliases", "reach"].includes(field),
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
    const reconcileProject = Effect.fn("MeshConfigPlanners.reconcileProject")(function* (
      key: string,
    ) {
      const state = (yield* snapshot).config;
      const service = yield* replicaService;
      yield* Effect.forEach(
        (state.projectMounts[key] ?? []).filter(
          (rep) => rep.role === "replica" && replicaDriver(state, rep) === mesh.environmentId,
        ),
        (rep) =>
          service.retry({ logicalKey: key, environmentId: rep.environmentId, resume: false }).pipe(
            Effect.mapError(failure),
            Effect.flatMap((status) =>
              status.state === "error"
                ? Effect.fail(
                    new MeshConfigError({
                      reason: "storage",
                      message: status.message ?? status.problems.join("; "),
                    }),
                  )
                : Effect.void,
            ),
          ),
        { concurrency: 4, discard: true },
      );
    });
    const projectActions = Effect.fn("MeshConfigPlanners.projectActions")(function* (kind: string) {
      const state = (yield* snapshot).config;
      return Object.entries(state.projectMounts).flatMap(([key, reps]) => {
        const title = titleOf(state.projectTitles, key);
        return title &&
          reps.some(
            (rep) =>
              rep.role === "replica" &&
              (rep.environmentId === mesh.environmentId ||
                replicaDriver(state, rep) === mesh.environmentId),
          )
          ? [
              {
                id: `${kind}/${key}`,
                server: mesh.environmentId,
                project: key,
                description: `${kind === "ignores" ? "Sync ignores" : "Replica policy"} for ${title}`,
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
                  ? {
                      ...rep,
                      ignores: (rep.ignores ?? []).every((pattern) =>
                        policy.ignore.includes(pattern),
                      )
                        ? []
                        : (rep.ignores ?? []),
                      mode: policy.replica,
                    }
                  : rep,
              ),
            },
          }))
          .pipe(Effect.mapError(failure));
        yield* reconcileProject(key);
      }),
    };
    const conflicts: ConfigPlanner = {
      name: "conflicts",
      plan: Effect.fn("MeshConfigPlanners.conflicts.plan")(() => projectActions("conflicts")),
      reconcile: Effect.fn("MeshConfigPlanners.conflicts.reconcile")(function* (action) {
        yield* reconcileProject(yield* requireProject(action));
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
                description: `Replica of ${title} on ${doc.machines[rule.on]?.title ?? rule.on}`,
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
            (rep) => rep.environmentId === environmentId && rep.role === "replica",
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
          yield* reconcileProject(key);
        }
      }),
    };
    const sshPlanner: ConfigPlanner = {
      name: "ssh",
      plan: Effect.fn("MeshConfigPlanners.ssh.plan")(function* (doc) {
        const bound = bindingsFromLayout((yield* snapshot).document);
        return [
          {
            id: "ssh/blocks",
            server: mesh.environmentId,
            description: "Reconcile managed SSH blocks",
          },
          ...Object.entries(bound)
            .filter(([, id]) => id !== mesh.environmentId)
            .map(([machine]) => ({
              id: `ssh/route/${machine}`,
              server: mesh.environmentId,
              machine,
              description: `Check SSH route to ${machine} (${doc.ssh?.mode ?? "managed"})`,
            })),
        ];
      }),
      reconcile: Effect.fn("MeshConfigPlanners.ssh.reconcile")((action, doc) =>
        ssh.reconcile(doc, action.machine),
      ),
    };
    const agentPlanner: ConfigPlanner = {
      name: "agents",
      plan: Effect.fn("MeshConfigPlanners.agents.plan")(() =>
        Effect.succeed([
          {
            id: "agents/kit",
            server: mesh.environmentId,
            description: "Install bundled t3 skill and managed mesh instructions",
          },
        ]),
      ),
      reconcile: Effect.fn("MeshConfigPlanners.agents.reconcile")(function* (_action, doc) {
        const bindings = bindingsFromLayout((yield* snapshot).document);
        const name = Object.keys(bindings).find((key) => bindings[key] === mesh.environmentId);
        if (!name)
          return yield* new MeshConfigError({
            reason: "validation",
            message: "Local machine binding is unavailable",
          });
        const machine = doc.machines[name];
        yield* agents.reconcile(doc, {
          title: machine?.title ?? name,
          label: machine?.label ?? name,
        });
      }),
    };
    const bootstrapPlanner: ConfigPlanner = {
      name: "bootstrap",
      timeout: "15 minutes",
      plan: Effect.fn("MeshConfigPlanners.bootstrap.plan")(function* (doc) {
        const bound = bindingsFromLayout((yield* snapshot).document);
        return Object.entries(doc.machines)
          .filter(([name, machine]) => machine.bootstrap && !bound[name])
          .map(([name]) => ({
            id: `bootstrap/${name}`,
            machine: name,
            server: mesh.environmentId,
            description: `Bootstrap ${name} over SSH`,
          }));
      }),
      reconcile: Effect.fn("MeshConfigPlanners.bootstrap.reconcile")((action, doc) =>
        action.machine
          ? bootstrap.reconcile(action.machine, doc)
          : Effect.fail(
              new MeshConfigError({ reason: "validation", message: "Missing bootstrap machine" }),
            ),
      ),
    };
    const updatePlanner: ConfigPlanner = {
      name: "updates",
      timeout: "15 minutes",
      plan: Effect.fn("MeshConfigPlanners.updates.plan")((doc) =>
        Effect.succeed(
          doc.t3?.version
            ? [
                {
                  id: "updates/runtime",
                  server: mesh.environmentId,
                  description: `Ensure runtime ${doc.t3.version} through the rolling update lease`,
                },
              ]
            : [],
        ),
      ),
      reconcile: () => rollout.reconcile,
    };
    return MeshConfigPlanners.of([
      bootstrapPlanner,
      updatePlanner,
      machines,
      links,
      sshPlanner,
      replicas,
      ignores,
      conflicts,
      agentPlanner,
    ]);
  }),
);
