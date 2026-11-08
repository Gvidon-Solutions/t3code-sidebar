#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

if (process.env.T3_DELIVERY_FIXTURE_GATE !== "1") {
  throw new Error(
    "This gate is only the isolated delivery transport fixture. Configure the real T1 command for releases, or explicitly set T3_DELIVERY_FIXTURE_GATE=1 for isolated E2E.",
  );
}
if (!process.env.T3_DELIVERY_FIXTURE_GATE_LOG)
  throw new Error("Set the private fixture gate log path");
NodeFS.mkdirSync(NodePath.dirname(process.env.T3_DELIVERY_FIXTURE_GATE_LOG), {
  recursive: true,
  mode: 0o700,
});
NodeFS.appendFileSync(
  process.env.T3_DELIVERY_FIXTURE_GATE_LOG,
  JSON.stringify({
    fixture: "delivery bed gate",
    cwd: process.cwd(),
    at: new Date().toISOString(),
  }) + "\n",
  { mode: 0o600 },
);
console.log("Delivery bed fixture gate passed; this does not substitute for T1 acceptance");
