import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  AlarmClockOffIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  EyeIcon,
  MessageCircleQuestionIcon,
  PinIcon,
  PinOffIcon,
  ShieldQuestionIcon,
  Undo2Icon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveWorkingStartedAt,
} from "../Sidebar.logic";
import { compactAgo, threadActivityMs } from "./workspaces.logic";

export type WorkspaceRowVariant = "active" | "pinned" | "settled" | "snoozed";

export interface WorkspaceThreadRowProps {
  thread: SidebarThreadSummary;
  variant: WorkspaceRowVariant;
  isActive: boolean;
  now: number;
  /** Project name shown before the title (pinned, snoozed and search rows). */
  projectLabel?: string | null;
  jumpLabel?: string | null;
  isRenaming: boolean;
  canSettle: boolean;
  canPin: boolean;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onTogglePin: (thread: SidebarThreadSummary) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onWake: (threadRef: ScopedThreadRef) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string | null) => void;
}

function StatusGlyph({ thread, isUnread }: { thread: SidebarThreadSummary; isUnread: boolean }) {
  const status = resolveSidebarThreadStatus(thread);
  const glyph: { icon: ReactNode; label: string } | null =
    status === "working"
      ? {
          icon: <CircleDashedIcon className="size-3.5 text-sky-600 dark:text-sky-400" />,
          label: "Working",
        }
      : status === "monitoring"
        ? { icon: <EyeIcon className="size-3.5 text-foreground/70" />, label: "Monitoring" }
        : status === "approval"
          ? {
              icon: <ShieldQuestionIcon className="size-3.5 text-warning-foreground" />,
              label: "Needs approval",
            }
          : status === "input"
            ? {
                icon: (
                  <MessageCircleQuestionIcon className="size-3.5 text-indigo-600 dark:text-indigo-300" />
                ),
                label: "Waiting for your answer",
              }
            : status === "failed"
              ? {
                  icon: <CircleAlertIcon className="size-3.5 text-red-600 dark:text-red-400" />,
                  label: "Failed",
                }
              : isUnread
                ? {
                    icon: (
                      <span className="size-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                    ),
                    label: "Done, unread",
                  }
                : null;
  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center"
      role={glyph ? "img" : undefined}
      aria-label={glyph?.label}
      title={glyph?.label}
    >
      {glyph?.icon}
    </span>
  );
}

function RowAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="flex size-5 items-center justify-center rounded text-sidebar-muted-foreground transition-colors hover:bg-foreground/8 hover:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-3.5"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function formatElapsed(startedAt: string | null, now: number): string {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(started)) return "";
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function formatWakeIn(snoozedUntil: string | null | undefined, now: number): string {
  const until = snoozedUntil ? Date.parse(snoozedUntil) : Number.NaN;
  if (Number.isNaN(until)) return "";
  const delta = Math.max(0, until - now);
  const minute = 60_000;
  if (delta < 60 * minute) return `${Math.max(1, Math.ceil(delta / minute))}m`;
  if (delta < 24 * 60 * minute) return `${Math.round(delta / (60 * minute))}h`;
  return `${Math.round(delta / (24 * 60 * minute))}d`;
}

export const WorkspaceThreadRow = memo(function WorkspaceThreadRow(props: WorkspaceThreadRowProps) {
  const { thread, variant, now } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  const isRunning = thread.session?.status === "running" && thread.session.activeTurnId != null;
  const isRegenerating = thread.titleRegeneration != null;

  const meta =
    status === "working"
      ? formatElapsed(resolveWorkingStartedAt(thread), now)
      : variant === "snoozed"
        ? `in ${formatWakeIn(thread.snoozedUntil, now)}`
        : compactAgo(threadActivityMs(thread), now);

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onOpen(threadRef);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    props.onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
  };

  const isPinned = thread.pinnedAt != null;
  const settleBlocked = isRunning || thread.hasPendingApprovals;
  const tooltip = [thread.title, thread.branch ? `⎇ ${thread.branch}` : null]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      role="button"
      tabIndex={0}
      data-thread-key={threadKey}
      data-active={props.isActive ? "true" : undefined}
      title={tooltip}
      className={cn(
        "group/ws-row relative flex h-7 min-w-0 cursor-pointer select-none items-center gap-2 rounded-md pr-1.5 pl-2 text-[13px] outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        props.isActive
          ? "bg-sidebar-row-active text-sidebar-foreground"
          : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
        variant === "settled" && !props.isActive && "text-sidebar-muted-foreground",
      )}
      onClick={() => props.onOpen(threadRef)}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      <StatusGlyph thread={thread} isUnread={isUnread} />
      {props.isRenaming ? (
        <RenameInput
          initialTitle={thread.title}
          onCommit={(title) => props.onCommitRename(threadRef, title)}
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            isUnread && !props.isActive && "font-medium text-sidebar-foreground",
            isRegenerating && "animate-pulse",
          )}
        >
          {props.projectLabel ? (
            <span className="mr-1.5 text-sidebar-muted-foreground">{props.projectLabel}</span>
          ) : null}
          {thread.title}
        </span>
      )}
      {props.isRenaming ? null : (
        <>
          <span
            className={cn(
              "shrink-0 text-2xs tabular-nums text-sidebar-muted-foreground group-hover/ws-row:hidden group-focus-within/ws-row:hidden",
              status === "working" && "text-sky-600 dark:text-sky-400",
            )}
          >
            {variant === "pinned" || variant === "snoozed" ? null : isPinned ? (
              <PinIcon className="mr-1 inline size-3 align-[-2px] opacity-60" />
            ) : null}
            {props.jumpLabel ? (
              <span className="rounded bg-foreground/8 px-1 text-3xs font-medium text-sidebar-foreground">
                {props.jumpLabel}
              </span>
            ) : (
              meta
            )}
          </span>
          <span className="hidden shrink-0 items-center gap-0.5 group-hover/ws-row:flex group-focus-within/ws-row:flex">
            {variant === "snoozed" ? (
              <RowAction label="Wake now" onClick={() => props.onWake(threadRef)}>
                <AlarmClockOffIcon />
              </RowAction>
            ) : variant === "settled" ? (
              <RowAction label="Move back to active" onClick={() => props.onUnsettle(threadRef)}>
                <Undo2Icon />
              </RowAction>
            ) : (
              <>
                {props.canPin ? (
                  <RowAction
                    label={isPinned ? "Unpin" : "Pin"}
                    onClick={() => props.onTogglePin(thread)}
                  >
                    {isPinned ? <PinOffIcon /> : <PinIcon />}
                  </RowAction>
                ) : null}
                {props.canSettle ? (
                  <RowAction
                    label={
                      settleBlocked
                        ? "Can't settle while the agent is running or waiting for approval"
                        : "Settle"
                    }
                    disabled={settleBlocked}
                    onClick={() => props.onSettle(threadRef)}
                  >
                    <CheckIcon />
                  </RowAction>
                ) : null}
              </>
            )}
          </span>
        </>
      )}
    </div>
  );
});

function RenameInput({
  initialTitle,
  onCommit,
}: {
  initialTitle: string;
  onCommit: (title: string | null) => void;
}) {
  const [value, setValue] = useState(initialTitle);
  const committedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = (title: string | null) => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(title);
  };
  return (
    <input
      ref={inputRef}
      value={value}
      aria-label="Thread title"
      className="h-5 min-w-0 flex-1 rounded border border-ring/60 bg-background px-1 text-[13px] outline-hidden"
      onChange={(event) => setValue(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          commit(null);
        }
      }}
      onBlur={() => commit(value)}
    />
  );
}
