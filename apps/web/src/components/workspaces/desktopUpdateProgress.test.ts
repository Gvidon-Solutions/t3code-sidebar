import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeDesktopUpdateProgress } from "./desktopUpdateProgress";

const base: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "0.0.45-sidebar.11",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.45-sidebar.12",
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: true,
};

describe("describeDesktopUpdateProgress", () => {
  it("shows the download's percent", () => {
    expect(
      describeDesktopUpdateProgress({ ...base, status: "downloading", downloadPercent: 37.8 }),
    ).toMatchObject({
      kind: "downloading",
      label: "Downloading 37%",
      detail: "Downloading 0.0.45-sidebar.12 (37%)",
      percent: 37,
    });
  });

  it("offers the restart once downloaded", () => {
    expect(
      describeDesktopUpdateProgress({
        ...base,
        status: "downloaded",
        downloadedVersion: "0.0.45-sidebar.12",
      }),
    ).toMatchObject({ kind: "downloaded", label: "Restart to update" });
  });

  it("keeps a failed install's reason, though the download stays", () => {
    expect(
      describeDesktopUpdateProgress({
        ...base,
        status: "downloaded",
        downloadedVersion: "0.0.45-sidebar.12",
        errorContext: "install",
        message: "Could not install the update: Request dismissed.",
      }),
    ).toMatchObject({
      kind: "failed",
      label: "Update failed",
      detail: "Could not install the update: Request dismissed.",
    });
  });

  it("stays out of the way when nothing is in flight", () => {
    expect(describeDesktopUpdateProgress(base)).toBeNull();
    expect(describeDesktopUpdateProgress({ ...base, status: "up-to-date" })).toBeNull();
    expect(describeDesktopUpdateProgress(null)).toBeNull();
  });
});
