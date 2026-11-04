import { MeshConfigError, OrchestratorMcpFailure } from "@t3tools/contracts";
import { bindingsFromLayout } from "@t3tools/shared/meshConfig";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as MeshConfig from "../../../mesh/MeshConfig.ts";
import * as MeshLayout from "../../../mesh/MeshLayoutService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MeshToolkit } from "./tools.ts";

const asFailure = (error: MeshConfigError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "validation" || error.reason === "stale_revision"
        ? "invalid_request"
        : error.reason === "not_found"
          ? "invalid_request"
          : "orchestration_error",
    message:
      error.reason === "stale_revision" && error.diff
        ? `${error.message}\n${error.diff.map((entry) => `${entry.path}: ${JSON.stringify(entry.before)} -> ${JSON.stringify(entry.after)}`).join("\n")}`
        : error.message,
  });

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

export const layer = McpToolAccess.toLayer(MeshToolkit, {
  t3_mesh_config_get: McpToolAccess.reads(() => snapshot),
  t3_mesh_config_plan: McpToolAccess.reads(({ doc }) =>
    service.pipe(
      Effect.flatMap((config) => config.plan(doc)),
      Effect.catchTags({ MeshConfigError: (error) => Effect.fail(asFailure(error)) }),
    ),
  ),
  t3_mesh_config_apply: McpToolAccess.writes(({ doc, baseRevision }) =>
    service.pipe(
      Effect.flatMap((config) => config.apply(doc, baseRevision)),
      Effect.catchTags({ MeshConfigError: (error) => Effect.fail(asFailure(error)) }),
    ),
  ),
  t3_mesh_config_rollback: McpToolAccess.writes(({ revision }) =>
    service.pipe(
      Effect.flatMap((config) => config.rollback(revision)),
      Effect.catchTags({ MeshConfigError: (error) => Effect.fail(asFailure(error)) }),
    ),
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
