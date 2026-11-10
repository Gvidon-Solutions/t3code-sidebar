import * as MeshTestServices from "../../testFixtures/meshServices.ts";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProviderInstanceId,
  ProjectId,
  PlanId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "./ProjectionStore.ts";

const layer = ProjectionStore.layer.pipe(Layer.provideMerge(MeshTestServices.layerMemory));

const threadId = ThreadId.make("thread:terminal-nodes");
const runId = RunId.make("run:terminal-nodes");
const otherRunId = RunId.make("run:still-open");
const rootNodeId = NodeId.make("node:root");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "test",
};

const nodeEvent = (
  id: string,
  run: RunId,
  kind: "todo_list" | "tool_call" | "user_input_request",
  status: "pending" | "running" | "waiting",
  now: DateTime.Utc,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:node:${id}`),
  type: "node.updated",
  threadId,
  runId: run,
  nodeId: NodeId.make(id),
  occurredAt: now,
  payload: {
    id: NodeId.make(id),
    threadId,
    runId: run,
    parentNodeId: null,
    rootNodeId,
    kind,
    status,
    countsForRun: kind === "todo_list",
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  },
});

it.effect("terminal run updates close their open child nodes and todo list plan", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadEvent: Extract<OrchestrationV2DomainEvent, { type: "thread.created" }> = {
      id: EventId.make("event:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:terminal-nodes"),
        title: "terminal nodes",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    };
    const startedRun: Extract<OrchestrationV2DomainEvent, { type: "run.created" }> = {
      id: EventId.make("event:run:started"),
      type: "run.created",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:terminal-nodes"),
        rootNodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    };
    const otherRun: Extract<OrchestrationV2DomainEvent, { type: "run.created" }> = {
      ...startedRun,
      id: EventId.make("event:run:other"),
      runId: otherRunId,
      payload: { ...startedRun.payload, id: otherRunId, ordinal: 2 },
    };
    const completedRun: Extract<OrchestrationV2DomainEvent, { type: "run.updated" }> = {
      id: EventId.make("event:run:completed"),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...startedRun.payload, status: "completed", completedAt: now },
    };
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadEvent,
      startedRun,
      otherRun,
      nodeEvent("node:todo", runId, "todo_list", "running", now),
      nodeEvent("node:tool-running", runId, "tool_call", "running", now),
      nodeEvent("node:tool-pending", runId, "tool_call", "pending", now),
      nodeEvent("node:input", runId, "user_input_request", "waiting", now),
      nodeEvent("node:other-tool", otherRunId, "tool_call", "running", now),
      {
        id: EventId.make("event:plan:todo"),
        type: "plan.updated",
        threadId,
        runId,
        nodeId: NodeId.make("node:todo"),
        occurredAt: now,
        payload: {
          id: PlanId.make("plan:todo"),
          threadId,
          runId,
          nodeId: NodeId.make("node:todo"),
          kind: "todo_list",
          status: "active",
          steps: [],
        },
      },
      completedRun,
    ];
    for (const event of events) yield* projections.apply(event);

    const rows = yield* sql<{
      readonly node_id: string;
      readonly status: string;
      readonly completed_at: string | null;
      readonly payload_status: string;
      readonly payload_completed_at: string | null;
    }>`SELECT node_id, status, completed_at,
        json_extract(payload_json, '$.status') AS payload_status,
        json_extract(payload_json, '$.completedAt') AS payload_completed_at
      FROM orchestration_v2_projection_nodes ORDER BY node_id`;
    assert.deepStrictEqual(
      rows.map((row) => ({
        nodeId: row.node_id,
        status: row.status,
        payloadStatus: row.payload_status,
        completed: row.completed_at !== null && row.payload_completed_at !== null,
      })),
      [
        { nodeId: "node:input", status: "cancelled", payloadStatus: "cancelled", completed: true },
        {
          nodeId: "node:other-tool",
          status: "running",
          payloadStatus: "running",
          completed: false,
        },
        {
          nodeId: "node:todo",
          status: "completed",
          payloadStatus: "completed",
          completed: true,
        },
        {
          nodeId: "node:tool-pending",
          status: "interrupted",
          payloadStatus: "interrupted",
          completed: true,
        },
        {
          nodeId: "node:tool-running",
          status: "interrupted",
          payloadStatus: "interrupted",
          completed: true,
        },
      ],
    );
    const plans = yield* sql<{ readonly plan_id: string; readonly status: string }>`
      SELECT plan_id, status FROM orchestration_v2_projection_plans
    `;
    assert.deepStrictEqual(plans, [{ plan_id: "plan:todo", status: "completed" }]);

    const replayed = events.reduce(
      ProjectionStore.applyToProjection,
      ProjectionStore.emptyProjection(threadEvent),
    );
    assert.deepStrictEqual(
      replayed.nodes.map((node) => [node.id, node.status]),
      [
        ["node:todo", "completed"],
        ["node:tool-running", "interrupted"],
        ["node:tool-pending", "interrupted"],
        ["node:input", "cancelled"],
        ["node:other-tool", "running"],
      ],
    );
    assert.strictEqual(replayed.plans[0]?.status, "completed");
  }).pipe(Effect.provide(layer)),
);
