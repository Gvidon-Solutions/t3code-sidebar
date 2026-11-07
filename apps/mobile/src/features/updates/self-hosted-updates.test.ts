import { expect, it, vi } from "vite-plus/test";
import * as Updates from "expo-updates";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { rollbackMobileBundle, resumeLatestMobileBundle } from "./self-hosted-updates";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: { mobileUpdateUrl: "https://studio.example/api/mobile-updates/manifest" },
    },
  },
}));
vi.mock("expo-updates", () => ({
  isEnabled: true,
  updateId: "current-bundle",
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
  setUpdateRequestHeadersOverride: vi.fn(),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("react-native", () => ({ AppState: {}, Linking: {}, Platform: { OS: "android" } }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./app-updates", () => ({ installAppUpdateChecks: vi.fn() }));

it("pins rollback to the bundle being replaced and restores latest selection after a failed rollback", async () => {
  vi.clearAllMocks();
  vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  vi.mocked(Updates.fetchUpdateAsync).mockResolvedValue({
    isNew: false,
    manifest: undefined,
    isRollBackToEmbedded: false,
  });
  await expect(rollbackMobileBundle()).rejects.toThrow("No previous compatible bundle");
  expect(Updates.reloadAsync).not.toHaveBeenCalled();
  expect(Updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
  vi.mocked(Updates.fetchUpdateAsync).mockResolvedValue({
    isNew: true,
    isRollBackToEmbedded: false,
    manifest: { id: "previous", commitTime: 1, assets: [] },
  });
  await rollbackMobileBundle();
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    "t3.mobileUpdateRollbackFrom",
    "current-bundle",
  );
  expect(Updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith({
    "t3-update-selection": "previous",
    "t3-rollback-from": "current-bundle",
  });
  expect(Updates.reloadAsync).toHaveBeenCalledOnce();
  await resumeLatestMobileBundle();
  expect(Updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith("t3.mobileUpdateRollbackFrom");
});
