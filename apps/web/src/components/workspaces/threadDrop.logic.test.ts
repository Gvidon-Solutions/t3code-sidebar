import { expect, it } from "vite-plus/test";
import { threadDropProject } from "./threadDrop.logic";

it("drops into the source machine's representation even when a remote machine is listed first", () => {
  const remote = { environmentId: "op", id: "remote-project" };
  const local = { environmentId: "gv", id: "scratch-project" };
  expect(threadDropProject("gv", [remote, local])).toBe(local);
  expect(threadDropProject("gv", [remote])).toBe(remote);
  expect(threadDropProject("gv", [])).toBeUndefined();
});
