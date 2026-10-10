import type { SidebarWorkspace } from "@t3tools/contracts";
import { ListIcon, PlusIcon, RowsIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type WorkspaceActivity, workspaceColor, workspaceInitials } from "./workspaces.logic";

/** MIME type carried by a dragged project folder; the payload is its project key. */
export const WORKSPACE_PROJECT_DRAG_TYPE = "application/x-t3-workspace-project";

export function WorkspaceAvatar({
  workspace,
  size = "md",
  className,
}: {
  workspace: Pick<SidebarWorkspace, "id" | "name" | "icon" | "color"> | null;
  size?: "md" | "lg";
  className?: string;
}) {
  const color = workspace ? workspaceColor(workspace) : null;
  return (
    <span
      aria-hidden
      style={color ? ({ "--ws-tile": color } as CSSProperties) : undefined}
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold tracking-tight",
        size === "lg" ? "size-6 rounded-[7px] text-[11px]" : "size-5 rounded-md text-[10px]",
        workspace
          ? "bg-(--ws-tile) text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]"
          : "bg-foreground/8 text-sidebar-muted-foreground",
        className,
      )}
    >
      {workspace ? workspaceInitials(workspace) : <RowsIcon className="size-3.5" />}
    </span>
  );
}

/**
 * The titlebar row: current workspace avatar and name. Double-click renames,
 * right-click opens the workspace menu. Doubles as the desktop drag region.
 */
export function WorkspaceTitlebar({
  workspace,
  isElectron,
  isRenaming,
  onStartRename,
  onCommitRename,
  onContextMenu,
  actions,
}: {
  workspace: SidebarWorkspace | null;
  isElectron: boolean;
  isRenaming: boolean;
  onStartRename: () => void;
  onCommitRename: (name: string | null) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  actions: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 pr-2 pl-3 md:pl-[calc(var(--workspace-titlebar-content-left)+0.25rem)]",
        isElectron && "drag-region",
      )}
    >
      <SidebarTrigger variant="ghost" className="relative top-auto translate-y-0 md:hidden" />
      <WorkspaceAvatar workspace={workspace} size="lg" />
      {isRenaming && workspace ? (
        <NameInput initial={workspace.name} onCommit={onCommitRename} />
      ) : (
        <button
          type="button"
          className="min-w-0 truncate rounded px-0.5 text-left text-sm font-semibold tracking-tight text-sidebar-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          title={
            workspace ? "Double-click to rename · right-click for workspace actions" : undefined
          }
          onDoubleClick={workspace ? onStartRename : undefined}
          onContextMenu={onContextMenu}
        >
          {workspace ? workspace.name : "All workspaces"}
        </button>
      )}
      <span className="flex-1" />
      <div className="flex shrink-0 items-center">{actions}</div>
    </div>
  );
}

function NameInput({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = (name: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(name);
  };
  return (
    <input
      ref={inputRef}
      value={value}
      aria-label="Workspace name"
      className="h-6 min-w-0 flex-1 rounded-md border border-ring/60 bg-background px-1.5 text-sm font-semibold outline-hidden"
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") commit(value);
        if (event.key === "Escape") commit(null);
      }}
      onBlur={() => commit(value)}
    />
  );
}

function TileIndicator({ activity }: { activity: WorkspaceActivity }) {
  if (activity.attention > 0) {
    return (
      <span
        className={cn(
          "absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] leading-none font-bold text-white ring-2 ring-sidebar",
          activity.failed > 0 ? "bg-red-500" : "bg-amber-500",
        )}
      >
        {activity.attention}
      </span>
    );
  }
  return (
    <>
      {activity.unread > 0 ? (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-sidebar" />
      ) : null}
      {activity.working > 0 ? (
        <span className="absolute -bottom-0.5 -left-0.5 size-2 rounded-full bg-sky-500 ring-2 ring-sidebar" />
      ) : null}
    </>
  );
}

export interface WorkspaceTileEntry {
  workspace: SidebarWorkspace;
  activity: WorkspaceActivity;
}

