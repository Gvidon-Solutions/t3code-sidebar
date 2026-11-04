import {
  CommandId,
  EnvironmentId,
  OrchestratorMcpFailure,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import { threadLinkHref } from "@t3tools/shared/threadLinks";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";

const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

/** A same-machine move only changes the thread's project; it never needs a model. */
export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    readonly move: (
      input: ThreadMoveInput,
    ) => Effect.Effect<ThreadMoveResult, OrchestratorMcpFailure>;
  }
>()("t3/mesh/ThreadMoveService") {}

export const layer = Layer.effect(
  ThreadMoveService,
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const mesh = yield* MeshLayoutService;
    const providers = yield* ProviderRegistry;
    const crypto = yield* Crypto.Crypto;
    const self = EnvironmentId.make(mesh.environmentId);
    const move = Effect.fn("ThreadMoveService.move")(function* (input: ThreadMoveInput) {
      if (input.modelSelection) {
        const selection = input.modelSelection;
        const available = yield* providers.getProviders;
        if (
          !available.some(
            (provider) =>
              provider.enabled &&
              provider.instanceId === selection.instanceId &&
              provider.models.some((model) => model.slug === selection.model),
          )
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The selected model is unavailable on this machine.",
          });
      }
      yield* orchestrator
        .dispatch({
          type: "thread.move",
          commandId:
            input.commandId ??
            CommandId.make(
              yield* crypto
                .randomUUIDv4()
                .pipe(Effect.mapError(() => failure(new Error("Cannot allocate a move id.")))),
            ),
          threadId: input.threadId,
          projectId: input.projectId,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        })
        .pipe(Effect.mapError(failure));
      const snapshot = yield* mesh.read;
      return {
        threadId: input.threadId,
        environmentId: self,
        link: threadLinkHref({ environmentId: self, threadId: input.threadId }),
        machine:
          snapshot.config.machines[self]?.title ??
          snapshot.config.machines[self]?.label ??
          snapshot.config.machines[self]?.tag ??
          "this machine",
      } satisfies ThreadMoveResult;
    });
    return ThreadMoveService.of({ move });
  }),
);
