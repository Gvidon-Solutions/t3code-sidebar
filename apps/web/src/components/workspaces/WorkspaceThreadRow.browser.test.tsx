import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { THREAD_DRAG_TYPE } from "@t3tools/client-runtime/state/mesh-layout";
import { WorkspaceThreadRow } from "./WorkspaceThreadRow";

it("drags a thread identity and ends the move gesture", async () => {
  const thread = makeThreadFixture({ title: "Move me" });
  const onDragStart = vi.fn();
  const onDragEnd = vi.fn();
  const noop = () => undefined;
  await using screen = await render(
    <WorkspaceThreadRow
      thread={thread}
      variant="active"
      isActive={false}
      now={0}
      isRenaming={false}
      canSettle
      canPin
      onOpen={noop}
      onContextMenu={noop}
      onTogglePin={noop}
      onSettle={noop}
      onUnsettle={noop}
      onWake={noop}
      onCommitRename={noop}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    />,
  );
  const row = screen.getByRole("button", { name: /Move me/ }).element();
  const dataTransfer = new DataTransfer();
  await act(() => {
    row.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }),
    );
  });
  expect(dataTransfer.getData(THREAD_DRAG_TYPE)).toBe(`${thread.environmentId}:${thread.id}`);
  expect(onDragStart).toHaveBeenCalledOnce();
  await act(() => {
    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
  });
  expect(onDragEnd).toHaveBeenCalledOnce();
});
