import type { OrchestrationV2ExecutionNode } from "@t3tools/contracts";

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "interrupted", "cancelled"] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

/**
 * Open child nodes a run leaves behind when it ends without the provider closing them.
 * A todo list is done, tool calls never finish, and questions can no longer be answered.
 */
const TERMINAL_RUN_NODE_STATUS_BY_KIND = {
  todo_list: "completed",
  tool_call: "interrupted",
  approval_request: "cancelled",
  user_input_request: "cancelled",
} as const satisfies Partial<
  Record<OrchestrationV2ExecutionNode["kind"], OrchestrationV2ExecutionNode["status"]>
>;

type TerminalRunNodeKind = keyof typeof TERMINAL_RUN_NODE_STATUS_BY_KIND;

export const TERMINAL_RUN_NODE_KINDS = Object.keys(
  TERMINAL_RUN_NODE_STATUS_BY_KIND,
) as ReadonlyArray<TerminalRunNodeKind>;

export function isTerminalRunStatus(status: string): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as ReadonlyArray<string>).includes(status);
}

export function terminalRunNodeStatus(kind: string): OrchestrationV2ExecutionNode["status"] | null {
  return kind in TERMINAL_RUN_NODE_STATUS_BY_KIND
    ? TERMINAL_RUN_NODE_STATUS_BY_KIND[kind as TerminalRunNodeKind]
    : null;
}
