import { expect, it } from "@effect/vitest";
import { resolveSshHost, resolveMeshHost } from "./sshHost.ts";

it("accepts configured SSH aliases and rejects options and endpoint syntax", () => {
  for (const host of ["t3-studio", "cloudbox.example.test", "192.0.2.1", "laptop", "[2001:db8::1]"])
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
    "host\n",
    "[::1]\n",
    "[invalid::ip]",
    "host;id",
    "host\\path",
  ])
    expect(() => resolveSshHost(host)).toThrow("SSH host");
});

it("resolves configured mesh SSH modes without machine-specific defaults", () => {
  expect(resolveMeshHost(undefined, "studio")).toBe("t3-studio");
  expect(resolveMeshHost({ ssh: { mode: "off" } }, "studio")).toBeUndefined();
  expect(
    resolveMeshHost(
      { ssh: { mode: "existing" }, machines: { studio: { ssh: { host: "custom-host" } } } },
      "studio",
    ),
  ).toBe("custom-host");
  expect(resolveMeshHost({ ssh: { mode: "existing" } }, "studio")).toBeUndefined();
  expect(() =>
    resolveMeshHost(
      { ssh: { mode: "existing" }, machines: { studio: { ssh: { host: "-oProxyCommand=bad" } } } },
      "studio",
    ),
  ).toThrow("SSH host");
});
