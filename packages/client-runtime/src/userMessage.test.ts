import { formatInboxDelivery, InboxIssueId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { GuestMessageId } from "@t3tools/contracts";

import { resolveUserMessagePresentation } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("shows a guest's own words and name, not the attributed text the agent reads", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "user",
        text: "Message from guest Sam, sent by the owner:\n\nWhy?",
        context: {
          guest: {
            guestMessageId: GuestMessageId.make("guest-message:one"),
            name: "Sam",
            text: "Why?",
          },
        },
      }),
    ).toEqual({ text: "Why?", attribution: "guest", scheduledTaskId: undefined, guestName: "Sam" });
  });

  it("attributes older server-sent restart continuations to T3 Code, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "t3code" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });

  it("labels the owner's inbox comment and shows only what they wrote", () => {
    const issueId = InboxIssueId.make("issue-1");
    const text = formatInboxDelivery({
      issueId,
      title: "PFM: model retires",
      kind: "comment",
      text: "Switch to gpt-5.7.",
    });
    expect(
      resolveUserMessagePresentation({
        id: `inbox:${issueId}:entry-1:thread-1`,
        role: "user",
        createdBy: "user",
        text,
      }),
    ).toEqual({
      text: "Switch to gpt-5.7.",
      attribution: "inbox",
      scheduledTaskId: undefined,
      inbox: { issueId, title: "PFM: model retires", kind: "comment" },
    });
    // The same text typed by hand is the user's own message.
    expect(resolveUserMessagePresentation({ role: "user", text })).toMatchObject({
      attribution: null,
    });
  });
});
