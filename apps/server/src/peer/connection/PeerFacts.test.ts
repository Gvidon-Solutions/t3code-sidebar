import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { collectPeerFacts } from "./PeerFacts.ts";
import { sshDirectory } from "../../platform/ServerPlatform.ts";

it.effect.each([
  { key: "ssh-ed25519 AAAA", config: "Port 2222\n", port: 2222, include: null },
  { key: "ssh-rsa BBBB", config: "# Port 2222\n", port: 22, include: null },
  { key: "ssh-ed25519 CCCC", config: "Include extra*.conf\n", port: 2323, include: "Port 2323\n" },
  { key: null, config: "", port: 22, include: null },
])("reports public host keys, absence and sshd port (%j)", ({ key, config, port, include }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mesh-facts-" });
    if (key)
      yield* fs.writeFileString(path.join(directory, "ssh_host_ed25519_key.pub"), `${key}\n`);
    yield* fs.writeFileString(path.join(directory, "sshd_config"), config);
    if (include) yield* fs.writeFileString(path.join(directory, "extra.conf"), include);
    const facts = yield* collectPeerFacts({ sshDir: directory, version: "1.2.3" });
    expect(facts.version).toBe("1.2.3");
    expect(facts.sshd).toEqual(key ? { port, hostKeys: [key] } : null);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("uses each platform's system SSH directory", () => {
  expect(sshDirectory("linux", {})).toBe("/etc/ssh");
  expect(sshDirectory("darwin", {})).toBe("/etc/ssh");
  expect(sshDirectory("win32", { ProgramData: "D:\\ProgramData" })).toBe("D:\\ProgramData\\ssh");
});
