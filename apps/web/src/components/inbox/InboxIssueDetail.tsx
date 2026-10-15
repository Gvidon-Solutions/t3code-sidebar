import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedInboxIssue } from "@t3tools/client-runtime/inbox";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  InboxEntry,
  InboxIssue,
  InboxIssueId,
  InboxSeverity,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  SendIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { inboxAtoms } from "../../state/inbox";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { describeInboxEvent, INBOX_SEVERITY_DOT_CLASS, inboxDeliveryFailure } from "./inbox.logic";

const SEVERITY_BADGE: Record<
  InboxSeverity,
  { label: string; variant: "error" | "warning" | "secondary" }
> = {
  action: { label: "Action", variant: "error" },
  attention: { label: "Attention", variant: "warning" },
  info: { label: "Info", variant: "secondary" },
};

function reportFailure(title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Tells the server the owner has seen the issue up to its newest entry, while
 * it is on screen and the window is focused. Each sequence is sent once.
 */
function useMarkIssueSeen(
  environmentId: EnvironmentId,
  issue: InboxIssue | null,
  enabled: boolean,
) {
  const markSeen = useAtomCommand(inboxAtoms.markIssueSeen, {
    label: "inbox mark seen",
    reportFailure: false,
  });
  const sent = useRef<string | null>(null);
  const issueId = issue?.id;
  const lastSequence = issue?.lastSequence ?? 0;
  const seenSequence = issue?.seenSequence ?? 0;
  useEffect(() => {
    if (!enabled || issueId === undefined || lastSequence <= seenSequence) return;
    const key = `${environmentId}:${issueId}:${lastSequence}`;
    const visible = () => document.visibilityState === "visible" && document.hasFocus();
    let timer: number | undefined;
    const attempt = () => {
      window.clearTimeout(timer);
      if (sent.current === key || !visible()) return;
      timer = window.setTimeout(() => {
        if (sent.current === key || !visible()) return;
        sent.current = key;
        void markSeen({ environmentId, input: { issueId, sequence: lastSequence } });
      }, 400);
    };
    attempt();
    window.addEventListener("focus", attempt);
    document.addEventListener("visibilitychange", attempt);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", attempt);
      document.removeEventListener("visibilitychange", attempt);
    };
  }, [enabled, environmentId, issueId, lastSequence, markSeen, seenSequence]);
}

/** Fork: one inbox issue: its description, history, actions and the owner's comment box. */
export function InboxIssueDetail(props: {
  environmentId: EnvironmentId;
  issueId: InboxIssueId;
  /** The issue as the list has it; shown until the detail subscription answers. */
  listed: ScopedInboxIssue | null;
  onBack: () => void;
}) {
  const { environmentId, issueId, listed, onBack } = props;
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const detail = useEnvironmentQuery(
    connected ? inboxAtoms.inboxIssueLive({ environmentId, input: { issueId } }) : null,
  );
  const issue = detail.data?.issue ?? listed?.issue ?? null;
  const entries = detail.data?.entries ?? null;
  const machine = environment?.label ?? listed?.environmentLabel ?? null;
  const project = useProject(
    issue?.projectId ? scopeProjectRef(environmentId, issue.projectId) : null,
  );
  const canMarkSeen = useAtomValue(inboxAtoms.markIssueSeen.permissionAtom(environmentId));
  useMarkIssueSeen(environmentId, issue, connected && canMarkSeen);
  const scrollRef = useRef<HTMLDivElement>(null);

  if (issue === null) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex shrink-0 items-center px-3 py-2 md:hidden">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeftIcon />
            Issues
          </Button>
        </div>
        <p className="px-6 py-10 text-center text-sm text-muted-foreground">
          {detail.error !== null
            ? `Could not load this issue: ${detail.error}`
            : connected
              ? "Loading…"
              : "This issue's machine is not connected."}
        </p>
      </div>
    );
  }

  const severity = SEVERITY_BADGE[issue.severity];
  const meta = [machine, project?.title ?? null, issue.source.label].filter(
    (part): part is string => part !== null && part.length > 0,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 pt-4 pb-8 sm:px-6">
          <div className="-ms-2 md:hidden">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeftIcon />
              Issues
            </Button>
          </div>
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={severity.variant} size="sm">
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", INBOX_SEVERITY_DOT_CLASS[issue.severity])}
                />
                {severity.label}
              </Badge>
              {issue.state === "open" && issue.waitingForOwner ? (
                <Badge variant="error" size="sm">
                  Needs your answer
                </Badge>
              ) : null}
              {issue.state === "resolved" ? (
                <Badge variant="success" size="sm">
                  Resolved
                </Badge>
              ) : issue.state === "dismissed" ? (
                <Badge variant="secondary" size="sm">
                  Closed as not relevant
                </Badge>
              ) : null}
              {issue.repeatCount > 0 ? (
                <Badge variant="outline" size="sm">
                  Reported {issue.repeatCount + 1} times
                </Badge>
              ) : null}
            </div>
            <h2 className="text-lg font-semibold text-foreground">{issue.title}</h2>
            <p className="text-xs text-muted-foreground">{meta.join(" · ")}</p>
          </header>
          <InboxIssueActions environmentId={environmentId} issue={issue} connected={connected} />
          {issue.description.trim().length > 0 ? (
            <div className="text-sm">
              <ChatMarkdown
                text={issue.description}
                cwd={project?.workspaceRoot}
                environmentId={environmentId}
              />
            </div>
          ) : null}
          <section aria-label="History" className="flex flex-col gap-3 border-t border-border pt-4">
            {entries === null ? (
              <p className="text-xs text-muted-foreground">
                {detail.error !== null
                  ? `Could not load the history: ${detail.error}`
                  : "Loading history…"}
              </p>
            ) : (
              entries.map((entry) => (
                <InboxEntryView
                  key={entry.id}
                  environmentId={environmentId}
                  entry={entry}
                  cwd={project?.workspaceRoot}
                />
              ))
            )}
          </section>
        </div>
      </div>
      <InboxCommentComposer
        environmentId={environmentId}
        issueId={issue.id}
        connected={connected}
        onSent={() => {
          const scroller = scrollRef.current;
          if (scroller)
            requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight }));
        }}
      />
    </div>
  );
}

