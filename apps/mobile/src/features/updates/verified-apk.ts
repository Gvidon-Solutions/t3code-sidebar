import { File, Paths } from "expo-file-system";
import { getContentUriAsync } from "expo-file-system/legacy";
import { startActivityAsync } from "expo-intent-launcher";
import forge from "node-forge";
import type { VerifiedApk } from "./native-update-verification";

export async function installVerifiedApk(apk: VerifiedApk): Promise<void> {
  const destination = new File(Paths.cache, `update-${apk.sha256}.apk`);
  if (destination.exists) destination.delete();
  const downloaded = await File.downloadFileAsync(apk.apkUrl, destination);
  try {
    const handle = downloaded.open();
    const digest = forge.md.sha256.create();
    try {
      for (;;) {
        const chunk = await handle.readBytes(1024 * 1024);
        if (chunk.length === 0) break;
        digest.update(forge.util.binary.raw.encode(chunk));
      }
    } finally {
      handle.close();
    }
    if (digest.digest().toHex() !== apk.sha256) throw new Error("APK SHA-256 verification failed");
    await startActivityAsync("android.intent.action.VIEW", {
      data: await getContentUriAsync(downloaded.uri),
      flags: 1,
      type: "application/vnd.android.package-archive",
    });
  } catch (error) {
    if (downloaded.exists) downloaded.delete();
    throw error;
  }
}
