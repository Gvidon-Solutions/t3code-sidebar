import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import {
  isAbsolutePath,
  isAudioPreviewFile,
  isVideoPreviewFile,
  resolveWorkspaceFilePath,
} from "./filePath";

export function useWorkspaceFileAssetUrlState(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
  readonly draftCwd?: string | null;
  /** The machine that holds the file when the route's own environment is not connected. */
  readonly peerEnvironmentId?: EnvironmentId | null;
  /** The connected machine to mint the proxy URL through. */
  readonly callEnvironmentId?: EnvironmentId | null;
}) {
  const absolutePath =
    props.cwd !== null && props.relativePath !== null
      ? resolveWorkspaceFilePath(props.cwd, props.relativePath)
      : null;

  const relativePath = props.relativePath;
  const draftCwd = props.draftCwd ?? null;
  const resource = useMemo<AssetResource | null>(() => {
    if (absolutePath === null || relativePath === null) return null;
    if (props.peerEnvironmentId !== undefined && props.peerEnvironmentId !== null) {
      return {
        _tag: "peer-file",
        environmentId: props.peerEnvironmentId,
        path: absolutePath,
      };
    }
    if (props.threadId !== null) {
      return {
        _tag:
          isVideoPreviewFile(absolutePath) ||
          isAudioPreviewFile(absolutePath) ||
          isAbsolutePath(relativePath)
            ? "media-file"
            : "workspace-file",
        threadId: props.threadId,
        path: absolutePath,
      };
    }
    if (draftCwd === null) return null;
    return { _tag: "draft-workspace-file", cwd: draftCwd, path: relativePath };
  }, [absolutePath, relativePath, props.threadId, props.peerEnvironmentId, draftCwd]);
  const callEnvironmentId = props.callEnvironmentId ?? props.environmentId;
  const state = useAssetUrlState(callEnvironmentId, resource);
  const refresh = useRefreshAssetUrl(callEnvironmentId, resource);
  return { ...state, resource, refresh };
}
