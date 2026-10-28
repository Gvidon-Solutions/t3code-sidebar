import type { DesktopUpdateState } from "@t3tools/contracts";

// Sidebar fork: what a running app update is doing, in words, for the
// Settings → Version row and the sidebar's update strip.

export interface DesktopUpdateProgress {
  readonly kind: "downloading" | "downloaded" | "failed";
  /** Short, for a button or the sidebar strip. */
  readonly label: string;
  /** One sentence for a description or tooltip. */
  readonly detail: string;
  /** 0–100 while downloading, when known. */
  readonly percent: number | null;
}

export function describeDesktopUpdateProgress(
  state: DesktopUpdateState | null,
): DesktopUpdateProgress | null {
  if (!state) return null;
  const version = state.downloadedVersion ?? state.availableVersion;
  const named = version ? ` ${version}` : "";
  if (state.status === "downloading") {
    const percent =
      typeof state.downloadPercent === "number" ? Math.floor(state.downloadPercent) : null;
    return {
      kind: "downloading",
      label: percent === null ? "Downloading…" : `Downloading ${percent}%`,
      detail: `Downloading${named}${percent === null ? "…" : ` (${percent}%)`}`,
      percent,
    };
  }
  // A failed install leaves the download in place ("downloaded"); a failed
  // download goes back to "available" or "error". Both keep the reason.
  if (
    state.message &&
    (state.errorContext === "download" || state.errorContext === "install") &&
    state.status !== "checking"
  ) {
    return {
      kind: "failed",
      label: state.errorContext === "download" ? "Download failed" : "Update failed",
      detail: state.message,
      percent: null,
    };
  }
  if (state.status === "downloaded") {
    return {
      kind: "downloaded",
      label: "Restart to update",
      detail: `${version ?? "The update"} is downloaded. Installing restarts the app.`,
      percent: null,
    };
  }
  return null;
}
