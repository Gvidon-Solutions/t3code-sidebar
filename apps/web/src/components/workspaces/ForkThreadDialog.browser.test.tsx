import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { ForkThreadDialog } from "./ForkThreadDialog";

vi.mock("../../hooks/useMeshLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useMeshLayout")>()),
  useMeshLayout: () => ({
    config: {
      machines: {
        A: { title: "Studio", label: "ST" },
        B: { title: "Cloudbox", label: "CB" },
        C: { title: "Laptop", label: "LT" },
      },
      projectMounts: { logical: [{ environmentId: "A", projectId: "p1" }] },
      projectMountStatus: {},
    },
  }),
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      { environmentId: "A", label: "Studio", connection: { phase: "connected" } },
      { environmentId: "C", label: "Laptop", connection: { phase: "connected" } },
      { environmentId: "D", label: "Travel laptop", connection: { phase: "connected" } },
    ],
  }),
  useEnvironmentProviders: () =>
    new Map([
      [
        "A",
        [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            models: [{ slug: "gpt-5", name: "GPT-5" }],
          },
        ],
      ],
    ]),
}));
vi.mock("../../state/meshReplicas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/meshReplicas")>()),
  useReplicaStatuses: () => [],
}));
vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  readThreadShell: () => ({
    id: "thread",
    projectId: "p1",
    title: "Studio notes",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
  }),
}));

it("offers machines by title and label and explains an offline target", async () => {
  await using screen = await render(
    <ForkThreadDialog
      request={{ environmentId: EnvironmentId.make("A"), threadId: ThreadId.make("thread") }}
      onClose={() => undefined}
    />,
    // This dialog does not navigate.
    { router: false },
  );
  await expect.element(screen.getByRole("heading", { name: "Fork to Studio" })).toBeInTheDocument();
  const select = screen
    .getByRole("combobox", {
      name: "Fork target machine",
    })
    .element() as HTMLSelectElement;
  const options = Array.from(select.options).map((option) => option.textContent);
  expect(options.some((text) => text?.includes("Cloudbox") && text?.includes("offline"))).toBe(
    true,
  );
  expect(options.some((text) => text?.includes("Studio") && text?.includes("ST"))).toBe(true);
  expect(options).toContain("Travel laptop ");
  await userEvent.selectOptions(select, "B");
  await expect.element(screen.getByText("Cloudbox is offline.")).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Fork to Cloudbox" })).toBeDisabled();
  await userEvent.selectOptions(select, "C");
  await expect.element(screen.getByText("No models are available on Laptop.")).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Fork to Laptop" })).toBeDisabled();
});
