import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { meshServicePlan } from "../platform/ServerPlatform.ts";
import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import * as Install from "./MeshInstall.ts";
const success: ProcessRunOutput = {
  code: 0 as ProcessRunOutput["code"],
  stdout: "",
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};
it.effect(
  "installs a root/user service idempotently and preserves existing settings and runtime selection",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "B1-install-" });
      const calls: { command: string; args: readonly string[] }[] = [];
      const service = yield* Install.MeshInstall.pipe(
        Effect.provide(Install.layer),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.UserId, 1000),
        Effect.provideService(HostProcess.Username, "studio"),
        Effect.provideService(HostProcess.ExecutablePath, "/runtime/t3"),
        Effect.provideService(ProcessRunner, {
          run: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return success;
            }),
        }),
      );
      yield* fs.makeDirectory(`${home}/state/userdata`, { recursive: true });
      yield* fs.writeFileString(`${home}/state/userdata/settings.json`, '{"custom":"keep"}');
      yield* service.install({ version: "0.1.5", port: 3799, baseDir: `${home}/state` });
      yield* service.install({ version: "0.1.6", port: 3799, baseDir: `${home}/state` });
      expect(yield* fs.readFileString(`${home}/state/runtime/service-state.json`)).toContain(
        '"activeVersion":"0.1.5"',
      );
      expect(yield* fs.readFileString(`${home}/state/userdata/settings.json`)).toContain(
        '"custom":"keep"',
      );
      expect(calls.some((c) => c.command === "loginctl" && c.args.includes("studio"))).toBe(true);
      expect(
        calls.filter((c) => c.command === "systemctl").every((c) => c.args[0] === "--user"),
      ).toBe(true);
      expect(yield* fs.readFileString(`${home}/.config/systemd/user/t3-mesh.service`)).toContain(
        "__service-launcher",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it("plans root systemd, a launchd agent and a real Windows SCM host without a Unix shell dependency", () => {
  const base = {
    home: "/home/studio",
    baseDir: "/home/studio/state",
    executable: "/runtime/t3",
    uid: 0,
    user: "root",
  };
  const linux = meshServicePlan({ ...base, platform: "linux" });
  expect(linux.files[0]?.path).toBe("/etc/systemd/system/t3-mesh.service");
  expect(linux.commands.some((c) => c.command === "loginctl")).toBe(false);
  const mac = meshServicePlan({ ...base, platform: "darwin", uid: 501 });
  expect(mac.files[0]?.content).toContain("<key>KeepAlive</key>");
  expect(mac.commands[0]?.args).toContain("gui/501");
  const windows = meshServicePlan({
    platform: "win32",
    home: "C:\\Users\\studio",
    baseDir: "C:\\T3",
    executable: "C:\\T3\\t3.exe",
    uid: 0,
    user: "studio",
  });
  const command = Buffer.from(windows.commands[0]!.args.at(-1)!, "base64").toString("utf16le");
  expect(command).toContain("New-Service");
  expect(command).toContain("Add-Type");
  expect(command).toContain("Start-Service");
});

it.effect(
  "executes macOS and Windows service-manager plans through bounded fake processes and reports failures",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const platform of ["darwin", "win32"] as const) {
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "B1-native-service-" });
        const calls: string[] = [];
        let fail = false;
        const service = yield* Install.MeshInstall.pipe(
          Effect.provide(Install.layer),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.UserId, 501),
          Effect.provideService(HostProcess.Username, "studio"),
          Effect.provideService(HostProcess.ExecutablePath, "/runtime/t3"),
          Effect.provideService(ProcessRunner, {
            run: (input) =>
              Effect.sync(() => {
                calls.push(input.command);
                expect(input.timeout).toBeDefined();
                return { ...success, code: (fail ? 1 : 0) as ProcessRunOutput["code"] };
              }),
          }),
        );
        yield* service.install({ version: "0.1.5", port: 3799, baseDir: `${home}/state` });
        expect(calls).toContain(platform === "darwin" ? "launchctl" : "powershell.exe");
        fail = true;
        expect(
          (yield* service
            .install({ version: "0.1.5", port: 3799, baseDir: `${home}/state` })
            .pipe(Effect.flip)).message,
        ).toContain("Service manager");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
