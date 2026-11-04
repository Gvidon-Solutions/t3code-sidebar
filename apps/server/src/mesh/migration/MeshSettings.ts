import { ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../../serverSettings.ts";
import { MeshLayoutService } from "../MeshLayoutService.ts";

export const layer = Layer.effect(
  ServerSettingsService,
  Effect.gen(function* () {
    const raw = yield* ServerSettingsService;
    const mesh = yield* MeshLayoutService;
    const updateLayout = Effect.fn("MeshSettings.updateLayout")(function* (
      patch: Parameters<typeof raw.updateSettings>[0],
    ) {
      if (patch.sidebarWorkspaces !== undefined)
        yield* mesh
          .editLegacy((yield* mesh.read).config, patch.sidebarWorkspaces)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({ settingsPath: "<mesh>", operation: "write-file", cause }),
            ),
          );
      const { sidebarWorkspaces: _layout, ...rest } = patch;
      return rest;
    });
    return ServerSettingsService.of({
      ...raw,
      updateSettings: Effect.fn("MeshSettings.updateSettings")(function* (patch) {
        return yield* raw.updateSettings(yield* updateLayout(patch));
      }),
      updateProviderInstance: Effect.fn("MeshSettings.updateProviderInstance")(function* (
        mutation,
        patch = {},
      ) {
        return yield* raw.updateProviderInstance(mutation, yield* updateLayout(patch));
      }),
    });
  }),
);
