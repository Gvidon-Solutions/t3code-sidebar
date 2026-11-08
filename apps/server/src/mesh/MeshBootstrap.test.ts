import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG, EnvironmentId } from "@t3tools/contracts";
import { ProcessRunner, type ProcessRunOutput, type ProcessRunInput } from "../processRunner.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import * as ServerConfig from "../config.ts";
import * as Layout from "../replicas/MeshLayoutTestLayer.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { MeshRuntimeArchive } from "./MeshRuntimeArchive.ts";
import * as Bootstrap from "./MeshBootstrap.ts";
const result = (stdout = "", code = 0): ProcessRunOutput => ({
  code: code as ProcessRunOutput["code"],
  stdout,
  stderr: code ? "Permission denied" : "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
it.effect(
  "bootstraps through verified transfer, service and mutual linking; drops the credential after failure and resumes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "B1-bootstrap-" });
      const calls: ProcessRunInput[] = [];
      let installed = false;
      let failProbe = true;
      let downloads = 0;
      const doc = {
        schema: 1,
        t3: { version: "0.1.5" },
        machines: {
          cloudbox: {
            reach: { address: "https://cloudbox.example" },
            bootstrap: {
              ssh: "studio@cloudbox:2222",
              hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBRZ",
            },
          },
        },
      };
      yield* Effect.gen(function* () {
        const mesh = yield* MeshLayoutService;
        const bootstrap = yield* Bootstrap.MeshBootstrap;
        const h = yield* mesh.nextHlc;
        yield* mesh.apply({
          "mesh.config": { h, v: { revision: "r1", doc, author: "studio", writtenAt: "" } },
        });
        for (const machine of [
          { bootstrap: doc.machines.cloudbox.bootstrap },
          {
            reach: { address: "http://cloudbox.example" },
            bootstrap: doc.machines.cloudbox.bootstrap,
          },
          { reach: doc.machines.cloudbox.reach, bootstrap: { ssh: "studio@cloudbox" } },
        ])
          expect(
            (yield* bootstrap
              .reconcile("cloudbox", { ...doc, machines: { cloudbox: machine } })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        expect(calls).toHaveLength(0);
        yield* bootstrap.credential("cloudbox", {
          kind: "password",
          value: "one-time-private-value",
        });
        expect((yield* bootstrap.reconcile("cloudbox", doc).pipe(Effect.flip)).message).toContain(
          "authentication refused",
        );
        expect(
          Object.values((yield* mesh.read).document).some((entry) =>
            JSON.stringify(entry.v).includes("one-time-private-value"),
          ),
        ).toBe(false);
        expect(calls[0]?.args).toContain("StrictHostKeyChecking=yes");
        expect(calls[0]?.args).not.toContain("StrictHostKeyChecking=accept-new");
        expect(calls[0]?.args).toContain("PubkeyAuthentication=no");
        expect(calls[0]?.args).toContain("PreferredAuthentications=password,keyboard-interactive");
        const firstCount = calls.length;
        expect(calls.filter((call) => call.args.at(-1)?.startsWith("uname"))).toHaveLength(1);
        failProbe = false;
        yield* bootstrap.reconcile("cloudbox", doc);
        expect(
          calls.slice(firstCount).every((call) => call.env?.T3_BOOTSTRAP_PASSWORD === undefined),
        ).toBe(true);
        expect(downloads).toBe(1);
        expect((yield* mesh.read).document["mesh.machineBinding/cloudbox"]?.v).toBe("cloudbox-id");
        const before = calls.length;
        yield* bootstrap.reconcile("cloudbox", doc);
        expect(calls.length).toBe(before);
        expect(
          (yield* mesh.read).document["mesh.bootstrapStatus/cloudbox/studio/bind"]?.v,
        ).toMatchObject({ state: "done" });
        expect(calls.find((call) => call.stdin)?.stdin).toBe(
          Buffer.from("verified archive").toString("base64"),
        );
      }).pipe(
        Effect.provide(
          Bootstrap.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Layout.layerTest("studio", DEFAULT_SIDEBAR_WORKSPACES_CONFIG),
                ServerConfig.layerTest(root, root),
                Layer.succeed(ProcessRunner, {
                  run: (input) =>
                    Effect.sync(() => {
                      calls.push(input);
                      const command = input.args.at(-1)!;
                      if (command.includes("--version")) return result("t3 v0.1.5\n");
                      if (command.startsWith("uname"))
                        return failProbe
                          ? result("", 255)
                          : result("Linux\nx86_64\n/home/studio\n");
                      if (command.includes("test ! -f"))
                        return result(installed ? "installed" : "");
                      if (input.stdin) {
                        installed = true;
                        return result();
                      }
                      if (command.includes("'pair'"))
                        return result("Token: private-pairing-token\n");
                      return result();
                    }),
                }),
                Layer.succeed(MeshRuntimeArchive, {
                  download: () =>
                    Effect.sync(() => {
                      downloads++;
                      return Buffer.from("verified archive");
                    }),
                }),
                Layer.mock(PeerLinks)({
                  link: (input) =>
                    Effect.sync(() => {
                      expect(input.pairingCode).toBe("private-pairing-token");
                      expect(input.url).toBe("https://cloudbox.example/");
                      return {
                        environmentId: EnvironmentId.make("cloudbox-id"),
                        label: "Cloudbox",
                        urls: [input.url],
                        access: "full-access" as const,
                        linkedAt: DateTime.makeUnsafe(0),
                        expiresAt: DateTime.makeUnsafe(99999999),
                        lastReachedAt: null,
                        lastError: null,
                      };
                    }),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it("refuses embedded passwords, flags, malformed ports and accepts IPv6 SSH targets", () => {
  for (const ssh of [
    "user:password@host",
    "-oProxyCommand=bad",
    "user@host:99999",
    "user@host\nother",
  ])
    expect(() => Bootstrap.bootstrapTarget(ssh)).toThrow();
  expect(Bootstrap.bootstrapTarget("studio@[::1]:2222")).toMatchObject({
    host: "[::1]",
    port: 2222,
  });
});
