import { expect, it } from "@effect/vitest";
import { mutagenSshEnvironment, nodeCommand, sshArguments, sshWrapper } from "./ReplicaPlatform.ts";
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
    HOME: "C:\\Studio",
    USERPROFILE: "C:\\Studio",
  });
  expect(mutagenSshEnvironment("linux", "/studio", "/state/mutagen")).toEqual({
    MUTAGEN_SSH_PATH: "/state/mutagen/../mesh/ssh/bin",
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
  expect(command).toContain(Buffer.from(source).toString("base64"));
});