/**
 * Bottom dock: one square tile per workspace (Zen-style), a "+" tile and the
 * toggle that folds every workspace into one list. Dropping a project folder
 * on a tile moves the project there.
 */
export function WorkspaceDock({
  entries,
  activeWorkspaceId,
  tilesVisible,
  onSelect,
  onTileContextMenu,
  onCreate,
  onToggleTiles,
  onDropProject,
}: {
  entries: readonly WorkspaceTileEntry[];
  activeWorkspaceId: string | null;
  tilesVisible: boolean;
  onSelect: (workspaceId: string) => void;
  onTileContextMenu: (workspaceId: string, position: { x: number; y: number }) => void;
  onCreate: () => void;
  onToggleTiles: () => void;
  onDropProject: (projectKey: string, workspaceId: string) => void;
}) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const handleDragOver = (event: ReactDragEvent, workspaceId: string) => {
    if (!event.dataTransfer.types.includes(WORKSPACE_PROJECT_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(workspaceId);
  };
  const handleDrop = (event: ReactDragEvent, workspaceId: string) => {
    const projectKey = event.dataTransfer.getData(WORKSPACE_PROJECT_DRAG_TYPE);
    setDropTarget(null);
    if (!projectKey) return;
    event.preventDefault();
    onDropProject(projectKey, workspaceId);
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-sidebar-border/60 px-2.5 pt-2 pb-1.5">
      {tilesVisible ? (
        <>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {entries.map(({ workspace, activity }, index) => {
              const isActive = workspace.id === activeWorkspaceId;
              const color = workspaceColor(workspace);
              const details = [
                workspace.name,
                index < 9 ? `Alt+${index + 1}` : null,
                activity.attention ? `${activity.attention} need you` : null,
                activity.working ? `${activity.working} working` : null,
                activity.unread ? `${activity.unread} unread` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Tooltip key={workspace.id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={workspace.name}
                        aria-pressed={isActive}
                        style={{ "--ws-tile": color } as CSSProperties}
                        className={cn(
                          "relative flex size-8 shrink-0 items-center justify-center rounded-[9px] text-[12px] font-semibold tracking-tight outline-hidden transition-[background-color,color,box-shadow,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring active:scale-95",
                          isActive
                            ? "bg-(--ws-tile) text-white shadow-[0_1px_2px_rgb(0_0_0/0.18),inset_0_0_0_1px_rgb(255_255_255/0.2)]"
                            : "bg-[color-mix(in_oklab,var(--ws-tile)_14%,transparent)] text-(--ws-tile) hover:bg-[color-mix(in_oklab,var(--ws-tile)_24%,transparent)]",
                          dropTarget === workspace.id &&
                            "ring-2 ring-(--ws-tile) ring-offset-2 ring-offset-sidebar",
                        )}
                        onClick={() => onSelect(workspace.id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          onTileContextMenu(workspace.id, { x: event.clientX, y: event.clientY });
                        }}
                        onDragOver={(event) => handleDragOver(event, workspace.id)}
                        onDragLeave={() => setDropTarget(null)}
                        onDrop={(event) => handleDrop(event, workspace.id)}
                      />
                    }
                  >
                    {workspaceInitials(workspace)}
                    <TileIndicator activity={activity} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{details}</TooltipPopup>
                </Tooltip>
              );
            })}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="New workspace"
                    className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-dashed border-sidebar-border text-sidebar-muted-foreground outline-hidden transition-colors hover:border-sidebar-foreground/40 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={onCreate}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">New workspace</TooltipPopup>
            </Tooltip>
          </div>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-sidebar-muted-foreground">
          All workspaces in one list
        </span>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tilesVisible ? "Show all workspaces in one list" : "Show workspace tiles"}
              aria-pressed={!tilesVisible}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center self-end rounded-md text-sidebar-muted-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring",
                !tilesVisible && "bg-sidebar-row-active text-sidebar-foreground",
              )}
              onClick={onToggleTiles}
            />
          }
        >
          <ListIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {tilesVisible ? "All workspaces in one list (Alt+0)" : "Show workspace tiles (Alt+0)"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
