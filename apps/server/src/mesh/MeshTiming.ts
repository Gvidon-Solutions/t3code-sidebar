declare const __T3CODE_PRODUCTION_BUILD__: boolean | undefined;

const productionBuild =
  typeof __T3CODE_PRODUCTION_BUILD__ !== "undefined" && __T3CODE_PRODUCTION_BUILD__;

export function resolveMeshTimeScale(value: string | undefined, production: boolean) {
  if (production || value === undefined) return 1;
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1)
    throw new Error("T3_MESH_TIME_SCALE must be greater than zero and at most one");
  return scale;
}

const scale = resolveMeshTimeScale(
  process.env.T3_MESH_TIME_SCALE,
  productionBuild || process.env.NODE_ENV === "production",
);

export const meshMillis = (milliseconds: number) => milliseconds * scale;
