import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../contextChipParts", () => ({
  UnresolvedChip: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => null,
  useThreadRefs: () => [],
  useProject: () => null,
}));

it("opens a handoff on its own machine even when the archived thread is absent from the sidebar", async () => {
  await using screen = await render(
    <MarkdownThreadLink
      environmentId={EnvironmentId.make("source")}
      link={{
        environmentId: EnvironmentId.make("destination"),
        threadId: ThreadId.make("handoff:conversation"),
      }}
      label="Original conversation"
    />,
  );
  await expect
    .element(screen.getByRole("link", { name: "Thread, Original conversation" }))
    .toHaveAttribute("href", "/destination/handoff%3Aconversation");
});
