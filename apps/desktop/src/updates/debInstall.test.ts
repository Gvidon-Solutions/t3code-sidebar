import { assert, describe, it } from "@effect/vitest";

import { DebInstallError, downloadedDebFile, installDebPackage } from "./debInstall.ts";

const FILE = "/home/user/.cache/t3code-sidebar-updater/pending/T3-Code-Sidebar-0.0.45-amd64.deb";

describe("downloadedDebFile", () => {
  it("finds the .deb electron-updater downloaded", () => {
    assert.equal(downloadedDebFile({ downloadedUpdateHelper: { file: FILE } }), FILE);
  });

  it("leaves other updates to electron-updater", () => {
    assert.isNull(downloadedDebFile({ downloadedUpdateHelper: { file: "/tmp/T3.AppImage" } }));
    assert.isNull(downloadedDebFile({ downloadedUpdateHelper: null }));
    assert.isNull(downloadedDebFile({}));
  });
});

describe("installDebPackage", () => {
  it("installs with dpkg behind the system password prompt", async () => {
    const calls: Array<[string, ReadonlyArray<string>]> = [];
    await installDebPackage(FILE, async (command, args) => {
      calls.push([command, args]);
      return { code: 0, stderr: "" };
    });
    assert.deepEqual(calls, [["pkexec", ["dpkg", "-i", FILE]]]);
  });

  it("says why it failed and how to install by hand", async () => {
    const error = await installDebPackage(FILE, async () => ({
      code: 126,
      stderr: "Error executing command as another user: Request dismissed\n",
    })).catch((cause: unknown) => cause);
    assert.instanceOf(error, DebInstallError);
    assert.equal(
      (error as Error).message,
      `Could not install the update: Error executing command as another user: Request dismissed. Install it by hand: sudo apt install '${FILE}'`,
    );
  });
});
