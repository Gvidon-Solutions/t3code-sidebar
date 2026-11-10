import { EnvironmentId, type FilesLocateResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { uiFileTarget } from "./fileTarget.ts";

const candidate = {
  environmentId: EnvironmentId.make("studio"),
  absolutePath: "/srv/app/src/x.ts",
  kind: "file" as const,
  via: "suffix" as const,
  inProject: true,
  touchedByThread: false,
  displayPath: "src/x.ts",
  line: 12,
};

const found = (environmentId: string): FilesLocateResult => ({
  status: "found",
  environmentId: EnvironmentId.make("studio"),
  target: { ...candidate, environmentId: EnvironmentId.make(environmentId) },
  tried: [],
});

describe("uiFileTarget", () => {
  it("H3 · omits the machine for the asking thread's own file", () => {
    expect(uiFileTarget(found("studio"), "src/x.ts", "studio")).toMatchObject({
      kind: "file",
      path: "/srv/app/src/x.ts",
      line: 12,
      resolved: { status: "found" },
    });
    expect(uiFileTarget(found("studio"), "src/x.ts", "studio").environmentId).toBeUndefined();
  });

  it("H3 · names the machine for another machine", () => {
    const target = uiFileTarget(found("cloudbox"), "src/x.ts", "studio");
    expect(target.environmentId).toBe("cloudbox");
    expect(target.path).toBe("/srv/app/src/x.ts");
    expect(target.resolved?.status).toBe("found");
  });

  it("H4 · a choice is published without opening a candidate", () => {
    const choose: FilesLocateResult = {
      status: "choose",
      environmentId: EnvironmentId.make("studio"),
      target: { ...candidate, environmentId: EnvironmentId.make("cloudbox") },
      candidates: [
        { ...candidate, environmentId: EnvironmentId.make("studio") },
        {
          ...candidate,
          environmentId: EnvironmentId.make("cloudbox"),
          absolutePath: "/srv/cloudbox/src/x.ts",
        },
      ],
      tried: [],
    };
    expect(uiFileTarget(choose, "src/x.ts", "studio")).toEqual({
      kind: "file",
      path: "src/x.ts",
      resolved: choose,
    });
  });

  it("H4 · a miss publishes the not-found result", () => {
    const missing: FilesLocateResult = {
      status: "notFound",
      environmentId: EnvironmentId.make("studio"),
      tried: [{ tier: "suffix" }],
    };
    expect(uiFileTarget(missing, "src/x.ts", "studio")).toEqual({
      kind: "file",
      path: "src/x.ts",
      resolved: missing,
    });
  });
});