function InboxThreadLink({
  environmentId,
  threadId,
  fallback,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  fallback: string;
}) {
  const ref = scopeThreadRef(environmentId, threadId);
  const thread = useThreadShell(ref);
  return (
    <InlineButton
      tone="muted"
      render={<Link to="/$environmentId/$threadId" params={buildThreadRouteParams(ref)} />}
    >
      {thread?.title ?? fallback}
    </InlineButton>
  );
}

function InboxIssueActions({
  environmentId,
  issue,
  connected,
}: {
  environmentId: EnvironmentId;
  issue: InboxIssue;
  connected: boolean;
}) {
  const navigate = useNavigate();
  const canDismiss = useAtomValue(inboxAtoms.dismissIssue.permissionAtom(environmentId));
  const canUndismiss = useAtomValue(inboxAtoms.undismissIssue.permissionAtom(environmentId));
  const undismiss = useAtomCommand(inboxAtoms.undismissIssue, { label: "inbox reopen" });
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const otherThreads = issue.threadIds.filter((threadId) => threadId !== issue.responsibleThreadId);
  const responsible = issue.responsibleThreadId;

  const reopen = async () => {
    setReopening(true);
    const result = await undismiss({ environmentId, input: { issueId: issue.id } });
    setReopening(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not reopen the issue", result);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {responsible !== null ? (
          <Button
            size="sm"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(environmentId, responsible)),
              })
            }
          >
            <MessageSquareIcon />
            Open conversation
          </Button>
        ) : null}
        {issue.state === "open" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!connected || !canDismiss}
            onClick={() => setDismissOpen(true)}
          >
            <XIcon />
            Close as not relevant
          </Button>
        ) : null}
        {issue.state === "dismissed" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!connected || !canUndismiss || reopening}
            onClick={() => void reopen()}
          >
            <RotateCcwIcon />
            Reopen
          </Button>
        ) : null}
      </div>
      {responsible === null ? (
        <p className="text-xs text-muted-foreground">
          Your first comment starts a conversation with an agent.
        </p>
      ) : null}
      {otherThreads.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>Also worked on in</span>
          {otherThreads.map((threadId) => (
            <InboxThreadLink
              key={threadId}
              environmentId={environmentId}
              threadId={threadId}
              fallback="a thread"
            />
          ))}
        </p>
      ) : null}
      {dismissOpen ? (
        <InboxDismissDialog
          environmentId={environmentId}
          issueId={issue.id}
          onClose={() => setDismissOpen(false)}
        />
      ) : null}
    </div>
  );
}

