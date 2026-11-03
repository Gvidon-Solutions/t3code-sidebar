import { expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import {
  EnvironmentId,
  ProviderInstanceId,
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  type ModelSelection,
} from "@t3tools/contracts";
import type { EnvironmentPresentation } from "../../state/environments";
import { render } from "../../../test/render";
import { DraftMachineHint } from "./DraftMachineHint";

const fixtures = vi.hoisted(() => ({
  environments: [] as EnvironmentPresentation[],
  providers: new Map<EnvironmentId, ServerConfig["providers"]>(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: fixtures.environments }),
  useEnvironmentProviders: () => fixtures.providers,
}));
function setup() {
  const gv = EnvironmentId.make("gv"),
    op = EnvironmentId.make("op");
  const claude = ProviderInstanceId.make("claude");
  const codex = ProviderInstanceId.make("codex");
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    defaultModelSelection: { instanceId: codex, model: "luna" },
    providerInstances: { [claude]: { driver: "claudeAgent", enabled: true, config: {} } },
  };
  const provider = (instanceId: ProviderInstanceId, authenticated: boolean, models: string[]) => ({
    instanceId,
    displayName: instanceId === claude ? "Claude" : "Codex",
    installed: true,
    status: "ready",
    auth: { status: authenticated ? "authenticated" : "unauthenticated" },
    models: models.map((slug) => ({ slug })),
  });
  fixtures.providers = new Map([
    [gv, [provider(claude, false, ["sonnet"]), provider(codex, true, ["first", "luna"])]],
    [op, [provider(claude, true, ["sonnet"])]],
  ]) as unknown as typeof fixtures.providers;
  fixtures.environments = [gv, op].map((environmentId) => ({
    environmentId,
    serverConfig: { settings },
  })) as unknown as EnvironmentPresentation[];
  return { gv, op, claude, codex };
}
it("keeps an unusable Claude selection and switches to its authenticated machine in one click", async () => {
  const { gv, op, claude } = setup();
  function Draft() {
    const [machine, setMachine] = useState(gv);
    const [model, setModel] = useState<ModelSelection>({ instanceId: claude, model: "sonnet" });
    return (
      <>
        <output>
          {machine}:{model.model}
        </output>
        <DraftMachineHint
          selection={model}
          environmentId={machine}
          machines={[
            {
              environmentId: gv,
              projectId: null,
              label: "gvidon",
              connected: true,
              machine: "server",
              isPrimary: true,
            },
            {
              environmentId: op,
              projectId: null,
              label: "Operalia",
              connected: true,
              machine: "server",
              isPrimary: false,
            },
          ]}
          onMachine={setMachine}
          onModel={(instanceId, slug) => setModel({ instanceId, model: slug })}
        />
      </>
    );
  }
  await using screen = await render(<Draft />);
  await expect.element(screen.getByText("gv:sonnet")).toBeVisible();
  await screen.getByRole("button", { name: "Claude works on Operalia. Switch machine" }).click();
  await expect.element(screen.getByText("op:sonnet")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /works on/ })).not.toBeInTheDocument();
});
it("uses the configured usable default locally rather than the first catalog model", async () => {
  const { gv, claude } = setup();
  function Draft() {
    const [model, setModel] = useState<ModelSelection>({ instanceId: claude, model: "sonnet" });
    return (
      <>
        <output>
          {model.instanceId}:{model.model}
        </output>
        <DraftMachineHint
          selection={model}
          environmentId={gv}
          machines={[
            {
              environmentId: gv,
              projectId: null,
              label: "gvidon",
              connected: true,
              machine: "server",
              isPrimary: true,
            },
          ]}
          onMachine={() => {
            throw new Error("No alternate machine");
          }}
          onModel={(instanceId, slug) => setModel({ instanceId, model: slug })}
        />
      </>
    );
  }
  await using screen = await render(<Draft />);
  await screen.getByRole("button", { name: "Use luna here" }).click();
  await expect.element(screen.getByText("codex:luna")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Use luna here" }))
    .not.toBeInTheDocument();
});
