import { page, userEvent } from "vite-plus/test/browser";
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
        E: { title: "Workshop", label: "WS" },
      },
      projectMounts: { logical: [{ environmentId: "A", projectId: "p1" }] },
      projectMountStatus: {},
    },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async ({ input }: { input: { targetEnvironmentId?: string } }) => {
      if (input.targetEnvironmentId === "B") throw new Error("Cloudbox is offline.");
      return {
        _tag: "Success",
        value: {
          providers: [
            {
              instanceId: "opencode",
              driver: "opencode",
              enabled: true,
              installed: true,
              status: "ready",
              auth: { status: "authenticated" },
              models: [
                {
                  slug: "cedar-model",
                  name: "Workshop model",
                  isCustom: false,
                  capabilities: null,
                },
              ],
            },
          ],
        },
      };
    },
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

it("offers machine titles, explains unavailable models and loads an unconnected mesh destination", async () => {
  await using screen = await render(
    <ForkThreadDialog
      request={{ environmentId: EnvironmentId.make("A"), threadId: ThreadId.make("thread") }}
      onClose={() => undefined}
    />,
    // This dialog does not navigate.
    { router: false },
  );
  await expect.element(screen.getByRole("heading", { name: "Fork to Studio" })).toBeInTheDocument();
  const select = screen.getByRole("combobox", { name: "Fork target machine" });
  await userEvent.fill(select, "Cloudbox");
  await page.getByRole("option", { name: "Cloudbox", exact: true }).click();
  await expect
    .element(screen.getByText("Could not load models on Cloudbox: Cloudbox is offline."))
    .toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Fork to Cloudbox" })).toBeDisabled();
  await userEvent.fill(select, "Laptop");
  await page.getByRole("option", { name: "Laptop", exact: true }).click();
  await expect
    .element(screen.getByText("No models are available on Laptop.").first())
    .toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Fork to Laptop" })).toBeDisabled();
  await userEvent.fill(select, "Workshop");
  await page.getByRole("option", { name: "Workshop", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Fork model" }))
    .toHaveTextContent("Workshop model");
  await expect.element(screen.getByRole("button", { name: "Fork to Workshop" })).toBeEnabled();
});
