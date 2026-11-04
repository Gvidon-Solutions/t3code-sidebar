import { expect, it } from "vite-plus/test";
import { forkEntries, forkText, lastForkableRun, FORK_ITEM_CHAR_LIMIT } from "./forkBundle.ts";
import { MessageId, ThreadId, TurnItemId, ChatAttachmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const now = DateTime.makeUnsafe("2026-11-03T00:00:00Z");
const threadId = ThreadId.make("L-source");
const attachment = {
  id: ChatAttachmentId.make("source-file"),
  type: "file" as const,
  name: "file.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
};
it("copies messages and tool outputs in order, keeps attachments, and marks each truncated item", () => {
  const messageId = MessageId.make("L-user");
  const base = {
    id: TurnItemId.make("L-item"),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const entries = forkEntries({
    messages: [
      {
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Remember the codeword cedar",
        attachments: [attachment],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "user",
        creationSource: "web",
      },
    ],
    turnItems: [
      {
        ...base,
        type: "user_message",
        messageId,
        text: "",
        attachments: [attachment],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "web",
      },
      {
        ...base,
        id: TurnItemId.make("L-tool"),
        ordinal: 2,
        type: "command_execution",
        input: "cat file.txt",
        output: "x".repeat(FORK_ITEM_CHAR_LIMIT + 20),
        exitCode: 0,
      },
      {
        ...base,
        id: TurnItemId.make("L-reasoning"),
        ordinal: 3,
        type: "reasoning",
        text: "private reasoning",
        streaming: false,
      },
    ],
  });
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({
    role: "user",
    text: "Remember the codeword cedar",
    attachments: [attachment],
  });
  expect(entries[1]?.text).toContain("cat file.txt");
  expect(entries[1]?.text).toContain("Truncated:");
  expect(forkText("short")).toBe("short");
  expect(JSON.stringify(entries)).not.toContain("private reasoning");
});

it("uses the last completed turn and ignores a turn that is still running", () => {
  const completed = { status: "completed" as const, ordinal: 1 };
  const running = { status: "running" as const, ordinal: 2 };
  expect(lastForkableRun([completed, running])).toBe(completed);
  expect(lastForkableRun([running])).toBeUndefined();
  expect(
    lastForkableRun([
      completed,
      { status: "failed", ordinal: 3 },
      { status: "waiting", ordinal: 4 },
    ]),
  ).toBe(completed);
});
