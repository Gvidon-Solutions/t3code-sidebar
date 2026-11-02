import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ReplicaError } from "@t3tools/contracts";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

const begin = "# t3-mesh begin";
const end = "# t3-mesh end";
export function managedSshConfig(
  original: string,
  routes: NonNullable<SidebarWorkspacesConfig["machines"][string]>["reach"],
): string {
  const starts = [...original.matchAll(/^# t3-mesh begin$/gm)];
  const stops = [...original.matchAll(/^# t3-mesh end$/gm)];
  const start = starts[0]?.index ?? -1;
  const stop = stops[0]?.index ?? -1;
  if (start < 0 !== stop < 0 || (start >= 0 && stop < start))
    throw new Error("Malformed t3-mesh SSH configuration block.");
  const lines: string[] = [];
  for (const [env, route] of Object.entries(routes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!route.identityFile) continue;
    if (/[\r\n\0]/.test(route.identityFile + route.ssh) || !/^[a-zA-Z0-9._-]+$/.test(env))
      throw new Error("Invalid SSH route.");
    const parsed = /^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/.exec(route.ssh);
    if (!parsed) throw new Error("Invalid SSH destination.");
    lines.push(
      `Host t3-mesh-${env}`,
      `  HostName ${parsed[2]}`,
      ...(parsed[1] ? [`  User ${parsed[1]}`] : []),
      ...(parsed[3] ? [`  Port ${parsed[3]}`] : []),
      `  IdentityFile "${route.identityFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
      "  IdentitiesOnly yes",
    );
  }
  const block = lines.length ? `${begin}\n${lines.join("\n")}\n${end}` : "";
  if (start >= 0) return original.slice(0, start) + block + original.slice(stop + end.length);
  return block
    ? `${original}${original.endsWith("\n") || !original ? "" : "\n"}${block}\n`
    : original;
}

export const syncManagedSshConfig = Effect.fn("ManagedSshConfig.sync")(function* (
  routes: SidebarWorkspacesConfig["machines"][string]["reach"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const filePath = path.join(home, ".ssh", "config");
  const original = (yield* fs.exists(filePath)) ? yield* fs.readFileString(filePath) : "";
  const contents = yield* Effect.try({
    try: () => managedSshConfig(original, routes),
    catch: (cause) =>
      new ReplicaError({ reason: "storage", message: "Invalid managed SSH configuration.", cause }),
  });
  if (contents !== original) {
    yield* writeFileStringAtomically({ filePath, contents });
    yield* fs.chmod(filePath, 0o600);
  }
});
