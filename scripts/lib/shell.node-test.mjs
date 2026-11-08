import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { quote, run, runSync, until } from "./shell.mjs";

NodeTest.test("quotes shell metacharacters without evaluating them", () => {
  const input = "space ' quote $HOME `id`\nsecond line";
  NodeAssert.equal(runSync("sh", ["-c", `printf %s ${quote(input)}`]), input);
});

NodeTest.test("preserves output and exit diagnostics", async () => {
  NodeAssert.equal(await run(process.execPath, ["-e", "console.log('value')"]), "value");
  await NodeAssert.rejects(
    run(process.execPath, ["-e", "console.error('reason'); process.exit(7)"]),
    (error) => error.code === 7 && error.stderr.includes("reason"),
  );
  await NodeAssert.rejects(
    run(process.execPath, ["-e", "console.log(1234)"], { maxBuffer: 2 }),
    /maxBuffer/,
  );
});

NodeTest.test("polling returns the accepted result and surfaces the last refusal", async () => {
  NodeAssert.equal(
    await until(
      "ready",
      async () => "ready",
      (value) => value === "ready",
    ),
    "ready",
  );
  await NodeAssert.rejects(
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
