import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  effortChoicesFor,
  modelOptionDisplay,
  quickSwitchModels,
  resolveModelDisplay,
} from "./modelDisplay";

const CLAUDE_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
      currentValue: "high",
    },
  ],
};

function modelOption(
  model: string,
  input: {
    readonly label?: string;
    readonly provider?: string;
    readonly providerLabel?: string;
    readonly capabilities?: ModelCapabilities | null;
    readonly options?: ReadonlyArray<{ id: string; value: string | boolean }>;
    readonly isLegacy?: boolean;
  } = {},
): ModelOption {
  const provider = input.provider ?? "claude";
  return {
    key: `${provider}:${model}`,
    label: input.label ?? model,
    subtitle: "",
    providerKey: provider,
    providerLabel: input.providerLabel ?? (provider === "claude" ? "Claude" : "Antigravity"),
    providerDriver: provider,
    isDefault: false,
    isLegacy: input.isLegacy ?? false,
    capabilities: input.capabilities ?? null,
    selection: {
      instanceId: ProviderInstanceId.make(provider),
      model,
      options: input.options,
    },
  };
}

describe("mobile model display", () => {
  it("shows the short model name next to a descriptor effort", () => {
    const selection = modelOption("claude-opus-4-5", {
      label: "Claude Opus 4.5",
      capabilities: CLAUDE_CAPABILITIES,
      options: [{ id: "effort", value: "high" }],
    }).selection;

    expect(
      resolveModelDisplay({
        name: "Claude Opus 4.5",
        providerLabel: "Claude",
        descriptors: CLAUDE_CAPABILITIES.optionDescriptors,
        selection,
      }),
    ).toEqual({ name: "Opus 4.5", effort: "High" });
  });

  it("lifts an effort baked into the model name", () => {
    expect(
      resolveModelDisplay({
        name: "Gemini 3.8 Flash (Medium)",
        providerLabel: "Antigravity",
      }),
    ).toEqual({ name: "Gemini 3.8 Flash", effort: "Medium" });
  });

  it("does not duplicate an effort the descriptor already names", () => {
    const option = modelOption("gemini-3.8-flash-high", {
      label: "Gemini 3.8 Flash (High)",
      provider: "antigravity",
      capabilities: CLAUDE_CAPABILITIES,
      options: [{ id: "effort", value: "high" }],
    });

    expect(modelOptionDisplay(option)).toEqual({ name: "Gemini 3.8 Flash", effort: "High" });
  });

  it("keeps an honest one-line name when a catalog is noisy", () => {
    expect(
      resolveModelDisplay({ name: "Astra V4.1Flash 1017 Max", providerLabel: "OpenRouter" }),
    ).toEqual({ name: "Astra V4.1Flash 1017", effort: "Max" });
  });
});

describe("reasoning choices", () => {
  const option = modelOption("claude-opus-4-5", {
    label: "Claude Opus 4.5",
    capabilities: CLAUDE_CAPABILITIES,
    options: [{ id: "effort", value: "high" }],
  });

  it("uses the provider descriptor when the model has one", () => {
    const result = effortChoicesFor({
      option,
      descriptors: CLAUDE_CAPABILITIES.optionDescriptors ?? [],
      selection: option.selection,
      reportedSelection: null,
      groups: [],
    });

    expect(result?.source).toBe("descriptor");
    expect(result?.choices.map((choice) => [choice.label, choice.selected])).toEqual([
      ["Low", false],
      ["Medium", false],
      ["High", true],
      ["Max", false],
    ]);
  });

  it("offers sibling models when the effort lives in the model name", () => {
    const groups: ProviderGroup[] = [
      {
        providerKey: "antigravity",
        providerLabel: "Antigravity",
        models: [
          modelOption("gemini-3.8-flash-low", {
            label: "Gemini 3.8 Flash (Low)",
            provider: "antigravity",
          }),
          modelOption("gemini-3.8-flash-medium", {
            label: "Gemini 3.8 Flash (Medium)",
            provider: "antigravity",
          }),
          modelOption("gemini-3.8-flash-high", {
            label: "Gemini 3.8 Flash (High)",
            provider: "antigravity",
          }),
          modelOption("gemini-3.7-flash-high", {
            label: "Gemini 3.7 Flash (High)",
            provider: "antigravity",
          }),
        ],
      },
    ];
    const current = groups[0]!.models[2]!;

    const result = effortChoicesFor({
      option: current,
      descriptors: [],
      selection: current.selection,
      reportedSelection: null,
      groups,
    });

    expect(result?.source).toBe("model");
    expect(result?.choices.map((choice) => [choice.label, choice.selected])).toEqual([
      ["Low", false],
      ["Medium", false],
      ["High", true],
    ]);
  });
});

describe("quick switch", () => {
  const groups: ProviderGroup[] = [
    {
      providerKey: "claude",
      providerLabel: "Claude",
      models: [
        modelOption("claude-opus-4-5", { label: "Claude Opus 4.5" }),
        modelOption("claude-sonnet-4-5", { label: "Claude Sonnet 4.5" }),
        modelOption("claude-haiku-4-5", { label: "Claude Haiku 4.5", isLegacy: true }),
      ],
    },
  ];

  it("prefers pinned models and drops legacy catalog entries", () => {
    const result = quickSwitchModels({
      groups,
      favoriteKeys: new Set([groups[0]!.models[1]!.key, groups[0]!.models[2]!.key]),
      current: groups[0]!.models[0]!,
    });

    expect(result.source).toBe("pinned");
    expect(result.models.map((model) => model.label)).toEqual(["Claude Sonnet 4.5"]);
  });

  it("suggests the current provider's models before anything is pinned", () => {
    const result = quickSwitchModels({
      groups,
      favoriteKeys: new Set(),
      current: groups[0]!.models[0]!,
    });

    expect(result.source).toBe("suggested");
    expect(result.models.map((model) => model.label)).toEqual([
      "Claude Opus 4.5",
      "Claude Sonnet 4.5",
    ]);
  });
});
