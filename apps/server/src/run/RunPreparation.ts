import { ReplicaError, type ReplicaRefInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { bindingsFromLayout, configFromLayout } from "@t3tools/shared/meshConfig";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import { resolveRunPlan } from "./RunPlan.ts";

export class RunSync extends Context.Service<
  RunSync,
  {
    readonly flush: (replica: ReplicaRefInput) => Effect.Effect<boolean, ReplicaError>;
    readonly conflicts: (
      replica: ReplicaRefInput,
    ) => Effect.Effect<readonly string[], ReplicaError>;
    readonly problems: (replica: ReplicaRefInput) => Effect.Effect<readonly string[], ReplicaError>;
  }
>()("t3/run/RunPreparation/RunSync") {}

export class RunPreparationError extends Schema.TaggedError<RunPreparationError>()(
  "RunPreparationError",
  {
    reason: Schema.Literals(["resolution", "sync", "timeout", "files"]),
    paths: Schema.Array(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  get exitCode() {
    return this.reason === "resolution" ? 255 : 75;
  }
  override get message() {
    switch (this.reason) {
      case "resolution":
        return this.cause instanceof Error
          ? this.cause.message
          : "Cannot resolve the replica's primary for t3 run.";
      case "sync":
        return "Replica synchronization failed.";
      case "timeout":
        return "Replica synchronization timed out.";
      case "files":
        return `Replica files block t3 run:\n${this.paths.join("\n")}`;
    }
  }
}

type Plan = ReturnType<typeof resolveRunPlan>;
export class RunPreparation extends Context.Service<
  RunPreparation,
  {
    readonly resolve: (cwd: string) => Effect.Effect<Plan, RunPreparationError>;
    readonly prepare: (
      cwd: string,
      timeout: Duration.Input,
    ) => Effect.Effect<Plan, RunPreparationError>;
    readonly finish: (
      plan: Plan,
      timeout: Duration.Input,
    ) => Effect.Effect<void, RunPreparationError>;
  }
>()("t3/run/RunPreparation") {}

export const layer = Layer.effect(
  RunPreparation,
  Effect.gen(function* () {
    const mesh = yield* MeshLayoutService;
    const sync = yield* RunSync;
    const synchronize = Effect.fn("RunPreparation.synchronize")(function* (
      plan: Extract<Plan, { kind: "remote" }>,
      timeout: Duration.Input,
      check: boolean,
    ) {
      const replica = { logicalKey: plan.logicalKey, environmentId: plan.environmentId };
      yield* Effect.gen(function* () {
        const flushed = yield* sync.flush(replica);
        if (!flushed) return yield* new RunPreparationError({ reason: "sync", paths: [] });
        if (!check) return;
        const conflicts = yield* sync.conflicts(replica);
        const problems = yield* sync.problems(replica);
        const paths = [...new Set([...conflicts, ...problems])];
        if (paths.length) return yield* new RunPreparationError({ reason: "files", paths });
      }).pipe(
        Effect.catchTags({
          ReplicaError: (cause) =>
            Effect.fail(new RunPreparationError({ reason: "sync", paths: [], cause })),
        }),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new RunPreparationError({ reason: "timeout", paths: [] })),
        }),
      );
    });
    const resolve = Effect.fn("RunPreparation.resolve")(function* (cwd: string) {
      const { document, config } = yield* mesh.read;
      const doc = configFromLayout(document);
      return yield* Effect.try({
        try: () =>
          resolveRunPlan({
            cwd,
            config,
            environmentId: mesh.environmentId,
            bindings: bindingsFromLayout(document),
            ...(doc ? { machines: doc.machines, desiredConfig: doc } : {}),
            ...(doc?.ssh?.mode ? { sshMode: doc.ssh.mode } : {}),
          }),
        catch: (cause) => new RunPreparationError({ reason: "resolution", paths: [], cause }),
      });
    });
    return RunPreparation.of({
      resolve,
      prepare: Effect.fn("RunPreparation.prepare")(function* (cwd, timeout) {
        const plan = yield* resolve(cwd);
        if (plan.kind === "remote") yield* synchronize(plan, timeout, true);
        return plan;
      }),
      finish: Effect.fn("RunPreparation.finish")(function* (plan, timeout) {
        if (plan.kind === "remote") yield* synchronize(plan, timeout, false);
      }),
    });
  }),
);
