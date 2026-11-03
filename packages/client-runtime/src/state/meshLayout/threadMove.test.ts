import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type ThreadMoveInput } from "@t3tools/contracts";
import { moveThreadWithConfirmation, threadMoveValidity } from "./threadMove.ts";

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

it("waits for confirmation, cancels without moving, and routes an accepted handoff from its source", async () => {
  const source = {
    id: ThreadId.make("thread"),
    projectId: ProjectId.make("one"),
    environmentId: EnvironmentId.make("source"),
  };
  const target = { id: ProjectId.make("one"), environmentId: EnvironmentId.make("target") };
  const decision = Promise.withResolvers<boolean>();
  const confirm = vi.fn(() => decision.promise);
  const move = vi.fn(
    async (request: { environmentId: EnvironmentId; input: ThreadMoveInput }) => request,
  );
  const pending = moveThreadWithConfirmation({ source, target, machine: "VPS", confirm, move });
  expect(move).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("this thread is archived"));
  decision.resolve(false);
  expect(await pending).toBeNull();
  expect(move).not.toHaveBeenCalled();
  const accepted = await moveThreadWithConfirmation({
    source,
    target,
    machine: "VPS",
    confirm: async () => true,
    move,
  });
  expect(accepted).toEqual({
    environmentId: source.environmentId,
    input: { threadId: source.id, projectId: target.id, targetEnvironmentId: target.environmentId },
  });
  move.mockClear();
  confirm.mockClear();
  expect(
    await moveThreadWithConfirmation({
      source,
      target: { ...target, environmentId: source.environmentId },
      machine: "Here",
      confirm,
      move,
    }),
  ).toBeNull();
  expect(move).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  const local = await moveThreadWithConfirmation({
    source,
    target: { id: ProjectId.make("two"), environmentId: source.environmentId },
    machine: "Here",
    confirm,
    move,
  });
  expect(local?.input).toEqual({ threadId: source.id, projectId: ProjectId.make("two") });
  expect(confirm).not.toHaveBeenCalled();
});
