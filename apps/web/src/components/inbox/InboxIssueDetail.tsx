import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedInboxIssue } from "@t3tools/client-runtime/inbox";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ChatAttachment,
  EnvironmentId,
  InboxEntry,
  InboxEntryKind,
  InboxIssue,
  InboxIssueId,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  BellIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  EllipsisIcon,
  type LucideIcon,
  MessageCircleIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  PencilLineIcon,
  Repeat2Icon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { inboxAtoms } from "../../state/inbox";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatRelativeTimeLabel,
} from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { type ExpandedImagePreview, expandedImageKey } from "../chat/ExpandedImagePreview";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InboxComposer } from "./InboxComposer";
import {
  describeInboxEvent,
  INBOX_SEVERITY_DOT_CLASS,
  INBOX_SEVERITY_LABEL,
  inboxDeliveryFailure,
} from "./inbox.logic";

const EVENT_ICON: Record<Exclude<InboxEntryKind, "comment">, LucideIcon> = {
  created: CircleDotIcon,
  updated: PencilLineIcon,
  waiting: MessageCircleQuestionIcon,
  waiting_cleared: MessageCircleIcon,
  handover: ArrowRightLeftIcon,
  reopened: RotateCcwIcon,
  repeated: Repeat2Icon,
  reminder: BellIcon,
  resolved: CircleCheckIcon,
  dismissed: CircleSlashIcon,
  undismissed: RotateCcwIcon,
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks the issue seen on the server once the window is visible and focused
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

function MetaSeparator() {
  return (
    <span aria-hidden className="text-muted-foreground/40">
      ·
    </span>
  );
}

/** Fork: one inbox issue: its description, history, actions and the owner's reply box. */
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
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

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

  const open = issue.state === "open";
  const meta = [
    machine,
    project?.title ?? null,
    issue.source.label,
    issue.repeatCount > 0 ? `Reported ${issue.repeatCount + 1} times` : null,
  ].filter((part): part is string => part !== null && part.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col px-5 pt-4 pb-10 sm:px-8 sm:pt-8">
          <div className="-ms-2 mb-3 md:hidden">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeftIcon />
              Issues
            </Button>
          </div>
          <header className="flex flex-col gap-3">
            <div className="flex items-start gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground/80">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 rounded-full",
                        open ? INBOX_SEVERITY_DOT_CLASS[issue.severity] : "bg-muted-foreground/35",
                      )}
                    />
                    {INBOX_SEVERITY_LABEL[issue.severity]}
                  </span>
                  {meta.map((part) => (
                    <span key={part} className="contents">
                      <MetaSeparator />
                      <span className="min-w-0 truncate">{part}</span>
                    </span>
                  ))}
                </p>
                <h2
                  className={cn(
                    "text-xl leading-snug font-semibold tracking-tight text-balance",
                    open ? "text-foreground" : "text-foreground/70",
                  )}
                >
                  {issue.title}
                </h2>
              </div>
              <InboxIssueActions
                environmentId={environmentId}
                issue={issue}
                connected={connected}
              />
            </div>
            <InboxIssueStatus environmentId={environmentId} issue={issue} connected={connected} />
          </header>
          {issue.description.trim().length > 0 ? (
            <div className="mt-6 text-sm">
              <ChatMarkdown
                text={issue.description}
                cwd={project?.workspaceRoot}
                environmentId={environmentId}
              />
            </div>
          ) : null}
          <section aria-label="Activity" className="mt-8 flex flex-col gap-5">
            <h3 className="flex items-center gap-3 text-xs font-medium text-muted-foreground after:h-px after:flex-1 after:bg-border/70">
              Activity
            </h3>
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
                  onExpandImage={setExpandedImage}
                />
              ))
            )}
          </section>
        </div>
      </div>
      <div className="shrink-0 px-3 pb-3 [--chat-content-max-width:44rem] sm:px-6 sm:pb-5">
        <InboxComposer
          environmentId={environmentId}
          issueId={issue.id}
          connected={connected}
          waitingForOwner={open && issue.waitingForOwner}
          startsConversation={issue.responsibleThreadId === null}
          onSent={() => {
            const scroller = scrollRef.current;
            if (scroller)
              requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight }));
          }}
        />
      </div>
      {expandedImage ? (
        <ExpandedImageDialog
          key={expandedImageKey(expandedImage)}
          preview={expandedImage}
          onClose={() => setExpandedImage(null)}
        />
      ) : null}
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

