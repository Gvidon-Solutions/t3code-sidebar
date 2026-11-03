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
  const at = EnvironmentId.make("at"),
    bo = EnvironmentId.make("bo");
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
    [at, [provider(claude, false, ["sonnet"]), provider(codex, true, ["first", "luna"])]],
    [bo, [provider(claude, true, ["sonnet"])]],
  ]) as unknown as typeof fixtures.providers;
  fixtures.environments = [at, bo].map((environmentId) => ({
    environmentId,
    serverConfig: { settings },
  })) as unknown as EnvironmentPresentation[];
  return { at, bo, claude, codex };
}
it("keeps an unusable Claude selection and switches to its authenticated machine in one click", async () => {
  const { at, bo, claude } = setup();
  function Draft() {
    const [machine, setMachine] = useState(at);
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
              environmentId: at,
              projectId: null,
              label: "atlas",
              connected: true,
              machine: "server",
              isPrimary: true,
            },
            {
              environmentId: bo,
              projectId: null,
              label: "Boreal",
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
  await expect.element(screen.getByText("at:sonnet")).toBeVisible();
  await screen.getByRole("button", { name: "Claude works on Boreal. Switch machine" }).click();
  await expect.element(screen.getByText("bo:sonnet")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /works on/ })).not.toBeInTheDocument();
});
it("uses the configured usable default locally rather than the first catalog model", async () => {
  const { at, claude } = setup();
  function Draft() {
    const [model, setModel] = useState<ModelSelection>({ instanceId: claude, model: "sonnet" });
    return (
      <>
        <output>
          {model.instanceId}:{model.model}
        </output>
        <DraftMachineHint
          selection={model}
          environmentId={at}
          machines={[
            {
              environmentId: at,
              projectId: null,
              label: "atlas",
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
