import { expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { mobileMoveProjectLabel } from "./threadMove.logic";

it("labels destinations with their machine and keeps No project recognizable", () => {
  const config = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: { at: { tag: "AT" }, bo: { tag: "BO" } },
  };
  expect(
    mobileMoveProjectLabel({ title: "Scratch", isScratch: true, environmentId: "at" }, config),
  ).toBe("No project · AT");
  expect(mobileMoveProjectLabel({ title: "Shared name", environmentId: "bo" }, config)).toBe(
    "Shared name · BO",
  );
});
