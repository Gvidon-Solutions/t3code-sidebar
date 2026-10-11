import type { SidebarWorkspace } from "@t3tools/contracts";
import {
  BookOpenIcon,
  BotIcon,
  BriefcaseIcon,
  Building2Icon,
  CodeXmlIcon,
  FlaskConicalIcon,
  Gamepad2Icon,
  GraduationCapIcon,
  HeartIcon,
  HouseIcon,
  LandmarkIcon,
  ListIcon,
  PlusIcon,
  RocketIcon,
  RowsIcon,
  SparklesIcon,
  StarIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
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
import {
  type WorkspaceActivity,
  WORKSPACE_LABEL_MAX,
  workspaceColor,
  workspaceMark,
} from "./workspaces.logic";

/** MIME type carried by a dragged project folder; the payload is its project key. */
export const WORKSPACE_PROJECT_DRAG_TYPE = "application/x-t3-workspace-project";
/** MIME type carried by a dragged workspace tile; the payload is its workspace id. */
const WORKSPACE_TILE_DRAG_TYPE = "application/x-t3-workspace-tile";

/** Built-in tile glyphs, stored in a workspace's `icon` as `glyph:<key>`. */
export const WORKSPACE_GLYPHS: Readonly<Record<string, { label: string; Icon: LucideIcon }>> = {
  house: { label: "Home", Icon: HouseIcon },
  briefcase: { label: "Briefcase", Icon: BriefcaseIcon },
  building: { label: "Company", Icon: Building2Icon },
  landmark: { label: "Bank", Icon: LandmarkIcon },
  wallet: { label: "Money", Icon: WalletIcon },
  graduation: { label: "Education", Icon: GraduationCapIcon },
  book: { label: "Book", Icon: BookOpenIcon },
  code: { label: "Code", Icon: CodeXmlIcon },
  bot: { label: "Bot", Icon: BotIcon },
  rocket: { label: "Rocket", Icon: RocketIcon },
  flask: { label: "Lab", Icon: FlaskConicalIcon },
  users: { label: "Team", Icon: UsersIcon },
  heart: { label: "Heart", Icon: HeartIcon },
  star: { label: "Star", Icon: StarIcon },
  sparkles: { label: "Sparkles", Icon: SparklesIcon },
  game: { label: "Games", Icon: Gamepad2Icon },
};

/** The tile face: a built-in glyph, the custom label or the first letter. */
function WorkspaceMark({
  workspace,
  glyphClassName,
}: {
  workspace: Pick<SidebarWorkspace, "name" | "icon">;
  glyphClassName: string;
}) {
  const mark = workspaceMark(workspace);
  if (mark.kind === "glyph") {
    const Glyph = WORKSPACE_GLYPHS[mark.glyph]?.Icon ?? RowsIcon;
    return <Glyph className={glyphClassName} />;
  }
  return <>{mark.text}</>;
}

/** Two-character labels get a step smaller type so they fit the square. */
const isWideMark = (workspace: Pick<SidebarWorkspace, "name" | "icon">) => {
  const mark = workspaceMark(workspace);
  return mark.kind === "text" && Array.from(mark.text).length > 1;
};

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
  const wide = workspace ? isWideMark(workspace) : false;
  return (
    <span
      aria-hidden
      style={color ? ({ "--ws-tile": color } as CSSProperties) : undefined}
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold leading-none tracking-tight",
        size === "lg" ? "size-6 rounded-md" : "size-5 rounded-md",
        size === "lg" ? (wide ? "text-3xs" : "text-2xs") : "text-3xs",
        workspace
          ? "bg-(--ws-tile) text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]"
          : "bg-foreground/8 text-sidebar-muted-foreground",
        className,
      )}
    >
      {workspace ? (
        <WorkspaceMark
          workspace={workspace}
          glyphClassName={size === "lg" ? "size-3.5" : "size-3"}
        />
      ) : (
        <RowsIcon className="size-3.5" />
      )}
    </span>
  );
}

