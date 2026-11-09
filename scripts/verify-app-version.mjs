#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Fails a release build when the shipped client bundle does not contain the
 * release version that the build was given. Usage:
 *   node scripts/verify-app-version.mjs 0.1.7-sidebar.63 apps/server/dist/client
 */
export async function verifyAppVersion(expected, directory) {
  const version = expected?.trim();
  if (!version) throw new Error("Missing expected release version");
  const files = await NodeFSP.readdir(directory, { recursive: true, withFileTypes: true });
  const candidates = files
    .filter((entry) => entry.isFile() && /\.(?:html|css|m?js)$/.test(entry.name))
    .map((entry) => NodePath.join(entry.parentPath ?? entry.path, entry.name));
  for (const file of candidates) {
    if ((await NodeFSP.readFile(file, "utf8")).includes(version)) return file;
  }
  throw new Error(`Built client in ${directory} does not contain version ${version}`);
}

if (import.meta.main) {
  const [expected, directory = "apps/server/dist/client"] = process.argv.slice(2);
  await verifyAppVersion(expected, directory).then(
    (file) => console.log(`App version ${expected} found in ${file}`),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
