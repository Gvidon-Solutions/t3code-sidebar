import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG, EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as MeshTest from "./MeshLayoutTestLayer.ts";
import * as Ssh from "./MeshSsh.ts";

it.live(
  "keeps keys across starts, isolates SSH files, preserves foreign content and reports route outcomes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "s1-ssh-" });
      const home = path.join(root, "home");
      const calls: ProcessRunner.ProcessRunInput[] = [];
      let stderr = "";
      let timedOut = false;
      const processes = Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.gen(function* () {
            calls.push(input);
            if (input.command === "ssh-keygen") {
              const destination = input.args?.at(-1);
              if (!destination) throw new Error("Missing key destination");
              yield* fs.writeFileString(destination, "private fixture");
              yield* fs.writeFileString(`${destination}.pub`, "ssh-ed25519 AAAA");
            }
            return {
              code: (stderr || timedOut ? 255 : 0) as ProcessRunner.ProcessRunOutput["code"],
              stdout: "",
              stderr,
              timedOut,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      });
      const links = Layer.succeed(PeerLinks, {
        enabled: Effect.succeed(true),
        ids: Effect.succeed([EnvironmentId.make("laptop-env")]),
        list: Effect.succeed([]),
        link: () => Effect.die("Unexpected link"),
        describe: () => Effect.succeedNone,
        acceptGrant: () => Effect.void,
        get: () => Effect.succeedNone,
        unlink: () => Effect.succeed(false),
        resolve: () => Effect.die("Unexpected resolve"),
        recordOutcome: () => Effect.void,
      });
      const mesh = MeshTest.layerTest("studio-env", {
        ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
        machines: {
          "laptop-env": {
            reported: {
              version: "1",
              reportedAt: "",
              user: "developer",
              platform: { os: "linux", arch: "x64", release: "" },
              meshPublicKey: "ssh-ed25519 BBBB",
              sshd: { port: 22, hostKeys: ["ssh-ed25519 CCCC"] },
            },
          },
        },
      });
      const environment = Layer.succeed(HostProcess.Environment, { T3_MESH_SSH_HOME: home });
      const dependencies = Layer.mergeAll(
        mesh,
        links,
        environment,
        processes,
        ServerConfig.layerTest(root, root),
      );
      const program = Effect.gen(function* () {
        const layout = yield* MeshLayoutService;
        const h = yield* layout.nextHlc;
        yield* layout.apply({
          "mesh.machineBinding/studio": { v: "studio-env", h },
          "mesh.machineBinding/laptop": { v: "laptop-env", h },
        });
        const ssh = yield* Ssh.MeshSsh;
        expect(ssh.publicKey).toBe("ssh-ed25519 AAAA");
        const doc = { schema: 1, machines: { studio: {}, laptop: {} } };
        yield* ssh.reconcile(doc);
        const config = path.join(home, ".ssh", "config");
        const authorized = path.join(home, ".ssh", "authorized_keys");
        expect((yield* fs.stat(path.join(home, ".ssh"))).mode & 0o777).toBe(0o700);
        for (const file of [config, authorized, path.join(root, "mesh", "ssh", "known_hosts")])
          expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
        yield* fs.writeFileString(
          authorized,
          `# personal\n${yield* fs.readFileString(authorized)}`,
        );
        yield* ssh.reconcile(doc, "laptop");
        expect(yield* fs.readFileString(authorized)).toMatch(/^# personal\n/);
        expect(calls.at(-1)?.args).toContain(config);
        yield* ssh.reconcile(
          {
            ...doc,
            ssh: { mode: "existing" },
            machines: { studio: {}, laptop: { ssh: { host: "my-laptop" } } },
          },
          "laptop",
        );
        expect(calls.at(-1)?.args).toContain("my-laptop");
        expect(yield* fs.readFileString(authorized)).not.toContain("BBBB");
        stderr = "Permission denied (publickey)";
        expect((yield* ssh.reconcile(doc, "laptop").pipe(Effect.flip)).message).toBe(
          "auth refused",
        );
        stderr = "";
        timedOut = true;
        expect((yield* ssh.reconcile(doc, "laptop").pipe(Effect.flip)).message).toContain(
          "timed out",
        );
        timedOut = false;
        yield* ssh.reconcile({ ...doc, ssh: { mode: "off" } });
        expect(yield* fs.readFileString(authorized)).toBe("\n# personal\n\n");
        const count = calls.filter((call) => call.command === "ssh-keygen").length;
        yield* Effect.gen(function* () {
          expect((yield* Ssh.MeshSsh).publicKey).toBe(ssh.publicKey);
        }).pipe(Effect.provide(Ssh.layer.pipe(Layer.provide(dependencies), Layer.fresh)));
        expect(calls.filter((call) => call.command === "ssh-keygen")).toHaveLength(count);
      });
      yield* program.pipe(Effect.provide(Ssh.layer.pipe(Layer.provideMerge(dependencies))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
