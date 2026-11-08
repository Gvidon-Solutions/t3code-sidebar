import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EnvironmentId } from "@t3tools/contracts";

import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { callRouted } from "../mesh/MeshRouting.ts";
import { RunRuntimeInfo } from "./RunProtocol.ts";
import type * as Schema from "effect/Schema";
import { configFromLayout } from "@t3tools/shared/meshConfig";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import * as Preparation from "./RunPreparation.ts";
import { DEFAULT_REMOTE_COMMANDS, RunRequest, RunResponse } from "./RunProtocol.ts";
export class RunControl extends Context.Service<
  RunControl,
  {
    readonly request: (
      request: Schema.Schema.Type<typeof RunRequest>,
    ) => Effect.Effect<Schema.Schema.Type<typeof RunResponse>>;
  }
>()("t3/run/RunControl") {}
export const layer = Layer.effect(
  RunControl,
  Effect.gen(function* () {
    const mesh = yield* MeshLayoutService;
    const preparation = yield* Preparation.RunPreparation;
    const links = yield* PeerLinks;
    const peers = yield* PeerMcpClient;
    return RunControl.of({
      request: Effect.fn("RunControl.request")(
        function* (request) {
          const plan =
            request.action === "prepare"
              ? yield* preparation.prepare(request.cwd, request.timeoutMs)
              : yield* preparation.resolve(request.cwd);
          if (request.action === "finish") yield* preparation.finish(plan, request.timeoutMs);
          let resolvedPlan: Schema.Schema.Type<typeof import("./RunProtocol.ts").RunPlan> = plan;
          if (plan.kind === "remote" && request.action === "resolve") {
            const info = yield* callRouted(
              { links: links, peers: peers, self: mesh.environmentId },
              {
                environmentId: EnvironmentId.make(plan.primaryEnvironmentId),
                tool: "t3_run_runtime",
                arguments: {},
                limits: { replicas: true, runtimeMode: "full-access", interactionMode: "default" },
                success: RunRuntimeInfo,
              },
            ).pipe(
              Effect.timeout("3 seconds"),
              Effect.mapError(
                (cause) =>
                  new Preparation.RunPreparationError({
                    reason: "resolution",
                    paths: [],
                    cause: new Error(
                      `Cannot discover the runtime on ${plan.machine}: ${cause instanceof Error ? cause.message : String(cause)}`,
                    ),
                  }),
              ),
            );
            resolvedPlan = { ...plan, runtime: info };
          }
          const doc = configFromLayout((yield* mesh.read).document);
          return {
            ok: true,
            plan: resolvedPlan,
            remoteCommands: doc?.replicas?.remoteCommands ?? DEFAULT_REMOTE_COMMANDS,
          } as const;
        },
        Effect.catchTags({
          RunPreparationError: (error) =>
            Effect.succeed({ ok: false, code: error.exitCode, message: error.message } as const),
        }),
      ),
    });
  }),
);
