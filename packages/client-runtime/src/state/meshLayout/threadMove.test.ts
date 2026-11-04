import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type ThreadMoveInput,
} from "@t3tools/contracts";
import { moveThread, threadMoveValidity } from "./threadMove.ts";

it.each([
  ["one", "same-project"],
  ["two", "local"],
])("validates a target project %s on the same machine", (id, expected) => {
  expect(
    threadMoveValidity({ environmentId: "a", projectId: "one" }, { environmentId: "a", id }),
  ).toBe(expected);
});

it("refuses a target on another machine", () => {
  expect(() =>
    threadMoveValidity({ environmentId: "a", projectId: "one" }, { environmentId: "b", id: "two" }),
  ).toThrow(/fork/i);
});

it("moves without a model and sends only the local project change", async () => {
  const source = {
    id: ThreadId.make("thread"),
    projectId: ProjectId.make("one"),
    environmentId: EnvironmentId.make("source"),
  };
  const move = vi.fn(
    async (request: { environmentId: EnvironmentId; input: ThreadMoveInput }) => request,
  );
  expect(
    await moveThread({
      source,
      target: { id: ProjectId.make("one"), environmentId: source.environmentId },
      move,
    }),
  ).toBeNull();
  expect(move).not.toHaveBeenCalled();
  const local = await moveThread({
    source,
    target: { id: ProjectId.make("two"), environmentId: source.environmentId },
    move,
  });
  expect(local?.input).toEqual({ threadId: source.id, projectId: ProjectId.make("two") });
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claude"),
    model: "haiku",
    options: [{ id: "effort", value: "high" }],
  };
  const changed = await moveThread({
    source,
    target: { id: ProjectId.make("two"), environmentId: source.environmentId },
    modelSelection,
    move,
  });
  expect(changed?.input.modelSelection).toEqual(modelSelection);
});
