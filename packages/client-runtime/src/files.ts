import type { EnvironmentId } from "@t3tools/contracts";
import { machineDisplayOf } from "./state/machineDisplay.ts";

/** T3 Mesh (fork): routing a file request to the machine that holds it. */
export const T3_FILE_URL_PREFIX = "t3-file://";

/** Uses the sidebar's default tag rule in file machine pickers. */
export function machineTag(label: string): string {
  return machineDisplayOf({ machines: {} }, "?", label).tag;
}

/**
 * The environment to make the call through. A connected target answers
 * directly; otherwise a connected server forwards over its link. Null when
 * this client is connected to nothing.
 */
export function pickFilesEnvironment(
  targetEnvironmentId: EnvironmentId,
  connectedEnvironmentIds: ReadonlyArray<EnvironmentId>,
): EnvironmentId | null {
  if (connectedEnvironmentIds.includes(targetEnvironmentId)) return targetEnvironmentId;
  return connectedEnvironmentIds[0] ?? null;
}

/** `t3-file://<envId>/<absolute path>`, the link a client can hand around. */
export function buildT3FileLink(environmentId: EnvironmentId, absolutePath: string): string {
  return `${T3_FILE_URL_PREFIX}${environmentId}/${encodeURIComponent(absolutePath)}`;
}

export interface T3FileLink {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
}

/**
 * Parses a `t3-file://` link. The path may be percent-encoded; a pasted
 * `t3-file://<envId>/<absolute path>` with the separators left alone works too.
 */
export function parseT3FileLink(value: string): T3FileLink | null {
  if (!value.startsWith(T3_FILE_URL_PREFIX)) return null;
  const rest = value.slice(T3_FILE_URL_PREFIX.length);
  const separator = rest.indexOf("/");
  if (separator <= 0) return null;
  const environmentId = rest.slice(0, separator) as EnvironmentId;
  let absolutePath: string;
  try {
    absolutePath = decodeURIComponent(rest.slice(separator + 1));
  } catch {
    return null;
  }
  if (absolutePath === "") return null;
  return { environmentId, absolutePath };
}

/** Newest first, one entry per path, bounded. */
export function addRecentFile(
  files: ReadonlyArray<string>,
  absolutePath: string,
  limit = 10,
): ReadonlyArray<string> {
  return [absolutePath, ...files.filter((file) => file !== absolutePath)].slice(0, limit);
}
