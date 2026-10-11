import { assert, describe, it } from "@effect/vitest";

import { forkReleasesFromIndex } from "./DesktopForkReleases.ts";

const release = (tag: string, publishedAt: string, assets: string[], draft = false) => ({
  tag_name: tag,
  draft,
  published_at: publishedAt,
  assets: assets.map((name) => ({ name })),
});

describe("forkReleasesFromIndex", () => {
  const index = [
    release("sidebar-v0.0.44-sidebar.3", "2026-10-11T10:00:00Z", [
      "latest.yml",
      "latest-linux.yml",
    ]),
    release("sidebar-v0.0.45-sidebar.5", "2026-10-11T13:00:00Z", [
      "latest.yml",
      "latest-linux.yml",
    ]),
    // First fork build: no updater manifests, so nothing could install it.
    release("sidebar-desktop-2", "2026-10-11T08:00:00Z", ["T3-Code-Sidebar.exe"]),
    release("sidebar-v0.0.45-sidebar.6", "2026-10-11T14:00:00Z", ["latest.yml"], true),
    release("sidebar-v0.0.44-sidebar.4", "2026-10-11T12:00:00Z", ["latest.yml"]),
  ];

  it("keeps published releases with this platform's manifest, newest first", () => {
    assert.deepEqual(
      forkReleasesFromIndex(index, "win32").map((entry) => entry.version),
      ["0.0.45-sidebar.5", "0.0.44-sidebar.4", "0.0.44-sidebar.3"],
    );
    assert.deepEqual(
      forkReleasesFromIndex(index, "linux").map((entry) => entry.tag),
      ["sidebar-v0.0.45-sidebar.5", "sidebar-v0.0.44-sidebar.3"],
    );
  });
});
