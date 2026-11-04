import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
    return RunControl.of({
      request: Effect.fn("RunControl.request")(
        function* (request) {
          const plan =
            request.action === "prepare"
              ? yield* preparation.prepare(request.cwd, request.timeoutMs)
              : yield* preparation.resolve(request.cwd);
          if (request.action === "finish") yield* preparation.finish(plan, request.timeoutMs);
          const doc = configFromLayout((yield* mesh.read).document);
          return {
            ok: true,
            plan,
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
