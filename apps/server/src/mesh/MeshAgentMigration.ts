import { defaultAgentAliases } from "@t3tools/shared/meshConfig";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MeshAgentKit } from "./MeshAgentKit.ts";
import { MeshConfig } from "./MeshConfig.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MeshConfig;
    const mesh = yield* MeshLayoutService;
    const kit = yield* MeshAgentKit;
    const key = `mesh.agentMigration/${encodeURIComponent(mesh.environmentId)}`;
    if ((yield* mesh.read).document[key]?.v === true) return;
    const current = yield* config.current;
    if (!current || current.doc.schema !== 1) return;
    const legacy =
      current.doc.agents?.instructions === undefined ? yield* kit.legacyInstructions : undefined;
    const aliases = current.doc.agents?.aliases;
    const seedAliases = !aliases || Object.keys(aliases).length === 0;
    if (legacy !== undefined || seedAliases)
      yield* config.apply(
        {
          ...current.doc,
          agents: {
            ...current.doc.agents,
            ...(seedAliases ? { aliases: defaultAgentAliases() } : {}),
            ...(legacy !== undefined ? { instructions: legacy } : {}),
          },
        },
        current.revision,
      );
    const h = yield* mesh.nextHlc;
    yield* mesh.apply({ [key]: { v: true, h } });
  }),
);
