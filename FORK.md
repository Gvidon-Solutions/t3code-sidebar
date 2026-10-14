# T3 Code Sidebar — fork notes and feature log

This repository is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code),
maintained alongside upstream. It adds a workspace sidebar and thread tabs and ships its own
desktop and Android builds ("T3 Code Sidebar") that install next to upstream T3 Code.
Everything else is upstream.

## How the fork is kept

- **Remotes.** `origin` is `Gvidon-Solutions/t3code-sidebar`, `upstream` is `pingdotgg/t3code`.
- **Branches.** Fork work lives on `ws`. `main` mirrors upstream and is not used for fork work.
- **Syncing.** Merge `upstream/main` into `ws` (no rebases of published history). Fork code is
  kept in its own files so merges stay small; the seams into upstream files are listed per
  feature below. Re-check those seams after every upstream merge.
- **No upstream PRs** from this fork unless the owner asks for one.
- **Tests.** The packaging tests assert the fork's app name, id and missing URL schemes; upstream
  CI does not run here (it triggers on `main`).

## Relation to upstream

- **Base.** Last synced with upstream `main` at `9e552285ba` on 2026-10-12 (merge into `ws`).
  Upstream's open PR #14865 (voice conversations) is merged in on top; see the feature log. Fork builds report
  upstream's version plus `-sidebar.<run>`.
- **Footprint in upstream files.** Small, about 16 files and 70 lines: the settings schema
  key, the shared-settings list, the sidebar switch in `AppSidebarLayout.tsx`, one Settings
  row, desktop identity and WSL paths, and the artifact build script. Everything else is in
  fork-only files. Run `git diff $(git merge-base ws upstream/main) ws --stat` to see it.
- **What is replaced, what is reused.** The workspace sidebar is a third sidebar next to
  upstream's two: upstream `Sidebar` and `LegacySidebar` are untouched, and the setting
  picks which one shows. The fork reuses upstream's thread data, statuses, actions, menus,
  keybindings and project icons. Server logic added: one settings key, and a subagent thread's
  status read from its root node (see the 2026-10-13 entry). Projects,
  threads, providers and the server run upstream code unchanged.
- **Mobile.** The Android app is upstream's `apps/mobile` built as a fourth variant
  (`APP_VARIANT=sidebar`) next to upstream's development/preview/production. Its fork
  features live in `apps/mobile/src/features/{workspaces,tabs,panels}/`; workspace rules are shared
  with web through `packages/client-runtime/src/state/sidebarWorkspaces.ts`. iOS is not built.

## Identity (Android)

|            | Upstream (production)  | Fork                                                    |
| ---------- | ---------------------- | ------------------------------------------------------- |
| App name   | T3 Code                | T3 Code Sidebar                                         |
| Package    | upstream's store id    | `com.gvidon.t3codesidebar`                              |
| URL scheme | `t3code://`            | `t3code-sidebar://`                                     |
| Signing    | Play / EAS             | fork key (`T3_ANDROID_*` secrets in CI)                 |
| Version    | store version          | `versionName` = release version, `versionCode` always 1 |
| Updates    | Play Store, EAS Update | APKs on this fork's releases; EAS Update off            |

The constant version code lets Android install any fork APK over any other, older ones
included, keeping the app's data. Changed in `apps/mobile/app.config.ts`
(`VARIANT_CONFIG.sidebar` and sidebar-only branches), `plugins/withAndroidReleaseSigning.cjs`,
the linking prefix in `src/App.tsx` and `src/lib/appLinking.ts`.

## Identity (desktop)

|                          | Upstream             | Fork                              |
| ------------------------ | -------------------- | --------------------------------- |
| Product name             | T3 Code (Alpha)      | T3 Code Sidebar                   |
| App id                   | `com.t3tools.t3code` | `com.gvidon.t3code-sidebar`       |
| Data dir (`T3CODE_HOME`) | `~/.t3`              | `~/.t3-sidebar` (also inside WSL) |
| Electron profile         | `t3code-v2`          | `t3code-sidebar-v2`               |
| `t3code://` handler      | registered           | not registered (left to upstream) |
| Updates                  | upstream releases    | this fork's GitHub releases       |

