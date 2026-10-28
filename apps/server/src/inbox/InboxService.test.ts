// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ChatAttachment,
  ChatAttachmentId,
  type InboxIssueId,
  isInboxIssueUnread,
  type OrchestrationV2ThreadShell,
  parseInboxDelivery,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as InboxService from "./InboxService.ts";

const project = ProjectId.make("project-ops");
const scratch = ProjectId.make("project-scratch");
const cron = ThreadId.make("thread-cron");
const fixer = ThreadId.make("thread-fixer");
const archived = ThreadId.make("thread-archived");

interface Sent {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly createdBy: string;
}

const harness = Effect.gen(function* () {
  const sent = yield* Ref.make<ReadonlyArray<Sent>>([]);
  const launched = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
  const shell = (threadId: ThreadId) =>
    ({
      id: threadId,
      projectId: project,
      title: threadId === cron ? "PFM monitor" : "Fixer",
      deletedAt: null,
    }) as unknown as OrchestrationV2ThreadShell;
  const layer = InboxService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shell(threadId)),
          sendToThread: (input) =>
            input.threadId === archived
              ? Effect.die(new Error("Thread is archived."))
              : Ref.update(sent, (all) => [
                  ...all,
                  {
                    threadId: input.threadId,
                    messageId: input.messageId,
                    text: input.text,
                    attachments: input.attachments,
                    createdBy: input.createdBy,
                  },
                ]).pipe(
                  Effect.as({
                    message: { attachments: input.attachments },
                  } as unknown as ThreadManagementService.ThreadManagementSendResult),
                ),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Ref.update(launched, (all) => [...all, input]).pipe(
              Effect.as({
                threadId: input.threadId!,
                resumed: false,
                projection: {
                  messages: [
                    {
                      id: input.initialMessage?.messageId,
                      attachments: input.initialMessage?.attachments ?? [],
                    },
                  ],
                },
              } as unknown as ThreadLaunchService.ThreadLaunchResult),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/unused",
          ensureScratchProject: Effect.succeed({ projectId: scratch }),
        }),
        ServerSettings.layerTest({}),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-inbox-" })),
    Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );
  return { sent, launched, layer };
});

const fromThread = (threadId: ThreadId): InboxService.InboxCaller => ({
  threadId,
  clientLabel: null,
});

