import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { it, expect } from "@effect/vitest";
import { managedSshConfig, syncManagedSshConfig } from "./ManagedSshConfig.ts";
it("replaces only its block and preserves surrounding SSH config byte for byte", () => {
  const original = "Host personal\n IdentityFile ~/.ssh/personal\n";
  const routes = { peer: { ssh: "user@example.test:2222", identityFile: "/keys/test key" } };
  const first = managedSshConfig(original, routes);
  expect(first.startsWith(original)).toBe(true);
  expect(first).toContain("Host t3-mesh-peer\n  HostName example.test\n  User user\n  Port 2222");
  expect(managedSshConfig(first, routes)).toBe(first);
  expect(managedSshConfig(`${first}Host after\n`, {})).toBe(`${original}\nHost after\n`);
  expect(managedSshConfig(original, { peer: { ssh: "example" } })).toBe(original);
  expect(() => managedSshConfig("# t3-mesh begin\n", routes)).toThrow("Malformed");
  expect(() => managedSshConfig(`${first}${first}`, routes)).toThrow("Malformed");
  expect(() =>
    managedSshConfig(original, { peer: { ssh: "example", identityFile: "key\nHost *" } }),
  ).toThrow("Invalid");
});

it.effect("writes only the managed block in an isolated home and removes retired identities", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-replica-ssh-" });
    const config = path.join(home, ".ssh", "config");
    yield* fs.makeDirectory(path.dirname(config));
    yield* fs.writeFileString(config, "Host personal\n  HostName personal.test\n");
    yield* syncManagedSshConfig({ peer: { ssh: "example.test", identityFile: "/keys/peer" } }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
    const saved = yield* fs.readFileString(config);
    expect(saved).toContain("Host personal\n  HostName personal.test\n# t3-mesh begin");
    expect(saved).toContain('IdentityFile "/keys/peer"');
    yield* syncManagedSshConfig({}).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
    expect(yield* fs.readFileString(config)).toBe("Host personal\n  HostName personal.test\n\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);
