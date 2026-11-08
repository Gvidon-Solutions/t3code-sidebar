import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { cleanAgentOptions } from "./agent-options.mjs";

NodeTest.test("delivery uses project defaults unless the owner configured agent options", () => {
  NodeAssert.deepEqual(cleanAgentOptions({}), []);
  NodeAssert.deepEqual(cleanAgentOptions({ agent: "custom" }), ["--agent", "custom"]);
  NodeAssert.deepEqual(cleanAgentOptions({ model: "model" }), ["--model", "model"]);
  NodeAssert.deepEqual(cleanAgentOptions({ agent: "custom", model: "model" }), [
    "--agent",
    "custom",
    "--model",
    "model",
  ]);
});
