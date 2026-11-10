import type { FilesLocateResult, UiOpenTarget } from "@t3tools/contracts";

/**
 * The `ui_open` file target sent to clients. A found file carries the resolved
 * target, with `environmentId` omitted for the asking thread's own machine; a
 * choice or a miss carries the locate result so the client shows the picker or
 * the not-found state instead of opening the best-ranked candidate.
 */
export function uiFileTarget(
  locate: FilesLocateResult,
  rawPath: string,
  threadEnvironmentId: string,
): Extract<UiOpenTarget, { kind: "file" }> {
  if (locate.status === "found" && locate.target !== undefined) {
    return {
      kind: "file",
      path: locate.target.absolutePath,
      ...(locate.target.line === undefined ? {} : { line: locate.target.line }),
      ...(locate.target.environmentId === threadEnvironmentId
        ? {}
        : { environmentId: locate.target.environmentId }),
      resolved: locate,
    };
  }
  return { kind: "file", path: rawPath, resolved: locate };
}
