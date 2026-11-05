import { proxyCommand } from "../platform/ServerPlatform.ts";
import type { MeshConfigDocument, SidebarMachine } from "@t3tools/contracts";

const begin = "# t3-mesh begin";
const end = "# t3-mesh end";
export function managedBlock(original: string, lines: readonly string[]): string {
  const starts = [...original.matchAll(/^# t3-mesh begin\r?$/gm)];
  const stops = [...original.matchAll(/^# t3-mesh end\r?$/gm)];
  if (
    starts.length > 1 ||
    stops.length > 1 ||
    starts.length !== stops.length ||
    (starts.length && starts[0]!.index! >= stops[0]!.index!)
  )
    throw new Error("Malformed t3-mesh managed block");
  const block = lines.length ? `${begin}\n${lines.join("\n")}\n${end}` : "";
  if (starts.length) {
    const stop = stops[0]!.index! + stops[0]![0].length;
    return (
      original.slice(0, starts[0]!.index) +
      block +
      original.slice(stop + (!block && original[stop] === "\n" ? 1 : 0))
    );
  }
  return block ? `${block}\n${original}` : original;
}
const safe = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid SSH field");
  return value;
};
const quote = (value: string) => `"${safe(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
export interface SshPeer {
  readonly name: string;
  readonly environmentId: string;
  readonly facts: SidebarMachine;
  readonly settings: MeshConfigDocument["machines"][string];
}
export function sshFiles(
  peers: readonly SshPeer[],
  paths: {
    readonly runtime: readonly string[];
    readonly platform?: string;
    readonly baseDir: string;
    readonly identity: string;
    readonly knownHosts: string;
  },
) {
  const config: string[] = [],
    authorized: string[] = [],
    known: string[] = [];
  for (const peer of [...peers].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[a-zA-Z0-9_-]+$/.test(peer.name)) throw new Error("Invalid machine name");
    const facts = peer.facts.reported;
    if (!facts) continue;
    if (facts.meshPublicKey) {
      if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(facts.meshPublicKey))
        throw new Error("Invalid mesh key");
      authorized.push(
        `restrict,pty,port-forwarding,permitopen="127.0.0.1:*",permitopen="[::1]:*",permitlisten="127.0.0.1:*",permitlisten="[::1]:*" ${facts.meshPublicKey}`,
      );
    }
    const user = peer.settings.ssh?.user ?? facts.user;
    if (!user || !facts.sshd) continue;
    const host = `t3-${peer.name}`;
    const proxy = proxyCommand(paths.platform, paths.runtime, peer.environmentId, paths.baseDir);
    config.push(
      `Host ${host}`,
      `  HostName ${host}`,
      `  HostKeyAlias ${host}`,
      `  ProxyCommand ${proxy}`,
      `  User ${quote(user)}`,
      `  IdentityFile ${quote(paths.identity)}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${quote(paths.knownHosts)}`,
      "  StrictHostKeyChecking yes",
      "  ServerAliveInterval 15",
      "  ConnectTimeout 10",
    );
    for (const key of facts.sshd.hostKeys) {
      if (!/^\S+ [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(key))
        throw new Error("Invalid SSH host key");
      known.push(`${host} ${key}`);
    }
  }
  if (config.length) config.push("Host *");
  return { config, authorized, known };
}
export function routeFailure(stderr: string, timedOut: boolean): string {
  if (timedOut) return "pipe unavailable: route check timed out";
  if (/REMOTE HOST IDENTIFICATION|Host key verification|host key.*changed/i.test(stderr))
    return "host key mismatch";
  if (/Permission denied|authentication failed/i.test(stderr)) return "auth refused";
  if (/Connection refused|no sshd/i.test(stderr)) return "no sshd";
  return `pipe unavailable: ${stderr.trim().slice(0, 500) || "SSH transport failed"}`;
}
