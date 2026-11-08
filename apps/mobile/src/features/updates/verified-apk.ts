import { File, Paths } from "expo-file-system";
import { getContentUriAsync } from "expo-file-system/legacy";
import { Linking } from "react-native";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { VerifiedApk } from "./native-update-verification";

export async function installVerifiedApk(apk: VerifiedApk): Promise<void> {
  const destination = new File(Paths.cache, `update-${apk.sha256}.apk`);
  if (destination.exists) destination.delete();
  const downloaded = await File.downloadFileAsync(apk.apkUrl, destination);
  try {
    const handle = downloaded.open();
    const digest = sha256.create();
    try {
      for (;;) {
        const chunk = await handle.readBytes(1024 * 1024);
        if (chunk.length === 0) break;
        digest.update(chunk);
      }
    } finally {
      handle.close();
    }
    if (bytesToHex(digest.digest()) !== apk.sha256)
      throw new Error("APK SHA-256 verification failed");
    await Linking.openURL(await getContentUriAsync(downloaded.uri));
  } catch (error) {
    if (downloaded.exists) downloaded.delete();
    throw error;
  }
}
