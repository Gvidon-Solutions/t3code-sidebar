import {
  installAppUpdateChecks,
  flushPendingAppUpdateWrites,
  runAppUpdateCheck,
} from "./app-updates";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { verifiedNativeUpdate } from "./native-update-verification";
import { installVerifiedApk } from "./verified-apk";
import { AppState, Platform } from "react-native";
import * as Dialog from "../../components/ui/Dialog";

const ROLLBACK_KEY = "t3.mobileUpdateRollbackFrom";
const updateUrl = () => {
  const value: unknown = Constants.expoConfig?.extra?.mobileUpdateUrl;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export async function rollbackMobileBundle() {
  if (!Updates.isEnabled || !updateUrl() || !Updates.updateId)
    throw new Error("No downloaded mobile bundle is running");
  const previousSelection = await AsyncStorage.getItem(ROLLBACK_KEY);
  Updates.setUpdateRequestHeadersOverride({
    "t3-update-selection": "previous",
    "t3-rollback-from": Updates.updateId,
  });
  try {
    const result = await Updates.fetchUpdateAsync();
    if (!result.isNew) throw new Error("No previous compatible bundle is available");
    await AsyncStorage.setItem(ROLLBACK_KEY, Updates.updateId);
    await flushPendingAppUpdateWrites();
    await Updates.reloadAsync();
  } catch (error) {
    Updates.setUpdateRequestHeadersOverride(
      previousSelection
        ? { "t3-update-selection": "previous", "t3-rollback-from": previousSelection }
        : null,
    );
    if (previousSelection) await AsyncStorage.setItem(ROLLBACK_KEY, previousSelection);
    else await AsyncStorage.removeItem(ROLLBACK_KEY);
    throw error;
  }
}

export async function resumeLatestMobileBundle() {
  await AsyncStorage.removeItem(ROLLBACK_KEY);
  Updates.setUpdateRequestHeadersOverride(null);
  const result = await Updates.fetchUpdateAsync();
  if (result.isNew) {
    await flushPendingAppUpdateWrites();
    await Updates.reloadAsync();
  }
}

export function installSelfHostedUpdateStatus() {
  const url = updateUrl();
  if (!url || !Updates.isEnabled) return installAppUpdateChecks();
  let disposeUpdateChecks: () => void = () => undefined;
  let disposed = false;
  let initialized = false;
  let checking = false;
  let notified = false;
  const check = async () => {
    if (checking || disposed) return;
    checking = true;
    try {
      const response = await fetch(new URL("/api/mobile-updates/status", url).href, {
        headers: {
          "expo-platform": Platform.OS,
          "expo-runtime-version": Updates.runtimeVersion ?? "",
        },
      });
      if (!response.ok) throw new Error(`Mobile update status returned ${response.status}`);
      const status: unknown = await response.json();
      if (
        !disposed &&
        !notified &&
        typeof status === "object" &&
        status !== null &&
        "requiresNativeUpdate" in status &&
        status.requiresNativeUpdate === true
      ) {
        notified = true;
        const certificate: unknown = Constants.expoConfig?.extra?.mobileUpdateCertificate;
        const apk =
          typeof certificate === "string"
            ? verifiedNativeUpdate(status, url, certificate, Updates.runtimeVersion ?? "")
            : undefined;
        Dialog.alert(
          "Update the app",
          "This update needs a newer app installation.",
          apk
            ? [
                { text: "Later", style: "cancel" },
                {
                  text: "Download app",
                  onPress: () => {
                    void installVerifiedApk(apk).catch((error) =>
                      Dialog.alert("Could not open download", String(error)),
                    );
                  },
                },
              ]
            : undefined,
        );
      }
    } catch (error) {
      console.warn("[mobile-updates] status check failed", error);
    } finally {
      checking = false;
    }
  };
  void AsyncStorage.getItem(ROLLBACK_KEY)
    .then((from) => {
      if (disposed) return;
      if (from)
        Updates.setUpdateRequestHeadersOverride({
          "t3-update-selection": "previous",
          "t3-rollback-from": from,
        });
      initialized = true;
      disposeUpdateChecks = installAppUpdateChecks();
      void check();
    })
    .catch((error) =>
      console.warn("[mobile-updates] rollback selection could not be restored", error),
    );
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      void check();
      if (initialized) void runAppUpdateCheck();
    }
  });
  return () => {
    disposed = true;
    subscription.remove();
    disposeUpdateChecks();
  };
}

export const hasSelfHostedUpdates = () => Boolean(updateUrl() && Updates.isEnabled);
