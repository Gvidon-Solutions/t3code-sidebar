import { expect, it } from "@effect/vitest";
import { resolveSshHost } from "./sshHost.ts";

it("accepts configured SSH aliases and rejects options and endpoint syntax", () => {
  for (const host of ["t3-studio", "cloudbox.example.test", "192.0.2.1", "laptop"])
    expect(resolveSshHost(host)).toBe(host);
  for (const host of [
    undefined,
    "",
    "-oProxyCommand=touch /tmp/injected",
    "-V",
    "studio\n-oX",
    "user@host",
    "host:/path",
    "host name",
    "host;id",
    "host\\path",
  ])
    expect(() => resolveSshHost(host)).toThrow("SSH host");
});
