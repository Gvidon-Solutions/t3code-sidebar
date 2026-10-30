import Constants from "expo-constants";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { openAttachmentInViewer } from "../../lib/attachmentDownload";
import { SettingsSection } from "./components/SettingsSection";
import { compareForkVersionsNewestFirst, downloadPercent } from "./forkVersions";

interface ForkApkRelease {
  readonly version: string;
  readonly publishedAt: string;
  readonly apkUrl: string;
  readonly apkName: string;
}

const RELEASE_TAG = /^sidebar-v(\d+\.\d+\.\d+-sidebar\.\d+)$/;

async function listForkApkReleases(repo: string, signal: AbortSignal): Promise<ForkApkRelease[]> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const releases = (await response.json()) as ReadonlyArray<{
    tag_name: string;
    draft: boolean;
    published_at: string | null;
    assets: ReadonlyArray<{ name: string; browser_download_url: string }>;
  }>;
  const apks = releases.flatMap((release) => {
    const version = RELEASE_TAG.exec(release.tag_name)?.[1];
    const apk = release.assets.find((asset) => asset.name.endsWith(".apk"));
    return !release.draft && version && apk
      ? [
          {
            version,
            publishedAt: release.published_at ?? "",
            apkUrl: apk.browser_download_url,
            apkName: apk.name,
          },
        ]
      : [];
  });
  // GitHub lists releases in its own order (an edited release can jump ahead).
  return apks.sort((left, right) => compareForkVersionsNewestFirst(left.version, right.version));
}

/**
 * Settings › About › Version history (sidebar fork): every published fork APK,
 * older ones included. All fork builds share one version code, so Android
 * installs any of them over the current one and keeps the app's data.
 */
export function ForkVersionHistorySection() {
  const repo = Constants.expoConfig?.extra?.forkReleaseRepo as string | null | undefined;
  const installedVersion = Constants.expoConfig?.version ?? "";
  const [releases, setReleases] = useState<ReadonlyArray<ForkApkRelease> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The APK being downloaded and how far along it is (null percent: size unknown).
  const [download, setDownload] = useState<{
    readonly version: string;
    readonly percent: number | null;
  } | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const installing = download?.version ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the fork's APK releases from GitHub with an abortable request
  useEffect(() => {
    if (!repo) return;
    const controller = new AbortController();
    listForkApkReleases(repo, controller.signal)
      .then(setReleases)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Unavailable");
      });
    return () => controller.abort();
  }, [repo]);

  if (!repo) return null;

  const install = (release: ForkApkRelease) => {
    if (installing === release.version) {
      downloadController.current?.abort();
      return;
    }
    if (installing !== null) return;
    Alert.alert(
      `Install ${release.version}?`,
      "The APK downloads and Android's installer opens. Your connections stay. A build older than the server may miss newer features.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Install",
          onPress: () => {
            const controller = new AbortController();
            downloadController.current = controller;
            setDownload({ version: release.version, percent: null });
            void openAttachmentInViewer({
              uri: release.apkUrl,
              attachment: {
                name: release.apkName,
                mimeType: "application/vnd.android.package-archive",
              },
              signal: controller.signal,
              onProgress: (progress) => {
                const percent = downloadPercent(progress);
                setDownload((current) =>
                  current?.version === release.version && current.percent !== percent
                    ? { version: release.version, percent }
                    : current,
                );
              },
            })
              .catch((cause: unknown) => {
                if (controller.signal.aborted) return;
                Alert.alert(
                  "Install failed",
                  cause instanceof Error ? cause.message : String(cause),
                );
              })
              .finally(() => {
                if (downloadController.current === controller) downloadController.current = null;
                setDownload(null);
              });
          },
        },
      ],
    );
  };

  return (
    <SettingsSection title="Version history">
      {error ? (
        <Text className="p-4 text-sm text-foreground-muted">Could not list versions: {error}</Text>
      ) : releases === null ? (
        <Text className="p-4 text-sm text-foreground-muted">Loading versions…</Text>
      ) : releases.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">No APK releases yet.</Text>
      ) : (
        releases.map((release, index) => {
          const installed = release.version === installedVersion;
          const downloading = download?.version === release.version ? download : null;
          return (
            <Pressable
              key={release.version}
              accessibilityRole="button"
              accessibilityHint={downloading ? "Cancels the download" : undefined}
              disabled={installed || (installing !== null && downloading === null)}
              onPress={() => install(release)}
              testID={`fork-version-${release.version}`}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <View className="flex-row items-center gap-3 px-4 py-3">
                <Text className="flex-1 text-base text-foreground">
                  {release.version}
                  {index === 0 ? "  · newest" : ""}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {downloading
                    ? downloading.percent === null
                      ? "Downloading…"
                      : `Downloading ${downloading.percent}%`
                    : installed
                      ? "Installed"
                      : release.publishedAt.slice(0, 10)}
                </Text>
              </View>
              {downloading ? (
                <View className="mx-4 mb-2 h-1 overflow-hidden rounded-full bg-subtle-strong">
                  <View
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${downloading.percent ?? 0}%` }}
                  />
                </View>
              ) : null}
            </Pressable>
          );
        })
      )}
    </SettingsSection>
  );
}
