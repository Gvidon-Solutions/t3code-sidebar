import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * The inbox (fork feature): issues agents raise for the owner. One problem is
 * one issue; agents keep it current and close it, the owner comments on it.
 * See FORK.md, "Agent inbox".
 */

export const InboxIssueId = TrimmedNonEmptyString.pipe(Schema.brand("InboxIssueId"));
export type InboxIssueId = typeof InboxIssueId.Type;
export const InboxEntryId = TrimmedNonEmptyString.pipe(Schema.brand("InboxEntryId"));
export type InboxEntryId = typeof InboxEntryId.Type;

export const InboxSeverity = Schema.Literals(["action", "attention", "info"]).annotate({
  description:
    "action: the owner must decide something; attention: the owner should look; info: for the record.",
});
export type InboxSeverity = typeof InboxSeverity.Type;

/** Higher ranks sort first and outrank lower ones on update. */
export const INBOX_SEVERITY_RANK: Record<InboxSeverity, number> = {
  action: 2,
  attention: 1,
  info: 0,
};

export const InboxIssueState = Schema.Literals(["open", "resolved", "dismissed"]);
export type InboxIssueState = typeof InboxIssueState.Type;

export const InboxAuthor = Schema.Literals(["owner", "agent", "system"]);
export type InboxAuthor = typeof InboxAuthor.Type;

export const InboxSource = Schema.Struct({
  kind: Schema.Literals(["thread", "scheduled_task", "client"]),
  /** Thread title, scheduled task title, or the MCP client's label. */
  label: Schema.String,
  threadId: Schema.optional(ThreadId),
  scheduledTaskId: Schema.optional(ScheduledTaskId),
});
export type InboxSource = typeof InboxSource.Type;

export const InboxIssue = Schema.Struct({
  id: InboxIssueId,
  severity: InboxSeverity,
  title: Schema.String,
  /** Markdown the agent keeps current: what is wrong and what is needed. */
  description: Schema.String,
  state: InboxIssueState,
  /** Set and cleared by the responsible agent only. */
  waitingForOwner: Schema.Boolean,
  waitingSince: Schema.NullOr(IsoDateTime),
  projectId: Schema.NullOr(ProjectId),
  /** The thread that gets the owner's comments; null until one exists. */
  responsibleThreadId: Schema.NullOr(ThreadId),
  /** The thread that raised the issue; it hears about the outcome. */
  creatorThreadId: Schema.NullOr(ThreadId),
  /** Every thread that worked on the issue, oldest first. */
  threadIds: Schema.Array(ThreadId),
  source: InboxSource,
  dedupeKey: Schema.NullOr(Schema.String),
  /** How many times an agent reported this problem again. */
  repeatCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Sort time: the last notable entry or daily reminder. */
  activityAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  closedBy: Schema.NullOr(InboxAuthor),
  /** The agent's resolution, or the owner's reason for dismissing. */
  closeNote: Schema.NullOr(Schema.String),
  /** Sequence of the newest entry. */
  lastSequence: NonNegativeInt,
  /** Sequence of the newest entry the owner has not necessarily seen yet. */
  notableSequence: NonNegativeInt,
  /** Sequence of the newest entry clients announce with a notification. */
  alertSequence: NonNegativeInt,
  /** The newest sequence the owner has seen, on any device. */
  seenSequence: NonNegativeInt,
});
export type InboxIssue = typeof InboxIssue.Type;

export const isInboxIssueUnread = (issue: Pick<InboxIssue, "notableSequence" | "seenSequence">) =>
  issue.notableSequence > issue.seenSequence;

export const InboxEntryKind = Schema.Literals([
  "created",
  "updated",
  "comment",
  "waiting",
  "waiting_cleared",
  "handover",
  "reopened",
  "repeated",
  "reminder",
  "resolved",
  "dismissed",
  "undismissed",
]);
export type InboxEntryKind = typeof InboxEntryKind.Type;

export const InboxDelivery = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["delivered", "failed"]),
  error: Schema.optional(Schema.String),
});
export type InboxDelivery = typeof InboxDelivery.Type;

export const InboxEntry = Schema.Struct({
  id: InboxEntryId,
  issueId: InboxIssueId,
  sequence: NonNegativeInt,
  kind: InboxEntryKind,
  author: InboxAuthor,
  threadId: Schema.NullOr(ThreadId),
  /** Markdown: the comment, a change summary, or the resolution. */
  text: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  /** Where an owner comment or a notice to an agent went. */
  deliveries: Schema.Array(InboxDelivery),
  /** Files the owner attached to a comment, as the responsible thread received them. */
  attachments: Schema.optionalKey(Schema.Array(ChatAttachment)),
});
export type InboxEntry = typeof InboxEntry.Type;

export class InboxError extends Schema.TaggedError<InboxError>()("InboxError", {
  message: Schema.String,
  issueId: Schema.optional(InboxIssueId),
}) {}

const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description:
    "One line, under 200 characters, e.g. 'PFM: model gpt-5.6 retires soon, pick a replacement'.",
});
const Markdown = Schema.String.check(Schema.isMaxLength(20_000));
const CommentText = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));

