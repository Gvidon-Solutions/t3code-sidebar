import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Workspace sidebar configuration (fork feature), a shared server setting; view state stays per
 * device. A project shows in `placements[projectKey]`, else `assignments[projectKey]`, else the
 * first workspace whose rule glob matches its root, else `defaultWorkspace` (or the first).
 */
export const SidebarWorkspace = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** One or two characters shown on the workspace tile; the name's initial when absent. */
  icon: Schema.optionalKey(Schema.String),
  /** CSS color for the tile and the sidebar tint. */
  color: Schema.optionalKey(Schema.String),
});
export type SidebarWorkspace = typeof SidebarWorkspace.Type;

export const SidebarWorkspaceRule = Schema.Struct({
  /** Glob over the project's workspace root; `*` matches within a segment, `**` across. */
  match: TrimmedNonEmptyString,
  workspace: TrimmedNonEmptyString,
});
export type SidebarWorkspaceRule = typeof SidebarWorkspaceRule.Type;

export const DEFAULT_SIDEBAR_WORKSPACE_QUIET_AFTER_DAYS = 5;

export const SidebarWorkspacesConfig = Schema.Struct({
  workspaces: Schema.Array(SidebarWorkspace).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Logical project key → workspace id. Wins over rules. Since `placements`,
   * the first workspace a placed project shows in, for clients that predate it.
   */
  assignments: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Logical project key → every workspace it shows in (one project, the same
   * threads, in several workspaces). Wins over `assignments` and rules.
   */
  placements: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  rules: Schema.Array(SidebarWorkspaceRule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  defaultWorkspace: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Logical project keys in the order the user dragged them into, for
   * workspaces without their own order. Each workspace shows its projects in
   * its order, projects missing from it first (newest first).
   */
  projectOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Workspace id → its own project order, once the user arranges or adds to it. */
  workspaceProjectOrder: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Workspace id → logical project key → where the user put the project by
   * hand in that workspace: "quiet" (in "Quiet projects" until moved back) or
   * "active" (never folds there). Absent: it folds by itself.
   */
  workspaceFold: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Literals(["quiet", "active"])),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Legacy, before `workspaceFold`: project keys that never folded, in every workspace. Unused. */
  alwaysShow: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Legacy, sidebar.22 only: project keys moved into "Quiet projects" everywhere. Unused. */
  alwaysQuiet: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  quietAfterDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_WORKSPACE_QUIET_AFTER_DAYS)),
  ),
});
export type SidebarWorkspacesConfig = typeof SidebarWorkspacesConfig.Type;

export const DEFAULT_SIDEBAR_WORKSPACES_CONFIG: SidebarWorkspacesConfig = Schema.decodeSync(
  SidebarWorkspacesConfig,
)({});
