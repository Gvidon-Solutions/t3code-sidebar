import { expect, it } from "@effect/vitest";
import { resolveTestVoiceProvider, testVoiceProviderEnabled } from "./testFlags.ts";

it("honours the voice fixture flag only outside production", () => {
  expect(resolveTestVoiceProvider("1", false, {})).toBe(true);
  expect(resolveTestVoiceProvider("0", false, {})).toBe(false);
  expect(resolveTestVoiceProvider(undefined, false, {})).toBe(false);
  expect(resolveTestVoiceProvider("1", true, {})).toBe(false);
  expect(resolveTestVoiceProvider("1", false, { NODE_ENV: "production" })).toBe(false);
  expect(testVoiceProviderEnabled({ T3_MESH_TEST_VOICE_PROVIDER: "1" })).toBe(true);
});