function InboxDismissDialog({
  environmentId,
  issueId,
  onClose,
}: {
  environmentId: EnvironmentId;
  issueId: InboxIssueId;
  onClose: () => void;
}) {
  const id = useId();
  const dismiss = useAtomCommand(inboxAtoms.dismissIssue, { label: "inbox dismiss" });
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const trimmed = reason.trim();

  const submit = async () => {
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    const result = await dismiss({ environmentId, input: { issueId, reason: trimmed } });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
    } else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not close the issue", result);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Close as not relevant</DialogTitle>
            <DialogDescription>
              The responsible agent is told your reason. You can reopen the issue later.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label htmlFor={`${id}-reason`} className="sr-only">
              Reason
            </label>
            <Textarea
              id={`${id}-reason`}
              size="sm"
              autoFocus
              required
              maxLength={20_000}
              placeholder="Why it does not matter"
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0 || pending}>
              Close issue
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function InboxEntryView({
  environmentId,
  entry,
  cwd,
}: {
  environmentId: EnvironmentId;
  entry: InboxEntry;
  cwd: string | undefined;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const failure = inboxDeliveryFailure(entry);
  const time = (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={entry.createdAt} />}>
        {formatDayAwareTimestamp(entry.createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(entry.createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
  const warning =
    failure === null ? null : (
      <p className="flex items-center gap-1 text-2xs text-warning-foreground">
        <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
        Not delivered to the agent: {failure}
      </p>
    );

  if (entry.kind === "comment") {
    const owner = entry.author === "owner";
    return (
      <article className={cn("flex flex-col gap-1", owner ? "items-end" : "items-start")}>
        <div className="flex items-center gap-1.5 px-1 text-2xs text-muted-foreground">
          {owner ? (
            "You"
          ) : entry.author === "agent" ? (
            entry.threadId !== null ? (
              <InboxThreadLink
                environmentId={environmentId}
                threadId={entry.threadId}
                fallback="Agent"
              />
            ) : (
              "Agent"
            )
          ) : (
            "T3 Code"
          )}
          <span aria-hidden>·</span>
          {time}
        </div>
        <div
          className={cn(
            "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
            owner ? "bg-message text-message-foreground" : "border border-border bg-card",
          )}
        >
          <ChatMarkdown
            text={entry.text ?? ""}
            cwd={cwd}
            environmentId={environmentId}
            lineBreaks={owner}
          />
        </div>
        {warning}
      </article>
    );
  }

  const event = describeInboxEvent(entry);
  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        event.tone === "success" && "rounded-lg border border-success/30 bg-success/8 px-3 py-2",
      )}
    >
      <p
        className={cn(
          "flex flex-wrap items-baseline gap-x-2 text-xs",
          event.tone === "success"
            ? "font-medium text-success-foreground"
            : event.tone === "muted"
              ? "text-muted-foreground"
              : "text-foreground/80",
        )}
      >
        <span>{event.label}</span>
        <span className="text-2xs text-muted-foreground">{time}</span>
      </p>
      {event.detail ? (
        <div className="text-sm text-foreground/80">
          <ChatMarkdown text={event.detail} cwd={cwd} environmentId={environmentId} />
        </div>
      ) : null}
      {warning}
    </div>
  );
}

function InboxCommentComposer({
  environmentId,
  issueId,
  connected,
  onSent,
}: {
  environmentId: EnvironmentId;
  issueId: InboxIssueId;
  connected: boolean;
  onSent: () => void;
}) {
  const canComment = useAtomValue(inboxAtoms.commentOnIssue.permissionAtom(environmentId));
  const comment = useAtomCommand(inboxAtoms.commentOnIssue, { label: "inbox comment" });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const trimmed = text.trim();
  const disabled = !connected || !canComment;

  const send = async () => {
    if (trimmed.length === 0 || sending || disabled) return;
    setSending(true);
    const result = await comment({ environmentId, input: { issueId, text: trimmed } });
    setSending(false);
    if (result._tag === "Success") {
      setText("");
      onSent();
    } else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not send the comment", result);
    }
  };

  return (
    <form
      className="shrink-0 border-t border-border bg-background px-5 py-3 sm:px-6"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
        <Textarea
          size="sm"
          aria-label="Comment"
          aria-description="Enter to send; Shift+Enter for a new line."
          maxLength={20_000}
          placeholder={
            disabled ? "You cannot comment from here right now" : "Write a comment for the agent"
          }
          disabled={disabled}
          readOnly={sending}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button type="submit" size="sm" disabled={disabled || sending || trimmed.length === 0}>
          <SendIcon />
          Send
        </Button>
      </div>
    </form>
  );
}
