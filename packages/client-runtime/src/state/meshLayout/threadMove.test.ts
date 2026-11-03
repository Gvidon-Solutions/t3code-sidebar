import { expect, it } from "vite-plus/test";
import { threadMoveValidity } from "./threadMove.ts";

it.each([
  ["a", "one", "same-project"],
  ["a", "two", "local"],
  ["b", "one", "cross-machine"],
  ["b", "two", "cross-machine"],
])("validates a target representation on %s in %s", (environmentId, id, expected) => {
  expect(threadMoveValidity({ environmentId: "a", projectId: "one" }, { environmentId, id })).toBe(
    expected,
  );
});
