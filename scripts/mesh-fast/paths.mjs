import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const harnessRoot = NodePath.resolve(
  NodeURL.fileURLToPath(new URL("../../", import.meta.url)),
);
export const productRoot = NodePath.resolve(process.env.MESH_FAST_PRODUCT_ROOT ?? harnessRoot);
