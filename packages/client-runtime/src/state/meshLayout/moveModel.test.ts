import { expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { resolveMoveModel } from "./moveModel.ts";
it("preserves current instance, model and options or chooses the target default when unavailable", () => {
  const current = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "source",
    options: [{ id: "effort", value: "high" }],
  };
  const target = { instanceId: ProviderInstanceId.make("claude"), model: "target" };
  expect(
    resolveMoveModel(current, [{ selection: current }, { selection: target, isDefault: true }]),
  ).toEqual({ selection: current, fallback: false });
  expect(
    resolveMoveModel(current, [
      { selection: current, isUnavailable: true },
      { selection: target, isDefault: true },
    ]),
  ).toEqual({ selection: target, fallback: true });
  expect(
    resolveMoveModel(
      current,
      [
        { selection: target },
        { selection: { ...target, model: "catalog-default" }, isDefault: true },
      ],
      target,
    ),
  ).toEqual({ selection: target, fallback: true });
  expect(resolveMoveModel(current, [])).toEqual({ selection: null, fallback: true });
});
