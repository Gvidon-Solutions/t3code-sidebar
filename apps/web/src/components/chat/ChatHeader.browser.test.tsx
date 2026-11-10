import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
const mesh = vi.hoisted(() => ({ config: null as unknown }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));
vi.mock(import("../../hooks/useMeshLayout"), () => ({
  useMeshLayout: () => ({
    config: mesh.config as never,
    source: null,
    state: {} as never,
    edit: () => {},
  }),
  useMeshLayoutOptional: (() => ({ config: mesh.config as never, source: null })) as never,
}));

import { render } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";

function header(title: string) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    mesh.config = null;
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("keeps the machine tag directly after the thread title", async () => {
  mesh.config = {
    machines: {
      environment: { title: "Laptop", tag: "LT" },
      studio: { title: "Studio", tag: "ST" },
    },
    projectMounts: {},
    projectMountStatus: {},
  } as never;
  await using screen = await render(header("A thread title long enough to need truncation"));
  const breadcrumb = screen.container.querySelector('[aria-label="Thread breadcrumb"]');
  const title = screen.container.querySelector(
    '[aria-label="Thread actions for A thread title long enough to need truncation"]',
  );
  const tag = screen.container.querySelector('[role="img"][aria-label="Machine: Laptop"]');
  expect(breadcrumb).not.toBeNull();
  expect(title).not.toBeNull();
  expect(tag).not.toBeNull();
  expect(breadcrumb!.contains(tag!)).toBe(true);
  expect(title!.compareDocumentPosition(tag!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The title no longer grows to the far end of the header; it truncates before the tag.
  expect(getComputedStyle(title!).flexGrow).toBe("0");
});
