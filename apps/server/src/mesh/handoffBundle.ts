import type {
  HandoffEntry,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export const HANDOFF_ITEM_CHAR_LIMIT = 32_000;
export function handoffText(text: string): string {
  return text.length <= HANDOFF_ITEM_CHAR_LIMIT
    ? text
    : `${text.slice(0, HANDOFF_ITEM_CHAR_LIMIT)}\n[Truncated: ${text.length - HANDOFF_ITEM_CHAR_LIMIT} characters omitted from this item. Original remains on the source machine.]`;
}
export function handoffEntries(input: {
  readonly messages: readonly OrchestrationV2ConversationMessage[];
  readonly turnItems: readonly OrchestrationV2TurnItem[];
}): HandoffEntry[] {
  const entries: HandoffEntry[] = [];
  const represented = new Set<string>();
  const messages = new Map(input.messages.map((message) => [message.id, message]));
  for (const item of input.turnItems.toSorted((a, b) => a.ordinal - b.ordinal)) {
    if (item.type === "user_message" || item.type === "assistant_message") {
      represented.add(item.messageId);
      const message = messages.get(item.messageId);
      entries.push({
        role: item.type === "user_message" ? "user" : "assistant",
        text: handoffText(message?.text ?? item.text),
        attachments: message?.attachments ?? item.attachments ?? [],
      });
    } else if (
      item.type !== "reasoning" &&
      item.type !== "secret_request" &&
      item.type !== "link_request"
    ) {
      const {
        id: _id,
        threadId: _thread,
        runId: _run,
        nodeId: _node,
        providerThreadId: _pt,
        providerTurnId: _turn,
        nativeItemRef: _native,
        parentItemId: _parent,
        ...content
      } = item;
      entries.push({
        role: "assistant",
        text: handoffText(`Conversation activity: ${JSON.stringify(content)}`),
        attachments: [],
      });
    }
  }
  for (const message of input.messages)
    if (!represented.has(message.id) && message.role !== "system") {
      entries.push({
        role: message.role,
        text: handoffText(message.text),
        attachments: message.attachments,
      });
    }
  return entries;
}
