import { expect, it } from "vite-plus/test";
import { createApkDigest } from "./apkDigest";

it("hashes large binary chunks and preserves zero and non-ASCII bytes across boundaries", () => {
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 256);
  const whole = createApkDigest();
  whole.update(bytes);
  const split = createApkDigest();
  split.update(bytes.subarray(0, 32771));
  split.update(bytes.subarray(32771));
  expect(whole.hex()).toBe("fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83");
  expect(split.hex()).toBe("fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83");
});
