import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0084 from "./084_CloseTerminalRunNodes.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("084_CloseTerminalRunNodes", (it) => {
  it.effect("closes open child nodes of terminal runs and leaves active runs alone", () => {
    const logs: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 83 });
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      const old = "2026-10-01T00:00:00.000Z";
      const runs: ReadonlyArray<readonly [string, string, number]> = [
        ["run:completed", "completed", 1],
        ["run:failed", "failed", 2],
        ["run:interrupted", "interrupted", 3],
        ["run:cancelled", "cancelled", 4],
        ["run:running", "running", 5],
      ];
      for (const [runId, status, ordinal] of runs) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, 'thread:fixture', ${ordinal}, 'codex', NULL, ${status},
            ${now}, ${status === "running" ? null : now}, ${JSON.stringify({ id: runId })}
          )
        `;
      }
      yield* sql`
        INSERT INTO orchestration_v2_projection_runtime_requests (
          runtime_request_id, thread_id, node_id, provider_turn_id, kind, status,
          created_at, resolved_at, payload_json
        ) VALUES (
          'request:input', 'thread:fixture', 'node:input-pending', NULL, 'user_input',
          'pending', ${now}, NULL, '{}'
        )
      `;
      const nodes: ReadonlyArray<{
        readonly id: string;
        readonly runId: string;
        readonly kind: string;
        readonly status: string;
        readonly expected: string | null;
        readonly runtimeRequestId?: string;
      }> = [
        {
          id: "node:todo",
          runId: "run:completed",
          kind: "todo_list",
          status: "running",
          expected: "completed",
        },
        {
          id: "node:tool-running",
          runId: "run:interrupted",
          kind: "tool_call",
          status: "running",
          expected: "interrupted",
        },
        {
          id: "node:tool-pending",
          runId: "run:interrupted",
          kind: "tool_call",
          status: "pending",
          expected: "interrupted",
        },
        {
          id: "node:input",
          runId: "run:completed",
          kind: "user_input_request",
          status: "waiting",
          expected: "cancelled",
        },
        {
          id: "node:approval",
          runId: "run:failed",
          kind: "approval_request",
          status: "waiting",
          expected: "cancelled",
        },
        {
          id: "node:tool-cancelled",
          runId: "run:cancelled",
          kind: "tool_call",
          status: "running",
          expected: "interrupted",
        },
        {
          id: "node:input-pending",
          runId: "run:completed",
          kind: "user_input_request",
          status: "waiting",
          expected: null,
          runtimeRequestId: "request:input",
        },
        {
          id: "node:active",
          runId: "run:running",
          kind: "tool_call",
          status: "running",
          expected: null,
        },
      ];
      for (const node of nodes) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_nodes (
            node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status,
            provider_thread_id, provider_turn_id, runtime_request_id, started_at,
            completed_at, payload_json
          ) VALUES (
            ${node.id}, 'thread:fixture', ${node.runId}, NULL, 'node:root', ${node.kind},
            ${node.status}, NULL, NULL, ${node.runtimeRequestId ?? null}, ${old}, NULL,
            ${JSON.stringify({ id: node.id, status: node.status, completedAt: null })}
          )
        `;
      }
      const plans: ReadonlyArray<readonly [string, string, string, string]> = [
        ["plan:todo-completed", "run:completed", "todo_list", "active"],
        ["plan:todo-cancelled", "run:cancelled", "todo_list", "active"],
        ["plan:todo-already", "run:completed", "todo_list", "completed"],
        ["plan:proposed", "run:completed", "proposed_plan", "active"],
      ];
      for (const [planId, runId, kind, status] of plans) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_plans (
            plan_id, thread_id, run_id, node_id, kind, status, payload_json
          ) VALUES (
            ${planId}, 'thread:fixture', ${runId}, ${`node:${planId}`}, ${kind}, ${status},
            ${JSON.stringify({ id: planId, kind, status })}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 84 });

      for (const node of nodes) {
        const row = (yield* sql<{
          readonly status: string;
          readonly completed_at: string | null;
          readonly payload_status: string;
          readonly payload_completed_at: string | null;
        }>`SELECT status, completed_at,
            json_extract(payload_json, '$.status') AS payload_status,
            json_extract(payload_json, '$.completedAt') AS payload_completed_at
          FROM orchestration_v2_projection_nodes WHERE node_id = ${node.id}`)[0]!;
        assert.strictEqual(row.status, node.expected ?? node.status);
        assert.strictEqual(row.payload_status, node.expected ?? node.status);
        if (node.expected === null) {
          assert.isNull(row.completed_at);
          assert.isNull(row.payload_completed_at);
        } else {
          assert.isNotNull(row.completed_at);
          assert.isNotNull(row.payload_completed_at);
        }
      }
      const repairedPlans = yield* sql<{ readonly plan_id: string; readonly status: string }>`
        SELECT plan_id, status FROM orchestration_v2_projection_plans ORDER BY plan_id
      `;
      assert.deepStrictEqual(repairedPlans, [
        { plan_id: "plan:proposed", status: "active" },
        { plan_id: "plan:todo-already", status: "completed" },
        { plan_id: "plan:todo-cancelled", status: "completed" },
        { plan_id: "plan:todo-completed", status: "completed" },
      ]);
      const repairedLogs = logs.map((message) => String(message));
      assert.isTrue(
        repairedLogs.some((message) => message.includes("Closed 6 orphaned nodes")),
        repairedLogs.join("\n"),
      );
      assert.isTrue(
        repairedLogs.some((message) => message.includes("Completed 2 orphaned todo lists")),
        repairedLogs.join("\n"),
      );

      logs.length = 0;
      yield* Migration0084;
      assert.isFalse(logs.some((message) => String(message).includes("orphaned")));
      const afterSecondRun = yield* sql<{ readonly node_id: string; readonly status: string }>`
        SELECT node_id, status FROM orchestration_v2_projection_nodes ORDER BY node_id
      `;
      const expectedSecondRun = [...nodes]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((node) => node.expected ?? node.status);
      assert.deepStrictEqual(
        afterSecondRun.map((row) => row.status),
        expectedSecondRun,
      );
    }).pipe(
      Effect.provide(
        Logger.layer(
          [
            Logger.make(({ message }) => {
              logs.push(message);
            }),
          ],
          { mergeWithExisting: false },
        ),
      ),
    );
  });
});