export type WorkspaceTitleEditing = "name" | "label" | null;

/**
 * The titlebar row: current workspace avatar and name. Double-click renames,
 * right-click opens the workspace menu. Doubles as the desktop drag region.
 */
export function WorkspaceTitlebar({
  workspace,
  isElectron,
  editing,
  onStartRename,
  onCommitRename,
  onCommitLabel,
  onContextMenu,
  actions,
}: {
  workspace: SidebarWorkspace | null;
  isElectron: boolean;
  editing: WorkspaceTitleEditing;
  onStartRename: () => void;
  onCommitRename: (name: string | null) => void;
  /** Null cancels; an empty string clears the label back to the first letter. */
  onCommitLabel: (label: string | null) => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  actions: ReactNode;
}) {
  const labelValue =
    workspace?.icon && workspaceMark(workspace).kind === "text" ? workspace.icon : "";
  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 pr-2 pl-3 md:pl-[calc(var(--workspace-titlebar-content-left)+0.25rem)]",
        isElectron && "drag-region",
      )}
    >
      <SidebarTrigger variant="ghost" className="relative top-auto translate-y-0 md:hidden" />
      <WorkspaceAvatar workspace={workspace} size="lg" />
      {editing === "name" && workspace ? (
        <InlineInput
          key="name"
          initial={workspace.name}
          ariaLabel="Workspace name"
          className="flex-1 text-sm font-semibold"
          onCommit={onCommitRename}
        />
      ) : editing === "label" && workspace ? (
        <>
          <InlineInput
            key="label"
            initial={labelValue}
            ariaLabel="Tile label"
            placeholder="Aa"
            className="w-12 text-center text-sm font-semibold"
            onCommit={onCommitLabel}
          />
          <span className="min-w-0 truncate text-xs text-sidebar-muted-foreground">
            Up to {WORKSPACE_LABEL_MAX} letters or an emoji · Enter
          </span>
        </>
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
          {workspace ? workspace.name : "All"}
        </button>
      )}
      <span className="flex-1" />
      <div className="flex shrink-0 items-center">{actions}</div>
    </div>
  );
}

