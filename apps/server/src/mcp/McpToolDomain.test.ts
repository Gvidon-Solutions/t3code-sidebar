import { expect, it } from "@effect/vitest";
import type * as Tool from "effect/ai/Tool";
import { mcpDomain, mcpDomainByName, registerMcpTools } from "./McpToolDomain.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { FilesToolkit } from "./toolkits/files/tools.ts";
import { HtmlToolkit } from "./toolkits/html/tools.ts";
import { InboxToolkit } from "./toolkits/inbox/tools.ts";
import { MeshToolkit } from "./toolkits/mesh/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { UiToolkit } from "./toolkits/ui/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

it("classifies every advertised tool and derives forwarding policy from those declarations", () => {
  const sets: ReadonlyArray<Readonly<Record<string, Tool.Any>>> = [
    AttachmentToolkit.tools,
    DeviceToolkit.tools,
    EnvironmentToolkit.tools,
    FilesToolkit.tools,
    HtmlToolkit.tools,
    InboxToolkit.tools,
    MeshToolkit.tools,
    OrchestratorToolkit.tools,
    PreviewToolkit.tools,
    PreviewControlsToolkit.tools,
    ProjectToolkit.tools,
    PullRequestsToolkit.tools,
    ThreadToolkit.tools,
    UiToolkit.tools,
    WorktreeToolkit.tools,
  ];
  for (const tools of sets) {
    registerMcpTools(tools);
    for (const tool of Object.values(tools)) {
      expect(mcpDomain(tool), tool.name).toBeDefined();
      expect(mcpDomainByName(tool.name), tool.name).toBe(mcpDomain(tool));
    }
  }
  expect(mcpDomainByName("t3_run_runtime")).toBe("replicas");
  expect(mcpDomainByName("request_secret")).toBe("owner");
});
