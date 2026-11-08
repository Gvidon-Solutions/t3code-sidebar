import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { layerTest as layoutTest } from "../../testFixtures/MeshLayoutTestLayer.ts";
import * as Config from "./MeshConfig.ts";

/** The real config service over an in-memory layout, with no reconcilers. */
export const layerTest = (environmentId = "test") =>
  Config.layer.pipe(
    Layer.provide(Layer.succeed(Config.MeshConfigPlanners, [])),
    Layer.provideMerge(layoutTest(environmentId, DEFAULT_SIDEBAR_WORKSPACES_CONFIG)),
  );
