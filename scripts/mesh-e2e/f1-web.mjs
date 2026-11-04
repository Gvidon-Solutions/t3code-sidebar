#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { chromium } from "playwright-core";

const { values } = NodeUtil.parseArgs({
  options: {
    origin: { type: "string" },
    "storage-state": { type: "string" },
    "thread-title": { type: "string" },
    "thread-id": { type: "string" },
    "target-title": { type: "string" },
    "target-project-id": { type: "string" },
    shots: { type: "string", default: "/tmp/t3-f1-shots" },
  },
});
for (const name of [
  "origin",
  "storage-state",
  "thread-title",
  "thread-id",
  "target-title",
  "target-project-id",
]) {
  NodeAssert.ok(values[name], `--${name} is required`);
}
const cli = NodeURL.fileURLToPath(
  new URL("../../agent-kit/skills/t3/scripts/t3ctl.mjs", import.meta.url),
);
const readThread = () =>
  JSON.parse(
    NodeChildProcess.execFileSync(
      process.execPath,
      [cli, "tool", "t3_thread_read", JSON.stringify({ threadId: values["thread-id"], limit: 1 })],
      { encoding: "utf8" },
    ),
  );
const before = readThread();
NodeAssert.ok(before.thread.itemCount > 0, "Use a fixture with real conversation history");
NodeAssert.notEqual(
  before.thread.projectId,
  values["target-project-id"],
  "Fixture must start in another project",
);
await NodeFSP.mkdir(values.shots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({
    storageState: values["storage-state"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: values.shots, size: { width: 1440, height: 1000 } },
  });
  const page = await context.newPage();
  const video = page.video();
  await page.goto(values.origin);
  const row = page
    .locator("[data-thread-key]")
    .filter({ has: page.getByText(values["thread-title"], { exact: true }) });
  const folder = page
    .locator('[draggable="true"][aria-expanded]')
    .filter({ has: page.getByText(values["target-title"], { exact: true }) });
  await row.waitFor();
  await folder.waitFor();
  await page.screenshot({
    path: NodePath.join(values.shots, "web-drag-before.png"),
    fullPage: true,
  });
  await row.dragTo(folder);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: `Move to ${values["target-title"]}?`, exact: true })
    .waitFor();
  NodeAssert.equal(
    await dialog.getByRole("combobox").count(),
    0,
    "Local moves must not need a model",
  );
  await page.screenshot({
    path: NodePath.join(values.shots, "web-drag-confirm.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: `Move to ${values["target-title"]}`, exact: true })
    .click();
  await page.getByText(`Moved to ${values["target-title"]} on`, { exact: false }).waitFor();
  const after = readThread();
  NodeAssert.equal(after.thread.projectId, values["target-project-id"]);
  NodeAssert.equal(after.thread.threadId, before.thread.threadId);
  NodeAssert.equal(after.thread.archived, false);
  NodeAssert.equal(after.thread.itemCount, before.thread.itemCount);
  NodeAssert.equal(after.thread.runCount, before.thread.runCount);
  NodeAssert.equal(after.thread.providerInstanceId, before.thread.providerInstanceId);
  NodeAssert.equal(after.thread.model, before.thread.model);
  await page.screenshot({
    path: NodePath.join(values.shots, "web-drag-after.png"),
    fullPage: true,
  });
  console.log(
    "PASS real Chromium dragTo -> model-free confirmation -> backend project changed; original identity/history retained",
  );
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Fork to machine…", exact: true }).click();
  await page.getByRole("dialog").getByRole("combobox", { name: "Fork target machine" }).waitFor();
  await page.screenshot({
    path: NodePath.join(values.shots, "web-fork-machine-dialog.png"),
    fullPage: true,
  });
  console.log("PASS real thread menu -> Fork to machine dialog");
  await page.keyboard.press("Escape");
  await context.close();
  const recorded = await video.path();
  const destination = NodePath.join(values.shots, "web-drag.webm");
  await NodeFSP.rename(recorded, destination);
  console.log(`Evidence: ${values.shots}`);
} finally {
  await browser.close();
}
