import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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

export function resolveMeshTestValue(value: string | undefined, production: boolean) {
  return production ? undefined : value;
}

/** Test-only path redirects; a production build ignores them. */
export const meshTestValue = (value: string | undefined) =>
  resolveMeshTestValue(value, productionBuild || process.env.NODE_ENV === "production");

export const MeshTimeScale = Context.Reference<number>("t3/mesh/TimeScale", {
  defaultValue: () =>
    resolveMeshTimeScale(
      process.env.T3_MESH_TIME_SCALE,
      productionBuild || process.env.NODE_ENV === "production",
    ),
});
export const meshMillis = (milliseconds: number, scale = 1) => milliseconds * scale;
export const meshTimer = Effect.map(
  MeshTimeScale,
  (scale) => (milliseconds: number) => meshMillis(milliseconds, scale),
);

export function resolveMeshAssetUrl(url: string, origin: string | undefined, production: boolean) {
  if (production || origin === undefined) return url;
  const mirror = new URL(origin);
  if (
    mirror.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(mirror.hostname) ||
    mirror.pathname !== "/" ||
    mirror.username ||
    mirror.password ||
    mirror.search ||
    mirror.hash
  )
    throw new Error("T3_MESH_TEST_ASSET_ORIGIN must be a loopback HTTP origin");
  return new URL(new URL(url).pathname, mirror).href;
}

export const meshAssetUrl = (url: string) =>
  resolveMeshAssetUrl(
    url,
    process.env.T3_MESH_TEST_ASSET_ORIGIN,
    productionBuild || process.env.NODE_ENV !== "test",
  );
