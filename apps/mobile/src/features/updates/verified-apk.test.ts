import { expect, it, vi } from "vite-plus/test";
import { installVerifiedApk } from "./verified-apk";
import { File } from "expo-file-system";
import { startActivityAsync } from "expo-intent-launcher";

vi.mock("expo-file-system", () => ({
  Paths: { cache: "/cache" },
  File: class {
    exists = false;
    static downloadFileAsync = vi.fn();
  },
}));
vi.mock("expo-file-system/legacy", () => ({
  getContentUriAsync: vi.fn(async () => "content://verified-apk"),
}));
vi.mock("expo-intent-launcher", () => ({ startActivityAsync: vi.fn() }));

it("refuses corrupt APK bytes before opening the installer and removes the download", async () => {
  vi.clearAllMocks();
  const remove = vi.fn();
  const close = vi.fn();
  const apk = {
    platform: "android" as const,
    runtimeVersion: "next",
    apkUrl: "https://updates.example/app.apk",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  };
  const downloaded = (text: string) => {
    let read = false;
    return {
      uri: "file:///cache/update.apk",
      exists: true,
      delete: remove,
      open: () => ({
        close,
        readBytes: async () => {
          if (read) return new Uint8Array();
          read = true;
          return new TextEncoder().encode(text);
        },
      }),
    };
  };
  vi.mocked(File.downloadFileAsync).mockResolvedValueOnce(downloaded("corrupt") as unknown as File);
  await expect(installVerifiedApk(apk)).rejects.toThrow("SHA-256");
  expect(remove).toHaveBeenCalledOnce();
  expect(startActivityAsync).not.toHaveBeenCalled();
  vi.mocked(File.downloadFileAsync).mockResolvedValueOnce(downloaded("abc") as unknown as File);
  await installVerifiedApk(apk);
  expect(startActivityAsync).toHaveBeenCalledWith("android.intent.action.VIEW", {
    data: "content://verified-apk",
    flags: 1,
    type: "application/vnd.android.package-archive",
  });
  expect(close).toHaveBeenCalledTimes(2);
});
