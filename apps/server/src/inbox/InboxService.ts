import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  formatInboxDelivery,
  INBOX_CONTEXT_SEPARATOR,
  INBOX_SEVERITY_RANK,
  InboxEntry,
  InboxEntryId,
  InboxError,
  InboxIssue,
  InboxIssueId,
  inboxDeliveryMessageId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  ChatAttachment,
  type InboxAgentCommentInput,
  type InboxAuthor,
  type InboxDelivery,
  type InboxDismissInput,
  type InboxEntryKind,
  type InboxIssueDetail,
  type InboxListInput,
  type InboxMarkSeenInput,
  type InboxOwnerCommentInput,
  type InboxPostInput,
  type InboxPostResult,
  type InboxResolveInput,
  type InboxSnapshot,
  type InboxSource,
  type InboxSubscribeInput,
  type InboxUpdateInput,
  type OrchestrationV2Actor,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";

/** An issue waiting for the owner rises to the top again after this long without an answer. */
export const INBOX_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Closed issues a subscription carries unless the client asks for more. */
const DEFAULT_CLOSED_LIMIT = 30;

/** Who calls the agent-facing methods: a T3 thread, or an MCP client T3 did not launch. */
export interface InboxCaller {
  readonly threadId: ThreadId | null;
  readonly clientLabel: string | null;
}

export class InboxService extends Context.Service<
  InboxService,
  {
    readonly subscribe: (input: InboxSubscribeInput) => Stream.Stream<InboxSnapshot, InboxError>;
    readonly subscribeIssue: (issueId: InboxIssueId) => Stream.Stream<InboxIssueDetail, InboxError>;
    readonly get: (issueId: InboxIssueId) => Effect.Effect<InboxIssueDetail, InboxError>;
    readonly list: (input: InboxListInput) => Effect.Effect<ReadonlyArray<InboxIssue>, InboxError>;
    // Agents, through MCP.
    readonly post: (
      caller: InboxCaller,
      input: InboxPostInput,
    ) => Effect.Effect<InboxPostResult, InboxError>;
    readonly agentComment: (
      caller: InboxCaller,
      input: InboxAgentCommentInput,
    ) => Effect.Effect<InboxIssueDetail, InboxError>;
    readonly update: (
      caller: InboxCaller,
      input: InboxUpdateInput,
    ) => Effect.Effect<InboxIssueDetail, InboxError>;
    readonly resolve: (
      caller: InboxCaller,
      input: InboxResolveInput,
    ) => Effect.Effect<InboxIssueDetail, InboxError>;
    // The owner, through the clients.
    readonly ownerComment: (
      input: InboxOwnerCommentInput,
    ) => Effect.Effect<InboxIssueDetail, InboxError>;
    readonly markSeen: (input: InboxMarkSeenInput) => Effect.Effect<InboxIssue, InboxError>;
    readonly dismiss: (input: InboxDismissInput) => Effect.Effect<InboxIssue, InboxError>;
    readonly undismiss: (issueId: InboxIssueId) => Effect.Effect<InboxIssue, InboxError>;
    /** Raises issues that waited a day for the owner; returns how many. Run by the scheduler. */
    readonly remindDue: Effect.Effect<number, InboxError>;
  }
>()("t3/inbox/InboxService") {}

interface IssueRow {
  readonly issue_id: string;
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  readonly state: string;
  readonly waiting_for_owner: number;
  readonly waiting_since: string | null;
  readonly last_reminder_at: string | null;
  readonly project_id: string | null;
  readonly responsible_thread_id: string | null;
  readonly creator_thread_id: string | null;
  readonly thread_ids_json: string;
  readonly source_json: string;
  readonly dedupe_key: string | null;
  readonly repeat_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly activity_at: string;
  readonly closed_at: string | null;
  readonly closed_by: string | null;
  readonly close_note: string | null;
  readonly last_sequence: number;
  readonly notable_sequence: number;
  readonly alert_sequence: number;
  readonly seen_sequence: number;
}

interface EntryRow {
  readonly entry_id: string;
  readonly issue_id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly author: string;
  readonly thread_id: string | null;
  readonly text: string | null;
  readonly created_at: string;
  readonly deliveries_json: string;
  readonly attachments_json: string;
}

const decodeIssue = Schema.decodeUnknownEffect(InboxIssue);
const isInboxError = Schema.is(InboxError);
const decodeEntry = Schema.decodeUnknownEffect(InboxEntry);
const encodeAttachments = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ChatAttachment)));
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const corrupt = (what: string) => () =>
  new InboxError({ message: `An inbox ${what} in the database could not be read.` });

const issueFromRow = (row: IssueRow): Effect.Effect<InboxIssue, InboxError> =>
  decodeIssue({
    id: row.issue_id,
    severity: row.severity,
    title: row.title,
    description: row.description,
    state: row.state,
    waitingForOwner: row.waiting_for_owner === 1,
    waitingSince: row.waiting_since,
    projectId: row.project_id,
    responsibleThreadId: row.responsible_thread_id,
    creatorThreadId: row.creator_thread_id,
    threadIds: parseJson(row.thread_ids_json) ?? [],
    source: parseJson(row.source_json),
    dedupeKey: row.dedupe_key,
    repeatCount: row.repeat_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activityAt: row.activity_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closeNote: row.close_note,
    lastSequence: row.last_sequence,
    notableSequence: row.notable_sequence,
    alertSequence: row.alert_sequence,
    seenSequence: row.seen_sequence,
  }).pipe(Effect.mapError(corrupt("issue")));

