declare const __T3CODE_PRODUCTION_BUILD__: boolean | undefined;

/** Production bundles and released servers must never honour test-only provider flags. */
export function resolveTestVoiceProvider(
  value: string | undefined,
  production: boolean,
  env: { readonly NODE_ENV?: string | undefined } = process.env,
): boolean {
  if (production || env.NODE_ENV === "production") return false;
  return value === "1";
}

export const testVoiceProviderEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  resolveTestVoiceProvider(
    env.T3_MESH_TEST_VOICE_PROVIDER,
    typeof __T3CODE_PRODUCTION_BUILD__ !== "undefined" && __T3CODE_PRODUCTION_BUILD__,
    env,
  );
