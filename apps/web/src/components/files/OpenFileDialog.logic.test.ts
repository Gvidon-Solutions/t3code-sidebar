import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fileViewerContext,
  findProjectForFile,
  readRecentFiles,
  recentFilesStorageKey,
  rememberRecentFile,
  resolveOpenFilePath,
} from "./OpenFileDialog.logic";

const here = "env-here" as EnvironmentId;
const there = "env-there" as EnvironmentId;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("resolveOpenFilePath", () => {
  it("keeps absolute and home paths on the selected machine", () => {
    expect(
      resolveOpenFilePath({
        value: "/srv/app/README.md",
        environmentId: here,
        workspaceRoot: "/srv/app",
      }),
    ).toEqual({ environmentId: here, absolutePath: "/srv/app/README.md" });
    expect(
      resolveOpenFilePath({ value: "~/notes.md", environmentId: here, workspaceRoot: null }),
    ).toEqual({ environmentId: here, absolutePath: "~/notes.md" });
    expect(
      resolveOpenFilePath({ value: "C:\\work\\a.txt", environmentId: here, workspaceRoot: null }),
    ).toEqual({ environmentId: here, absolutePath: "C:\\work\\a.txt" });
  });

  it("joins a relative path to the selected project root", () => {
    expect(
      resolveOpenFilePath({
        value: "src/index.ts",
        environmentId: here,
        workspaceRoot: "/srv/app/",
      }),
    ).toEqual({ environmentId: here, absolutePath: "/srv/app/src/index.ts" });
    expect(
      resolveOpenFilePath({ value: "src/index.ts", environmentId: here, workspaceRoot: null }),
    ).toBeNull();
  });

  it("follows a pasted t3-file link to its machine", () => {
    expect(
      resolveOpenFilePath({
        value: "t3-file://env-there/%2Fsrv%2Fapp%2FREADME.md",
        environmentId: here,
        workspaceRoot: "/srv/app",
      }),
    ).toEqual({ environmentId: there, absolutePath: "/srv/app/README.md" });
  });

  it("ignores an empty field", () => {
    expect(
      resolveOpenFilePath({ value: "  ", environmentId: here, workspaceRoot: "/srv/app" }),
    ).toBeNull();
  });
});

describe("findProjectForFile", () => {
  const projects = [
    { environmentId: here, workspaceRoot: "/srv/app", title: "App" },
    { environmentId: here, workspaceRoot: "/srv/app/packages/web", title: "Web" },
    { environmentId: there, workspaceRoot: "/srv/app", title: "App there" },
  ];

  it("uses the longest matching root on the selected machine", () => {
    expect(findProjectForFile(projects, here, "/srv/app/packages/web/src/a.ts")?.title).toBe("Web");
    expect(findProjectForFile(projects, here, "/srv/app/README.md")?.title).toBe("App");
    expect(findProjectForFile(projects, there, "/srv/app/README.md")?.title).toBe("App there");
  });

  it("returns null for a path outside every project", () => {
    expect(findProjectForFile(projects, here, "/etc/hosts")).toBeNull();
    expect(findProjectForFile(projects, here, "/srv/application/a.ts")).toBeNull();
  });

  it("names the machine when no project contains the file", () => {
    expect(
      fileViewerContext({
        environmentId: there,
        environmentLabel: "Cloudbox",
        absolutePath: "/etc/hosts",
        projects,
      }),
    ).toEqual({ environmentId: there, workspaceRoot: "/", projectName: "Cloudbox" });
  });
});

describe("recent files", () => {
  it("keeps a bounded per-machine list", () => {
    const storage = memoryStorage();
    expect(readRecentFiles(storage, here)).toEqual([]);
    rememberRecentFile(storage, here, "/a");
    rememberRecentFile(storage, here, "/b");
    rememberRecentFile(storage, here, "/a");
    expect(readRecentFiles(storage, here)).toEqual(["/a", "/b"]);
    expect(readRecentFiles(storage, there)).toEqual([]);
    expect(recentFilesStorageKey(here)).toBe("t3code:recent-files:env-here");
  });

  it("ignores corrupt storage", () => {
    const storage = memoryStorage();
    storage.setItem(recentFilesStorageKey(here), "{not json");
    expect(readRecentFiles(storage, here)).toEqual([]);
  });
});