export const InboxSubscribeInput = Schema.Struct({
  /** Closed issues to include, newest first. Open issues always come in full. */
  closedLimit: Schema.optional(NonNegativeInt),
});
export type InboxSubscribeInput = typeof InboxSubscribeInput.Type;

export const InboxSnapshot = Schema.Struct({
  issues: Schema.Array(InboxIssue),
  closedTotal: NonNegativeInt,
});
export type InboxSnapshot = typeof InboxSnapshot.Type;

export const InboxIssueInput = Schema.Struct({ issueId: InboxIssueId });
export type InboxIssueInput = typeof InboxIssueInput.Type;

export const InboxIssueDetail = Schema.Struct({
  issue: InboxIssue,
  entries: Schema.Array(InboxEntry),
});
export type InboxIssueDetail = typeof InboxIssueDetail.Type;

/** Text, attachments, or both: a comment may be only a screenshot. */
export const InboxOwnerCommentInput = Schema.Struct({
  issueId: InboxIssueId,
  text: Markdown,
  /** Uploaded first through the attachment upload RPC, then referenced here by id. */
  attachments: Schema.optionalKey(Schema.Array(ChatAttachment)),
});
export type InboxOwnerCommentInput = typeof InboxOwnerCommentInput.Type;

export const InboxMarkSeenInput = Schema.Struct({
  issueId: InboxIssueId,
  sequence: NonNegativeInt,
});
export type InboxMarkSeenInput = typeof InboxMarkSeenInput.Type;

export const InboxDismissInput = Schema.Struct({
  issueId: InboxIssueId,
  reason: CommentText,
});
export type InboxDismissInput = typeof InboxDismissInput.Type;

export const InboxIssueResult = Schema.Struct({ issue: InboxIssue });
export type InboxIssueResult = typeof InboxIssueResult.Type;

export const INBOX_WS_METHODS = {
  subscribe: "inbox.subscribe",
  subscribeIssue: "inbox.subscribeIssue",
  comment: "inbox.comment",
  markSeen: "inbox.markSeen",
  dismiss: "inbox.dismiss",
  undismiss: "inbox.undismiss",
} as const;

const InboxRpcError = Schema.Union([InboxError, EnvironmentAuthorizationError]);

/** Open issues and the newest closed ones: a snapshot on subscribe, then one after every change. */
export const WsInboxSubscribeRpc = Rpc.make(INBOX_WS_METHODS.subscribe, {
  payload: InboxSubscribeInput,
  success: InboxSnapshot,
  error: InboxRpcError,
  stream: true,
});
/** One issue with its whole history, re-sent after every change to it. */
export const WsInboxSubscribeIssueRpc = Rpc.make(INBOX_WS_METHODS.subscribeIssue, {
  payload: InboxIssueInput,
  success: InboxIssueDetail,
  error: InboxRpcError,
  stream: true,
});
/** The owner's comment; it is also delivered to the responsible thread. */
export const WsInboxCommentRpc = Rpc.make(INBOX_WS_METHODS.comment, {
  payload: InboxOwnerCommentInput,
  success: InboxIssueDetail,
  error: InboxRpcError,
});
export const WsInboxMarkSeenRpc = Rpc.make(INBOX_WS_METHODS.markSeen, {
  payload: InboxMarkSeenInput,
  success: InboxIssueResult,
  error: InboxRpcError,
});
/** "Close as not relevant": the owner's decision, told to the responsible agent. */
export const WsInboxDismissRpc = Rpc.make(INBOX_WS_METHODS.dismiss, {
  payload: InboxDismissInput,
  success: InboxIssueResult,
  error: InboxRpcError,
});
/** Undoes the owner's dismissal. */
export const WsInboxUndismissRpc = Rpc.make(INBOX_WS_METHODS.undismiss, {
  payload: InboxIssueInput,
  success: InboxIssueResult,
  error: InboxRpcError,
});

export const INBOX_RPCS = [
  WsInboxSubscribeRpc,
  WsInboxSubscribeIssueRpc,
  WsInboxCommentRpc,
  WsInboxMarkSeenRpc,
  WsInboxDismissRpc,
  WsInboxUndismissRpc,
] as const;

const WaitingForOwner = Schema.Boolean.annotate({
  description:
    "true when the issue now needs the owner's answer or decision; false once it does not. You manage this flag: the owner reading or commenting never changes it.",
});

export const InboxPostInput = Schema.Struct({
  severity: InboxSeverity,
  title: Title,
  description: Markdown.annotate({
    description:
      "Markdown: what happened, its impact, and what you need from the owner. Replaces the description on update.",
  }),
  projectId: Schema.optional(
    ProjectId.annotate({
      description: "Defaults to the calling thread's project.",
    }),
  ),
  threadIds: Schema.optional(
    Schema.Array(ThreadId).annotate({
      description:
        "Other threads where the work happens. The calling thread is added automatically.",
    }),
  ),
  dedupeKey: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description:
        "Stable key for this problem, e.g. 'pfm:model-retirement:gpt-5.6'. Posting again with it updates the open issue, or reopens it if it was resolved.",
    }),
  ),
  waitingForOwner: Schema.optional(WaitingForOwner),
});
export type InboxPostInput = typeof InboxPostInput.Type;

