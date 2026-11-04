import {
  MessageId,
  TurnItemId,
  type MeshForkOrigin,
  type MeshForkRef,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type HandoffEntry,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

export function planForkRecord(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly origin: MeshForkOrigin;
  readonly now: DateTime.Utc;
  readonly ordinal: number;
  readonly entries: readonly HandoffEntry[];
  readonly marker?: string;
}) {
  const { thread, origin, now } = input;
  const entries = [
    ...(input.marker ? [{ role: "assistant" as const, text: input.marker, attachments: [] }] : []),
    ...input.entries,
  ];
  const messages: OrchestrationV2ConversationMessage[] = entries.map((entry, index) => ({
    ...entry,
    id: MessageId.make(`${origin.id}:fork:message:${index}`),
    threadId: thread.id,
    runId: null,
    nodeId: null,
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: "system",
    creationSource: "server",
  }));
  const items: OrchestrationV2TurnItem[] = messages.map((message, index) => ({
    id: TurnItemId.make(`${origin.id}:fork:item:${index}`),
    threadId: thread.id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal + index,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    ...(message.role === "user"
      ? {
          type: "user_message" as const,
          inputIntent: "turn_start" as const,
          createdBy: "user" as const,
          creationSource: "server" as const,
        }
      : { type: "assistant_message" as const, streaming: false }),
    messageId: message.id,
    text: message.text,
    attachments: message.attachments,
  }));
  return {
    thread: {
      ...thread,
      meshFork: origin,
      updatedAt: now,
      ...(messages.length > 0 ? { historyOrigin: "v1_import" as const } : {}),
      ...(thread.meshForks ? { meshForks: thread.meshForks } : {}),
    },
    messages,
    items,
  };
}

export function planForkLinked(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly fork: MeshForkRef;
  readonly now: DateTime.Utc;
}) {
  const forks = input.thread.meshForks ?? [];
  if (forks.some((entry) => entry.id === input.fork.id)) return input.thread;
  return {
    ...input.thread,
    meshForks: [...forks, input.fork],
    updatedAt: input.now,
  };
}