/** The conversation button and the overflow menu, beside the title. */
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
  const [dismissOpen, setDismissOpen] = useState(false);
  const responsible = issue.responsibleThreadId;

  return (
    <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
      {responsible !== null ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, responsible)),
            })
          }
        >
          <MessageSquareIcon />
          Conversation
        </Button>
      ) : null}
      {issue.state === "open" ? (
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Issue actions" size="icon-sm" variant="ghost" />}
          >
            <EllipsisIcon aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!connected || !canDismiss} onClick={() => setDismissOpen(true)}>
              <CircleSlashIcon />
              Close as not relevant
            </MenuItem>
          </MenuPopup>
        </Menu>
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

/** Quiet lines under the title: how a closed issue ended, and which other threads took part. */
function InboxIssueStatus({
  environmentId,
  issue,
  connected,
}: {
  environmentId: EnvironmentId;
  issue: InboxIssue;
  connected: boolean;
}) {
  const canUndismiss = useAtomValue(inboxAtoms.undismissIssue.permissionAtom(environmentId));
  const undismiss = useAtomCommand(inboxAtoms.undismissIssue, { label: "inbox reopen" });
  const [reopening, setReopening] = useState(false);
  const otherThreads = issue.threadIds.filter((threadId) => threadId !== issue.responsibleThreadId);
  const closedAgo = issue.closedAt === null ? "" : formatRelativeTimeLabel(issue.closedAt);

  const reopen = async () => {
    setReopening(true);
    const result = await undismiss({ environmentId, input: { issueId: issue.id } });
    setReopening(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not reopen the issue", result);
    }
  };

  const line = (icon: ReactNode, children: ReactNode) => (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
      {icon}
      {children}
    </p>
  );

  return (
    <>
      {issue.state === "resolved"
        ? line(
            <CircleCheckIcon className="text-success" />,
            <>
              <span className="font-medium text-success-foreground">
                Resolved{issue.closedBy === "agent" ? " by the agent" : ""}
              </span>
              {closedAgo ? (
                <>
                  <MetaSeparator />
                  <span>{closedAgo}</span>
                </>
              ) : null}
            </>,
          )
        : null}
      {issue.state === "dismissed"
        ? line(
            <CircleSlashIcon />,
            <>
              <span>Closed as not relevant</span>
              {closedAgo ? (
                <>
                  <MetaSeparator />
                  <span>{closedAgo}</span>
                </>
              ) : null}
              <MetaSeparator />
              <InlineButton
                tone="muted"
                disabled={!connected || !canUndismiss || reopening}
                onClick={() => void reopen()}
              >
                Reopen
              </InlineButton>
            </>,
          )
        : null}
      {otherThreads.length > 0
        ? line(
            <ArrowRightLeftIcon />,
            <>
              <span>Also worked on in</span>
              {otherThreads.map((threadId, index) => (
                <span key={threadId} className="contents">
                  {index > 0 ? <MetaSeparator /> : null}
                  <InboxThreadLink
                    environmentId={environmentId}
                    threadId={threadId}
                    fallback="a thread"
                  />
                </span>
              ))}
            </>,
          )
        : null}
    </>
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

/** Files on an owner comment: thumbnails that open the image viewer, then file rows. */
function InboxEntryAttachments({
  environmentId,
  attachments,
  onExpandImage,
}: {
  environmentId: EnvironmentId;
  attachments: ReadonlyArray<ChatAttachment>;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}) {
  const { resolvedTheme } = useTheme();
  const resources = attachments.map((attachment) => ({
    _tag: "attachment" as const,
    attachmentId: attachment.id,
  }));
  const urls = useAssetUrls(environmentId, resources);
  const items = attachments.map((attachment, index) => ({ attachment, url: urls[index] ?? null }));
  const images = items.filter((item) => item.attachment.type === "image");
  const files = items.filter((item) => item.attachment.type !== "image");
  const viewable = images.flatMap((item) =>
    item.url === null ? [] : [{ src: item.url, name: item.attachment.name }],
  );

  return (
    <>
      {images.length > 0 ? (
        <div className="mb-2 grid max-w-[210px] grid-cols-2 gap-2">
          {images.map(({ attachment, url }) => (
            <div
              key={attachment.id}
              className="aspect-[4/3] overflow-hidden rounded-lg border border-border/80 bg-background/70"
            >
              {url !== null ? (
                <button
                  type="button"
                  className="block h-full w-full cursor-zoom-in"
                  aria-label={`Preview ${attachment.name}`}
                  onClick={() =>
                    onExpandImage({
                      images: viewable,
                      index: Math.max(
                        0,
                        viewable.findIndex((image) => image.src === url),
                      ),
                    })
                  }
                >
                  <img src={url} alt={attachment.name} className="h-full w-full object-cover" />
                </button>
              ) : (
                <span className="flex h-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
                  {attachment.name}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="mb-2 flex flex-col gap-1">
          {files.map(({ attachment, url }) => (
            <div key={attachment.id} className="flex min-w-0 items-center gap-2 text-sm">
              <PierreEntryIcon
                pathValue={attachment.name}
                kind="file"
                mimeType={attachment.mimeType}
                theme={resolvedTheme}
              />
              {url !== null ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate hover:underline focus-visible:outline-2"
                >
                  {attachment.name}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
              )}
              <span className="shrink-0 text-xs opacity-60 tabular-nums">
                {formatAttachmentSize(attachment.sizeBytes)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function InboxEntryView({
  environmentId,
  entry,
  cwd,
  onExpandImage,
}: {
  environmentId: EnvironmentId;
  entry: InboxEntry;
  cwd: string | undefined;
  onExpandImage: (preview: ExpandedImagePreview) => void;
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
      <p className="flex items-center gap-1 px-1 text-2xs text-warning-foreground">
        <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
        Not delivered to the agent: {failure}
      </p>
    );

  if (entry.kind === "comment") {
    const attachments = entry.attachments ?? [];
    const text = entry.text?.trim() ?? "";
    if (entry.author === "owner") {
      // The owner's words look like their messages in a thread.
      return (
        <article className="flex flex-col items-end gap-1">
          <p className="me-1 text-2xs text-muted-foreground/70">
            You <MetaSeparator /> {time}
          </p>
          <div className="max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
            {attachments.length > 0 ? (
              <InboxEntryAttachments
                environmentId={environmentId}
                attachments={attachments}
                onExpandImage={onExpandImage}
              />
            ) : null}
            {text.length > 0 ? (
              <div className="text-sm">
                <ChatMarkdown text={text} cwd={cwd} environmentId={environmentId} lineBreaks />
              </div>
            ) : null}
          </div>
          {warning}
        </article>
      );
    }
    // An agent's words look like an answer in a thread: no bubble.
    return (
      <article className="flex flex-col gap-1">
        <p className="flex items-center gap-1.5 text-2xs text-muted-foreground/70">
          {entry.author === "agent" ? (
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
          <MetaSeparator />
          {time}
        </p>
        <div className="text-sm text-foreground">
          <ChatMarkdown text={text} cwd={cwd} environmentId={environmentId} />
        </div>
        {warning}
      </article>
    );
  }

  const event = describeInboxEvent(entry);
  const Icon = EVENT_ICON[entry.kind];
  // The one colored outcome: the problem is fixed, as "Done" reads in the sidebar.
  const resolved = entry.kind === "resolved";
  return (
    <div className="flex flex-col gap-1.5">
      <p
        className={cn(
          "flex min-w-0 items-center gap-2 text-xs",
          event.tone === "muted" ? "text-muted-foreground" : "text-foreground/85",
          event.tone === "outcome" && "font-medium",
          resolved && "text-success-foreground",
        )}
      >
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            resolved
              ? "text-success"
              : event.tone === "muted"
                ? "text-muted-foreground/70"
                : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 truncate">{event.label}</span>
        <span className="shrink-0 text-2xs font-normal text-muted-foreground/70">{time}</span>
      </p>
      {event.detail ? (
        <div
          className={cn(
            "ms-1.5 border-s-2 ps-4 text-sm text-foreground/85",
            resolved ? "border-success/45" : "border-border",
          )}
        >
          <ChatMarkdown text={event.detail} cwd={cwd} environmentId={environmentId} />
        </div>
      ) : null}
      {warning}
    </div>
  );
}