function InlineInput({
  initial,
  ariaLabel,
  placeholder,
  className,
  onCommit,
}: {
  initial: string;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  onCommit: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = (next: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(next);
  };
  return (
    <input
      ref={inputRef}
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className={cn(
        "h-6 min-w-0 rounded-md border border-ring/60 bg-background px-1.5 outline-hidden",
        className,
      )}
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
          "absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-3xs leading-none font-bold text-white ring-2 ring-sidebar",
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
 * toggle that folds every workspace into one list. Tiles drag to reorder;
 * dropping a project folder on a tile moves the project there.
 */
export function WorkspaceDock({
  entries,
  activeWorkspaceId,
  defaultWorkspaceId,
  tilesVisible,
  onSelect,
  onTileContextMenu,
  onCreate,
  onToggleTiles,
  onDropProject,
  onReorder,
}: {
  entries: readonly WorkspaceTileEntry[];
  activeWorkspaceId: string | null;
  defaultWorkspaceId: string | null;
  tilesVisible: boolean;
  onSelect: (workspaceId: string) => void;
  onTileContextMenu: (workspaceId: string, position: { x: number; y: number }) => void;
  onCreate: () => void;
  onToggleTiles: () => void;
  onDropProject: (projectKey: string, workspaceId: string) => void;
  /** Moves a workspace before slot `beforeIndex` of the current order. */
  onReorder: (workspaceId: string, beforeIndex: number) => void;
}) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [reorderSlot, setReorderSlot] = useState<number | null>(null);
  const clearDrag = () => {
    setDropTarget(null);
    setReorderSlot(null);
  };
  const handleDragOver = (event: ReactDragEvent<HTMLElement>, index: number) => {
    const types = event.dataTransfer.types;
    if (types.includes(WORKSPACE_TILE_DRAG_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.getBoundingClientRect();
      setReorderSlot(event.clientX < rect.left + rect.width / 2 ? index : index + 1);
      return;
    }
    if (!types.includes(WORKSPACE_PROJECT_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(entries[index]?.workspace.id ?? null);
  };
  const handleDrop = (event: ReactDragEvent, index: number) => {
    const tileId = event.dataTransfer.getData(WORKSPACE_TILE_DRAG_TYPE);
    const projectKey = event.dataTransfer.getData(WORKSPACE_PROJECT_DRAG_TYPE);
    const slot = reorderSlot;
    const workspaceId = entries[index]?.workspace.id;
    clearDrag();
    if (tileId && slot !== null) {
      event.preventDefault();
      onReorder(tileId, slot);
    } else if (projectKey && workspaceId) {
      event.preventDefault();
      onDropProject(projectKey, workspaceId);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-sidebar-border/60 px-2.5 pt-2 pb-1.5">
      {tilesVisible ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {entries.map(({ workspace, activity }, index) => {
            const isActive = workspace.id === activeWorkspaceId;
            const isDefault = workspace.id === defaultWorkspaceId;
            const color = workspaceColor(workspace);
            const details = [
              workspace.name,
              isDefault ? "default" : null,
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
                      draggable
                      aria-label={workspace.name}
                      aria-pressed={isActive}
                      style={{ "--ws-tile": color } as CSSProperties}
                      className={cn(
                        "relative flex size-8 shrink-0 items-center justify-center rounded-lg font-semibold leading-none tracking-tight outline-hidden transition-[background-color,color,box-shadow,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring active:scale-95",
                        isWideMark(workspace) ? "text-2xs" : "text-xs",
                        isActive
                          ? "bg-(--ws-tile) text-white shadow-[0_1px_2px_rgb(0_0_0/0.18),inset_0_0_0_1px_rgb(255_255_255/0.2)]"
                          : "bg-[color-mix(in_oklab,var(--ws-tile)_14%,transparent)] text-(--ws-tile) hover:bg-[color-mix(in_oklab,var(--ws-tile)_24%,transparent)] dark:bg-[color-mix(in_oklab,var(--ws-tile)_24%,transparent)] dark:text-[color-mix(in_oklab,var(--ws-tile)_65%,white)] dark:hover:bg-[color-mix(in_oklab,var(--ws-tile)_34%,transparent)]",
                        dropTarget === workspace.id &&
                          "ring-2 ring-(--ws-tile) ring-offset-2 ring-offset-sidebar",
                      )}
                      onClick={() => onSelect(workspace.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        onTileContextMenu(workspace.id, { x: event.clientX, y: event.clientY });
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(WORKSPACE_TILE_DRAG_TYPE, workspace.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={clearDrag}
                      onDragOver={(event) => handleDragOver(event, index)}
                      onDragLeave={clearDrag}
                      onDrop={(event) => handleDrop(event, index)}
                    />
                  }
                >
                  <WorkspaceMark workspace={workspace} glyphClassName="size-4" />
                  <TileIndicator activity={activity} />
                  {isDefault ? (
                    <span className="absolute -bottom-1 left-1/2 h-0.5 w-2.5 -translate-x-1/2 rounded-full bg-sidebar-muted-foreground/60" />
                  ) : null}
                  {reorderSlot === index ? (
                    <span className="absolute inset-y-0.5 -left-1 w-0.5 rounded-full bg-sidebar-foreground/70" />
                  ) : null}
                  {reorderSlot === index + 1 ? (
                    <span className="absolute inset-y-0.5 -right-1 w-0.5 rounded-full bg-sidebar-foreground/70" />
                  ) : null}
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
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-sidebar-border text-sidebar-muted-foreground outline-hidden transition-colors hover:border-sidebar-foreground/40 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={onCreate}
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">New workspace</TooltipPopup>
          </Tooltip>
        </div>
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
