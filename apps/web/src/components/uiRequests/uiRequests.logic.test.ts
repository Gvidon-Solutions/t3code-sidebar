import { EnvironmentId, ThreadId, type UiRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findSidebarWorkspace, takeNewUiRequests } from "./uiRequests.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

function request(id: string): UiRequest {
  return { id, threadId: ThreadId.make("thread-1"), target: { kind: "home" } };
}

describe("takeNewUiRequests", () => {
  it("takes the first value per environment as a baseline", () => {
    const seen = new Map<EnvironmentId, string | null>();
    expect(
      takeNewUiRequests(seen, [
        { environmentId: local, request: request("old") },
        { environmentId: remote, request: null },
      ]),
    ).toEqual([]);
    expect(
      takeNewUiRequests(seen, [
        { environmentId: local, request: request("old") },
        { environmentId: remote, request: request("first") },
      ]),
    ).toEqual([{ environmentId: remote, request: request("first") }]);
  });

  it("acts on each request id once", () => {
    const seen = new Map<EnvironmentId, string | null>([[local, null]]);
    const entries = [{ environmentId: local, request: request("a") }];
    expect(takeNewUiRequests(seen, entries)).toHaveLength(1);
    expect(takeNewUiRequests(seen, entries)).toEqual([]);
    expect(takeNewUiRequests(seen, [{ environmentId: local, request: request("b") }])).toHaveLength(
      1,
    );
  });
});

describe("findSidebarWorkspace", () => {
  const workspaces = [
    { id: "ws-main", name: "Main" },
    { id: "ws-vtb", name: "vtb" },
  ];

  it("matches an id, then a name ignoring case", () => {
    expect(findSidebarWorkspace([workspaces], "ws-vtb")?.name).toBe("vtb");
    expect(findSidebarWorkspace([workspaces], "main")?.id).toBe("ws-main");
    expect(findSidebarWorkspace([workspaces], "VTB ")?.id).toBe("ws-vtb");
    expect(findSidebarWorkspace([workspaces], "Personal")).toBeNull();
  });

  it("prefers the earlier list", () => {
    expect(findSidebarWorkspace([[{ id: "a", name: "Main" }], workspaces], "main")?.id).toBe("a");
  });
});
