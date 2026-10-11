// Sidebar fork: lists this fork's published desktop builds and points the
// updater at one of them, so the user can move to any version, older included.
import {
  DESKTOP_FORK_RELEASE_TAG_PATTERN,
  type DesktopForkRelease,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

export class DesktopForkReleasesError extends Schema.TaggedError<DesktopForkReleasesError>()(
  "DesktopForkReleasesError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    published_at: Schema.NullOr(Schema.String),
    assets: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));

const RELEASE_INDEX_TIMEOUT = Duration.seconds(20);

/** The updater manifest a release must carry for this platform to install it. */
export function updateManifestName(platform: NodeJS.Platform): string {
  if (platform === "linux") return "latest-linux.yml";
  if (platform === "darwin") return "latest-mac.yml";
  return "latest.yml";
}

/** Installable fork releases from GitHub's release index, newest first. */
export function forkReleasesFromIndex(
  index: typeof ReleaseIndex.Type,
  platform: NodeJS.Platform,
): DesktopForkRelease[] {
  const manifest = updateManifestName(platform);
  return index
    .filter(
      (release) =>
        !release.draft &&
        DESKTOP_FORK_RELEASE_TAG_PATTERN.test(release.tag_name) &&
        release.assets.some((asset) => asset.name === manifest),
    )
    .map((release) => ({
      tag: release.tag_name,
      version: release.tag_name.slice("sidebar-v".length),
      publishedAt: release.published_at ?? "",
    }))
    .toSorted((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/** GitHub `owner/repo` of the app's own update feed (app-update.yml). */
const readFeedRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fileSystem
    .readFileString(environment.appUpdateYmlPath, "utf-8")
    .pipe(Effect.orElseSucceed(() => ""));
  const field = (key: string) => raw.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "m"))?.[1];
  const owner = field("owner");
  const repo = field("repo");
  if (field("provider") !== "github" || !owner || !repo) {
    return yield* new DesktopForkReleasesError({
      reason: "This build has no GitHub update feed to pick versions from.",
    });
  }
  return { owner, repo };
});

export const list = Effect.fn("desktop.forkReleases.list")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const { owner, repo } = yield* readFeedRepository;
  const body = yield* httpClient
    .execute(
      HttpClientRequest.get(
        `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
      ).pipe(HttpClientRequest.setHeader("Accept", "application/vnd.github+json")),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.mapError(() => new DesktopForkReleasesError({ reason: "Could not list releases." })),
      Effect.timeoutOrElse({
        duration: RELEASE_INDEX_TIMEOUT,
        orElse: () =>
          Effect.fail(new DesktopForkReleasesError({ reason: "Listing releases timed out." })),
      }),
    );
  const index = yield* decodeReleaseIndex(body).pipe(
    Effect.mapError(
      () => new DesktopForkReleasesError({ reason: "The release list had an unexpected shape." }),
    ),
  );
  return forkReleasesFromIndex(index, environment.platform);
});

/** Points the updater at one release (or back at the newest) and checks it. */
export const select = Effect.fn("desktop.forkReleases.select")(function* (
  tag: string | null,
): Effect.fn.Return<
  DesktopUpdateState,
  DesktopForkReleasesError | DesktopUpdates.DesktopUpdateActionInProgressError,
  DesktopUpdates.DesktopUpdates | DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem
> {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  if (tag === null) return yield* updates.followFeed(null);
  if (!DESKTOP_FORK_RELEASE_TAG_PATTERN.test(tag)) {
    return yield* new DesktopForkReleasesError({ reason: `Not a release tag: ${tag}` });
  }
  const { owner, repo } = yield* readFeedRepository;
  return yield* updates.followFeed(`https://github.com/${owner}/${repo}/releases/download/${tag}`);
});
