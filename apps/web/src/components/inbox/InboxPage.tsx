import { inboxIssueKey, type ScopedInboxIssue } from "@t3tools/client-runtime/inbox";
import { type EnvironmentId, type InboxIssueId, isInboxIssueUnread } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleCheckIcon, CircleSlashIcon, MessageCircleQuestionIcon } from "lucide-react";
import { memo } from "react";

import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { showMoreClosedInboxIssues, useInboxState } from "../../state/inbox";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { InboxIssueDetail } from "./InboxIssueDetail";
import {
  groupInboxIssuesBySeverity,
  INBOX_SEVERITY_DOT_CLASS,
  INBOX_SEVERITY_LABEL,
} from "./inbox.logic";

export interface InboxSearch {
  readonly environmentId?: EnvironmentId;
  readonly issueId?: InboxIssueId;
  readonly view?: "open" | "closed";
}

/** Project titles by `environmentId:projectId`, for the cards' project label. */
function useProjectTitles(): ReadonlyMap<string, string> {
  const projects = useProjects();
  return new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
}

/** Fork: the inbox screen. The list on the left, the selected issue on the right. */
export function InboxPage({ search }: { search: InboxSearch }) {
  const state = useInboxState();
  const navigate = useNavigate();
  const view = search.view ?? "open";
  const selectedKey =
    search.environmentId !== undefined && search.issueId !== undefined
      ? `${search.environmentId}:${search.issueId}`
      : null;
  const selected =
    selectedKey === null
      ? null
      : (state.items.find((item) => inboxIssueKey(item) === selectedKey) ?? null);
  const onSelect = (item: ScopedInboxIssue) =>
    void navigate({
      to: "/inbox",
      search: (previous) => ({
        ...previous,
        environmentId: item.environmentId,
        issueId: item.issue.id,
      }),
    });
  const onView = (next: "open" | "closed") =>
    void navigate({
      to: "/inbox",
      search: (previous) => ({ ...previous, view: next }),
      replace: true,
    });
  const onBack = () =>
    void navigate({ to: "/inbox", search: search.view ? { view: search.view } : {} });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Inbox">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Inbox</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1">
          <section
            aria-label="Issues"
            className={cn(
              "flex min-h-0 w-full flex-col md:w-80 md:shrink-0 md:border-r md:border-border lg:w-96",
              selectedKey !== null && "max-md:hidden",
            )}
          >
            <InboxIssueList
              open={state.open}
              closed={state.closed}
              closedTotal={state.closedTotal}
              view={view}
              selectedKey={selectedKey}
              onSelect={onSelect}
              onView={onView}
            />
          </section>
          <section
            aria-label="Issue"
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              selectedKey === null && "max-md:hidden",
            )}
          >
            {search.environmentId !== undefined && search.issueId !== undefined ? (
              <InboxIssueDetail
                key={selectedKey}
                environmentId={search.environmentId}
                issueId={search.issueId}
                listed={selected}
                onBack={onBack}
              />
            ) : (
              <Empty className="flex-1">
                <EmptyHeader>
                  <EmptyDescription>
                    Select an issue to read its history and reply.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        </div>
      </div>
    </SidebarInset>
  );
}

