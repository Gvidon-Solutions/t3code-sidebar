import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import type { PendingReplicaRow as Row } from "@t3tools/client-runtime/state/mesh-layout";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PendingReplicaRow } from "./PendingReplicaRow";
import "../../index.css";

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      { environmentId: "target", label: "QA machine" },
      { environmentId: "source", label: "Primary machine" },
    ],
  })) as never,
}));

it("names connected machines in a truncated error and lets the keyboard retry the correct replica", async () => {
  const row: Row = {
    logicalKey: "qa",
    rep: {
      environmentId: "target",
      source: "source",
      path: "/work/qa",
      transport: "mutagen",
      role: "replica",
      createdAt: "",
    },
    status: { state: "error", updatedAt: "" },
    live: null,
    progress: null,
    conflicts: 0,
    message: "No route",
    projectId: null,
  };
  const retry = vi.fn();
  await using screen = await render(
    <div style={{ width: 200 }}>
      <PendingReplicaRow config={DEFAULT_SIDEBAR_WORKSPACES_CONFIG} row={row} onRetry={retry} />
    </div>,
  );
  const short = "Can't reach Primary machine";
  const detail = "Can't reach Primary machine from QA machine. Ask an agent to fix the connection";
  await userEvent.hover(screen.getByText(short));
  await expect.element(page.getByText(detail, { exact: true }).first()).toBeVisible();
  await userEvent.tab();
  await expect
    .element(screen.getByRole("button", { name: "Retry replica on QA machine" }))
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(retry).toHaveBeenCalledExactlyOnceWith(row);
});
