import { ReplicaError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as MutagenInstaller from "./MutagenInstaller.ts";
import * as MutagenRunner from "./MutagenRunner.ts";
import * as ReplicaPaths from "./ReplicaPaths.ts";
import * as Replicas from "./ProjectReplicaService.ts";

export class ReplicaRuntime extends Context.Service<
  ReplicaRuntime,
  {
    readonly get: Effect.Effect<Replicas.ProjectReplicaService["Service"], ReplicaError>;
  }
>()("t3/replicas/ReplicaRuntime") {}

const layerManaged = Replicas.layer.pipe(
  Layer.provide(ReplicaPaths.layer),
  Layer.provide(MutagenRunner.layer.pipe(Layer.provide(MutagenInstaller.layer))),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(FetchHttpClient.layer),
);

const layer = Layer.effect(
  ReplicaRuntime,
  Effect.gen(function* () {
    // Older server graphs can serve older clients without a mesh store. Stage C supplies this port.
    const mesh = yield* Effect.serviceOption(MeshLayoutService);
    if (Option.isNone(mesh))
      return ReplicaRuntime.of({
        get: Effect.fail(
          new ReplicaError({
            reason: "disabled",
            message: "The mesh layout service is not available on this server.",
          }),
        ),
      });
    const existing = yield* Effect.serviceOption(Replicas.ProjectReplicaService);
    if (Option.isSome(existing)) {
      yield* existing.value.start;
      return ReplicaRuntime.of({ get: Effect.succeed(existing.value) });
    }
    const context = yield* Layer.build(
      layerManaged.pipe(Layer.provide(Layer.succeed(MeshLayoutService, mesh.value))),
    );
    const service = Context.get(context, Replicas.ProjectReplicaService);
    yield* service.start;
    return ReplicaRuntime.of({ get: Effect.succeed(service) });
  }),
);

export const getService = Effect.serviceOption(ReplicaRuntime).pipe(
  Effect.flatMap((runtime) =>
    Option.isSome(runtime)
      ? runtime.value.get
      : Effect.fail(
          new ReplicaError({
            reason: "disabled",
            message: "Replica runtime is not available on this server.",
          }),
        ),
  ),
);

export const withRuntime = <A, E, R>(base: Layer.Layer<A, E, R>) =>
  Layer.merge(base, layer.pipe(Layer.provide(base)));
