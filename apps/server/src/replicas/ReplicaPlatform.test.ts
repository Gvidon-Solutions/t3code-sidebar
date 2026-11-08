import {
  windowsSshWrapperInstall,
  bootstrapAskpass,
  bootstrapFacts,
  bootstrapRemoteRuntime,
} from "../platform/ServerPlatform.ts";
import { expect, it } from "@effect/vitest";
import {
  executableName,
  mutagenTarget,
  agentSkillDirectories,
  mutagenSshEnvironment,
  nodeCommand,
  sshArguments,
  sshWrapper,
} from "../platform/ServerPlatform.ts";
it("builds the same bounded SSH command on Windows and POSIX with an explicit isolated home", () => {
  for (const home of ["/tmp/studio home", "C:\\Users\\Studio Home"]) {
    const args = sshArguments("t3-studio", home);
    expect(args.slice(0, 2)).toEqual(["-F", `${home}/.ssh/config`]);
    expect(args).toContain("ConnectTimeout=10");
    expect(args.at(-1)).toBe("t3-studio");
  }
  for (const host of ["-oProxyCommand=bad", "studio\nHost *", ""])
    expect(() => sshArguments(host)).toThrow();
});
it("isolates Mutagen's ssh/scp on POSIX and OpenSSH's profile on Windows", () => {
  expect(mutagenSshEnvironment("win32", "C:\\Studio", "C:\\State\\mutagen")).toEqual({
    MUTAGEN_SSH_PATH: "C:\\State\\mesh\\ssh\\bin",
  });
  expect(mutagenSshEnvironment("linux", "/studio", "/state/mutagen")).toEqual({
    MUTAGEN_SSH_PATH: "/state/mesh/ssh/bin",
  });
  expect(mutagenSshEnvironment("darwin", undefined, "/state")).toEqual({});
  for (const program of ["ssh", "scp"] as const) {
    const wrapper = sshWrapper("linux", "/runtime/t3", "/studio home/.ssh/config", program);
    expect(wrapper.name).toBe(program);
    expect(wrapper.contents).toContain(`exec ${program} -F '/studio home/.ssh/config' "$@"`);
    expect(
      sshWrapper("win32", "C:\\t3.exe", "C:\\Studio\\.ssh\\config", program).contents,
    ).toContain("exit /b %ERRORLEVEL%");
  }
});
it("encodes remote scripts without interpolating their quotes, paths or shell expansions", () => {
  const source = "const root = 'C:\\\\Studio'; console.log('$HOME');";
  const command = nodeCommand(source);
  expect(command).not.toContain("$HOME");
  expect(command).toContain('exec "$SHELL" -lc');
  expect(nodeCommand(source, "win32")).toContain("powershell.exe -NoLogo -EncodedCommand");
  expect(command).toContain(Buffer.from(source).toString("base64"));
});

it("selects runtime binary names, Mutagen releases and skill paths across server platforms", () => {
  for (const [platform, arch, expected] of [
    ["linux", "x64", "linux_amd64"],
    ["darwin", "arm64", "darwin_arm64"],
    ["win32", "x64", "windows_amd64"],
  ] as const) {
    expect(mutagenTarget(platform, arch)).toBe(expected);
    expect(executableName("mutagen", platform)).toBe(
      platform === "win32" ? "mutagen.exe" : "mutagen",
    );
  }
  expect(agentSkillDirectories("C:\\Users\\studio", "win32")[0]).toBe(
    "C:\\Users\\studio\\.agents\\skills\\t3",
  );
  expect(agentSkillDirectories("/Users/studio", "darwin")[0]).toBe(
    "/Users/studio/.agents/skills/t3",
  );
});

it("uses native Windows executable transports and askpass without putting a password in helper source", () => {
  const commands = windowsSshWrapperInstall("C:\\State\\bin", "C:\\Studio\\.ssh\\config");
  expect(commands).toHaveLength(2);
  for (const command of commands) {
    const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
    const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
    expect(encoded).toBeDefined();
    const source = Buffer.from(encoded!, "base64").toString();
    expect(source).toContain("System32\\OpenSSH");
    expect(source).toContain('new StringBuilder("-F ")');
    expect(source).toContain("child.ExitCode");
  }
  const askpass = bootstrapAskpass("win32", "C:\\Private");
  expect(askpass.name).toBe("askpass.exe");
  expect(askpass.command?.command).toBe("powershell.exe");
  expect(bootstrapFacts("Darwin\narm64\n/Users/studio\n", false)).toEqual({
    platform: "darwin",
    arch: "arm64",
    home: "/Users/studio",
  });
  expect(bootstrapFacts("C:\\Users\\studio\nAMD64\n", true)).toEqual({
    platform: "win32",
    arch: "x64",
    home: "C:\\Users\\studio",
  });
  expect(() => bootstrapRemoteRuntime("win32", "C:\\Users\\studio", "1.2.3", "relative")).toThrow();
});
