// @effect-diagnostics nodeBuiltinImport:off -- Called from electron-updater's promise-based install seam (ElectronUpdater.ts).
import * as NodeChildProcess from "node:child_process";

// Sidebar fork: installs a downloaded .deb update ourselves. electron-updater's
// own deb install runs pkexec through a blocking shell and failed on Ubuntu
// without ever reaching polkit, then reported nothing useful. This asks for the
// administrator password the same way, asynchronously, and says what went wrong.

export interface DebInstallCommandResult {
  readonly code: number | null;
  readonly stderr: string;
}

export type DebInstallCommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => Promise<DebInstallCommandResult>;

const runCommand: DebInstallCommandRunner = (command, args) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(command, [...args], (error, _stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
        stderr: stderr || error?.message || "",
      });
    });
  });

/**
 * The .deb electron-updater downloaded, or null for any other update (only
 * its deb updater downloads .deb files). The file sits on a protected helper.
 */
export function downloadedDebFile(updater: unknown): string | null {
  const file = (updater as { downloadedUpdateHelper?: { file?: unknown } | null })
    .downloadedUpdateHelper?.file;
  return typeof file === "string" && file.endsWith(".deb") ? file : null;
}

/** A failed install; its message is shown to the user as is. */
export class DebInstallError extends Error {}

export function describeDebInstallFailure(result: DebInstallCommandResult, file: string): string {
  const reason =
    result.stderr
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0) ?? `exit code ${result.code ?? "unknown"}`;
  return `Could not install the update: ${reason}. Install it by hand: sudo apt install '${file}'`;
}

/** Installs the .deb as root after the system password prompt. */
export async function installDebPackage(
  file: string,
  run: DebInstallCommandRunner = runCommand,
): Promise<void> {
  const result = await run("pkexec", ["dpkg", "-i", file]);
  if (result.code !== 0) throw new DebInstallError(describeDebInstallFailure(result, file));
}
