import type {
  EnvironmentId,
  EnvironmentMachineKind,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { projectMachineTags } from "@t3tools/client-runtime/state/mesh-layout";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { Project } from "../types";
import {
  buildCommandPaletteProjectMetadata,
  buildProjectActionItems,
  type CommandPaletteItemPin,
  type CommandPaletteProject,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface CommandPaletteProjectLocation {
  readonly label: string | null;
  readonly machine: EnvironmentMachineKind;
}

interface ProjectItemsInput {
  readonly projects: ReadonlyArray<CommandPaletteProject>;
  readonly projectGroupByTargetKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly locationByEnvironmentId: ReadonlyMap<EnvironmentId, CommandPaletteProjectLocation>;
  readonly config: SidebarWorkspacesConfig | null;
  /** Titles that two logical projects share, so their rows need a path tail. */
  readonly ambiguousTitles?: ReadonlySet<string>;
  readonly runProject: (project: CommandPaletteProject) => Promise<void>;
  readonly pin?: (project: CommandPaletteProject) => CommandPaletteItemPin | null;
}

function projectFaviconIcon(project: Project) {
  return <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />;
}

/** Projects as root search results; a grouped project matches on every member. */
export function buildProjectSearchItems(input: ProjectItemsInput) {
  const membersOf = (project: CommandPaletteProject) =>
    input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)?.memberProjects ?? [
      project,
    ];
  return buildProjectActionItems({
    projects: input.projects,
    valuePrefix: "project",
    searchTerms: (project) =>
      buildCommandPaletteProjectMetadata({
        projects: membersOf(project),
        locationByEnvironmentId: input.locationByEnvironmentId,
      }).searchTerms,
    renderDescription: (project) => (
      <ProjectMachineDescription
        config={input.config}
        group={input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)}
        project={project}
        showPathTail={input.ambiguousTitles?.has(project.title) === true}
      />
    ),
    icon: projectFaviconIcon,
    runProject: input.runProject,
    ...(input.pin ? { pin: input.pin } : {}),
  });
}

/** Projects as targets of the "New thread in..." submenu. */
export function buildNewThreadInProjectItems(
  input: ProjectItemsInput & { readonly currentProjectKey: string | null },
) {
  return buildProjectActionItems({
    projects: input.projects,
    valuePrefix: "new-thread-in",
    searchTerms: (project) => {
      const group = input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      const location = input.locationByEnvironmentId.get(project.environmentId);
      return [
        ...(group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []),
        ...(location?.label ? [location.label] : []),
      ];
    },
    renderDescription: (project) => (
      <ProjectMachineDescription
        config={input.config}
        group={input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)}
        project={project}
        showPathTail={input.ambiguousTitles?.has(project.title) === true}
        current={input.currentProjectKey === `${project.environmentId}:${project.id}`}
      />
    ),
    icon: projectFaviconIcon,
    runProject: input.runProject,
    ...(input.pin ? { pin: input.pin } : {}),
  });
}

/** One row per logical project: its machines as config tags, main copy first. */
export function ProjectMachineDescription(props: {
  readonly config: SidebarWorkspacesConfig | null;
  readonly group: SidebarProjectSnapshot | undefined;
  readonly project: CommandPaletteProject;
  /** Two projects share this title, so the row needs a path tail to tell them apart. */
  readonly showPathTail?: boolean;
  /** The "New thread in..." menu marks the project the thread already lives in. */
  readonly current?: boolean;
}) {
  const members = props.group?.memberProjects ?? [props.project];
  const tags = projectMachineTags(
    props.config ?? { machines: {}, projectMounts: {} },
    props.group?.projectKey ?? "",
    members.map((member) => member.environmentId),
  );
  const current = props.current === true;
  const mesh = props.config !== null && tags.some((tag) => tag.tag !== "");
  if (!mesh) {
    return (
      <span className="flex min-w-0 items-center gap-1 truncate text-muted-foreground">
        {current ? (
          <>
            <span className="shrink-0">Current</span>
            <span className="shrink-0 text-muted-foreground/50">·</span>
          </>
        ) : null}
        <span className="truncate">{shortProjectPath(props.project.workspaceRoot)}</span>
      </span>
    );
  }
  const names = tags.map((tag) => tag.label).join(" · ");
  const pathTail = props.showPathTail ? shortProjectPath(props.project.workspaceRoot) : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="flex min-w-0 items-center gap-1" aria-label={`On ${names}`} />}
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          {current ? (
            <>
              <span className="shrink-0">Current</span>
              <span className="shrink-0 text-muted-foreground/50">·</span>
            </>
          ) : null}
          {tags.map((tag) => (
            <span
              key={tag.environmentId}
              className="shrink-0 rounded bg-foreground/[0.06] px-1 py-0.5 font-semibold text-3xs uppercase tracking-wide text-muted-foreground"
            >
              {tag.tag}
            </span>
          ))}
          {pathTail === null ? null : (
            <span className="truncate text-muted-foreground/70">{pathTail}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{pathTail === null ? names : `${names} · ${pathTail}`}</TooltipPopup>
    </Tooltip>
  );
}

function shortProjectPath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length <= 2 ? path : `…/${segments.slice(-2).join("/")}`;
}
