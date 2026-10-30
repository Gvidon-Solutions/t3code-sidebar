import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  AlarmClockOffIcon,
  AudioLinesIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  GaugeIcon,
  HourglassIcon,
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarThreadStatus, resolveWorkingStartedAt } from "../Sidebar.logic";
import { useWorkspaceViewStore } from "./workspaceViewStore";
import { compactAgo, isThreadUnread, threadActivityMs } from "./workspaces.logic";

/**
 * `agent`: a subagent under the thread that started it (WorkspaceAgentGroup).
 * `voice`: the thread holding this client's voice conversation, on top of the list.
 */
export type WorkspaceRowVariant = "active" | "pinned" | "settled" | "snoozed" | "agent" | "voice";

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

function StatusGlyph({
  thread,
  isUnread,
  isAgent,
}: {
  thread: SidebarThreadSummary;
  isUnread: boolean;
  isAgent: boolean;
}) {
  const status = resolveSidebarThreadStatus(thread);
  // Colors follow the upstream sidebar's status palette (Sidebar.tsx topStatus).
  const glyph: { icon: ReactNode; label: string; className: string } | null =
    status === "working"
      ? { icon: <CircleDashedIcon />, label: "Working", className: "text-info" }
      : status === "waiting"
        ? { icon: <HourglassIcon />, label: "Waiting", className: "text-foreground/60" }
        : status === "limited"
          ? { icon: <GaugeIcon />, label: "Usage limit reached", className: "text-warning" }
          : status === "approval"
            ? {
                icon: <ShieldQuestionIcon />,
                label: "Needs approval",
                className: "text-warning-foreground",
              }
            : status === "input"
              ? {
                  icon: <MessageCircleQuestionIcon />,
                  label: "Waiting for your answer",
                  className: "text-indigo-600 dark:text-indigo-300",
                }
              : status === "failed"
                ? { icon: <CircleAlertIcon />, label: "Failed", className: "text-error" }
                : isUnread
                  ? { icon: <CircleCheckIcon />, label: "Done, unread", className: "text-success" }
                  : isAgent
                    ? {
                        icon: <CheckIcon />,
                        label: "Done",
                        className: "text-sidebar-muted-foreground",
                      }
                    : null;
  if (!glyph) return <span className="flex size-3.5 shrink-0" />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={glyph.label}
            className={cn(
              "flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5",
              glyph.className,
            )}
          />
        }
      >
        {glyph.icon}
      </TooltipTrigger>
      <TooltipPopup side="top">{glyph.label}</TooltipPopup>
    </Tooltip>
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
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            className="flex size-5 items-center justify-center rounded text-sidebar-muted-foreground transition-colors hover:bg-foreground/8 hover:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-3.5"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClick();
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
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
  const seenBaselineAt = useWorkspaceViewStore((state) => state.seenBaselineAt);
  const isUnread = isThreadUnread(thread, lastVisitedAt, seenBaselineAt);
  const status = resolveSidebarThreadStatus(thread);
  const isRunning = status === "working";
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

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="button"
            tabIndex={0}
            data-thread-key={threadKey}
            data-active={props.isActive ? "true" : undefined}
            className={cn(
              "group/ws-row relative flex h-7 min-w-0 cursor-pointer select-none items-center gap-2 rounded-md pr-1.5 pl-2 text-sm outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              props.isActive
                ? "bg-sidebar-row-active text-sidebar-foreground"
                : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
              variant === "settled" && !props.isActive && "text-sidebar-muted-foreground",
            )}
            onClick={() => props.onOpen(threadRef)}
            onKeyDown={handleKeyDown}
            onContextMenu={handleContextMenu}
          />
        }
      >
        {variant === "voice" ? (
          <span
            className="flex size-3.5 shrink-0 items-center justify-center"
            role="img"
            aria-label="Voice conversation"
          >
            <AudioLinesIcon className="size-3.5 text-sidebar-foreground" />
          </span>
        ) : (
          <StatusGlyph thread={thread} isUnread={isUnread} isAgent={variant === "agent"} />
        )}
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
                "shrink-0 text-2xs tabular-nums text-sidebar-muted-foreground",
                variant !== "agent" && "group-hover/ws-row:hidden group-focus-within/ws-row:hidden",
                status === "working" && "text-info-foreground",
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
              {variant === "agent" ? null : variant === "snoozed" ? (
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
      </TooltipTrigger>
      <TooltipPopup side="right" align="start">
        <div className="min-w-0 wrap-anywhere">{thread.title}</div>
        {thread.branch ? (
          <div className="min-w-0 text-muted-foreground">⎇ {thread.branch}</div>
        ) : null}
      </TooltipPopup>
    </Tooltip>
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses and selects the rename input's DOM node on mount
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
      className="h-5 min-w-0 flex-1 rounded border border-ring/60 bg-background px-1 text-sm outline-hidden"
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
