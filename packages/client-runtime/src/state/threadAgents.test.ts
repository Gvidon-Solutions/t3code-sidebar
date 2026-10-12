import { describe, expect, it } from "vite-plus/test";

import {
  type AgentThreadInput,
  groupThreadAgents,
  summarizeThreadAgents,
  threadAgentsLabel,
  threadAgentsOpenByDefault,
} from "./threadAgents.ts";

function thread(
  id: string,
  overrides: Partial<Omit<AgentThreadInput, "lineage">> & {
    parent?: string;
    status?: string;
  } = {},
): AgentThreadInput {
  const { parent, status, ...rest } = overrides;
  return {
    id,
    environmentId: "env",
    createdAt: "2026-10-12T10:00:00.000Z",
    archivedAt: null,
    lineage: parent
      ? { relationshipToParent: "subagent", parentThreadId: parent }
      : { relationshipToParent: null, parentThreadId: null },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: status ? ({ status } as AgentThreadInput["runtime"]) : null,
    ...rest,
  };
}

describe("groupThreadAgents", () => {
  it("hangs subagents, and theirs, under the thread that started them, in launch order", () => {
    const { agentsByRoot, nested } = groupThreadAgents([
      thread("root"),
      thread("b", { parent: "root", createdAt: "2026-10-12T10:02:00.000Z" }),
      thread("a", { parent: "root", createdAt: "2026-10-12T10:01:00.000Z" }),
      thread("a1", { parent: "a", createdAt: "2026-10-12T10:03:00.000Z" }),
      thread("other"),
    ]);
    expect(agentsByRoot.get("env:root")?.map((agent) => agent.id)).toEqual(["a", "b", "a1"]);
    expect([...nested].toSorted()).toEqual(["env:a", "env:a1", "env:b"]);
    expect(agentsByRoot.has("env:other")).toBe(false);
  });

  it("leaves a subagent whose parent is gone as an ordinary row", () => {
    const { agentsByRoot, nested } = groupThreadAgents([
      thread("orphan", { parent: "missing" }),
      thread("root", { archivedAt: "2026-10-12T11:00:00.000Z" }),
      thread("child", { parent: "root" }),
    ]);
    expect(agentsByRoot.size).toBe(0);
    expect(nested.size).toBe(0);
  });
});

describe("summarizeThreadAgents", () => {
  it("counts what the agents are doing", () => {
    const summary = summarizeThreadAgents([
      thread("a", { status: "running" }),
      thread("b", { status: "completed" }),
      thread("c", { hasPendingApprovals: true }),
      thread("d", { status: "failed" }),
    ]);
    expect(summary.states).toEqual(["working", "done", "attention", "failed"]);
    expect(threadAgentsLabel(summary)).toBe("4 agents · 1 needs you · 1 working · 1 failed");
    expect(threadAgentsOpenByDefault(summary)).toBe(true);
  });

  it("folds away once every agent is done", () => {
    const summary = summarizeThreadAgents([thread("a"), thread("b", { status: "completed" })]);
    expect(threadAgentsLabel(summary)).toBe("2 agents · done");
    expect(threadAgentsOpenByDefault(summary)).toBe(false);
  });
});
