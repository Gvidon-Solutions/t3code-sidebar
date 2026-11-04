import { conflictCopyPath, conflictRoots } from "./conflictResolution.ts";

export const nodeCommand = (source: string) =>
  `node -e "eval(Buffer.from('${Buffer.from(source).toString("base64")}','base64').toString())"`;

export function sshArguments(host: string, sshHome?: string): string[] {
  if (!host || host.startsWith("-") || /[\s\0]/.test(host)) throw new Error("Invalid SSH host");
  return [
    ...(sshHome ? ["-F", `${sshHome.replace(/[\\/]$/, "")}/.ssh/config`] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "--",
    host,
  ];
}

export function preserveConflictScript(
  root: string,
  iso: string,
  paths: readonly string[],
): string {
  const copies = conflictRoots(paths).map((relative) => [
    relative,
    conflictCopyPath(iso, relative),
  ]);
  return `const fs = require('node:fs'), path = require('node:path');
const root = fs.realpathSync(${JSON.stringify(root)});
function guard(target) {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('Outside conflict root');
  let parent = path.dirname(target);
  while (parent !== root) {
    try { if (fs.lstatSync(parent).isSymbolicLink()) throw Error('Symlink parent'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    parent = path.dirname(parent);
  }
}
for (const [relative, copy] of ${JSON.stringify(copies)}) {
  const source = path.resolve(root, relative), destination = path.resolve(root, copy);
  guard(source); guard(destination);
  try { fs.lstatSync(source); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
  try { fs.lstatSync(destination); throw Error('Conflict copy already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}`;
}

export function sshWrapper(
  platform: string,
  _executable: string,
  configFile: string,
  program: "ssh" | "scp" = "ssh",
) {
  if (/[\r\n\0]/.test(configFile)) throw new Error("Invalid SSH config path");
  if (platform === "win32")
    return {
      name: `${program}.cmd`,
      contents: `@echo off\r\n${program} -F "${configFile}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    };
  const quoted = "'" + configFile.replaceAll("'", "'\\''") + "'";
  return { name: program, contents: `#!/bin/sh\nexec ${program} -F ${quoted} "$@"\n` };
}

export function mutagenSshEnvironment(
  platform: string,
  sshHome: string | undefined,
  dataDirectory: string,
) {
  if (!sshHome) return {};
  return platform === "win32"
    ? { HOME: sshHome, USERPROFILE: sshHome }
    : { MUTAGEN_SSH_PATH: `${dataDirectory}/../mesh/ssh/bin` };
}
