import {
  MeshMachineAddInput,
  MeshVersionUpdateInput,
  MeshUpdateVoteInput,
  MeshUpdateHealth,
  ProjectId,
  SecretRef,
} from "@t3tools/contracts";
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
import * as Path from "effect/Path";

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

import { RunRuntimeInfo } from "../../../run/RunProtocol.ts";
const RunRuntimeTool = Tool.make("t3_run_runtime", {
  ...shared,
  dependencies: [...shared.dependencies, Path.Path],
  description:
    "Read the primary's runtime and terminal module for an authenticated replica connection. Run commands with t3 run.",
  parameters: Tool.EmptyParams,
  success: RunRuntimeInfo,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

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

const MachineAdd = Tool.make("t3_mesh_machine_add", {
  ...shared,
  description:
    "Add a bootstrap machine to mesh config through plan/apply. Credentials are supplied separately through a one-time secret reference.",
  parameters: MeshMachineAddInput,
  success: MeshConfigRevision,
}).annotate(Tool.Destructive, true);
const VersionUpdate = Tool.make("t3_mesh_update", {
  ...shared,
  description: "Plan or apply a target runtime version for the mesh's serialized rolling update.",
  parameters: MeshVersionUpdateInput,
  success: Schema.Union([MeshConfigPlan, MeshConfigRevision]),
}).annotate(Tool.Destructive, true);
const UpdateVote = Tool.make("t3_mesh_update_vote", {
  ...shared,
  description: "Linked-server update lease grant/release. Requires the authenticated lease owner.",
  parameters: MeshUpdateVoteInput,
  success: Schema.Boolean,
}).annotate(Tool.Destructive, true);
const UpdateHealth = Tool.make("t3_mesh_update_health", {
  ...shared,
  description:
    "Read runtime version, layout clocks and replica readiness for update health checks.",
  parameters: Tool.EmptyParams,
  success: MeshUpdateHealth,
}).annotate(Tool.Readonly, true);
const BootstrapCredential = Tool.make("t3_mesh_bootstrap_credential", {
  ...shared,
  description:
    "Provide one-use SSH agent, identity path or password secretRef for an unjoined bootstrap machine. Never put a password in config or tool text.",
  parameters: Schema.Struct({
    name: Schema.String,
    kind: Schema.Literals(["agent", "key", "password"]),
    identityFile: Schema.optionalKey(Schema.String),
    secretRef: Schema.optionalKey(SecretRef),
    projectId: Schema.optionalKey(ProjectId),
  }),
  success: Schema.Struct({ accepted: Schema.Boolean }),
}).annotate(Tool.Destructive, true);
export const MeshToolkit = Toolkit.make(
  MachineAdd,
  VersionUpdate,
  UpdateVote,
  UpdateHealth,
  BootstrapCredential,
  RunRuntimeTool,
  GetTool,
  PlanTool,
  ApplyTool,
  RollbackTool,
  HistoryTool,
  StatusTool,
);
