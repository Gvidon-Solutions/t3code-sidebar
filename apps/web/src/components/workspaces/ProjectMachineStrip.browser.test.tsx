import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty } from "@t3tools/contracts";
import { projectMachineStrip } from "@t3tools/client-runtime/state/mesh-layout";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ProjectMachineStrip } from "./ProjectMachineStrip";

it("opens Machines without toggling its folder, including after a live status changes", async () => {
  const open = vi.fn();
  const toggle = vi.fn();
  const config = {
    ...empty,
    projectMounts: {
      demo: [
        {
          environmentId: "lab",
          role: "primary" as const,
          path: "/demo",
          transport: "git" as const,
          createdAt: "",
        },
        {
          environmentId: "vps",
          role: "replica" as const,
          path: "/demo",
          transport: "mutagen" as const,
          createdAt: "",
        },
        {
          environmentId: "at",
          role: "replica" as const,
          path: "/demo",
          transport: "mutagen" as const,
          createdAt: "",
        },
      ],
    },
  };
  const group = { projectKey: "demo", environmentIds: ["at"], knownEnvironmentIds: ["lab", "at"] };
  const model = projectMachineStrip(config, group, []);
  await using screen = await render(
    <div onClick={toggle}>
      <ProjectMachineStrip model={model} onOpen={open} />
    </div>,
  );
  await screen.getByRole("button", { name: model.description }).click();
  expect(open).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: model.description }).element().textContent?.match(/⇄/g),
  ).toHaveLength(1);
  expect(
    screen.getByRole("img", { name: "Machine: at" }).element().querySelector("[aria-hidden]"),
  ).not.toBeNull();
  expect(toggle).not.toHaveBeenCalled();
  const synced = projectMachineStrip(config, group, [
    {
      logicalKey: "demo",
      environmentId: "at",
      state: "watching",
      conflicts: [],
      problems: [],
      updatedAt: "",
    },
  ]);
  await screen.rerender(
    <div onClick={toggle}>
      <ProjectMachineStrip model={synced} onOpen={open} />
    </div>,
  );
  await expect.element(screen.getByRole("button", { name: synced.description })).toBeVisible();
  expect(
    screen.getByRole("img", { name: "Machine: at" }).element().querySelector("[aria-hidden]"),
  ).toBeNull();
  const primaries = projectMachineStrip(
    {
      ...config,
      projectMounts: {
        demo: config.projectMounts.demo.map((rep) => ({ ...rep, role: "primary" as const })),
      },
    },
    group,
    [],
  );
  await screen.rerender(<ProjectMachineStrip model={primaries} onOpen={open} />);
  expect(
    screen.getByRole("button", { name: primaries.description }).element().textContent,
  ).not.toContain("⇄");
});

it("collapses tags for a long project title and retains the complete machine description", async () => {
  const title = "Research workspace with a deliberately long title";
  const model = projectMachineStrip(
    {
      ...empty,
      machines: {
        studio: { label: "Studio" },
        cloudbox: { label: "Cloudbox" },
        laptop: { label: "Laptop" },
      },
    },
    {
      projectKey: "demo",
      environmentIds: ["studio", "cloudbox", "laptop"],
      knownEnvironmentIds: ["studio", "cloudbox", "laptop"],
    },
    [],
  );
  await using screen = await render(
    <div style={{ display: "flex", width: 280, gap: 8 }}>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      <ProjectMachineStrip model={model} compact onOpen={() => undefined} />
    </div>,
  );
  expect(screen.getByText(title).element().getBoundingClientRect().width).toBeGreaterThan(140);
  await expect.element(screen.getByText("+2")).toBeVisible();
  expect(
    screen
      .getByRole("button", { name: model.description })
      .element()
      .querySelectorAll('[role="img"]'),
  ).toHaveLength(1);
});
