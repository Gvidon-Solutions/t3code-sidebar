import { expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { mobileMoveProjectLabel } from "./threadMove.logic";

it("labels destinations with their machine and keeps No project recognizable", () => {
  expect(
    mobileMoveProjectLabel(
      { title: "Notes", environmentId: "07e7a1a797ee" },
      DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    ),
  ).toBe("Notes · Unnamed machine");
  const config = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: { at: { tag: "ST", title: "Studio" }, bo: { tag: "CB", title: "Cloudbox" } },
  };
  expect(
    mobileMoveProjectLabel({ title: "Scratch", isScratch: true, environmentId: "at" }, config),
  ).toBe("No project · Studio");
  expect(mobileMoveProjectLabel({ title: "Shared name", environmentId: "bo" }, config)).toBe(
    "Shared name · Cloudbox",
  );
});