const entryFromRow = (row: EntryRow): Effect.Effect<InboxEntry, InboxError> => {
  const attachments = parseJson(row.attachments_json);
  return decodeEntry({
    id: row.entry_id,
    issueId: row.issue_id,
    sequence: row.sequence,
    kind: row.kind,
    author: row.author,
    threadId: row.thread_id,
    text: row.text,
    createdAt: row.created_at,
    deliveries: parseJson(row.deliveries_json) ?? [],
    ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {}),
  }).pipe(Effect.mapError(corrupt("entry")));
};

/**
 * The inbox keeps its own tables instead of a numbered migration: the
 * migrator only runs ids above the newest one a database recorded, so a fork
 * migration in upstream's sequence would silently skip upstream's next
 * migration with that id. Schema changes here must stay additive and
 * idempotent (check `PRAGMA table_info` before `ALTER TABLE`).
 */
export const ensureSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_inbox_issues (
      issue_id TEXT PRIMARY KEY,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      state TEXT NOT NULL,
      waiting_for_owner INTEGER NOT NULL DEFAULT 0,
      waiting_since TEXT,
      last_reminder_at TEXT,
      project_id TEXT,
      responsible_thread_id TEXT,
      creator_thread_id TEXT,
      thread_ids_json TEXT NOT NULL,
      source_json TEXT NOT NULL,
      dedupe_key TEXT,
      repeat_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activity_at TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT,
      close_note TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      notable_sequence INTEGER NOT NULL DEFAULT 0,
      alert_sequence INTEGER NOT NULL DEFAULT 0,
      seen_sequence INTEGER NOT NULL DEFAULT 0
    )
  `;
  // One open issue per problem; closed ones keep their key for reopening.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS fork_inbox_issues_open_dedupe
    ON fork_inbox_issues (dedupe_key) WHERE dedupe_key IS NOT NULL AND state = 'open'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_inbox_issues_state_closed
    ON fork_inbox_issues (state, closed_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_inbox_entries (
      entry_id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      author TEXT NOT NULL,
      thread_id TEXT,
      text TEXT,
      created_at TEXT NOT NULL,
      deliveries_json TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE (issue_id, sequence)
    )
  `;
  // Added after the first release: databases from then lack the column.
  const entryColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(fork_inbox_entries)
  `;
  if (!entryColumns.some((column) => column.name === "attachments_json")) {
    yield* sql`
      ALTER TABLE fork_inbox_entries ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});

/** How an entry changes the issue's read and alert markers. */
interface EntryEffect {
  /** Makes the issue unread (blue counter) and raises it in the list. */
  readonly notable: boolean;
  /** Clients announce it with a notification. */
  readonly alert: boolean;
}

const SILENT: EntryEffect = { notable: false, alert: false };
const NEWS: EntryEffect = { notable: true, alert: true };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const singleLine = (text: string) => text.replace(/\s+/g, " ").trim();

