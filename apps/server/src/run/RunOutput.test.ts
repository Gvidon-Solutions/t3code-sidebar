import { expect, it } from "@effect/vitest";
import { rewriteRunOutput } from "./RunOutput.ts";

it("rewrites only complete project-root path prefixes across every byte split", () => {
  const source = Buffer.from(
    'é /primary/app/src.ts:2 /primary/application /other/primary/app "/primary/app"\n',
  );
  const expected =
    'é /replica/app/src.ts:2 /primary/application /other/primary/app "/replica/app"\n';
  for (let split = 0; split <= source.length; split++) {
    const rewrite = rewriteRunOutput("/primary/app", "/replica/app");
    expect(
      Buffer.concat([
        rewrite.write(source.subarray(0, split)),
        rewrite.write(source.subarray(split)),
        rewrite.end(),
      ]).toString(),
    ).toBe(expected);
  }
});
it("streams long lines immediately and flushes the final root at EOF", () => {
  const rewrite = rewriteRunOutput("/work/app", "/copy");
  expect(rewrite.write(Buffer.from("x".repeat(10000)))).toHaveLength(9991);
  expect(Buffer.concat([rewrite.write(Buffer.from(" /work/app")), rewrite.end()]).toString()).toBe(
    "x".repeat(9) + " /copy",
  );
});

it("preserves arbitrary binary output outside the exact replacement", () => {
  const rewrite = rewriteRunOutput("/work", "/copy");
  const source = Buffer.concat([
    Buffer.from([0xff, 0x00]),
    Buffer.from(" /work/a"),
    Buffer.from([0xc3, 0x00]),
  ]);
  expect(Buffer.concat([rewrite.write(source), rewrite.end()])).toEqual(
    Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(" /copy/a"), Buffer.from([0xc3, 0x00])]),
  );
});
