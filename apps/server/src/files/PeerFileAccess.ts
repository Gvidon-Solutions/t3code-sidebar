// @effect-diagnostics nodeBuiltinImport:off - lexical containment needs the native path semantics.
import * as NodePath from "node:path";

/** A `peer-file` URL may name this machine or a machine this server is linked to. */
export const peerTargetAllowed = (
  self: string,
  target: string,
  linkedEnvironmentIds: ReadonlyArray<string>,
) => target === self || linkedEnvironmentIds.includes(target);

/**
 * A linked caller keeps its own file permission for a locally minted proxy URL:
 * a project-only or read-only link cannot reach outside the target's projects.
 */
export const peerFilePathAllowed = (input: {
  readonly linked: boolean;
  readonly files: "all" | "projects" | "none";
  readonly access?: string;
  readonly absolutePath: string;
  readonly projectRoots: ReadonlyArray<string>;
}) => {
  if (!input.linked) return true;
  if (input.files === "none") return false;
  if (input.files === "all" && input.access !== "read-only") return true;
  if (!NodePath.isAbsolute(input.absolutePath)) return false;
  return input.projectRoots.some((root) => {
    const relative = NodePath.relative(root, input.absolutePath);
    return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
  });
};
