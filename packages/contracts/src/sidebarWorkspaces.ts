import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Workspace sidebar configuration (fork feature).
 *
 * Workspaces group projects (personal, work clients, …). The config is a
 * shared server setting so every client of the user's environments shows the
 * same workspaces; which workspace is open, collapsed folders and similar view
 * state stay per device.
 *
 * A project belongs to the workspace named by `assignments[projectKey]`, else
 * to the first rule whose glob matches its workspace root, else to
 * `defaultWorkspace` (or the first workspace).
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
  /** Logical project key → workspace id. Wins over rules. */
  assignments: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  rules: Schema.Array(SidebarWorkspaceRule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  defaultWorkspace: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Logical project keys that never fold into "Quiet projects". */
  alwaysShow: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  quietAfterDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_WORKSPACE_QUIET_AFTER_DAYS)),
  ),
});
export type SidebarWorkspacesConfig = typeof SidebarWorkspacesConfig.Type;

export const DEFAULT_SIDEBAR_WORKSPACES_CONFIG: SidebarWorkspacesConfig = Schema.decodeSync(
  SidebarWorkspacesConfig,
)({});
