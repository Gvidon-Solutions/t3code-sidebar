import { DeliveryAdmission } from "../../../mesh/DeliveryAdmission.ts";
import { DeliveryDrainError } from "@t3tools/contracts";
import { MeshBootstrap } from "../../../mesh/MeshBootstrap.ts";
import { MeshRollout } from "../../../mesh/MeshRollout.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { bindingsFromLayout } from "@t3tools/shared/meshConfig";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as MeshConfig from "../../../mesh/MeshConfig.ts";
import * as MeshLayout from "../../../mesh/MeshLayoutService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as RunRuntimeInfo from "../../../run/RunRuntimeInfo.ts";
import { MeshToolkit } from "./tools.ts";

const optional = Effect.serviceOption(MeshConfig.MeshConfig).pipe(
  Effect.map((option) => Option.map(option, (value) => value as MeshConfig.MeshConfigService)),
);
const service = optional.pipe(
  Effect.flatMap((option) =>
    Effect.fromOption(
      option,
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The mesh config service is not available on this server.",
        }),
    ),
  ),
);

const snapshot = Effect.gen(function* () {
  const config = yield* service;
  const mesh = yield* Effect.serviceOption(MeshLayout.MeshLayoutService);
  const current = yield* config.current;
  return {
    current: current ?? null,
    bindings: Option.isSome(mesh) ? bindingsFromLayout((yield* mesh.value.read).document) : {},
  };
});

const rollout = Effect.serviceOption(MeshRollout).pipe(
  Effect.flatMap((value) =>
    Effect.fromOption(
      value,
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Mesh rollout is unavailable",
        }),
    ),
  ),
);
const bootstrap = Effect.serviceOption(MeshBootstrap).pipe(
  Effect.flatMap((value) =>
    Effect.fromOption(
      value,
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Mesh bootstrap is unavailable",
        }),
    ),
  ),
);
const admission = Effect.serviceOption(DeliveryAdmission).pipe(
  Effect.flatMap((value) =>
    Effect.fromOption(
      value,
      () => new DeliveryDrainError({ message: "Delivery drain unavailable" }),
    ),
  ),
);
export const layer = McpToolAccess.toLayer(MeshToolkit, {
  t3_delivery_drain: McpToolAccess.writes((input) =>
    admission.pipe(Effect.flatMap((service) => service.drain(input))),
  ),
  t3_delivery_drain_status: McpToolAccess.writes(() =>
    admission.pipe(Effect.flatMap((service) => service.status)),
  ),
  t3_delivery_cancel_drain: McpToolAccess.writes(({ requestId }) =>
    admission.pipe(Effect.flatMap((service) => service.cancel(requestId))),
  ),
  t3_mesh_machine_add: McpToolAccess.writes(({ name, ssh }) =>
    service.pipe(Effect.flatMap((config) => config.addMachine(name, ssh))),
  ),
  t3_mesh_update: McpToolAccess.writes(({ version, plan }) =>
    service.pipe(Effect.flatMap((config) => config.updateVersion(version, plan === true))),
  ),
  t3_mesh_update_health: McpToolAccess.reads(() =>
    rollout.pipe(Effect.flatMap((service) => service.health)),
  ),
  t3_mesh_update_vote: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      if (!scope.client?.linked || scope.client.access !== "full-access")
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Update votes require a trusted full-access mesh connection",
        });
      return yield* (yield* rollout).vote(input);
    }),
  ),
  t3_mesh_bootstrap_credential: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const target = yield* bootstrap;
      let value: string | undefined = input.identityFile;
      if (input.kind === "password") {
        if (!input.secretRef || !input.projectId)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Password bootstrap requires a one-use secretRef and its projectId",
          });
        const secrets = yield* Effect.serviceOption(SecretRequests);
        if (secrets._tag === "None")
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "One-time secret API is unavailable",
          });
        value = yield* secrets.value
          .consume({ ref: input.secretRef, projectId: input.projectId })
          .pipe(
            Effect.mapError(
              () =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "Bootstrap secret reference is invalid, expired or already consumed",
                }),
            ),
          );
      }
      if (input.kind === "key" && !value)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "An SSH identity file is required",
        });
      yield* target.credential(input.name, {
        kind: input.kind,
        ...(value !== undefined ? { value } : {}),
      });
      return { accepted: true };
    }),
  ),
  t3_run_runtime: McpToolAccess.reads(() => RunRuntimeInfo.read()),
  t3_mesh_config_get: McpToolAccess.reads(() => snapshot),
  t3_mesh_config_plan: McpToolAccess.reads(({ doc }) =>
    service.pipe(Effect.flatMap((config) => config.plan(doc))),
  ),
  t3_mesh_config_apply: McpToolAccess.writes(({ doc, baseRevision }) =>
    service.pipe(Effect.flatMap((config) => config.apply(doc, baseRevision))),
  ),
  t3_mesh_config_rollback: McpToolAccess.writes(({ revision }) =>
    service.pipe(Effect.flatMap((config) => config.rollback(revision))),
  ),
  t3_mesh_config_history: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const config = yield* service;
      return { revisions: yield* config.history };
    }),
  ),
  t3_mesh_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const config = yield* service;
      return yield* config.status;
    }),
  ),
});
