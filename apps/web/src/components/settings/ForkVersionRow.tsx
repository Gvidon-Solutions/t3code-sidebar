import type { DesktopForkRelease } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { APP_VERSION } from "../../branding";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NEWEST = "newest";

const releaseDate = (iso: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

/**
 * Settings → Version (sidebar fork): pick any published build of the fork,
 * older ones included. The pick becomes the available update, so the Version
 * row above downloads and installs it. Takes the place of upstream's update
 * track, which the fork does not publish.
 */
export function ForkVersionRow() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.forkReleases;
  const updateState = useDesktopUpdateState();
  const [releases, setReleases] = useState<readonly DesktopForkRelease[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists the fork's desktop releases through the Electron bridge
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .list()
      .then((next) => {
        if (!cancelled) setReleases(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge) return null;

  const newest = releases?.[0];
  const offered = updateState?.downloadedVersion ?? updateState?.availableVersion ?? null;
  const pinned = releases?.find(
    (release) => release.version === offered && release.tag !== newest?.tag,
  );
  const value = pinned?.tag ?? NEWEST;

  const choose = async (tag: string) => {
    if (pending || tag === value) return;
    const release = releases?.find((entry) => entry.tag === tag);
    if (release) {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Switch to T3 Code Sidebar ${release.version}?\n\n` +
          "It becomes the available update: download and install it from the Version row. " +
          "A build older than the one that last ran may not read data written by newer builds.",
      );
      if (!confirmed) return;
    }
    setPending(true);
    void bridge
      .select(tag === NEWEST ? null : tag)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not switch version",
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
      })
      .finally(() => setPending(false));
  };

  const description = loadError
    ? `Could not list versions: ${loadError}`
    : pinned
      ? `Picked ${pinned.version}. Download and install it above, or pick Newest to follow updates again.`
      : "Install any published version, older ones included.";

  return (
    <SettingsRow
      {...searchableSetting("update-track")}
      title="Version history"
      description={description}
      control={
        <Select
          value={value}
          onValueChange={(next) => {
            if (typeof next === "string") void choose(next);
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-48"
            aria-label="Version history"
            disabled={pending || releases === null}
          >
            <SelectValue>{pinned ? pinned.version : "Newest"}</SelectValue>
          </SelectTrigger>
          <SelectPopup
            align="end"
            alignItemWithTrigger={false}
            className="max-h-[min(20rem,var(--available-height))]"
          >
            <SelectItem hideIndicator value={NEWEST}>
              Newest
            </SelectItem>
            {releases?.map((release) => (
              <SelectItem
                hideIndicator
                key={release.tag}
                value={release.tag}
                disabled={release.version === APP_VERSION}
              >
                {release.version}
                <span className="text-muted-foreground">
                  {release.version === APP_VERSION ? " · installed" : ""} ·{" "}
                  {releaseDate(release.publishedAt)}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
