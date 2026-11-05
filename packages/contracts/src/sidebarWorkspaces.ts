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

export const PeerConnectionStatus = Schema.Struct({
  sourceEnvironmentId: Schema.optionalKey(Schema.String),
  observedAt: Schema.optionalKey(Schema.String),
  environmentId: Schema.String,
  state: Schema.Literals(["direct", "relayed", "offline"]),
  via: Schema.NullOr(Schema.String),
  direction: Schema.NullOr(Schema.Literals(["inbound", "outbound"])),
  connectedAt: Schema.NullOr(Schema.String),
  offlineSince: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export type PeerConnectionStatus = typeof PeerConnectionStatus.Type;

/** The sshd a machine reports over its link: its port and public host keys. */
export const SidebarMachineReportedSshd = Schema.Struct({
  port: Schema.Int,
  hostKeys: Schema.Array(Schema.String),
});
export type SidebarMachineReportedSshd = typeof SidebarMachineReportedSshd.Type;

/**
 * What a machine reports about itself over the persistent peer connection. Only
 * reported facts live here; names, tags and reach belong to the mesh config.
 */
export const SidebarMachineReported = Schema.Struct({
  version: Schema.String,
  platform: Schema.Struct({
    os: Schema.String,
    arch: Schema.String,
    release: Schema.String,
  }),
  user: Schema.NullOr(Schema.String),
  /** Absent when the machine has no readable sshd host keys. */
  sshd: Schema.NullOr(SidebarMachineReportedSshd),
  meshPublicKey: Schema.optionalKey(Schema.String),
  reportedAt: Schema.String,
  connections: Schema.optionalKey(Schema.Array(PeerConnectionStatus)),
  sshRoutes: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        status: Schema.Literals(["ok", "failed", "unknown"]),
        reason: Schema.optionalKey(Schema.String),
        checkedAt: Schema.String,
      }),
    ),
  ),
});
export type SidebarMachineReported = typeof SidebarMachineReported.Type;

/** A machine as the user names it in the sidebar; absent fields fall back to the server's label. */
export const SidebarMachine = Schema.Struct({
  label: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  aliases: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Up to three characters shown on thread rows. */
  tag: Schema.optionalKey(Schema.String),
  color: Schema.optionalKey(Schema.String),
  /** Facts the machine itself reported over its link (never user-edited). */
  reported: Schema.optionalKey(SidebarMachineReported),
});
export type SidebarMachine = typeof SidebarMachine.Type;

/**
 * How a representation's files get there: its own checkout ("git": a primary, or an
 * independent clone), a Mutagen session with `source`, an SSHFS mount of `source`, or
 * a folder the user keeps in step by hand.
 */
export const SidebarProjectMountTransport = Schema.Literals(["git", "mutagen", "sshfs", "manual"]);
export type SidebarProjectMountTransport = typeof SidebarProjectMountTransport.Type;

/**
 * One representation of a logical project on one machine. A project may have several
 * primaries (each owns its `.git` and runs builds) and any number of replicas, each
 * synced from one `source` representation. Nothing here is tied to a particular machine.
 */
export const SidebarProjectMount = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["lite", "full"])),
  environmentId: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  /** The project registered at `path` there, once it is. */
  projectId: Schema.optionalKey(Schema.String),
  transport: SidebarProjectMountTransport,
  /** Reserved by the destination server before its driver starts copying. */
  pathAllocated: Schema.optionalKey(Schema.Boolean),
  adoption: Schema.optionalKey(
    Schema.Struct({
      environmentId: Schema.String,
      sessionIdentifier: Schema.String,
      paused: Schema.Boolean,
    }),
  ),
  syncKey: Schema.optionalKey(Schema.String),
  explicitPath: Schema.optionalKey(Schema.Boolean),
  pathValidated: Schema.optionalKey(Schema.Boolean),
  /** "primary" owns `.git` and computes; "replica" is a synced working copy of `source`. */
  role: Schema.Literals(["primary", "replica"]),
  /** For a replica: the environment whose representation it syncs with. */
  source: Schema.optionalKey(Schema.String),
  /** Extra ignore patterns for this replica, on top of the machine's defaults. */
  ignores: Schema.optionalKey(Schema.Array(Schema.String)),
  createdAt: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type SidebarProjectMount = typeof SidebarProjectMount.Type;

export const SidebarProjectMountState = Schema.Literals([
  "pending",
  "mounting",
  "watching",
  "conflict",
  "error",
  "paused",
  "removed",
]);
export type SidebarProjectMountState = typeof SidebarProjectMountState.Type;

const ReplicaSkippedPath = Schema.Struct({ path: Schema.String, error: Schema.String });

/** What the machine holding a replica last reported about synchronization. */
export const SidebarProjectMountStatus = Schema.Struct({
  skipped: Schema.optionalKey(Schema.Number),
  skippedPaths: Schema.optionalKey(Schema.Array(ReplicaSkippedPath)),
  conflictCopies: Schema.optionalKey(
    Schema.Struct({ environmentId: Schema.String, path: Schema.String }),
  ),
  state: SidebarProjectMountState,
  message: Schema.optionalKey(Schema.String),
  conflicts: Schema.optionalKey(Schema.Number),
  updatedAt: Schema.String,
});
export type SidebarProjectMountStatus = typeof SidebarProjectMountStatus.Type;

export const SidebarWorkspacesConfig = Schema.Struct({
  meshWriters: Schema.optionalKey(Schema.Array(Schema.String)),
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
  /** Environment id → how the user names and marks that machine. */
  machines: Schema.Record(Schema.String, SidebarMachine).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  projectTitles: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Any project key → the logical project key it belongs to (merged projects). */
  projectAliases: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Logical project key → the folders it has on each machine. */
  projectMounts: Schema.Record(Schema.String, Schema.Array(SidebarProjectMount)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Logical project key → environment id → that replica's last reported status. */
  projectMountStatus: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, SidebarProjectMountStatus),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type SidebarWorkspacesConfig = typeof SidebarWorkspacesConfig.Type;

export const DEFAULT_SIDEBAR_WORKSPACES_CONFIG: SidebarWorkspacesConfig = Schema.decodeSync(
  SidebarWorkspacesConfig,
)({});
