import { EnvironmentId, type MeshConfigRevision } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { MeshConfigDialog } from "./MeshConfigDialog";
const mocks = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("../../state/meshLayout", () => ({
  meshLayoutAtoms: { configGet: "get", configPlan: "plan", configApply: "apply" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (request: { input: unknown }) => {
    if (command === "get")
      return {
        _tag: "Success",
        value: {
          current: {
            revision: "current",
            doc: { schema: 1, machines: {} },
            author: "studio",
            writtenAt: "2026-11-05T00:00:00Z",
          },
        },
      };
    if (command === "plan")
      return {
        _tag: "Success",
        value: {
          actions: [{ id: "ssh", server: "studio", description: "Write managed SSH config" }],
        },
      };
    mocks.apply(request.input);
    return {
      _tag: "Success",
      value: {
        revision: "next",
        doc: { schema: 1, machines: {} },
        author: "studio",
        writtenAt: "2026-11-05T00:00:00Z",
      },
    };
  },
}));
vi.mock("../../hooks/useMeshLayout", () => ({
  useMeshLayout: () => ({
    state: {
      snapshot: {
        document: {
          "mesh.configHistory/old": {
            v: {
              revision: "old",
              doc: { schema: 1, machines: {}, ssh: { mode: "off" } },
              author: "cloudbox",
              writtenAt: "2026-11-04T00:00:00Z",
            } satisfies MeshConfigRevision,
          },
        },
      },
    },
  }),
}));
it("edits YAML, shows validation paths and plans a history restoration before applying with the current base", async () => {
  mocks.apply.mockReset();
  await using screen = await render(
    <MeshConfigDialog environmentId={EnvironmentId.make("studio")} onClose={() => undefined} />,
  );
  const yaml = screen.getByRole("textbox", { name: "Mesh YAML" });
  await expect.element(yaml).toHaveValue("schema: 1\nmachines: {}\n");
  await expect.element(screen.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await yaml.fill(
    "schema: 1\nmachines: {}\nreplicas:\n  rules: [{project: '*', on: missing, when: manual}]",
  );
  await screen.getByRole("button", { name: "Plan", exact: true }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("replicas.rules.0.on: Unknown machine: missing");
  await screen.getByText("History", { exact: true }).click();
  await screen.getByRole("button", { name: "Restore r1" }).click();
  await expect.element(yaml).toHaveValue("schema: 1\nmachines: {}\nssh:\n  mode: off\n");
  await expect.element(screen.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await screen.getByRole("button", { name: "Plan", exact: true }).click();
  await expect
    .element(screen.getByRole("list", { name: "Config plan" }))
    .toHaveTextContent("Write managed SSH config");
  await yaml.fill("schema: 1\nmachines: {}\nssh: {mode: managed}\n");
  await expect.element(screen.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await screen.getByRole("button", { name: "Restore r1" }).click();
  await screen.getByRole("button", { name: "Plan", exact: true }).click();
  await screen.getByRole("button", { name: "Apply", exact: true }).click();
  await vi.waitFor(() =>
    expect(mocks.apply).toHaveBeenCalledWith({
      doc: { schema: 1, machines: {}, ssh: { mode: "off" } },
      baseRevision: "current",
    }),
  );
});
