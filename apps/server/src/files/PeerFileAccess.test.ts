import { describe, expect, it } from "@effect/vitest";

import { peerFilePathAllowed, peerTargetAllowed } from "./PeerFileAccess.ts";

describe("peer file access", () => {
  it("H1 · a project-folders link cannot leave the target's projects", () => {
    const base = {
      linked: true,
      files: "projects" as const,
      projectRoots: ["/srv/proj"],
    };
    expect(peerFilePathAllowed({ ...base, absolutePath: "/srv/proj/src/x.ts" })).toBe(true);
    expect(peerFilePathAllowed({ ...base, absolutePath: "/srv/other/x.ts" })).toBe(false);
    expect(peerFilePathAllowed({ ...base, absolutePath: "/srv/proj/../other/x.ts" })).toBe(false);
    expect(peerFilePathAllowed({ ...base, absolutePath: "src/x.ts" })).toBe(false);
  });

  it("H1 · a read-only all-files link still stays inside projects", () => {
    expect(
      peerFilePathAllowed({
        linked: true,
        files: "all",
        access: "read-only",
        absolutePath: "/srv/other/x.ts",
        projectRoots: ["/srv/proj"],
      }),
    ).toBe(false);
    expect(
      peerFilePathAllowed({
        linked: true,
        files: "all",
        access: "full-access",
        absolutePath: "/srv/other/x.ts",
        projectRoots: ["/srv/proj"],
      }),
    ).toBe(true);
  });

  it("H1 · an owner client is not limited by a link, a none link is always denied", () => {
    expect(
      peerFilePathAllowed({
        linked: false,
        files: "none",
        absolutePath: "/srv/other/x.ts",
        projectRoots: [],
      }),
    ).toBe(true);
    expect(
      peerFilePathAllowed({
        linked: true,
        files: "none",
        absolutePath: "/srv/proj/x.ts",
        projectRoots: ["/srv/proj"],
      }),
    ).toBe(false);
  });

  it("H1 · only this machine or a linked machine may be named", () => {
    expect(peerTargetAllowed("studio", "studio", [])).toBe(true);
    expect(peerTargetAllowed("studio", "cloudbox", ["cloudbox"])).toBe(true);
    expect(peerTargetAllowed("studio", "laptop", ["cloudbox"])).toBe(false);
  });
});
