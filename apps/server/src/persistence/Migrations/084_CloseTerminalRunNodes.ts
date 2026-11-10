import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  TERMINAL_RUN_NODE_KINDS,
  TERMINAL_RUN_STATUSES,
} from "../../orchestration-v2/TerminalRunNodes.ts";

// Runs can end while providers still leave todo lists, tool calls and questions open.
// Those nodes never close on their own, so drain admission counted them as active work.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repairedAt = DateTime.formatIso(yield* DateTime.now);
  const closed = yield* sql<{ node_id: string }>`
    UPDATE orchestration_v2_projection_nodes
    SET
      status = CASE kind
        WHEN 'todo_list' THEN 'completed'
        WHEN 'tool_call' THEN 'interrupted'
        WHEN 'approval_request' THEN 'cancelled'
        WHEN 'user_input_request' THEN 'cancelled'
        ELSE status
      END,
      completed_at = COALESCE(
        completed_at,
        (
          SELECT run.completed_at
          FROM orchestration_v2_projection_runs AS run
          WHERE run.run_id = orchestration_v2_projection_nodes.run_id
        ),
        ${repairedAt}
      ),
      payload_json = json_set(
        payload_json,
        '$.status',
        CASE kind
          WHEN 'todo_list' THEN 'completed'
          WHEN 'tool_call' THEN 'interrupted'
          WHEN 'approval_request' THEN 'cancelled'
          WHEN 'user_input_request' THEN 'cancelled'
          ELSE json_extract(payload_json, '$.status')
        END,
        '$.completedAt',
        COALESCE(
          completed_at,
          (
            SELECT run.completed_at
            FROM orchestration_v2_projection_runs AS run
            WHERE run.run_id = orchestration_v2_projection_nodes.run_id
          ),
          ${repairedAt}
        )
      )
    WHERE status IN ('pending','running','waiting')
      AND kind IN ${sql.in([...TERMINAL_RUN_NODE_KINDS])}
      AND (
        COALESCE(runtime_request_id, json_extract(payload_json, '$.runtimeRequestId')) IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runtime_requests AS request
          WHERE request.runtime_request_id = COALESCE(
              orchestration_v2_projection_nodes.runtime_request_id,
              json_extract(orchestration_v2_projection_nodes.payload_json, '$.runtimeRequestId')
            )
            AND request.status = 'pending'
        )
      )
      AND run_id IN (
        SELECT run_id FROM orchestration_v2_projection_runs
        WHERE status IN ${sql.in([...TERMINAL_RUN_STATUSES])}
      )
    RETURNING node_id
  `;
  if (closed.length > 0)
    yield* Effect.logInfo(`Closed ${closed.length} orphaned nodes of terminal runs`);

  const completedPlans = yield* sql<{ plan_id: string }>`
    UPDATE orchestration_v2_projection_plans
    SET status = 'completed',
      payload_json = json_set(payload_json, '$.status', 'completed')
    WHERE kind = 'todo_list'
      AND status = 'active'
      AND run_id IN (
        SELECT run_id FROM orchestration_v2_projection_runs
        WHERE status IN ${sql.in([...TERMINAL_RUN_STATUSES])}
      )
    RETURNING plan_id
  `;
  if (completedPlans.length > 0)
    yield* Effect.logInfo(
      `Completed ${completedPlans.length} orphaned todo lists of terminal runs`,
    );
});
