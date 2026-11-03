import { expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { mobileMoveProjectLabel } from "./threadMove.logic";

it("labels destinations with their machine and keeps No project recognizable", () => {
  const config = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: { gv: { tag: "GV" }, op: { tag: "OP" } },
  };
  expect(
    mobileMoveProjectLabel({ title: "Scratch", isScratch: true, environmentId: "gv" }, config),
  ).toBe("No project · GV");
  expect(mobileMoveProjectLabel({ title: "Shared name", environmentId: "op" }, config)).toBe(
    "Shared name · OP",
  );
});
