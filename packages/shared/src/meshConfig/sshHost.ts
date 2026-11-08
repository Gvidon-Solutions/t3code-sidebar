export function resolveSshHost(host: string | undefined): string {
  if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))
    throw new Error("SSH host must be a configured alias, DNS name or IPv4 address.");
  return host;
}
