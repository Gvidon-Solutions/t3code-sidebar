import { expect, it } from "vite-plus/test";
import { threadDropProject } from "./threadDrop.logic";

it("drops into the source machine's representation even when a remote machine is listed first", () => {
  const remote = { environmentId: "bo", id: "remote-project" };
  const local = { environmentId: "at", id: "scratch-project" };
  expect(threadDropProject("at", [remote, local])).toBe(local);
  expect(threadDropProject("at", [remote])).toBe(remote);
  expect(threadDropProject("at", [])).toBeUndefined();
});
