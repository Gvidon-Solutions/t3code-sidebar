import {
  MeshConfigApplyInput,
  MeshConfigHistory,
  MeshConfigPlan,
  MeshConfigPlanInput,
  MeshConfigRevision,
  MeshConfigRollbackInput,
  MeshConfigSnapshot,
  MeshConfigStatus,
  MeshConfigError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, MeshConfigError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const GetTool = Tool.make("t3_mesh_config_get", {
  ...shared,
  description:
    "Read the mesh config: the current revision and document, plus machine-name to environment-id bindings.",
  parameters: Tool.EmptyParams,
  success: MeshConfigSnapshot,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PlanTool = Tool.make("t3_mesh_config_plan", {
  ...shared,
  description:
    "Validate a mesh config document (JSON or YAML) and list the actions reconciliation would take. Stores nothing.",
  parameters: MeshConfigPlanInput,
  success: MeshConfigPlan,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ApplyTool = Tool.make("t3_mesh_config_apply", {
  ...shared,
  description:
    "Store a new mesh config revision. Pass the revision it was based on; a stale base is refused with a path diff.",
  parameters: MeshConfigApplyInput,
  success: MeshConfigRevision,
}).annotate(Tool.Destructive, true);

const RollbackTool = Tool.make("t3_mesh_config_rollback", {
  ...shared,
  description: "Apply an earlier mesh config revision as a new revision.",
  parameters: MeshConfigRollbackInput,
  success: MeshConfigRevision,
}).annotate(Tool.Destructive, true);

const HistoryTool = Tool.make("t3_mesh_config_history", {
  ...shared,
  description: "List stored mesh config revisions, newest first (the last fifty are kept).",
  parameters: Tool.EmptyParams,
  success: MeshConfigHistory,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const StatusTool = Tool.make("t3_mesh_status", {
  ...shared,
  description:
    "Per-server config reconciliation status: each action, whether it is done, in progress or failed, and why.",
  parameters: Tool.EmptyParams,
  success: MeshConfigStatus,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const MeshToolkit = Toolkit.make(
  GetTool,
  PlanTool,
  ApplyTool,
  RollbackTool,
  HistoryTool,
  StatusTool,
);