function InboxIssueList(props: {
  open: ReadonlyArray<ScopedInboxIssue>;
  closed: ReadonlyArray<ScopedInboxIssue>;
  closedTotal: number;
  view: "open" | "closed";
  selectedKey: string | null;
  onSelect: (item: ScopedInboxIssue) => void;
  onView: (view: "open" | "closed") => void;
}) {
  const { open, closed, closedTotal, view, selectedKey, onSelect, onView } = props;
  const groups = groupInboxIssuesBySeverity(open);
  const projectTitles = useProjectTitles();
  // Re-renders the relative times once a minute; rows are memoized on their props.
  const now = useNowMinute();
  const row = (item: ScopedInboxIssue) => {
    const key = inboxIssueKey(item);
    return (
      <InboxIssueRow
        key={key}
        item={item}
        projectTitle={
          item.issue.projectId === null
            ? null
            : (projectTitles.get(`${item.environmentId}:${item.issue.projectId}`) ?? null)
        }
        selected={key === selectedKey}
        now={now}
        onSelect={onSelect}
      />
    );
  };

  return (
    <>
      <div className="flex shrink-0 items-center px-3 py-2">
        <ToggleGroup
          aria-label="Issues to show"
          className="w-full *:flex-1"
          value={[view]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "open" || value === "closed") onView(value);
          }}
        >
          <Toggle value="open">Open{open.length > 0 ? ` · ${open.length}` : ""}</Toggle>
          <Toggle value="closed">Closed</Toggle>
        </ToggleGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {view === "open" ? (
          groups.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>All quiet</EmptyTitle>
                <EmptyDescription>
                  No open issues. Agents will raise anything that needs you here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            groups.map((group) => (
              <section key={group.severity} aria-label={INBOX_SEVERITY_LABEL[group.severity]}>
                <h2 className="flex items-center gap-1.5 px-2.5 pt-4 pb-1.5 text-2xs font-medium text-muted-foreground">
                  {INBOX_SEVERITY_LABEL[group.severity]}
                  <span className="font-normal text-muted-foreground/60 tabular-nums">
                    {group.items.length}
                  </span>
                </h2>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{group.items.map(row)}</ul>
              </section>
            ))
          )
        ) : closed.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyDescription>Nothing closed yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 pt-1">{closed.map(row)}</ul>
            {closedTotal > closed.length ? (
              <div className="flex justify-center pt-3">
                <Button variant="ghost" size="sm" onClick={showMoreClosedInboxIssues}>
                  Show more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

const InboxIssueRow = memo(function InboxIssueRow(props: {
  item: ScopedInboxIssue;
  projectTitle: string | null;
  selected: boolean;
  /** Only here so the relative time re-renders each minute. */
  now: string;
  onSelect: (item: ScopedInboxIssue) => void;
}) {
  const { item, projectTitle, selected, onSelect } = props;
  const { issue } = item;
  const unread = isInboxIssueUnread(issue);
  const open = issue.state === "open";
  const waiting = open && issue.waitingForOwner;
  const time = formatRelativeTimeLabel(
    open ? issue.activityAt : (issue.closedAt ?? issue.activityAt),
  );
  const meta = [
    item.environmentLabel,
    projectTitle,
    issue.source.label,
    issue.repeatCount > 0 ? `×${issue.repeatCount + 1}` : null,
  ].filter((part): part is string => part !== null && part.length > 0);
  const ClosedIcon = issue.state === "resolved" ? CircleCheckIcon : CircleSlashIcon;

  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(item)}
        className={cn(
          "group/inbox-row flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          selected ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? (
            <span
              aria-label={INBOX_SEVERITY_LABEL[issue.severity]}
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                INBOX_SEVERITY_DOT_CLASS[issue.severity],
              )}
            />
          ) : (
            <ClosedIcon
              aria-label={issue.state === "resolved" ? "Resolved" : "Closed as not relevant"}
              className={cn(
                "-mx-[3px] size-3 shrink-0",
                issue.state === "resolved" ? "text-success" : "text-muted-foreground/70",
              )}
            />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              unread || waiting
                ? "font-medium text-foreground"
                : open
                  ? "text-foreground/80 group-hover/inbox-row:text-foreground"
                  : "text-secondary-label group-hover/inbox-row:text-foreground/80",
              selected && "text-foreground",
            )}
          >
            {issue.title}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground/70 tabular-nums">{time}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2 ps-3.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/80">
            {meta.join(" · ")}
          </span>
          {waiting ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-foreground/80">
              <MessageCircleQuestionIcon aria-hidden className="size-3" />
              Your turn
            </span>
          ) : unread ? (
            <span aria-label="New" className="size-1.5 shrink-0 rounded-full bg-info" />
          ) : null}
        </span>
      </button>
    </li>
  );
});
