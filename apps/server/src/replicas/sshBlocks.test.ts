import { expect, it } from "@effect/vitest";
import { managedBlock, routeFailure, sshFiles } from "./sshBlocks.ts";

it("updates only its block, is idempotent and rejects damaged markers", () => {
  const original = "# private config\nHost personal\n  User developer\n";
  const updated = managedBlock(original, ["Host t3-studio"]);
  expect(updated.endsWith(original)).toBe(true);
  expect(managedBlock(updated, ["Host t3-studio"])).toBe(updated);
  expect(managedBlock(updated, ["Host t3-laptop"])).not.toContain("Host t3-studio");
  expect(managedBlock(updated, [])).toBe(original);
  for (const damaged of [
    "# t3-mesh begin",
    "# t3-mesh end",
    "# t3-mesh end\n# t3-mesh begin",
    `${updated}\n${updated}`,
  ])
    expect(() => managedBlock(damaged, [])).toThrow("Malformed");
});
it("pins keys and generates the shared runtime pipe route with restricted peer access", () => {
  const files = sshFiles(
    [
      {
        name: "studio",
        environmentId: "env-studio",
        settings: {},
        facts: {
          reported: {
            user: "developer",
            version: "1",
            reportedAt: "",
            platform: { os: "linux", arch: "x64", release: "" },
            meshPublicKey: "ssh-ed25519 AAAA",
            sshd: { port: 22, hostKeys: ["ssh-ed25519 BBBB"] },
          },
        },
      },
    ],
    {
      runtime: ["/opt/t3 runtime/t3"],
      baseDir: "/data/studio",
      identity: "/data/key",
      knownHosts: "/data/known",
    },
  );
  expect(files.config.join("\n")).toContain(
    "ProxyCommand '/opt/t3 runtime/t3' 'mesh' 'pipe' 'env-studio' '--base-dir' '/data/studio'",
  );
  expect(files.config).toContain("  StrictHostKeyChecking yes");
  expect(files.known).toEqual(["t3-studio ssh-ed25519 BBBB"]);
  expect(files.authorized[0]).toContain('restrict,pty,port-forwarding,permitopen="127.0.0.1:*"');
});
it.each([
  ["Permission denied (publickey)", false, "auth refused"],
  ["Host key verification failed", false, "host key mismatch"],
  ["connect: Connection refused", false, "no sshd"],
  ["", true, "pipe unavailable: route check timed out"],
  ["peer disconnected", false, "pipe unavailable: peer disconnected"],
])("explains route failure %s", (stderr, timeout, reason) =>
  expect(routeFailure(stderr, timeout)).toBe(reason),
);