export const InboxPostResult = Schema.Struct({
  issueId: InboxIssueId,
  outcome: Schema.Literals(["created", "updated", "reopened", "dismissed"]),
  state: InboxIssueState,
  message: Schema.String,
});
export type InboxPostResult = typeof InboxPostResult.Type;

export const InboxListInput = Schema.Struct({
  state: Schema.optional(
    Schema.Literals(["open", "resolved", "dismissed", "all"]).annotate({
      description: "Defaults to open.",
    }),
  ),
  severity: Schema.optional(InboxSeverity),
  waitingForOwner: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type InboxListInput = typeof InboxListInput.Type;

export const InboxListResult = Schema.Struct({ issues: Schema.Array(InboxIssue) });
export type InboxListResult = typeof InboxListResult.Type;

export const InboxAgentCommentInput = Schema.Struct({
  issueId: InboxIssueId,
  text: CommentText.annotate({
    description:
      "Markdown for the owner: what you took from their instructions, what you did, the result, or what you still need.",
  }),
  waitingForOwner: Schema.optional(WaitingForOwner),
});
export type InboxAgentCommentInput = typeof InboxAgentCommentInput.Type;

export const InboxUpdateInput = Schema.Struct({
  issueId: InboxIssueId,
  severity: Schema.optional(InboxSeverity),
  title: Schema.optional(Title),
  description: Schema.optional(Markdown),
  waitingForOwner: Schema.optional(WaitingForOwner),
  responsibleThreadId: Schema.optional(
    ThreadId.annotate({
      description:
        "Hand the issue to another thread; the owner's comments go there from now on. Both threads are told.",
    }),
  ),
  threadIds: Schema.optional(
    Schema.Array(ThreadId).annotate({
      description: "Threads to add to the issue's thread list.",
    }),
  ),
});
export type InboxUpdateInput = typeof InboxUpdateInput.Type;

export const InboxResolveInput = Schema.Struct({
  issueId: Schema.optional(InboxIssueId),
  dedupeKey: Schema.optional(TrimmedNonEmptyString),
  resolution: CommentText.annotate({
    description: "How it was fixed and how you verified that the problem is really gone.",
  }),
});
export type InboxResolveInput = typeof InboxResolveInput.Type;

/** Message ids of inbox deliveries; clients use them to label the message. */
export const INBOX_MESSAGE_ID_PREFIX = "inbox:";

export const inboxDeliveryMessageId = (
  issueId: InboxIssueId,
  entryId: InboxEntryId,
  threadId: ThreadId,
) => `${INBOX_MESSAGE_ID_PREFIX}${issueId}:${entryId}:${threadId}`;

const INBOX_DELIVERY_HEADER = /^\[T3 inbox · issue (\S+) · ([^\r\n]*)\]\r?\n\r?\n/;
const INBOX_COMMENT_FOOTER =
  "\n\n(The owner wrote this comment on the inbox issue above. You are responsible for it: read it with inbox_get, answer with inbox_comment, keep waitingForOwner accurate, and close it with inbox_resolve once the problem is verified fixed.)";
const INBOX_NOTE_FOOTER = "\n\n(Inbox notice. Read the issue with inbox_get.)";

/** Separates the owner's words from the issue context given to a newly started thread. */
export const INBOX_CONTEXT_SEPARATOR = "\n\n---\nThe issue so far:\n\n";

/** The text an agent receives: an owner comment, or a notice about the issue. */
export const formatInboxDelivery = (input: {
  readonly issueId: InboxIssueId;
  readonly title: string;
  readonly kind: "comment" | "notice";
  readonly text: string;
}) =>
  `[T3 inbox · issue ${input.issueId} · ${input.title}]\n\n${input.text}${
    input.kind === "comment" ? INBOX_COMMENT_FOOTER : INBOX_NOTE_FOOTER
  }`;

/** Splits a delivered inbox message back into its issue and the text a person wrote. */
export const parseInboxDelivery = (message: {
  readonly id?: string;
  readonly text: string;
}): {
  readonly issueId: InboxIssueId;
  readonly title: string;
  readonly kind: "comment" | "notice";
  readonly text: string;
} | null => {
  if (message.id === undefined || !message.id.startsWith(INBOX_MESSAGE_ID_PREFIX)) return null;
  const header = INBOX_DELIVERY_HEADER.exec(message.text);
  if (header === null) return null;
  const rest = message.text.slice(header[0].length);
  const kind = rest.endsWith(INBOX_COMMENT_FOOTER) ? "comment" : "notice";
  const footer = kind === "comment" ? INBOX_COMMENT_FOOTER : INBOX_NOTE_FOOTER;
  return {
    issueId: InboxIssueId.make(header[1]!),
    title: header[2]!,
    kind,
    text: (rest.endsWith(footer) ? rest.slice(0, -footer.length) : rest).split(
      INBOX_CONTEXT_SEPARATOR,
    )[0]!,
  };
};