Changed in `apps/desktop/src/app/{DesktopEnvironment,DesktopStatePaths,DesktopEarlyElectronStartup,DesktopApp,DesktopUserData,DesktopLegacyLocalStorage}.ts`,
`apps/desktop/src/backend/DesktopBackendConfiguration.ts` (WSL `t3Home`),
`apps/desktop/src/wsl/DesktopWslEnvironment.ts` (WSL runtime dir), `apps/desktop/package.json`
and `scripts/build-desktop-artifact.ts` (app id, artifact and `.deb` package names, no URL
schemes, no AppStream metainfo). Windows also gets its own AppUserModelID.

## Releases and deployment

- **Desktop.** `.github/workflows/sidebar-desktop.yml` runs on every push to `ws` (docs and
  `deploy/` excluded): JS bundle → Linux AppImage/deb + Linux CLI archive → Windows NSIS with
  the CLI archive embedded as the WSL runtime → GitHub release `sidebar-v<version>` marked
  latest, with `latest.yml` / `latest-linux.yml`. Version is `<upstream version>-sidebar.<run>`;
  the core stays upstream's so version-skew checks against servers hold. Builds are unsigned.
- **Android.** The same workflow's `android` job prebuilds the sidebar variant, builds a release
  APK signed with the fork key and attaches `T3-Code-Sidebar-<version>.apk` to the release.
  Local builds: source `~/.local/share/t3-ws/android-signing.env`, then
  `APP_VARIANT=sidebar npx expo prebuild --platform android` and `./gradlew assembleRelease`.
  E2E helpers for the emulator are in `scripts/sidebar-mobile-e2e/`.
- **Self-hosted web.** `deploy/t3-ws/` builds a Docker image of `t3 serve` and runs it on the
  owner's VPS behind an SSH tunnel (`deploy.sh`, `open.sh` → `t3-ws` command). Codex only.

## Feature log

Newest first. Each entry: what it does for the user, how it works, where it lives.

### 2026-10-14 — "No project" in every workspace

- **What.** Chats without a project live in one "No project" folder that every workspace shows,
  last, with the same chats: a chat started from any workspace is seen from all of them. It can't
  be moved to a workspace, dragged or folded into quiet projects. The desktop called it "Chats";
  it is "No project" everywhere now.
- **How.** The scratch project gets no workspace. The desktop keeps it as a shared part of the
  sidebar model that each workspace view appends (its pinned and snoozed chats too); the
  all-workspaces view and search show it once. Tiles don't count its activity, so a running chat
  doesn't light every tile. Opening such a chat stays in the open workspace. The phone keeps the
  folder in whichever workspace is open.
- **Where.** `WorkspaceSidebar.tsx` (`SharedModel`, `withShared`, `isSharedThread`, the folder
  menu); `isInCurrentWorkspace` in `apps/mobile/src/features/workspaces/useWorkspaceHome.ts`; the
  folder menu in `WorkspaceChrome.tsx`.

### 2026-10-14 — Fork Claude threads of a moved or renamed project

