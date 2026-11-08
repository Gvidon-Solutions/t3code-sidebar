import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, run, runSync, until } from "./shell.mjs";

test("quotes shell metacharacters without evaluating them", () => {
  const input = "space ' quote $HOME `id`\nsecond line";
  assert.equal(runSync("sh", ["-c", `printf %s ${quote(input)}`]), input);
});

test("preserves output and exit diagnostics", async () => {
  assert.equal(await run(process.execPath, ["-e", "console.log('value')"]), "value");
  await assert.rejects(
    run(process.execPath, ["-e", "console.error('reason'); process.exit(7)"]),
    (error) => error.code === 7 && error.stderr.includes("reason"),
  );
  await assert.rejects(
    run(process.execPath, ["-e", "console.log(1234)"], { maxBuffer: 2 }),
    /maxBuffer/,
  );
});

test("polling returns the accepted result and surfaces the last refusal", async () => {
  assert.equal(
    await until(
      "ready",
      async () => "ready",
      (value) => value === "ready",
    ),
    "ready",
  );
  await assert.rejects(
    until(
      "refused",
      async () => {
        throw Error("denied");
      },
      () => false,
      1,
    ),
    /denied/,
  );
});
