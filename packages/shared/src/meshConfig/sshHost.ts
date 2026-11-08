export function resolveSshHost(host: string | undefined): string {
  const alias = host && /^[a-zA-Z0-9]/.test(host) && !/[^a-zA-Z0-9._-]/.test(host);
  const ipv6 =
    host &&
    /^\[[0-9a-fA-F:.]+\]$/.test(host) &&
    host.endsWith("]") &&
    URL.canParse(`ssh://${host}`);
  if (!host || (!alias && !ipv6))
    throw new Error("SSH host must be a configured alias, DNS name or IP address.");
  return host;
}

export function resolveMeshHost(
  settings:
    | {
        readonly ssh?: { readonly mode?: "managed" | "existing" | "off" };
        readonly machines?: Readonly<Record<string, { readonly ssh?: { readonly host?: string } }>>;
      }
    | undefined,
  machine: string,
): string | undefined {
  if (settings?.ssh?.mode === "off") return undefined;
  const host =
    settings?.ssh?.mode === "existing" ? settings.machines?.[machine]?.ssh?.host : `t3-${machine}`;
  return host === undefined ? undefined : resolveSshHost(host);
}