- **What.** Forking a Claude thread whose project folder was moved or renamed after the thread
  started failed on the first message ("Provider turn failed to start · Claude Agent SDK query
  failed"). Such forks now work like any other; normal turns were never affected.
- **How.** Claude keeps a transcript under the folder the session started in. Resume finds it in
  any project folder, but the SDK's `forkSession` with `dir` looks only under the current folder.
  The Claude adapter now retries the fork without `dir` when that lookup fails, so the SDK
  searches every project folder; the fork lands next to the source transcript, where resume finds
  it.
- **Where.** `forkThread` in `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
  (tests: "forks a session whose transcript stayed under the project's old directory", "reports
  the project-directory miss when no project has the session"). Needs the server running this
  build.

### 2026-10-14 — Removing a project from a workspace sticks

- **What.** Moving a project out of a workspace (or deleting the workspace) left its old
  assignment in the server settings, so the project could jump back. Removed assignments are now
  gone for good, from the app and from agents (`/t3` skill, `t3ctl ws unassign`).
- **How.** Settings patches are deep-merged, which can add record keys but never drop them.
  Clients always send the whole `sidebarWorkspaces` config, so the server now replaces it instead
  of merging it.
- **Where.** Seam: one spread in `applyServerSettingsPatch`, `packages/shared/src/serverSettings.ts` (test: "replaces
  the sidebar workspace config so a removed project assignment does not survive"). Needs the
  server running this build.

### 2026-10-13 — Pin the desktop app to the dock (Linux)

- **What.** On GNOME the running app offered no "Pin to Dash": the dock tied its window to the
  hidden `t3code://` handler entry. The window now belongs to the installed "T3 Code Sidebar"
  entry and can be pinned.
- **How.** Electron 44 names the window after `setDesktopName` (X11 `WM_CLASS`, Wayland
  `app_id` = `com.gvidon.T3CodeSidebar`) and ignores `--class`, while the `.deb`/AppImage entry
  declared `StartupWMClass=t3code-sidebar`. The packaged entry now declares the desktop id as its
  `StartupWMClass`, which docks match before desktop ids, and the `--class` switch uses the same
  value.
- **Where.** `resolveLinuxWmClass` in `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`
  (used by `DesktopEnvironment.ts`); `linux.desktop.entry` in `scripts/build-desktop-artifact.ts`
  (test: "applies platform-specific packaging"). Takes effect once the new `.deb` is installed.

### 2026-10-13 — Agents that still work show as working

- **What.** The agents under a thread showed "done" with green dots while they were still
  running. They now show as working (blue dot, "2 agents · 2 working", group open) until they
  finish, and as failed when they fail.
- **How.** A subagent thread has no runs and no provider session of its own: the provider drives
  it through a runless `root_turn` node, so its shell read idle and its runtime null. The server
  now gives such a thread (subagent lineage, no runs) the status of its newest runless root node,
  in both the SQL snapshot and the in-memory shell; any event on the thread refreshes the shell.
  Clients read that status from the shell when the thread has no runtime.
- **Where.** `subagentShellStatus` and the `runless_root_status` column in
  `apps/server/src/orchestration-v2/ProjectionStore.ts` (tests: "runless subagent's root node
  status"); `agentRunState` in `packages/client-runtime/src/state/threadAgents.ts`. Needs the
  server update; older servers keep the old behaviour.

### 2026-10-13 — Long answers no longer overlap on Android

- **What.** On the phone, a long answer with quotes inside list items came out shorter than its
  text: the copy/fork/time row sat on top of the last lines and the end was cut off. Answers and
  Markdown file previews now get their full height.
- **How.** The GitHub-flavoured Markdown view (react-native-enriched-markdown) sizes itself from an
  estimate built with StaticLayouts before it renders, and that estimate runs short for a quote
  nested in a list item. After laying out its segments the view now compares
  their real height with its frame; when they differ it stores the real height for that width and
  document and asks Yoga to measure again, which then returns it.
- **Where.** `patches/react-native-enriched-markdown@1.2.0-t3.11.patch` (`storeLaidOutHeight` in
  `MeasurementStore.kt`, `reportLaidOutHeight` in `EnrichedMarkdown.kt`), registered in
  `pnpm-workspace.yaml` (`patchedDependencies`, and `allowBuilds` for the patched package). When
  the vendored tgz is bumped, re-create the patch or drop it if upstream fixed the estimate.

### 2026-10-13 — Version history in order, with download progress (Android)

- **What.** Settings › About › Version history lists builds newest first by build number
  (sidebar.14 above sidebar.9), and "newest" marks the real newest. While an APK downloads its row
  shows "Downloading 37%" over a thin bar; tapping the row again cancels. The Version row keeps its
  label whole and wraps a long version on the right.
- **How.** Releases are sorted by version instead of GitHub's order; the download reports
  progress through `File.downloadFileAsync`'s `onProgress`.
- **Where.** `apps/mobile/src/features/settings/forkVersions.ts`, `ForkVersionHistory.tsx`; seams:
  the optional `onProgress` of `openAttachmentInViewer` in `apps/mobile/src/lib/attachmentDownload.ts`,
  the Version row in `SettingsAboutRouteScreen.tsx`.

### 2026-10-12 — Talk to Codex (voice conversations, upstream PR #14865)

- **What.** In a Codex thread, the waveform button in the composer (or F8, or `/voice`) starts a
  live voice conversation. Captions show above the composer; what you ask lands in the thread as a
  message, the agent does the work, and its final answer is read aloud. `/voice` or the button
  again stops it. The voice is picked in Settings › Providers › Codex › Voice. Web, desktop and
  the Android app; in a browser the microphone needs https or localhost. Codex only, and the
  thread needs a started session (send one message first).
- **How.** Upstream's PR #14865 is merged as is, ahead of upstream: audio runs straight between
  the client and OpenAI over WebRTC, and the server only relays SDP, captions and lifecycle over
  the `provider.voice.session` stream (Codex app-server `thread/realtime/*`). Android gains
  `react-native-webrtc` and the microphone permission. Also brings 4 upstream `main` commits.
- **Where.** Upstream code, no fork seams: `apps/server/src/provider/CodexVoice.ts`,
  `packages/client-runtime/src/voice-mode/`, `apps/web/src/voice/`, `VoiceModeStrip.tsx`,
  `apps/mobile/src/features/voice-mode/`, `MainWindowPermissions.ts`;
  `docs/internals/voice-conversations.md`. When upstream lands the PR, the next upstream merge
  takes its final version.

### 2026-10-12 — Agents hang under the thread that launched them

- **What.** A thread's subagents no longer stand in the thread list as ordinary threads. Under
  the thread that launched them sits one line, "5 agents · 4 working", with a coloured dot per
  agent; it opens onto the agents' rows along a guide line. Agents of agents join the same list.
  The group is open while any agent works or needs you and folds away once all are done; a tap
  opens or closes it. Desktop sidebar and phone Home/drawer alike.
- **How.** Subagents are grouped under their top-level thread by `lineage.parentThreadId`; one
  whose top-level thread is not loaded stays an ordinary row on the desktop (the phone hid
  subagents before and still does in that case). Opening an agent opens its group.
- **Where.** `packages/client-runtime/src/state/threadAgents.ts`,
  `apps/web/src/components/workspaces/WorkspaceAgentGroup.tsx`,
  `apps/mobile/src/features/workspaces/agentThreadShells.ts` (Home's navigation list drops subagents,
  so `useWorkspaceHome.ts` adds them back for the grouping); seams: `renderThread` and the
  model in `WorkspaceSidebar.tsx`, the `agent` row variant in `WorkspaceThreadRow.tsx`, `pushAgents`
  in `workspaceNavigator.ts`, `WorkspaceAgentsRow` in `WorkspaceChrome.tsx`, `nested` in
  `WorkspaceThreadLine.tsx` (passed through `compact` in `thread-list-v2-items.tsx`), and the
  `ws-agents` cases in `HomeScreen.tsx` and `WorkspaceDrawer.tsx`.

### 2026-10-12 — Desktop updates you can watch, and that install on Ubuntu

- **What.** While an update downloads, the Version row in Settings and a strip above the
  workspace tiles show its percent. Once downloaded, the strip offers "Restart to update", and a
  failed download or install says why. On a .deb install, Install asks for the system password and
  installs; if that fails, the message gives the `sudo apt install` command for the downloaded
  file. The Version history list is capped in height so it scrolls.
- **How.** electron-updater's own deb install never reached polkit on Ubuntu and reported nothing.
  For a downloaded .deb the app now runs `pkexec dpkg -i <file>` itself, asynchronously, then
  relaunches the way electron-updater would. Download progress reaches the window at every whole
  percent instead of every tenth.
- **Where.** `apps/desktop/src/updates/debInstall.ts`,
  `apps/web/src/components/workspaces/desktopUpdateProgress.ts`, `WorkspaceUpdateStrip.tsx`;
  seams: `quitAndInstall` and `ElectronUpdaterQuitAndInstallError.message` in
  `electron/ElectronUpdater.ts`, `shouldBroadcastDownloadProgress` in `DesktopUpdates.ts`, the
  Version row labels in `SettingsPanels.tsx`, the strip in `WorkspaceSidebar.tsx`.

### 2026-10-12 — Compact new-thread button on the phone

- **What.** The phone's new-thread button stays a small pencil button above the workspace tile
  bar; it no longer unfolds into a wide "New thread" pill.
- **How.** The Android FAB is always rendered collapsed, so it no longer tracks list scrolling.
- **Where.** `AndroidHomeFab.android.tsx`.

### 2026-10-12 — Fork any thread; no tab bar on the phone

- **What.** "Fork" in the thread menu (desktop right-click and chat header, phone long-press)
  copies a Codex or Claude thread up to its latest finished response; a reply still streaming
  is left out. Threads imported from T3 v1 or from agent sessions fork too, even if nobody
  continued them yet. The fork is named "Title (n)", n counting up across all forks of that
  thread (a fork of "Title (2)" is "Title (3)"), lands under its source after its earlier
  forks and opens. It is never pinned, even when the source is. "Fork from this response"
  names and places its fork the same way. On the phone the Chats / Pull requests bar is gone:
  the workspace tile bar is the bottom of the screen.
- **How.** The client sends `thread.fork` with `latest_stable` (or the response's run), then
  writes `activeOrderKey`s that place the fork (`planForkPlacement`, usually a single write).
  The server's fork plan clears the pin fields it copies from the source. An imported thread
  without runs has nothing `latest_stable` can point at, so the server copies its runless
  history into the fork (`planLegacyImportFork`); the fork's first turn hands that history
  to the provider like any imported thread's first turn.
- **Where.** `client-runtime/src/state/threadForks.ts`, `operations/commands.ts` (optional
  `runId`); `useForkThread.ts` in web and mobile `workspaces/`; `threadActionMenu.logic.ts`,
  `useThreadActionMenu.ts`, `ChatView.tsx`, `contextMenuFallback.ts`;
  `thread-list-v2-items.tsx`, `ThreadFeed.tsx`, `HomeRouteScreen.tsx`, `HomeScreen.tsx`,
  `ThreadNavigationSidebar.tsx`, `WorkspaceRootScreen.android.tsx`; server
  `ThreadForkService.ts`, `Orchestrator.ts` (`dispatchThreadFork`).

### 2026-10-12 — Desktop shows the same workspaces as the phone

- **What.** A desktop paired with the user's server (for example the T3 server on the same
  machine) shows that server's workspaces, folder order and assignments, as the phone does,
  instead of the empty set of its own bundled server.
- **How.** The sidebar reads `sidebarWorkspaces` from the first connected non-primary server
  that has workspaces (by environment id, the phone's rule), else from the primary. Edits
  already go to every shared-settings target.
- **Where.** `WorkspaceSidebar.tsx` (config source).

### 2026-10-12 — Upstream merge: phone tab bar

- **What.** Brings in 95 upstream commits (phone bottom tab bar with Pull requests, saved list
  filters, theme and menu fixes, desktop and server fixes). On the phone the workspace tile bar
  sits above upstream's tab bar.
- **How.** Home keeps the fork's folder list inside upstream's new scroll gesture, under the
  folder drag host; list padding and scroll restore follow upstream. The review diff view still
  claims touches only once a drag axis is chosen, which already honours upstream's new
  scroll-enabled flag.
- **Where.** `HomeScreen.tsx`, `T3ReviewDiffView.kt`, `FileMarkdownPreview.tsx`,
  `ThreadRouteScreen.tsx`, `mobile-preferences.ts`, `AndroidHomeFab.android.tsx`.

### 2026-10-12 — Projects keep their place; drag to reorder; swipe the tile bar

- **What.** Project folders no longer jump to the top when a thread in them gets activity:
  they stay in the order you put them in, the same on desktop and phone. A new project
  appears on top. "No project" (desktop: Chats) always sits last, under Quiet projects and
  above Snoozed, and never folds into Quiet. Desktop: drag a folder above or below another
  (dropping it on a workspace tile still moves it there). Phone: hold a folder and move the
  finger; the list turns into a compact list of folders to drop it into place. Hold and let
  go without moving for the folder menu as before. A horizontal swipe along the bottom tile
  bar opens the previous or next workspace.
- **How.** The order is `projectOrder` in the shared `sidebarWorkspaces` setting, one list of
  project keys for all workspaces; projects not in it yet sort first, newest first. Quiet
  projects keep their slot and return to it. The phone's long-press is a pan gesture that
  activates after the hold and opens the anchored menu itself when the finger never moved.
  The tile-bar swipe is off while the tiles overflow and the bar scrolls. Servers older than
  this drop the field on write, so the server needs this build too.
- **Where.** `sortWorkspaceProjects` and `moveProjectInOrder` in
  `packages/client-runtime/src/state/sidebarWorkspaces.ts`; desktop drag in
  `WorkspaceSidebar.tsx`; phone drag in `apps/mobile/src/features/workspaces/WorkspaceFolderDrag.tsx`,
  hosted by `HomeScreen.tsx` and `WorkspaceDrawer.tsx`; the tile-bar swipe in
  `WorkspaceChrome.tsx`.

### 2026-10-11 — Keyboard stays up after sending (phone)

- **What.** Sending a message no longer closes the keyboard, so follow-ups are one tap away;
  tap outside the composer to close it.
- **Where.** One removed `blur()` in `handleSendMessage`, `ThreadDetailScreen.tsx`.

### 2026-10-11 — Install any version on the phone

- **What.** Settings › About › Version history on the Android app lists every fork release that
  has an APK, marks the installed one, and installs any of them (older ones too) after a
  confirm: the APK downloads and Android's installer opens. Connections and settings stay.
- **How.** Lists GitHub releases of `extra.forkReleaseRepo` with an `.apk` asset and opens the
  download with the existing attachment viewer (`application/vnd.android.package-archive`).
  Works because every fork APK has version code 1 and the same signing key; the sidebar
  variant also requests `REQUEST_INSTALL_PACKAGES`.
- **Where.** `apps/mobile/src/features/settings/ForkVersionHistory.tsx`; seams: one line in
  `SettingsAboutRouteScreen.tsx`, sidebar branches in `app.config.ts`.

### 2026-10-11 — Thread tabs on the phone

- **What.** Files opened from a thread (markdown, PDF, code) become tabs next to its chat, shown
  as chips under the header. Tapping a chip switches; long-press closes. Each tab reopens in
  the mode (preview / source) and at the scroll position it was left in, across app
  restarts. Up to 8 tabs per thread; the least recently used closes first. PDFs preview in
  the app on Android (pdf.js).
- **How.** Tab state is a per-device preference (`threadTabs`, keyed by environment and
  thread, 40 threads kept). Markdown and PDF store a scroll offset; source stores the first
  visible row (native code view's `visible-range` event and `initialRowIndex`).
- **Where.** `apps/mobile/src/lib/threadTabs.ts`, `apps/mobile/src/features/tabs/`,
  `apps/mobile/src/features/files/WorkspaceFilePdfPreview.tsx`; seams: the tab strip in
  `ThreadRouteScreen.tsx` and `ThreadFilesRouteScreen.tsx`, restore/report props in
  `FileMarkdownPreview.tsx` and `SourceFileSurface.tsx`, `threadTabs` in
  `persistence/mobile-preferences.ts`.

### 2026-10-11 — Chat swipes on the phone

- **What.** In a chat, the chat and its file tabs are full-screen pages in the order the tabs
  were opened, and a horizontal swipe flips between them, following the finger, from the chat
  and from any file. Swiping right on the chat is Back: Home slides in from underneath. Past
  the last tab, a swipe left pulls in the Files panel: open tabs, files changed in the working
  tree, All files and Git. Code without word wrap and a zoomed PDF pan until their edge, then
  flip; vertical scrolling and zoom always stay with the file. Back walks the same
  way (panel, tab, chat). Files opened from the chat or the file tree land in the pager too.
- **How.** One pan on the thread screen with manual activation, so vertical scrolling and a
  zoomed PDF keep their touches. The page track is as wide as all pages, because Android only
  hands touches to native views (code, PDF) inside their parents' bounds. The native code view
  leaves a horizontal drag to the pager once it is at its edge in that direction
  (`T3ReviewDiffView.kt`). Only the pages next to the current one are mounted. A file
  screen whose thread sits below it in the stack hands the file to that thread's pager
  (`tab` route param) and pops; on Android it opens without an animation so the hand-off
  doesn't show. Android phones only; tablets and iOS keep upstream's screens.
- **Where.** `apps/mobile/src/features/panels/`; seams: the `ThreadPager` branch at the end of
  `ThreadRouteScreen.tsx`, the `ThreadFileScreen` hand-off and `embedded` file view in
  `ThreadFilesRouteScreen.tsx`, a nullable role in `useAdaptiveWorkspacePaneRole`, the
  `ThreadFile` animation in `Stack.tsx`, the edge check in `T3ReviewDiffView.kt`, and two
  exported status-label constants in `thread-list-v2-items.tsx`.

### 2026-10-11 — Workspaces on the phone

- **What.** With workspaces set up on a connected server, the Android Home looks like the
  desktop sidebar: the workspace's tile and name in the toolbar, pinned threads, then project folders of
  one-line threads (status glyph, title, time), each folder with a + for a new thread there,
  "N settled" and "Show N more" under it, Quiet projects and Snoozed folded at the bottom,
  workspace tiles along the bottom with a dot for threads that need you or are working.
  Long-press a folder to move the project to another workspace; long-press or swipe a
  thread for upstream's actions. Tap the workspace name to rename it in place; long-press it
  or a tile for the desktop's workspace menu (icon, colour, order, default, delete); the +
  tile adds a workspace. The New thread button floats above the tiles; the filter gives way
  to them. Searching shows upstream's flat results.
- **How.** Reads the same shared `sidebarWorkspaces` server setting as the desktop and uses
  the same partition, sort and quiet rules (`workspaceNavigator.ts` mirrors
  `WorkspaceSidebar.tsx`; workspace resolution is shared in client-runtime), so the phone
  and desktop agree on what goes where. Thread rows are upstream's rows in a one-line mode,
  so menus and swipes are unchanged; their swipe buttons drop the caption to fit the row. Moving a project and workspace edits write to every
  server that has workspaces, through edit helpers shared with the desktop. The open workspace and folded sections are per-device
  preferences. Without workspaces Home stays upstream's.
- **Where.** `apps/mobile/src/features/workspaces/`,
  `packages/client-runtime/src/state/sidebarWorkspaces.ts` (web's `workspaces.logic.ts`
  re-exports it); seams: `HomeScreen.tsx` (project filter, rows, dock), the
  `compact` prop of `ThreadListV2Row`, `iconOnlyActions` in `thread-swipe-actions.tsx`, the FAB lift in `AndroidHomeFab.android.tsx`, the
  title and filter hide in `MaterialThreadListToolbar.tsx`, two preferences in `persistence/mobile-preferences.ts`.

### 2026-10-11 — Android app "T3 Code Sidebar"

- **What.** An APK of the mobile app with the fork's identity that installs next to upstream's
  T3 Code and pairs with any T3 server, including t3-ws.
- **How / Where.** See Identity (Android) and Releases above.

### 2026-10-11 — Install any version (rollback) from Settings

- **What.** Settings › General › Version history lists every published fork build. Picking one
  makes it the available update; Download and Install on the Version row then install it, older
  builds included. Newest goes back to following updates. Lasts until the app restarts, after
  which the newest build is offered again (never installed without a click).
- **How.** The desktop app lists GitHub releases of the repo in its `app-update.yml` that carry
  this platform's updater manifest. Picking one points electron-updater at that release
  (`generic` feed `releases/download/<tag>/`) with downgrades allowed and runs a check. It
  replaces upstream's Stable/Nightly track, which the fork does not publish.
- **Where.** `apps/desktop/src/updates/DesktopForkReleases.ts`, `packages/contracts/src/forkReleases.ts`,
  `apps/web/src/components/settings/ForkVersionRow.tsx`; seams: `followFeed` in
  `DesktopUpdates.ts`, the IPC wiring (`channels.ts`, `methods/updates.ts`,
  `DesktopIpcHandlers.ts`, `preload.ts`, `ipc.ts` bridge type) and one branch in
  `SettingsPanels.tsx`.

### 2026-10-11 — Upstream merge: orchestration v2

- **What.** Brings in 748 upstream commits (orchestration v2, server-tracked thread visits,
  usage-limit and waiting states, new Electron profile layout). The sidebar shows the new
  states: hourglass for waiting, gauge for a usage limit; both count as needing attention.
- **How.** The sidebar reads v2 thread shells (`latestRun`, `runtime`) through upstream's
  `resolveSidebarThreadStatus`; the fork identity moved into upstream's new
  `DesktopUserData.ts` and `DesktopLegacyLocalStorage.ts`. The `.deb` package name and
  AppUserModelID are now distinct from upstream, so both install side by side.
- **Where.** `workspaces.logic.ts`, `WorkspaceThreadRow.tsx`, the identity files above.

### 2026-10-11 — Done badge for threads never opened on this device

- **What.** A thread whose latest turn finished after you started using the workspace sidebar
  on this device shows a green check until you open it, even if this device never opened it.
- **How.** Upstream counts a completion as unseen only when there is a visit timestamp (the
  server's `lastVisitedAt`, or this device's). The workspace view store records
  `seenBaselineAt` once per device; `isThreadUnread` falls back to it. Opening a thread stamps
  the visit (upstream `ChatView`).
- **Where.** `workspaces.logic.ts` (`isThreadUnread`), `workspaceViewStore.ts`,
  `WorkspaceThreadRow.tsx`.

### 2026-10-11 — Self-updating desktop releases

- **What.** Installed T3 Code Sidebar offers new fork builds through the normal update button.
- **How.** Builds keep `GITHUB_REPOSITORY`, so electron-builder writes a GitHub publish config
  pointing at this fork; the release carries the updater manifests. Channel `latest`.
- **Where.** `.github/workflows/sidebar-desktop.yml`.

### 2026-10-11 — Project icons from the folder menu

- **What.** Right-click a project folder → Icon… / Reset icon.
- **How.** Reuses upstream's `ProjectIconPickerDialog` and project `projectIcon` override,
  written to every checkout of the folder (same as Project settings › Icon).
- **Where.** `WorkspaceSidebar.tsx` (`setFolderIcon`).

### 2026-10-11 — Tile order, tile icons, undeletable default

- **What.** Drag tiles (or Move left/right) to reorder; Alt+1…9 follow the order. Tile face:
  up to two letters, an emoji, or a built-in glyph. The default workspace can't be deleted and
  carries a small mark.
- **How.** Order is the order of `sidebarWorkspaces.workspaces`; `icon` holds the label or
  `glyph:<key>`. `effectiveDefaultWorkspaceId` is the one workspace delete refuses.
- **Where.** `workspaces.logic.ts`, `WorkspaceChrome.tsx`, `WorkspaceSidebar.tsx`.

### 2026-10-11 — Desktop app that installs next to upstream (incl. WSL)

- **What.** Windows/Linux installers named T3 Code Sidebar with their own data and profile;
  the WSL backend works and keeps its data in `~/.t3-sidebar` inside the distro.
- **Where.** See _Identity_ above.

### 2026-10-10 — Workspace sidebar

- **What.** Workspaces (e.g. personal / vtbfamily / potentialplus / eduplatform) as square
  tiles at the bottom, current workspace name at the top, one toggle (Alt+0) to see every
  workspace in one list. Projects are folders with one-line threads in a stable order, a
  Quiet projects group, pinned and snoozed sections, search, context menus, Alt+1…9 to switch
  workspaces, thread jump keys. Turn it off in Settings › General › Workspace sidebar.
- **How.** The config is a shared server setting (`sidebarWorkspaces`, in
  `SHARED_SERVER_SETTING_KEYS`), so every client of a server sees the same workspaces.
  Projects resolve to a workspace by explicit assignment, then path glob rules, then the
  default. Per-device view state (open workspace, collapsed folders) is local.
- **Where.** `packages/contracts/src/sidebarWorkspaces.ts`; seams in
  `packages/contracts/src/settings.ts`, `packages/client-runtime/src/state/sharedSettings.ts`,
  `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/components/settings/SettingsPanels.tsx`
  and `settingsSearch.ts`; UI in `apps/web/src/components/workspaces/`.
