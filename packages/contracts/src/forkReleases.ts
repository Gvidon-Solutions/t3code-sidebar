import * as Schema from "effect/Schema";

/**
 * A published desktop build of the sidebar fork (fork feature). The desktop
 * app lists these so the user can install any of them, older ones included.
 */
export const DesktopForkReleaseSchema = Schema.Struct({
  /** GitHub release tag, `sidebar-v<version>`. */
  tag: Schema.String,
  version: Schema.String,
  publishedAt: Schema.String,
});
export type DesktopForkRelease = typeof DesktopForkReleaseSchema.Type;

export const DesktopForkReleaseListSchema = Schema.Array(DesktopForkReleaseSchema);

/** Release tags the desktop app accepts; also guards the feed URL built from one. */
export const DESKTOP_FORK_RELEASE_TAG_PATTERN = /^sidebar-v\d+\.\d+\.\d+-sidebar\.\d+$/;