it.effect("one problem is one issue: a repeat updates it, and only news makes it unread", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness;
    yield* Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      const created = yield* inbox.post(fromThread(cron), {
        severity: "attention",
        title: "PFM: model gpt-5.6 retires soon",
        description: "Retires on 2026-11-01.",
        dedupeKey: "pfm:model:gpt-5.6",
      });
      assert.equal(created.outcome, "created");
      let issue = (yield* inbox.get(created.issueId)).issue;
      assert.equal(issue.projectId, project);
      assert.equal(issue.responsibleThreadId, cron);
      assert.deepEqual(issue.source, { kind: "thread", label: "PFM monitor", threadId: cron });
      assert.isTrue(isInboxIssueUnread(issue));
      yield* inbox.markSeen({ issueId: issue.id, sequence: issue.lastSequence });

      // The same check again with a new description: same issue, still read.
      const repeat = yield* inbox.post(fromThread(cron), {
        severity: "attention",
        title: "PFM: model gpt-5.6 retires soon",
        description: "Retires on 2026-11-01. Two services still use it.",
        dedupeKey: "pfm:model:gpt-5.6",
      });
      assert.equal(repeat.outcome, "updated");
      assert.equal(repeat.issueId, created.issueId);
      issue = (yield* inbox.get(created.issueId)).issue;
      assert.equal(issue.repeatCount, 1);
      assert.equal(issue.description, "Retires on 2026-11-01. Two services still use it.");
      assert.isFalse(isInboxIssueUnread(issue));

      // Raising the severity is news.
      yield* inbox.post(fromThread(cron), {
        severity: "action",
        title: "PFM: model gpt-5.6 retires soon",
        description: "Pick a replacement.",
        dedupeKey: "pfm:model:gpt-5.6",
        waitingForOwner: true,
      });
      issue = (yield* inbox.get(created.issueId)).issue;
      assert.equal(issue.severity, "action");
      assert.isTrue(issue.waitingForOwner);
      assert.isTrue(isInboxIssueUnread(issue));
      assert.equal(issue.alertSequence, issue.lastSequence);
      assert.lengthOf(yield* inbox.list({}), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "an owner comment reaches the responsible thread and leaves the agent's flags alone",
  () =>
    Effect.gen(function* () {
      const { layer, sent } = yield* harness;
      yield* Effect.gen(function* () {
        const inbox = yield* InboxService.InboxService;
        const { issueId } = yield* inbox.post(fromThread(cron), {
          severity: "action",
          title: "Banner service: certificate expires in 3 days",
          description: "Renew or switch to ACME?",
          waitingForOwner: true,
        });
        const detail = yield* inbox.ownerComment({ issueId, text: "Why not ACME?" });
        // A question is not a decision: only the agent changes waitingForOwner.
        assert.isTrue(detail.issue.waitingForOwner);
        assert.isFalse(isInboxIssueUnread(detail.issue));
        const comment = detail.entries.at(-1)!;
        assert.equal(comment.author, "owner");
        assert.deepEqual(comment.deliveries, [{ threadId: cron, status: "delivered" }]);

        const [message] = yield* Ref.get(sent);
        assert.equal(message?.threadId, cron);
        assert.equal(message?.createdBy, "user");
        assert.deepEqual(parseInboxDelivery({ id: message!.messageId, text: message!.text }), {
          issueId,
          title: "Banner service: certificate expires in 3 days",
          kind: "comment",
          text: "Why not ACME?",
        });

        const answered = yield* inbox.agentComment(fromThread(cron), {
          issueId,
          text: "ACME needs port 80, which the firewall blocks. Renewing manually today.",
          waitingForOwner: false,
        });
        assert.isFalse(answered.issue.waitingForOwner);
        assert.isTrue(isInboxIssueUnread(answered.issue));
        assert.deepEqual(
          answered.entries.map((entry) => entry.kind),
          ["created", "comment", "comment", "waiting_cleared"],
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a failed delivery is recorded on the comment instead of failing it", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness;
    yield* Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      const { issueId } = yield* inbox.post(fromThread(archived), {
        severity: "info",
        title: "Nightly backup finished",
        description: "All green.",
      });
      const detail = yield* inbox.ownerComment({ issueId, text: "Thanks" });
      const [delivery] = detail.entries.at(-1)!.deliveries;
      assert.equal(delivery?.status, "failed");
      assert.include(delivery?.error ?? "", "archived");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a resolved problem that returns reopens the same issue; the creator hears both", () =>
  Effect.gen(function* () {
    const { layer, sent } = yield* harness;
    yield* Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      const { issueId } = yield* inbox.post(fromThread(cron), {
        severity: "attention",
        title: "PFM: 5xx above 1%",
        description: "Since 09:00.",
        dedupeKey: "pfm:5xx",
      });
      yield* inbox.update(fromThread(cron), { issueId, responsibleThreadId: fixer });
      const resolved = yield* inbox.resolve(fromThread(fixer), {
        dedupeKey: "pfm:5xx",
        resolution: "Rolled back release 41; error rate 0.02% for an hour.",
      });
      assert.equal(resolved.issue.state, "resolved");
      assert.equal(resolved.issue.closedBy, "agent");

      const again = yield* inbox.post(fromThread(cron), {
        severity: "attention",
        title: "PFM: 5xx above 1%",
        description: "Again since 14:00.",
        dedupeKey: "pfm:5xx",
      });
      assert.deepEqual([again.outcome, again.issueId], ["reopened", issueId]);
      const reopened = yield* inbox.get(issueId);
      assert.equal(reopened.issue.state, "open");
      assert.equal(reopened.issue.responsibleThreadId, fixer);
      assert.include(reopened.entries.at(-1)?.text ?? "", "Rolled back release 41");

      // Handover told the fixer; the fixer's resolution told the creator;
      // the cron's reopening told the fixer.
      const notices = (yield* Ref.get(sent)).map((message) => [
        message.threadId,
        parseInboxDelivery({ id: message.messageId, text: message.text })?.text.split(":")[0],
      ]);
      assert.deepEqual(notices, [
        [fixer, "This thread is now responsible for the issue"],
        [cron, "The issue was resolved"],
        [fixer, "The problem came back"],
      ]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("closing as not relevant tells the agent, and a repeat does not reopen it", () =>
  Effect.gen(function* () {
    const { layer, sent } = yield* harness;
    yield* Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      const { issueId } = yield* inbox.post(fromThread(cron), {
        severity: "action",
        title: "Staging disk at 85%",
        description: "Clean up?",
        dedupeKey: "staging:disk",
        waitingForOwner: true,
      });
      const dismissed = yield* inbox.dismiss({ issueId, reason: "Staging is being rebuilt." });
      assert.deepEqual(
        [dismissed.state, dismissed.closedBy, dismissed.closeNote, dismissed.waitingForOwner],
        ["dismissed", "owner", "Staging is being rebuilt.", false],
      );
      const [notice] = yield* Ref.get(sent);
      assert.equal(notice?.threadId, cron);
      assert.include(notice?.text ?? "", "Staging is being rebuilt.");

      const repeat = yield* inbox.post(fromThread(cron), {
        severity: "action",
        title: "Staging disk at 90%",
        description: "Clean up?",
        dedupeKey: "staging:disk",
      });
      assert.deepEqual([repeat.outcome, repeat.state], ["dismissed", "dismissed"]);
      assert.equal((yield* inbox.get(issueId)).issue.state, "dismissed");

      const undone = yield* inbox.undismiss(issueId);
      assert.equal(undone.state, "open");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("the first comment on an issue without a thread starts the responsible thread", () =>
  Effect.gen(function* () {
    const { layer, launched } = yield* harness;
    yield* Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      const { issueId } = yield* inbox.post(
        { threadId: null, clientLabel: "t3ctl" },
        {
          severity: "attention",
          title: "Disk check script: gor at 92%",
          description: "/ is full.",
        },
      );
      const before = (yield* inbox.get(issueId)).issue;
      assert.deepEqual(
        [before.responsibleThreadId, before.projectId, before.source.label],
        [null, null, "t3ctl"],
      );

      const detail = yield* inbox.ownerComment({ issueId, text: "Clear the docker cache." });
      const [launch] = yield* Ref.get(launched);
      assert.equal(launch?.projectId, scratch);
      assert.equal(launch?.title, "Disk check script: gor at 92%");
      // The agent gets the issue as context; the thread shows only the owner's words.
      assert.include(launch?.initialMessage?.text ?? "", "/ is full.");
      assert.equal(
        parseInboxDelivery({
          id: launch!.initialMessage!.messageId!,
          text: launch!.initialMessage!.text,
        })?.text,
        "Clear the docker cache.",
      );
      assert.equal(detail.issue.responsibleThreadId, launch?.threadId);
      assert.deepEqual(detail.issue.threadIds, [launch!.threadId!]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an issue waiting for the owner rises again once a day, silently", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness;
    yield* Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      const { issueId } = yield* inbox.post(fromThread(cron), {
        severity: "action",
        title: "Approve the PFM rollout",
        description: "Ready since Monday.",
        waitingForOwner: true,
      });
      const issue = (yield* inbox.get(issueId)).issue;
      // Reading is not answering.
      yield* inbox.markSeen({ issueId, sequence: issue.lastSequence });

      yield* TestClock.adjust("23 hours");
      assert.equal(yield* inbox.remindDue, 0);
      yield* TestClock.adjust("1 hour");
      // The scheduler's own tick may have run it first; either way it happens once.
      yield* inbox.remindDue;
      const reminded = yield* inbox.get(issueId);
      assert.deepEqual(
        reminded.entries.map((entry) => entry.kind),
        ["created", "reminder"],
      );
      assert.isTrue(isInboxIssueUnread(reminded.issue));
      assert.isTrue(reminded.issue.alertSequence < reminded.issue.lastSequence);
      assert.isTrue(reminded.issue.activityAt > issue.activityAt);
      assert.equal(yield* inbox.remindDue, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rejects comments on unknown issues with a message the agent can act on", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness;
    yield* Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      const error = yield* inbox
        .agentComment(fromThread(cron), { issueId: "issue-missing" as InboxIssueId, text: "Hi" })
        .pipe(Effect.flip);
      assert.equal(error.message, "Inbox issue issue-missing was not found.");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "an owner comment carries uploaded files to the thread and keeps the thread's copies",
  () =>
    Effect.gen(function* () {
      const { layer, sent } = yield* harness;
      yield* Effect.gen(function* () {
        const inbox = yield* InboxService.InboxService;
        const config = yield* ServerConfig.ServerConfig;
        const pendingId = createPendingAttachmentId()!;
        const bytes = new Uint8Array([137, 80, 78, 71]);
        yield* Effect.sync(() => {
          NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`), bytes);
        });
        const upload: ChatAttachment = {
          type: "image",
          id: ChatAttachmentId.make(pendingId),
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
        };
        const { issueId } = yield* inbox.post(fromThread(cron), {
          severity: "action",
          title: "Banner service: layout broken",
          description: "Which one is right?",
        });

        const rejected = yield* inbox.ownerComment({ issueId, text: "  " }).pipe(Effect.flip);
        assert.equal(rejected.message, "A comment needs text or an attachment.");

        // A screenshot alone is a comment.
        const detail = yield* inbox.ownerComment({ issueId, text: "", attachments: [upload] });
        const [message] = yield* Ref.get(sent);
        const delivered = message?.attachments[0];
        assert.equal(delivered?.name, "screenshot.png");
        assert.notEqual(delivered?.id, upload.id);
        const comment = detail.entries.at(-1)!;
        assert.isNull(comment.text);
        assert.deepEqual(comment.attachments, [delivered!]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
