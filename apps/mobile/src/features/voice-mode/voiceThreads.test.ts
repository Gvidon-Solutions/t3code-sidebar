import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ModelSelection, ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickTalkProject, resolveVoiceModelSelection } from "./voiceThreads";

function provider(
  instanceId: string,
  options: { voice?: boolean; models?: ReadonlyArray<string>; installed?: boolean } = {},
) {
  return {
    instanceId,
    driver: instanceId,
    enabled: true,
    installed: options.installed ?? true,
    auth: { status: "authenticated" },
    supportsVoice: options.voice,
    models: (options.models ?? []).map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    })),
  };
}

const config = (...providers: ReadonlyArray<ReturnType<typeof provider>>) =>
  ({ providers }) as unknown as ServerConfig;

const selection = (instanceId: string, model: string) =>
  ({ instanceId, model }) as unknown as ModelSelection;

describe("resolveVoiceModelSelection", () => {
  const codex = provider("codex", { voice: true, models: ["gpt-6-luna", "gpt-6-astra"] });
  const claude = provider("claude", { models: ["opus"] });

  it("keeps the draft's model when its provider can talk", () => {
    expect(
      resolveVoiceModelSelection(config(claude, codex), selection("codex", "gpt-6-luna"), null),
    ).toEqual(selection("codex", "gpt-6-luna"));
  });

  it("falls back to Codex's realtime model for a provider without voice", () => {
    expect(
      resolveVoiceModelSelection(config(claude, codex), selection("claude", "opus"), null),
    ).toEqual(selection("codex", "gpt-6-astra"));
    expect(
      resolveVoiceModelSelection(
        config(provider("codex", { voice: true, models: ["gpt-6-luna"] })),
        null,
        null,
      ),
    ).toEqual(selection("codex", "gpt-6-luna"));
  });

  it("finds nothing without a usable voice provider", () => {
    expect(resolveVoiceModelSelection(config(claude), null, null)).toBeNull();
    expect(
      resolveVoiceModelSelection(
        config(provider("codex", { voice: true, models: ["gpt-6-astra"], installed: false })),
        null,
        null,
      ),
    ).toBeNull();
    expect(resolveVoiceModelSelection(null, null, null)).toBeNull();
  });
});

describe("pickTalkProject", () => {
  const project = (id: string, environmentId = "env") =>
    ({ id, environmentId }) as unknown as EnvironmentProject;
  const canTalkIn = (candidate: EnvironmentProject) => candidate.environmentId === "env";

  it("takes the first project that is not quiet and can talk", () => {
    expect(
      pickTalkProject({
        folders: [
          { quiet: true, projects: [project("quiet")] },
          { quiet: false, projects: [project("elsewhere", "other")] },
          { quiet: false, projects: [project("other-member", "other"), project("loud")] },
        ],
        canTalkIn,
      })?.id,
    ).toBe("loud");
  });

  it("falls back to a quiet project, then to none", () => {
    expect(
      pickTalkProject({ folders: [{ quiet: true, projects: [project("quiet")] }], canTalkIn })?.id,
    ).toBe("quiet");
    expect(
      pickTalkProject({
        folders: [{ quiet: false, projects: [project("x", "other")] }],
        canTalkIn,
      }),
    ).toBeNull();
  });
});