export const layer = Layer.effect(
  InboxService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const settings = yield* ServerSettings.ServerSettingsService;
    const scheduler = yield* Scheduler.Scheduler;
    // Owner comments go through the same intake as the composer, which claims uploaded files.
    const intakeContext = yield* Effect.context<
      | ThreadManagementService.ThreadManagementService
      | ThreadLaunchService.ThreadLaunchService
      | FileSystem.FileSystem
      | ServerConfig.ServerConfig
    >();

    yield* ensureSchema.pipe(Effect.orDie);

    // Sliding(1): every signal re-reads the list, so only the latest matters.
    const changes = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    // One writer at a time keeps sequences gapless and dedupe checks honest.
    const writeLock = yield* Semaphore.make(1);

    const fail = (message: string, issueId?: InboxIssueId) =>
      new InboxError({ message, ...(issueId === undefined ? {} : { issueId }) });
    const storageError = (cause: unknown) =>
      fail(`Inbox storage failed: ${cause instanceof Error ? cause.message : String(cause)}`);

    const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));
    const newId = crypto.randomUUIDv4().pipe(Effect.orDie);

    const findIssue = (issueId: InboxIssueId) =>
      sql<IssueRow>`SELECT * FROM fork_inbox_issues WHERE issue_id = ${issueId}`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : issueFromRow(rows[0]),
        ),
        Effect.mapError(storageError),
      );

    const requireIssue = (issueId: InboxIssueId) =>
      findIssue(issueId).pipe(
        Effect.flatMap((issue) =>
          issue === null
            ? Effect.fail(fail(`Inbox issue ${issueId} was not found.`, issueId))
            : Effect.succeed(issue),
        ),
      );

    const listEntries = (issueId: InboxIssueId) =>
      sql<EntryRow>`
        SELECT * FROM fork_inbox_entries WHERE issue_id = ${issueId} ORDER BY sequence ASC
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, entryFromRow)),
        Effect.mapError(storageError),
      );

    const get = (issueId: InboxIssueId) =>
      Effect.all({ issue: requireIssue(issueId), entries: listEntries(issueId) });

    const writeIssue = (issue: InboxIssue, lastReminderAt: string | null) =>
      sql`
        INSERT OR REPLACE INTO fork_inbox_issues ${sql.insert({
          issue_id: issue.id,
          severity: issue.severity,
          title: issue.title,
          description: issue.description,
          state: issue.state,
          waiting_for_owner: issue.waitingForOwner ? 1 : 0,
          waiting_since: issue.waitingSince,
          last_reminder_at: lastReminderAt,
          project_id: issue.projectId,
          responsible_thread_id: issue.responsibleThreadId,
          creator_thread_id: issue.creatorThreadId,
          thread_ids_json: JSON.stringify(issue.threadIds),
          source_json: JSON.stringify(issue.source),
          dedupe_key: issue.dedupeKey,
          repeat_count: issue.repeatCount,
          created_at: issue.createdAt,
          updated_at: issue.updatedAt,
          activity_at: issue.activityAt,
          closed_at: issue.closedAt,
          closed_by: issue.closedBy,
          close_note: issue.closeNote,
          last_sequence: issue.lastSequence,
          notable_sequence: issue.notableSequence,
          alert_sequence: issue.alertSequence,
          seen_sequence: issue.seenSequence,
        })}
      `.pipe(Effect.mapError(storageError));

    const readReminderAt = (issueId: InboxIssueId) =>
      sql<{ readonly last_reminder_at: string | null }>`
        SELECT last_reminder_at FROM fork_inbox_issues WHERE issue_id = ${issueId}
      `.pipe(
        Effect.map((rows) => rows[0]?.last_reminder_at ?? null),
        Effect.mapError(storageError),
      );

    /**
     * Appends one entry and applies its markers to `issue`. The caller has
     * already changed the issue's fields; this stamps sequences and times.
     */
    const appendEntry = Effect.fn("InboxService.appendEntry")(function* (
      issue: Mutable<InboxIssue>,
      entry: {
        readonly kind: InboxEntryKind;
        readonly author: InboxAuthor;
        readonly threadId: ThreadId | null;
        readonly text: string | null;
        readonly attachments?: ReadonlyArray<ChatAttachment>;
      },
      effect: EntryEffect,
      now: string,
    ) {
      const id = InboxEntryId.make(yield* newId);
      const sequence = issue.lastSequence + 1;
      issue.lastSequence = sequence;
      issue.updatedAt = now;
      if (effect.notable) {
        issue.notableSequence = sequence;
        issue.activityAt = now;
      }
      if (effect.alert) issue.alertSequence = sequence;
      // The owner has seen what they wrote or did themselves.
      if (entry.author === "owner") issue.seenSequence = sequence;
      yield* sql`
        INSERT INTO fork_inbox_entries ${sql.insert({
          entry_id: id,
          issue_id: issue.id,
          sequence,
          kind: entry.kind,
          author: entry.author,
          thread_id: entry.threadId,
          text: entry.text,
          created_at: now,
          deliveries_json: "[]",
          attachments_json: encodeAttachments(entry.attachments ?? []),
        })}
      `.pipe(Effect.mapError(storageError));
      return id;
    });

    /** Swaps the pending upload refs for the copies the thread received, which outlive the uploads. */
    const recordAttachments = (
      entryId: InboxEntryId,
      attachments: ReadonlyArray<ChatAttachment>,
    ) =>
      attachments.length === 0
        ? Effect.void
        : sql`
            UPDATE fork_inbox_entries SET attachments_json = ${encodeAttachments(attachments)}
            WHERE entry_id = ${entryId}
          `.pipe(Effect.mapError(storageError), Effect.asVoid);

    const recordDeliveries = (entryId: InboxEntryId, deliveries: ReadonlyArray<InboxDelivery>) =>
      deliveries.length === 0
        ? Effect.void
        : sql`
            UPDATE fork_inbox_entries SET deliveries_json = ${JSON.stringify(deliveries)}
            WHERE entry_id = ${entryId}
          `.pipe(Effect.mapError(storageError), Effect.asVoid);

    /**
     * Sends a message into a thread; a failure is recorded on the entry, never
     * raised. Also returns the attachments as the thread received them.
     */
    const deliver = Effect.fn("InboxService.deliver")(function* (input: {
      readonly issue: InboxIssue;
      readonly entryId: InboxEntryId;
      readonly threadId: ThreadId;
      readonly kind: "comment" | "notice";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly createdBy: OrchestrationV2Actor;
    }) {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const shell = yield* threadManagement.getThreadShell(input.threadId);
          if (shell === null || shell.deletedAt !== null) {
            return yield* Effect.fail(fail("The thread no longer exists."));
          }
          const sent = yield* ThreadMessageIntake.sendToThread({
            projectId: shell.projectId,
            commandId: CommandId.make(`inbox:${input.entryId}:${input.threadId}`),
            threadId: input.threadId,
            messageId: MessageId.make(
              inboxDeliveryMessageId(input.issue.id, input.entryId, input.threadId),
            ),
            text: formatInboxDelivery({
              issueId: input.issue.id,
              title: input.issue.title,
              kind: input.kind,
              text: input.text,
            }),
            attachments: input.attachments ?? [],
            // Wait for a running turn instead of interrupting the agent's tools.
            mode: "queue",
            createdBy: input.createdBy,
            creationSource: "server",
          }).pipe(Effect.provide(intakeContext));
          return sent.message.attachments;
        }),
      );
      return Exit.isSuccess(exit)
        ? {
            delivery: { threadId: input.threadId, status: "delivered" } satisfies InboxDelivery,
            attachments: exit.value,
          }
        : {
            delivery: {
              threadId: input.threadId,
              status: "failed",
              error: describeCause(exit.cause),
            } satisfies InboxDelivery,
            attachments: [],
          };
    });

    /** Tells the issue's threads about something another party did, skipping that party. */
    const noticeThreads = Effect.fn("InboxService.noticeThreads")(function* (
      issue: InboxIssue,
      entryId: InboxEntryId,
      text: string,
      actorThreadId: ThreadId | null,
      extra: ReadonlyArray<ThreadId> = [],
    ) {
      const targets = [
        ...new Set(
          [issue.responsibleThreadId, issue.creatorThreadId, ...extra].filter(
            (threadId): threadId is ThreadId => threadId !== null && threadId !== actorThreadId,
          ),
        ),
      ];
      const deliveries = yield* Effect.forEach(targets, (threadId) =>
        deliver({ issue, entryId, threadId, kind: "notice", text, createdBy: "system" }).pipe(
          Effect.map((outcome) => outcome.delivery),
        ),
      );
      yield* recordDeliveries(entryId, deliveries);
    });

    const sourceFor = Effect.fn("InboxService.sourceFor")(function* (caller: InboxCaller) {
      if (caller.threadId === null) {
        return {
          source: { kind: "client", label: caller.clientLabel ?? "MCP client" } as InboxSource,
          projectId: null,
        };
      }
      const shell = yield* threadManagement
        .getThreadShell(caller.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const taskId = yield* latestScheduledTask(caller.threadId);
      const source: InboxSource =
        taskId === null
          ? { kind: "thread", label: shell?.title ?? "Thread", threadId: caller.threadId }
          : {
              kind: "scheduled_task",
              label: taskId.title,
              threadId: caller.threadId,
              scheduledTaskId: taskId.id,
            };
      return { source, projectId: shell?.projectId ?? null };
    });

    /**
     * The scheduled task behind a thread: the newest user message it sent.
     * Read straight from the projection, since threads keep no task link.
     */
    const latestScheduledTask = (threadId: ThreadId) =>
      sql<{ readonly task_id: string | null; readonly title: string | null }>`
        SELECT message.task_id AS task_id, task.title AS title
        FROM (
          SELECT json_extract(payload_json, '$.scheduledTaskId') AS task_id
          FROM orchestration_v2_projection_messages
          WHERE thread_id = ${threadId}
            AND role = 'user'
            AND json_extract(payload_json, '$.scheduledTaskId') IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        ) AS message
        LEFT JOIN scheduled_tasks AS task ON task.task_id = message.task_id
      `.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          return row?.task_id == null
            ? null
            : { id: ScheduledTaskId.make(row.task_id), title: row.title ?? "Scheduled task" };
        }),
        Effect.orElseSucceed(() => null),
      );

    const withThread = (threadIds: ReadonlyArray<ThreadId>, ...more: Array<ThreadId | null>) => {
      const next = [...threadIds];
      for (const threadId of more) {
        if (threadId !== null && !next.includes(threadId)) next.push(threadId);
      }
      return next;
    };

    /** Applies a waitingForOwner change and logs it; returns whether it changed. */
    const applyWaiting = Effect.fn("InboxService.applyWaiting")(function* (
      issue: Mutable<InboxIssue>,
      waiting: boolean | undefined,
      threadId: ThreadId | null,
      now: string,
    ) {
      if (waiting === undefined || waiting === issue.waitingForOwner) return false;
      issue.waitingForOwner = waiting;
      issue.waitingSince = waiting ? now : null;
      yield* appendEntry(
        issue,
        { kind: waiting ? "waiting" : "waiting_cleared", author: "agent", threadId, text: null },
        waiting ? NEWS : SILENT,
        now,
      );
      return true;
    });

    const commit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      writeLock
        .withPermits(1)(
          sql
            .withTransaction(effect)
            .pipe(Effect.mapError((error) => (isInboxError(error) ? error : storageError(error)))),
        )
        .pipe(Effect.tap(() => notifyChanged));

    const post: InboxService["Service"]["post"] = Effect.fn("InboxService.post")(
      function* (caller, input) {
        const { source, projectId: callerProjectId } = yield* sourceFor(caller);
        const result = yield* commit(
          Effect.gen(function* () {
            const now = yield* nowIso;
            const title = singleLine(input.title);
            const extraThreads = input.threadIds ?? [];
            const existing =
              input.dedupeKey === undefined
                ? null
                : yield* sql<IssueRow>`
                    SELECT * FROM fork_inbox_issues WHERE dedupe_key = ${input.dedupeKey}
                    ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, closed_at DESC
                    LIMIT 1
                  `.pipe(
                    Effect.flatMap((rows) =>
                      rows[0] === undefined ? Effect.succeed(null) : issueFromRow(rows[0]),
                    ),
                  );

            if (existing === null) {
              const issue: Mutable<InboxIssue> = {
                id: InboxIssueId.make(`issue-${yield* newId}`),
                severity: input.severity,
                title,
                description: input.description,
                state: "open",
                waitingForOwner: input.waitingForOwner ?? false,
                waitingSince: input.waitingForOwner === true ? now : null,
                projectId: input.projectId ?? callerProjectId,
                responsibleThreadId: caller.threadId,
                creatorThreadId: caller.threadId,
                threadIds: withThread([], caller.threadId, ...extraThreads),
                source,
                dedupeKey: input.dedupeKey ?? null,
                repeatCount: 0,
                createdAt: now,
                updatedAt: now,
                activityAt: now,
                closedAt: null,
                closedBy: null,
                closeNote: null,
                lastSequence: 0,
                notableSequence: 0,
                alertSequence: 0,
                seenSequence: 0,
              };
              yield* appendEntry(
                issue,
                { kind: "created", author: "agent", threadId: caller.threadId, text: null },
                NEWS,
                now,
              );
              yield* writeIssue(issue, null);
              return {
                issue: issue as InboxIssue,
                notice: null,
                result: {
                  issueId: issue.id,
                  outcome: "created",
                  state: "open",
                  message:
                    caller.threadId === null
                      ? `Created inbox issue ${issue.id}. No thread is responsible for it yet: the owner's first comment starts one.`
                      : `Created inbox issue ${issue.id}. You are responsible for it: comment on progress with inbox_comment and close it with inbox_resolve once verified.`,
                } satisfies InboxPostResult,
              };
            }

            const issue: Mutable<InboxIssue> = { ...existing };
            const reminderAt = yield* readReminderAt(issue.id);
            issue.threadIds = withThread(issue.threadIds, caller.threadId, ...extraThreads);
            issue.repeatCount += 1;

            if (existing.state === "dismissed") {
              // The owner decided this is not relevant; a repeat is only logged.
              yield* appendEntry(
                issue,
                { kind: "repeated", author: "agent", threadId: caller.threadId, text: title },
                SILENT,
                now,
              );
              yield* writeIssue(issue, reminderAt);
              return {
                issue: issue as InboxIssue,
                notice: null,
                result: {
                  issueId: issue.id,
                  outcome: "dismissed",
                  state: "dismissed",
                  message: `The owner closed issue ${issue.id} as not relevant${
                    issue.closeNote === null ? "" : `: ${issue.closeNote}`
                  }. It stays closed; do not report this problem again unless something new and significant happens, and then explain that in a new post without this dedupeKey.`,
                } satisfies InboxPostResult,
              };
            }

            const changes: string[] = [];
            const raised =
              INBOX_SEVERITY_RANK[input.severity] > INBOX_SEVERITY_RANK[issue.severity];
            if (input.severity !== issue.severity) {
              changes.push(`severity ${issue.severity} → ${input.severity}`);
              issue.severity = input.severity;
            }
            if (title !== issue.title) {
              changes.push(`title: ${title}`);
              issue.title = title;
            }
            const describedAgain = input.description !== issue.description;
            if (describedAgain) {
              changes.push("description updated");
              issue.description = input.description;
            }
            if (input.projectId !== undefined) issue.projectId = input.projectId;

            if (existing.state === "resolved") {
              issue.state = "open";
              issue.closedAt = null;
              issue.closedBy = null;
              const previous = issue.closeNote;
              issue.closeNote = null;
              const entryId = yield* appendEntry(
                issue,
                {
                  kind: "reopened",
                  author: "agent",
                  threadId: caller.threadId,
                  text: previous === null ? null : `Previous resolution: ${previous}`,
                },
                NEWS,
                now,
              );
              yield* applyWaiting(issue, input.waitingForOwner, caller.threadId, now);
              yield* writeIssue(issue, null);
              return {
                issue: issue as InboxIssue,
                notice: {
                  entryId,
                  text: "The problem came back: the issue was reopened.",
                },
                result: {
                  issueId: issue.id,
                  outcome: "reopened",
                  state: "open",
                  message: `The problem came back, so issue ${issue.id} was reopened with its history. Read it with inbox_get to see how it was solved before.`,
                } satisfies InboxPostResult,
              };
            }

            yield* appendEntry(
              issue,
              {
                kind: "updated",
                author: "agent",
                threadId: caller.threadId,
                text: changes.length === 0 ? "Reported again" : changes.join("; "),
              },
              raised ? NEWS : SILENT,
              now,
            );
            yield* applyWaiting(issue, input.waitingForOwner, caller.threadId, now);
            yield* writeIssue(issue, reminderAt);
            return {
              issue: issue as InboxIssue,
              notice: null,
              result: {
                issueId: issue.id,
                outcome: "updated",
                state: "open",
                message: `Updated open issue ${issue.id} (reported ${issue.repeatCount + 1} times). Post new findings for the owner with inbox_comment.`,
              } satisfies InboxPostResult,
            };
          }),
        );
        if (result.notice !== null) {
          yield* noticeThreads(
            result.issue,
            result.notice.entryId,
            result.notice.text,
            caller.threadId,
          );
          yield* notifyChanged;
        }
        return result.result;
      },
    );

    const agentComment: InboxService["Service"]["agentComment"] = (caller, input) =>
      commit(
        Effect.gen(function* () {
          const now = yield* nowIso;
          const issue: Mutable<InboxIssue> = { ...(yield* requireIssue(input.issueId)) };
          const reminderAt = yield* readReminderAt(issue.id);
          issue.threadIds = withThread(issue.threadIds, caller.threadId);
          yield* appendEntry(
            issue,
            { kind: "comment", author: "agent", threadId: caller.threadId, text: input.text },
            NEWS,
            now,
          );
          yield* applyWaiting(issue, input.waitingForOwner, caller.threadId, now);
          yield* writeIssue(issue, reminderAt);
        }),
      ).pipe(Effect.andThen(get(input.issueId)));

    const update: InboxService["Service"]["update"] = Effect.fn("InboxService.update")(
      function* (caller, input) {
        const handover = yield* commit(
          Effect.gen(function* () {
            const now = yield* nowIso;
            const issue: Mutable<InboxIssue> = { ...(yield* requireIssue(input.issueId)) };
            const reminderAt = yield* readReminderAt(issue.id);
            const changes: string[] = [];
            let raised = false;
            if (input.severity !== undefined && input.severity !== issue.severity) {
              raised = INBOX_SEVERITY_RANK[input.severity] > INBOX_SEVERITY_RANK[issue.severity];
              changes.push(`severity ${issue.severity} → ${input.severity}`);
              issue.severity = input.severity;
            }
            if (input.title !== undefined && singleLine(input.title) !== issue.title) {
              issue.title = singleLine(input.title);
              changes.push(`title: ${issue.title}`);
            }
            if (input.description !== undefined && input.description !== issue.description) {
              issue.description = input.description;
              changes.push("description updated");
            }
            issue.threadIds = withThread(
              issue.threadIds,
              caller.threadId,
              ...(input.threadIds ?? []),
            );
            if (changes.length > 0) {
              yield* appendEntry(
                issue,
                {
                  kind: "updated",
                  author: "agent",
                  threadId: caller.threadId,
                  text: changes.join("; "),
                },
                raised ? NEWS : SILENT,
                now,
              );
            }
            yield* applyWaiting(issue, input.waitingForOwner, caller.threadId, now);
            let handoverEntry: { entryId: InboxEntryId; from: ThreadId | null } | null = null;
            if (
              input.responsibleThreadId !== undefined &&
              input.responsibleThreadId !== issue.responsibleThreadId
            ) {
              const target = yield* threadManagement
                .getThreadShell(input.responsibleThreadId)
                .pipe(Effect.orElseSucceed(() => null));
              if (target === null || target.deletedAt !== null) {
                return yield* Effect.fail(
                  fail(`Thread ${input.responsibleThreadId} was not found.`, issue.id),
                );
              }
              const from = issue.responsibleThreadId;
              issue.responsibleThreadId = input.responsibleThreadId;
              issue.threadIds = withThread(issue.threadIds, input.responsibleThreadId);
              const entryId = yield* appendEntry(
                issue,
                {
                  kind: "handover",
                  author: "agent",
                  threadId: caller.threadId,
                  text: `Responsible thread: ${target.title}`,
                },
                SILENT,
                now,
              );
              handoverEntry = { entryId, from };
            }
            yield* writeIssue(issue, reminderAt);
            return handoverEntry === null ? null : { ...handoverEntry, issue: issue as InboxIssue };
          }),
        );
        if (handover !== null) {
          yield* noticeThreads(
            handover.issue,
            handover.entryId,
            `This thread is now responsible for the issue: the owner's comments arrive here. Read its history with inbox_get.`,
            caller.threadId,
            handover.from === null ? [] : [handover.from],
          );
          yield* notifyChanged;
        }
        return yield* get(input.issueId);
      },
    );

    const findResolveTarget = (input: InboxResolveInput): Effect.Effect<InboxIssue, InboxError> => {
      if (input.issueId !== undefined) return requireIssue(input.issueId);
      const dedupeKey = input.dedupeKey;
      if (dedupeKey === undefined) return Effect.fail(fail("Pass issueId or dedupeKey."));
      return sql<IssueRow>`
        SELECT * FROM fork_inbox_issues WHERE dedupe_key = ${dedupeKey} AND state = 'open'
      `.pipe(
        Effect.mapError(storageError),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(fail(`No open inbox issue has dedupeKey ${dedupeKey}.`))
            : issueFromRow(rows[0]),
        ),
      );
    };

    const resolve: InboxService["Service"]["resolve"] = Effect.fn("InboxService.resolve")(
      function* (caller, input) {
        const resolved = yield* commit(
          Effect.gen(function* () {
            const now = yield* nowIso;
            const target = yield* findResolveTarget(input);
            if (target.state !== "open") {
              return yield* Effect.fail(
                fail(`Inbox issue ${target.id} is already ${target.state}.`, target.id),
              );
            }
            const issue: Mutable<InboxIssue> = { ...target };
            issue.state = "resolved";
            issue.closedAt = now;
            issue.closedBy = "agent";
            issue.closeNote = input.resolution;
            issue.waitingForOwner = false;
            issue.waitingSince = null;
            issue.threadIds = withThread(issue.threadIds, caller.threadId);
            const entryId = yield* appendEntry(
              issue,
              {
                kind: "resolved",
                author: "agent",
                threadId: caller.threadId,
                text: input.resolution,
              },
              NEWS,
              now,
            );
            yield* writeIssue(issue, null);
            return { issue: issue as InboxIssue, entryId };
          }),
        );
        yield* noticeThreads(
          resolved.issue,
          resolved.entryId,
          `The issue was resolved: ${input.resolution}`,
          caller.threadId,
        );
        yield* notifyChanged;
        return yield* get(resolved.issue.id);
      },
    );

    /** A thread for an issue nobody owns yet, in its project or the scratch project. */
    const launchResponsibleThread = Effect.fn("InboxService.launchResponsibleThread")(function* (
      issue: InboxIssue,
      entryId: InboxEntryId,
      text: string,
      attachments: ReadonlyArray<ChatAttachment>,
    ) {
      const projectId =
        issue.projectId ??
        ProjectId.make(
          (yield* folders.ensureScratchProject.pipe(Effect.mapError(storageError))).projectId,
        );
      const current = yield* settings.getSettings.pipe(Effect.mapError(storageError));
      const resolved = resolveProjectSettings(current, projectId, null).settings;
      const threadId = ThreadId.make(`inbox-${yield* newId}`);
      const messageId = MessageId.make(inboxDeliveryMessageId(issue.id, entryId, threadId));
      const launched = yield* ThreadMessageIntake.launchThread({
        commandId: CommandId.make(`inbox:${entryId}:launch`),
        threadId,
        projectId,
        title: issue.title,
        modelSelection: resolved.defaultModelSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        runtimeMode: resolved.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId,
          text: formatInboxDelivery({
            issueId: issue.id,
            title: issue.title,
            kind: "comment",
            text: `${text}${INBOX_CONTEXT_SEPARATOR}${issue.description}`,
          }),
          attachments,
        },
        createdBy: "user",
        creationSource: "server",
      }).pipe(Effect.provide(intakeContext), Effect.exit);
      return Exit.isSuccess(launched)
        ? {
            delivery: {
              threadId: launched.value.threadId,
              status: "delivered",
            } satisfies InboxDelivery,
            attachments:
              launched.value.projection.messages.find((message) => message.id === messageId)
                ?.attachments ?? [],
          }
        : {
            delivery: {
              threadId,
              status: "failed",
              error: describeCause(launched.cause),
            } satisfies InboxDelivery,
            attachments: [],
          };
    });

    const ownerComment: InboxService["Service"]["ownerComment"] = Effect.fn(
      "InboxService.ownerComment",
    )(function* (input) {
      const text = input.text.trim();
      const attachments = input.attachments ?? [];
      if (text.length === 0 && attachments.length === 0) {
        return yield* Effect.fail(fail("A comment needs text or an attachment.", input.issueId));
      }
      const written = yield* commit(
        Effect.gen(function* () {
          const now = yield* nowIso;
          const issue: Mutable<InboxIssue> = { ...(yield* requireIssue(input.issueId)) };
          const reminderAt = yield* readReminderAt(issue.id);
          const entryId = yield* appendEntry(
            issue,
            {
              kind: "comment",
              author: "owner",
              threadId: null,
              text: text.length > 0 ? text : null,
              attachments,
            },
            SILENT,
            now,
          );
          yield* writeIssue(issue, reminderAt);
          return { issue: issue as InboxIssue, entryId };
        }),
      );
      const { issue, entryId } = written;
      const deliveredText = text.length > 0 ? text : "(Attachments only.)";
      if (issue.responsibleThreadId !== null) {
        const outcome = yield* deliver({
          issue,
          entryId,
          threadId: issue.responsibleThreadId,
          kind: "comment",
          text: deliveredText,
          attachments,
          createdBy: "user",
        });
        yield* recordDeliveries(entryId, [outcome.delivery]);
        yield* recordAttachments(entryId, outcome.attachments);
      } else {
        const outcome = yield* launchResponsibleThread(issue, entryId, deliveredText, attachments);
        const delivery = outcome.delivery;
        yield* recordDeliveries(entryId, [delivery]);
        yield* recordAttachments(entryId, outcome.attachments);
        if (delivery.status === "delivered") {
          yield* commit(
            Effect.gen(function* () {
              const now = yield* nowIso;
              const current: Mutable<InboxIssue> = { ...(yield* requireIssue(issue.id)) };
              const reminderAt = yield* readReminderAt(issue.id);
              current.responsibleThreadId = delivery.threadId;
              current.threadIds = withThread(current.threadIds, delivery.threadId);
              yield* appendEntry(
                current,
                {
                  kind: "handover",
                  author: "system",
                  threadId: delivery.threadId,
                  text: "A thread was started for the owner's comment and is now responsible.",
                },
                SILENT,
                now,
              );
              yield* writeIssue(current, reminderAt);
            }),
          );
        }
      }
      yield* notifyChanged;
      return yield* get(issue.id);
    });

    const markSeen: InboxService["Service"]["markSeen"] = (input) =>
      commit(
        sql`
          UPDATE fork_inbox_issues
          SET seen_sequence = MIN(MAX(seen_sequence, ${input.sequence}), last_sequence)
          WHERE issue_id = ${input.issueId}
        `,
      ).pipe(Effect.andThen(requireIssue(input.issueId)));

    const dismiss: InboxService["Service"]["dismiss"] = Effect.fn("InboxService.dismiss")(
      function* (input) {
        const written = yield* commit(
          Effect.gen(function* () {
            const now = yield* nowIso;
            const target = yield* requireIssue(input.issueId);
            if (target.state !== "open") {
              return yield* Effect.fail(
                fail(`Inbox issue ${target.id} is already ${target.state}.`, target.id),
              );
            }
            const issue: Mutable<InboxIssue> = { ...target };
            issue.state = "dismissed";
            issue.closedAt = now;
            issue.closedBy = "owner";
            issue.closeNote = input.reason;
            issue.waitingForOwner = false;
            issue.waitingSince = null;
            const entryId = yield* appendEntry(
              issue,
              { kind: "dismissed", author: "owner", threadId: null, text: input.reason },
              SILENT,
              now,
            );
            yield* writeIssue(issue, null);
            return { issue: issue as InboxIssue, entryId };
          }),
        );
        yield* noticeThreads(
          written.issue,
          written.entryId,
          `The owner closed this issue as not relevant. Reason: ${input.reason}\nStop working on it and do not report it again.`,
          null,
        );
        yield* notifyChanged;
        return yield* requireIssue(input.issueId);
      },
    );

    const undismiss: InboxService["Service"]["undismiss"] = Effect.fn("InboxService.undismiss")(
      function* (issueId) {
        const written = yield* commit(
          Effect.gen(function* () {
            const now = yield* nowIso;
            const target = yield* requireIssue(issueId);
            if (target.state !== "dismissed") {
              return yield* Effect.fail(
                fail(`Inbox issue ${target.id} was not closed as not relevant.`, target.id),
              );
            }
            const issue: Mutable<InboxIssue> = { ...target };
            issue.state = "open";
            issue.closedAt = null;
            issue.closedBy = null;
            issue.closeNote = null;
            const entryId = yield* appendEntry(
              issue,
              { kind: "undismissed", author: "owner", threadId: null, text: null },
              SILENT,
              now,
            );
            yield* writeIssue(issue, null);
            return { issue: issue as InboxIssue, entryId };
          }),
        );
        yield* noticeThreads(
          written.issue,
          written.entryId,
          "The owner reopened this issue after closing it as not relevant. You are responsible for it again.",
          null,
        );
        yield* notifyChanged;
        return yield* requireIssue(issueId);
      },
    );

    const remindDue: InboxService["Service"]["remindDue"] = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowText = DateTime.formatIso(now);
      const cutoff = DateTime.formatIso(
        DateTime.subtract(now, { milliseconds: INBOX_REMINDER_INTERVAL_MS }),
      );
      const dueNow = sql<IssueRow>`
        SELECT * FROM fork_inbox_issues
        WHERE state = 'open' AND waiting_for_owner = 1
          AND COALESCE(last_reminder_at, waiting_since) <= ${cutoff}
      `.pipe(Effect.mapError(storageError));
      // Checked first without the lock: nearly every tick has nothing due.
      if ((yield* dueNow).length === 0) return 0;
      return yield* commit(
        Effect.gen(function* () {
          const due = yield* dueNow;
          for (const row of due) {
            const issue: Mutable<InboxIssue> = { ...(yield* issueFromRow(row)) };
            // Reading is not answering: a reminder raises the issue again, silently.
            yield* appendEntry(
              issue,
              { kind: "reminder", author: "system", threadId: null, text: null },
              { notable: true, alert: false },
              nowText,
            );
            yield* writeIssue(issue, nowText);
          }
          return due.length;
        }),
      );
    });

    const queryIssues = Effect.fn("InboxService.queryIssues")(function* (input: InboxListInput) {
      const state = input.state ?? "open";
      const limit = input.limit ?? 200;
      const rows = yield* sql<IssueRow>`
          SELECT * FROM fork_inbox_issues
          WHERE (${state} = 'all' OR state = ${state})
            AND (${input.severity ?? null} IS NULL OR severity = ${input.severity ?? null})
            AND (${input.waitingForOwner === undefined ? null : input.waitingForOwner ? 1 : 0} IS NULL
              OR waiting_for_owner = ${input.waitingForOwner === undefined ? null : input.waitingForOwner ? 1 : 0})
          ORDER BY activity_at DESC
          LIMIT ${limit}
        `;
      return yield* Effect.forEach(rows, issueFromRow);
    }, Effect.mapError(storageError));

    const snapshot = Effect.fn("InboxService.snapshot")(function* (input: InboxSubscribeInput) {
      const closedLimit = input.closedLimit ?? DEFAULT_CLOSED_LIMIT;
      const open = yield* sql<IssueRow>`
          SELECT * FROM fork_inbox_issues WHERE state = 'open' ORDER BY activity_at DESC
        `;
      const closed = yield* sql<IssueRow>`
          SELECT * FROM fork_inbox_issues WHERE state != 'open'
          ORDER BY closed_at DESC LIMIT ${closedLimit}
        `;
      const total = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM fork_inbox_issues WHERE state != 'open'
        `;
      return {
        issues: yield* Effect.forEach([...open, ...closed], issueFromRow),
        closedTotal: total[0]?.count ?? 0,
      } satisfies InboxSnapshot;
    }, Effect.mapError(storageError));

    const live = <A>(read: Effect.Effect<A, InboxError>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before the first read so a change in between is not lost.
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(read),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read)),
          );
        }),
      );

    yield* scheduler.register(
      "inbox-reminders",
      remindDue.pipe(Effect.catch((error) => Effect.logWarning("Inbox reminders failed", error))),
    );

    return InboxService.of({
      subscribe: (input) => live(snapshot(input)),
      subscribeIssue: (issueId) => live(get(issueId)),
      get,
      list: queryIssues,
      post,
      agentComment,
      update,
      resolve,
      ownerComment,
      markSeen,
      dismiss,
      undismiss,
      remindDue,
    });
  }),
);

/** A short reason for a failed delivery, shown on the issue. */
function describeCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const text =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
