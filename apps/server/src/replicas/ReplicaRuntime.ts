import * as ReplicaEnvironment from "./ReplicaEnvironment.ts";
import { ReplicaError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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
  Layer.provide(ReplicaEnvironment.layer),
  Layer.provide(ReplicaPaths.layer),
  Layer.provide(MutagenRunner.layer.pipe(Layer.provide(MutagenInstaller.layer))),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(FetchHttpClient.layer),
);

export const layer = Layer.effect(
  ReplicaRuntime,
  Effect.gen(function* () {
    const service = yield* Replicas.ProjectReplicaService;
    yield* service.start;
    return ReplicaRuntime.of({ get: Effect.succeed(service) });
  }),
);

export const getService = Effect.flatMap(ReplicaRuntime, (runtime) => runtime.get);

export const withRuntime = <A, E, R>(base: Layer.Layer<A, E, R>) =>
  Layer.merge(base, layer.pipe(Layer.provide(layerManaged.pipe(Layer.provide(base)))));
