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
- **Tests.** The fork keeps the whole suite green: `vp lint` has no errors and every package's
  tests pass on Node 24 (the version `package.json` pins; Node 22 fails sqlite, WSL and lint-plugin
  tests). Upstream tests that check desktop identity (app name, id, profile, `~/.t3-sidebar`, WSL
  runtime dir) expect the fork's values, marked `// Sidebar fork:`. When a merge breaks a test,
  fix the fork code or the test; an upstream test that is broken upstream too is dropped or
  fixed the way upstream later did. Upstream CI does not run here (it triggers on `main`).

## Relation to upstream

- **Base.** Last synced with upstream release `v0.1.1` (`fe27e8e3dc`, tagged 2026-10-20) on
  2026-10-21 (merge into `ws`); from now on only stable upstream releases are merged.
  Upstream's open PR #14865 (voice conversations) is merged in on top; see the feature log. Fork builds report
  the synced release's version plus `-sidebar.<run>`, so keep the release tag in the backticks
  above: CI reads it from this line.
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

|                          | Upstream             | Fork                                                                                           |
| ------------------------ | -------------------- | ---------------------------------------------------------------------------------------------- |
| Product name             | T3 Code (Alpha)      | T3 Code Sidebar                                                                                |
| App id                   | `com.t3tools.t3code` | `com.gvidon.t3code-sidebar`                                                                    |
| Data dir (`T3CODE_HOME`) | `~/.t3`              | `~/.t3-sidebar` (also inside WSL)                                                              |
| Electron profile         | `t3code-v2`          | `t3code-sidebar-v2`                                                                            |
| `t3code://` handler      | registered           | registered at launch by Clerk's bridge (last launched app wins when upstream is installed too) |
| Updates                  | upstream releases    | this fork's GitHub releases                                                                    |

The fork skips upstream's own `xdg-mime` registration, but `@clerk/electron` calls
`app.setAsDefaultProtocolClient("t3code")` on every launch, so with upstream T3 Code installed
alongside, whichever app started last receives `t3code://` links: the Clerk sign-in callback, the
Codex sign-in handoff and prompt links.

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
  the core stays upstream's so version-skew checks against servers hold. The core is the higher
  of `apps/server/package.json` and the release tag in "Last synced with upstream release" above,
  because upstream stamps a release's version only when it builds it. Builds are unsigned.
- **Android.** The same workflow's `android` job prebuilds the sidebar variant, builds a release
  APK signed with the fork key and attaches `T3-Code-Sidebar-<version>.apk` to the release. The
  generated `android/` project and its native build outputs live in an Actions cache keyed by
  native inputs, so JavaScript-only pushes reuse them; the job builds `arm64-v8a` only by default
  (manual dispatch can add `x86_64`) and skips R8, PNG crunching and lintVital for this sideload
  APK. Local equivalent: `pnpm mobile:apk` (first build compiles native modules, later builds are
  usually a minute or two; it auto-loads `~/.local/share/t3-ws/android-signing.env` when present,
  so the APK updates an installed fork build). E2E helpers for the emulator are in
  `scripts/sidebar-mobile-e2e/`.
- **iOS.** `.github/workflows/sidebar-ios.yml` builds the sidebar variant for the iOS Simulator
  (arm64, unsigned, `com.gvidon.t3codesidebar`) on every `ws` push that touches the app and
  uploads the zipped `.app` as an artifact. It proves the app and its native modules compile for
  iOS; it never publishes a release (the desktop workflow ignores this file). A signed
  IPA/TestFlight job is in the file but stays off until the owner picks Apple signing.
- **Self-hosted web.** `deploy/t3-ws/` builds a Docker image of `t3 serve` and runs it on the
  owner's VPS behind an SSH tunnel (`deploy.sh`, `open.sh` → `t3-ws` command). Codex only.

## Feature log

### 2026-10-21 — Settings gear back in the phone's thread-list header

- **What.** On a phone the thread list's header shows inbox · search · ⚙ · filter again, and
  the gear opens Settings. Upstream v0.1.1 moved Settings into Android's bottom navigation bar,
  which the fork hides on phones (the workspace dock replaces it), so Settings had no way in.
- **How.** `WorkspaceListToolbarRow` takes an optional `onOpenSettings` and renders a gear
  button; `ThreadListToolbar` passes it outside the tablet sidebar, navigating to
  `SettingsSheet → SettingsContent → Settings`.
- **Where.** `apps/mobile/src/features/workspace/WorkspaceListToolbarRow.tsx`,
  `apps/mobile/src/features/home/ThreadListToolbar.tsx`.

### 2026-10-21 — Phone composer: model and reasoning always in view, ⤢ fills the screen

- **What.** The thread composer is back to the fork's layout: the draft on top and one toolbar
  row of "+", ⤢, the model chip with its name and reasoning effort, voice and send. The chip no
  longer shrinks to a provider icon while typing, and a short draft no longer turns the composer
  into upstream's single row. ⤢ grows the editor up to the thread's header, with or without the
  keyboard (it used to stop about a message short of it).
- **How.** `ThreadComposer` drops upstream's one-row measurement: a focused composer is always the
  card, and the model control never gets `iconOnly`. The full-screen height is still estimated
  from the window, then corrected once per opening: the composer measures where its top landed
  (`measureInWindow`) against the window y of the screen below the header, which
  `ThreadDetailScreen` passes as `fullScreenTop` on Android.
- **Where.** `apps/mobile/src/features/threads/{ThreadComposer,ThreadDetailScreen}.tsx`.

### 2026-10-21 — A clean fork: lint and tests green

- **What.** `vp lint` reports no errors (47 before) and the full test suite passes. The sidebar's
  hover hints are now the app's own tooltips instead of the browser's, focus rings sit inside
  the rows, the status colours use the theme's info/success/error/warning tokens, and thread and
  folder titles are 14px like upstream's rows (they were 13px).
- **How.** The three web sidebar files follow upstream's UI rules (no raw colours or arbitrary
  values, `Tooltip` instead of `title`, inset focus rings, no restyled `SidebarContent`).
  Desktop identity tests expect the fork's identity. `pickSharedServerSettings` lists
  `sidebarWorkspaces`; the thread-menu test mocks the fork-from-menu seam. The phone's thread
  pager loads the file page lazily, which breaks the import cycle between the thread and files
  screens. The packaging test no longer imports desktop source outside its tsconfig project, so
  typecheck is clean too. Tests that are flaky on upstream's own `v0.1.1` and that upstream
  deleted right after it (#22557) are gone here as well: the Claude "move foreground subagents
  to the background before a steer" case, `useTheme`, `useEnvironmentThemeSync`, and the
  `HtmlRenderDialog`, `UsageLimitsPooled`, `StyledDiffCodeView` and `DiffPanel` browser tests.
  Upstream's later browser-test fix is taken too: Playwright's mouse is parked off the page
  before each test (`apps/web/test/browserSetup.ts`), so no test starts hovered.
- **Where.** `apps/web/src/components/workspaces/{WorkspaceChrome,WorkspaceSidebar,WorkspaceThreadRow}.tsx`,
  `apps/web/src/hooks/useThreadActionMenu.test.ts`, `apps/desktop/src/**/*.test.ts`,
  `packages/client-runtime/src/state/sharedSettings.test.ts`,
  `apps/mobile/src/features/threads/ThreadRouteScreen.tsx`,
  `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`,
  `scripts/build-desktop-artifact.test.ts`.

Newest first. Each entry: what it does for the user, how it works, where it lives.

### 2026-10-21 — Upstream release v0.1.1

- **What.** Brings in upstream's `v0.1.1` (1486 commits past the v0.1.0 sync). The phone app
  moves onto a shared design system: themed native Android app bars, dialogs, menus, toasts and
  progress, and a composer that is one line until the text wraps. The web app now compiles with
  the React Compiler almost everywhere (fewer re-renders). Also: `t3 doctor` reclaims database
  space and can drop the pre-0.1.0 database; a linked pull request can be dragged into the
  composer; reasoning effort steps from the keyboard; pull requests can be linked and watched
  from the phone; servers bound to `::1` work through T3 Connect and Tailscale Serve; superseded
  history compacts in the background; worktrees shared by subagents are cleaned up; telemetry
  goes through `ingest.t3.codes` and counts product features and T3 MCP tools used. Plus several
  hundred fixes and performance changes. The orchestration protocol is unchanged.
- **How.** Mobile: components moved to `components/ui/` and lost their `Material*` names
  (`ControlPillMenu` → `Menu`, `MaterialButton` → `Button`, `showTextInputDialog` →
  `Dialog.prompt`), so the fork's mobile files import from there. Home's toolbar became
  `ThreadListToolbar` plus the shared `WorkspaceListToolbarRow`: the workspace title and the
  inbox button sit in the row (the pull request tab's toolbar gets them too), the filter still
  hides while the workspace dock shows. The inbox screens use upstream's `DETAIL_HEADER_OPTIONS`.
  The fork's composer growth, full-screen editor and model/effort chip sit on upstream's
  line/card composer; the card grows up to the space above the keyboard instead of upstream's
  four lines, and the native editors report both the fork's height and upstream's size events.
  Upstream's share merge now restores file chips itself, so that fork seam is gone; the
  cherry-picked keyboard fixes (#20803, #19980) are upstream's own code now. The terminal keeps
  the fork's extra keys in place of upstream's "Attach output" bar and attaches through
  upstream's new `requestCapture`. Enriched Markdown went to `t3.15` without a laid-out height,
  so the Android height patch is re-created as `t3.15`. Server: upstream turned service methods
  into `Effect.fn`; the voice check in Codex's background-work probe, Codex's voice session, the
  Claude fork retry (now passing upstream's `environment`) and the fork's never-pinned forks sit
  on the new forms, and the fork's own services follow the new `prefer-effect-fn` rule. Web:
  `useServerConfigs` no longer carries providers, so fork-from-menu, Talk and the palette's
  voice item read upstream's providers-by-environment atom; the inbox composer uses upstream's
  software-keyboard check; `WorkspaceSidebar`, the inbox, voice hooks and `useForkThread` drop
  manual memoization so the React Compiler compiles them (route following, the menu nonce and
  hotkeys go through `useEffectEvent`). Desktop: the updater's base state takes a disabled
  reason; upstream now declares the macOS microphone itself. Tests: `ws.test.ts` mocks the
  fork's inbox, UI-request and voice services; `pair.test.ts` turns off the effect plugin's
  `anyUnknownInErrorContext`, which with the fork's server types gives up on `cli` there although
  the resolved requirements match upstream's. Upstream now checks that every phone and web file
  compiles under the React Compiler, so the fork's files do too: Reanimated values go through
  `get()`/`set()`, "latest value" refs became `useEffectEvent` or layout-effect updates,
  gestures are built once, and `try`/`finally` became `.finally()` or `settlePromise`.
  Upstream also caps each Codex instruction entry at 4,000 bytes, so the fork's inbox and
  ui_open/voice instructions are separate sections of `T3_CODE_ORCHESTRATION_SECTIONS`.
- **Where.** `apps/mobile/src/features/{home/ThreadListToolbar,workspace/WorkspaceListToolbarRow}.tsx`,
  `features/threads/{ThreadComposer,NewTaskDraftScreen,ThreadSettingsSheet,ThreadFeed,ThreadDetailScreen,ThreadRouteScreen}.tsx`,
  `features/home/{HomeScreen,AndroidHomeFab.android}.tsx`, `features/terminal/ThreadTerminalRouteScreen.tsx`,
  `native/T3ComposerEditor*.tsx`, `Stack.tsx`, the fork's `features/{inbox,workspaces,voice-mode,…}`
  imports; `patches/react-native-enriched-markdown@1.2.0-t3.15.patch`, `pnpm-workspace.yaml`;
  `apps/server/src/orchestration-v2/{Adapters/CodexAdapterV2,Adapters/ClaudeAdapterV2,ThreadForkService,ProviderContinuationService}.ts`,
  `inbox/InboxService.ts`, `uiRequests/UiRequests.ts`, `ws.test.ts`, `cli/pair.test.ts`;
  `apps/web/src/components/workspaces/WorkspaceSidebar.tsx`, `chat/ChatComposer.tsx`,
  `hooks/useThreadActionMenu.ts`, `CommandPalette.tsx`, `voice/useTalk.ts`,
  `components/inbox/`, `components/workspaces/WorkspaceUpdateStrip.tsx`,
  `voice/useStartVoiceThread.ts`; `apps/mobile/src/features/{panels/ThreadPager,files/WorkspaceFilePdfPreview,workspaces/WorkspaceFolderDrag,workspaces/WorkspaceChrome,voice-mode/VoiceConversationBubble}.tsx`;
  `packages/provider-core/src/server/orchestrationInstructions.ts`;
  `apps/desktop/src/updates/DesktopUpdates.ts`, `scripts/build-desktop-artifact.ts`.

### 2026-10-21 — Full-screen draft editor; terminal tabs and keys on every screen

- **What.** Once a draft wraps to three lines, ⤢ appears in the composer toolbar next to "+",
  as in ChatGPT. It grows the same draft over the screen with only the text, ⤡ and send; ⤡,
  Back or sending returns to the normal composer. In a thread, a new thread and an inbox reply.
  The terminal's tab strip, the two rows of extra keys and "Attach output to chat" in its menu
  now also apply where there is no thread pager (tablets, unfolded foldables, iOS): the
  terminal screen shows Chat, the open files and every shell of the thread as tabs.
- **How.** The editors report their text height (`onContentHeightChange`);
  `useComposerFullScreen` turns it into lines and owns the full-screen state and Back.
  Full screen lifts the editor's cap by the thread glimpse a focused composer keeps. The
  `ThreadTerminal` route renders `ThreadTerminalTabsRouteScreen`, which gives the terminal the
  pager's controls: a terminal tab swaps the route's shell, Chat goes back, closing kills.
- **Where.** `apps/mobile/src/features/composer-fullscreen/`, seams in
  `features/threads/{ThreadComposer,NewTaskDraftScreen}.tsx`, `features/inbox/InboxComposer.tsx`
  and `native/T3ComposerEditor*.tsx`; `features/terminal/ThreadTerminalTabsRouteScreen.tsx` and
  the `ThreadTerminal` entry in `Stack.tsx`.

### 2026-10-21 — Terminals are tabs on the phone, with Termux-style keys; PDF and SVG stay sharp

- **What.** On an Android phone every terminal of the thread is a tab next to Chat and the open
  files (`>_ Terminal 1`, `>_ Terminal 2`…), swiped to like a file. The tabs are the server's
  shells, so a terminal opened on the desktop shows up on the phone and the other way round.
  "Open new terminal" in the menu adds a tab; long-pressing a tab asks, then ends that shell.
  Under the terminal sit two fixed rows of keys: ESC, ^C, /, HOME, END, PGUP/PGDN, TAB, PASTE,
  CTRL and ALT (tap for the next key, hold to lock), arrows that repeat while held, and a
  keyboard toggle. Swiping or scrolling the terminal no longer pops the keyboard; a tap does.
  "Attach output to chat" moved to the terminal's menu. PDFs re-render the visible pages at the
  zoom level once a pinch settles, and SVG files (blank before) render and zoom as vectors.
- **How.** A terminal page is keyed by `terminalTabKey(id)`, a string no path can be, so the
  pager, tab strip and route `tab` param carry it like a file. The pager lists the live sessions
  from `useKnownTerminalSessions` plus ids this device just asked for; closing runs the terminal
  close command with `deleteHistory`. The native canvas claims the touch from the pager only
  after a vertical move, selection drag or handle grab. The PDF viewer redraws visible pages at
  `devicePixelRatio × zoom` (capped at 16 Mpx) on `visualViewport` changes. SVG is shown through
  an `<img>` in our own page because the server's sandbox CSP blanks it as a document.
- **Where.** `apps/mobile/src/features/panels/{terminalTabs.ts,ThreadPager.tsx}`,
  `features/tabs/ThreadTabStrip.tsx`, `features/terminal/{TerminalExtraKeys,ThreadTerminalRouteScreen}.tsx`,
  `features/threads/ThreadRouteScreen.tsx`, `features/files/{WorkspaceFilePdfPreview,WorkspaceFileWebPreview,ThreadFilesRouteScreen}.tsx`,
  `modules/t3-terminal/android/.../{TerminalCanvasView,T3TerminalView}.kt`. Tablets and iOS keep
  the separate terminal screen.

### 2026-10-21 — Markdown opens rendered on the phone; composer no longer hides behind the keyboard

- **What.** A Markdown file opened on the phone shows its rendered preview first; a link to a
  specific line still opens the source at that line, and a tab switched to source stays source.
  On Android the message field no longer stays hidden under an open keyboard after quick
  back-and-forth between threads and apps.
- **How.** `defaultViewMode` treats Markdown like images and PDFs unless the route carries a
  line. The keyboard fix is upstream's #20803 and #19980, cherry-picked ahead of the next
  upstream merge: the composer follows the keyboard from its first frame instead of waiting
  for a visibility render, and an input that kept focus through an app switch is no longer
  quarantined.
- **Where.** `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx`; the cherry-picks touch
  `features/threads/{ThreadDetailScreen,ThreadFeed,QuestionAttachments}.tsx`.

### 2026-10-20 — Phone composer grows with the prompt, shared PDFs show up, "+" menu whole

- **What.** On the phone the message field grows line by line as you type, up to the space
  above the keyboard, then scrolls inside, as in ChatGPT; the card sits closer to the screen
  edges and the toolbar closer to the text. A file shared into T3 from another app (Files,
  a browser) now appears as its chip in the draft right away, named `report.pdf` rather than
  `primary:Download/report.pdf`, including when a new-task draft is already open or the app
  was cold-started by the share. The "+" menu shows all its rows with the keyboard open or
  closed.
- **How.** The native editors already emitted `onComposerContentSizeChange`; the wrappers now
  size themselves from it within the style's `minHeight`/`maxHeight`, and the cap is computed
  from the window, keyboard and insets. Share merges run `restoreMissingComposerFileReferences`
  so documents get their inline chip; the share sheet is presented a frame later so a
  cold-start navigation is not dropped, and a share arriving while the sheet is open is
  routed into it. The in-window Android menu gets an explicit height instead of Compose
  `matchContents`, which measured a short column.
- **Where.** `apps/mobile/src/native/composerEditorGrowth.ts`, `T3ComposerEditor.{native,ios}.tsx`,
  `features/threads/{ThreadComposer,NewTaskDraftScreen,NewTaskRouteScreen}.tsx`,
  `state/use-composer-drafts.ts`, `features/sharing/incoming-share-{model,presentation}.ts`,
  `Stack.tsx`, `components/AndroidAnchoredMenu.tsx`, `MaterialMenuPopup*.tsx`.

### 2026-10-20 — Your own model names, every pin in quick switch, camera in "+"

- **What.** Long-press a model in "All models" on the phone to rename it (`Sol 6.1` for
  `GPT-6.1-Sol`); the row keeps the catalog name underneath so models are never confused, and an
  empty name restores it. Names apply in the composer chip, quick switch and catalog search, and
  sync to every phone on the environment. Quick switch shows every pinned model, not the first
  six. The full catalog scrolls to its last provider again: Reasoning/Runtime moved into the
  list header and the bottom safe-area padding is back at the end. The composer "+" menu gains
  "Take Photo", which attaches a camera shot straight to the message.
- **How.** `ServerSettings.modelNicknames` (per provider instance and model), patched with
  `setModelNicknames`; `ModelOption.nickname` overrides the display name while effort and
  sibling grouping still read the catalog label. The camera uses `expo-image-picker`'s
  `launchCameraAsync` through the same attachment path as the library. Web does not read
  nicknames yet.
- **Where.** `packages/contracts/src/settings.ts`, `packages/shared/src/serverSettings.ts`,
  `apps/mobile/src/lib/modelOptions.ts`, `features/threads/modelDisplay.ts`,
  `ThreadSettingsSheet.tsx`, `ThreadSettingsRows.shared.tsx`, `lib/composerImages.ts`,
  `components/ComposerAttachmentButton.tsx`.

### 2026-10-20 — Model and reasoning on the phone: one tap, effort visible

- **What.** The composer chip reads `Opus 4.5 · High` (or `Gemini 3.8 Flash · High`) instead of
  hiding reasoning behind settings. Tapping it opens a compact sheet over the thread with
  Reasoning first, pinned or suggested models for one-tap switching, Runtime inline, and
  "All models" for the full catalog. The full picker also puts Reasoning and Runtime above the
  catalog instead of after every model. New-task drafts use the same sheet.
- **How.** A display layer splits the provider's name into a short name and an effort, lifts
  effort baked into names like `Gemini 3.8 Flash (High)`, dedupes a descriptor effort, and
  groups sibling effort variants. Quick switching applies the model immediately instead of
  staging it behind Save; the sheet is an in-app Modal and "All models" hands off to the
  existing native catalog route. Rows show the same short name plus an effort badge.
- **Where.** `apps/mobile/src/features/threads/QuickModelSheet.tsx`, `modelDisplay.ts`,
  `ThreadSettingsSheet.tsx`, `ThreadComposer.tsx`, `NewTaskDraftScreen.tsx`,
  `ComposerToolbar.tsx`, `ThreadSettingsRows.shared.tsx`; shared name split in
  `packages/shared/src/model.ts`. Local APK: `scripts/mobile-android-apk.mjs` (`pnpm mobile:apk`).

### 2026-10-17 — Open files stay current on the phone

- **What.** A file open on the phone shows edits within about two seconds, whoever makes them:
  the agent, an editor, another thread. Markdown preview and source re-read the file; a PDF (a
  LaTeX rebuild, say) swaps in the new pages and stays where the reader had scrolled. Text files
  gain Refresh in the menu. Before, the screen kept the copy from its first visit.
- **How.** While the file screen is focused and the app is in the foreground it polls every 2 s
  (`OPEN_FILE_POLL_MS`). Text re-reads the cached `readFile` query (files up to 512 KB; larger
  ones only on the other triggers), and re-reads at once after each settled `file_change` or
  `command_execution` item or checkpoint of the thread (web's `workspaceMutationId` signal) and
  on every return to the screen or the app. The pdf.js page reads the file's ETag from a GET it
  aborts after the headers, renders a changed PDF off-screen and swaps it in at the same scroll;
  an expired signed URL (404) is re-minted by the app and injected without reloading the page.
- **Where.** `apps/mobile/src/features/files/useWorkspaceFileRefresh.ts` (new),
  `WorkspaceFilePdfPreview.tsx`; seam: `ThreadFileView` and `FileContent` in
  `ThreadFilesRouteScreen.tsx`.

### 2026-10-17 — Voice: steer the call out loud, move it, hear it in a headset

- **What.** Say "end the call" or "turn off the mic" and the device holding the call hangs up or
  mutes; the thread stays, and the microphone button turns the mic back on. Ask to continue in
  another thread ("fork this and carry on there", "move this to project X") and the agent forks
  or creates the thread; the device hangs up, opens it and calls again there, and the new call
  starts knowing what was said. On Android the call goes through a connected Bluetooth or wired
  headset instead of the loudspeaker, and follows headsets as they connect. The voice panel above
  the composer is the same on the conversation's thread and on others: four lines of the latest
  words, mute and stop on the right; a long press swaps the words for a short menu (back, open
  the conversation, talk here, the device the call goes through).
- **How.** Two MCP tools, `voice_control` (`end`, `mute`) and `voice_move` (`threadId`), relay a
  `VoiceCommand` over a separate `uiRequests.subscribeVoiceCommands` stream (older clients never
  see it); only the client holding that thread's conversation acts (`appliesVoiceCommand`), after
  the assistant finishes its sentence (`applyVoiceCommand`). `VoiceSessionService` keeps the
  lines of each live conversation; `voice_move` waits for the target to finish preparing, then
  `carryOver` hands the newest lines (with a note) to the next call there as Codex realtime
  `initialItems`. A call on a thread still preparing waits up to 12 s instead of failing. On
  Android the local Expo module `t3-voice-audio` puts the call in communication mode and picks
  the device with `setCommunicationDevice` (SCO before Android 12); expo-audio's speakerphone
  switch, which overrode headsets, is no longer used there. The panel opens its menu when the
  finger lifts, so the next tap is not swallowed. Leaving the app still ends the call: Android
  takes the microphone and network from a background app without a foreground service, so the
  menu has no link to system settings; connect a headset from the quick settings shade.
- **Where.** Contracts: `uiRequests.ts`. Server: `mcp/toolkits/ui/` (tools + handlers),
  `uiRequests/UiRequests.ts`, `orchestration-v2/VoiceSessionService.ts` (+ test),
  `provider/CodexVoice.ts`, `Adapters/CodexAdapterV2.ts`, wiring in `ws.ts`,
  `RpcAuthorization.ts`, `RpcInstrumentation.ts`; `provider-core/.../ProviderAdapter.ts`
  (`initialItems`), `orchestrationInstructions.ts` (voice steering);
  `shared/.../t3McpToolPresentation.ts`. Client runtime: `voice-mode/commands.ts` (+ test),
  `uiRequests.ts`, `state/uiRequests.ts`, `t3ToolSummary.ts`, `work-log/presentation.ts`. Web:
  `components/uiRequests/`, `state/uiRequests.ts`, `VoiceModeStrip.tsx`, `components/voice/`.
  Mobile: `modules/t3-voice-audio/` (Kotlin + unit tests), `features/voice-mode/`
  (`voiceAudioRoute.ts`, `voiceMode.ts`, `ComposerVoiceMode.tsx`, `UiRequestCoordinator.tsx`,
  `VoiceConversationPreview.tsx`, `VoiceConversationBubble.tsx`), `AppSymbol.tsx`.

### 2026-10-16 — Finished agents leave the thread list

- **What.** The "7 agents · done" line under a thread goes away once all its agents finish; while
  any agent works or needs the owner it shows as before. Failed agents leave the line folded, as
  a warning. The thread's menu offers "Show agents (N)" / "Hide agents" to bring finished agents
  back or put them away; the choice lapses when the thread launches more agents. Opening one of
  the agents still shows the line. Inside the thread, its agents stay listed as before. Mobile
  hides finished agents the same way but has no menu item.
- **How.** One shared rule, `threadAgentsDisplay` (hidden / folded / open), with the user's
  choice stored under a key naming the agents' state and count (`threadAgentsChoiceKey`).
- **Where.** `packages/client-runtime/src/state/threadAgents.ts`, `WorkspaceSidebar.tsx`,
  mobile `workspaceNavigator.ts`. Seams: `show-agents` / `hide-agents` in
  `threadActionMenu.logic.ts`, an optional `agents` input to `useThreadActionMenu.ts`, a `bot`
  icon in `contextMenuFallback.ts`.

### 2026-10-16 — Voice that follows you, starts anywhere and opens things

- **What.** Voice starts in any Codex thread, even a new one with no message, or from **Talk**
  next to the new-thread button (a new Codex thread on GPT-6 Astra). The conversation no longer
  ends when you leave its thread: other threads show a compact strip above the composer
  (the conversation's latest words, mute, stop, **Talk here** to move it), and away from threads a
  round voice button floats on screen; drag it anywhere, tap it for the controls. Clicking the words
  (web, desktop) or long-pressing the strip or the button (phone) opens the voice thread. A thread
  started with **Talk** is named after the first phrase spoken in it. The thread holding the
  conversation is the first row of the sidebar (and the phone's Home), above Pinned, with a wave
  icon. One conversation per device; another device starting the same thread takes it over,
  while different threads can talk at the same time on different devices. Ask to open something
  (a thread, the inbox or an issue, a file, the diff, a workspace, home) and the device you're
  talking from switches to it; any agent can do the same with `ui_open`, which opens files and
  the diff beside the thread you're looking at and switches straight to the rest (devices not
  showing that agent's thread ignore it). The phone
  still stops voice when the app goes to the background.
- **How.** `VoiceSessionService` opens the provider session and starts or resumes the Codex thread
  without a turn when the thread has none loaded, and records the provider thread as a run
  would, so the next run continues the same native conversation. `CodexVoice` and the Codex
  adapter keep conversations per native thread, and report a live one as pending background work
  so idle release leaves it alone. Codex's voice model has no tools, so navigation travels as an
  ordinary delegated turn: the agent calls the MCP tool `ui_open`, `UiRequests` relays it over the
  `uiRequests.subscribe` stream, and each client decides with `decideUiRequest` (voice holder →
  navigate, thread shown → side panel for files and the diff, otherwise navigate; else ignore).
- **Where.** Server: `orchestration-v2/VoiceSessionService.ts` (+ test), `provider/CodexVoice.ts`,
  `Adapters/CodexAdapterV2.ts` (voice parts), `ThreadTitleRegenerationService.ts`
  (`nameFromSpeech`, + test), `uiRequests/UiRequests.ts` (+ test),
  `mcp/toolkits/ui/`, wiring in `ws.ts`, `runtimeLayer.ts`, `McpHttpServer.ts`,
  `RpcAuthorization.ts`, `RpcInstrumentation.ts`; agent guidance in
  `provider-core/.../orchestrationInstructions.ts`. Contracts: `packages/contracts/src/uiRequests.ts`.
  Client runtime: `uiRequests.ts` (+ test), `state/uiRequests.ts`. Web: `voice/`
  (`useStartVoiceThread.ts`, `useTalk.ts`), `components/voice/VoiceBubble.tsx`,
  `components/voice/VoiceConversationPreview.tsx`,
  `components/uiRequests/`, seams in `ChatComposer.tsx`, `ChatView.tsx`, `CommandPalette.tsx`,
  `VoiceModeStrip.tsx`, `WorkspaceSidebar.tsx`, `WorkspaceThreadRow.tsx`, `routes/__root.tsx`.
  Mobile: `features/voice-mode/` (`VoiceModeRootLayer`, `VoiceConversationBubble`,
  `HomeTalkButton`, `UiRequestCoordinator`, `voiceThreads.ts`), seams in `Stack.tsx`,
  `ThreadComposer.tsx`, `NewTaskDraftScreen.tsx`, Home and workspace navigator files. The voice
  code started as upstream PR #14865, so these voice files are now fork seams too.

### 2026-10-16 — Inbox: the chat's reply box and quiet states

- **What.** The reply box on an issue is the chat composer: the same glass surface, editor,
  paperclip and round send button. Images and files can be attached, pasted or dropped, and
  reach the agent's thread with the comment. A comment may be a screenshot alone. "The agent is
  waiting for your answer" sits on the box as a composer banner instead of a red badge.
  States read like the rest of the app: severity is a small dot, a closed issue gets a quiet
  status line ("Resolved by the agent · 2h ago", "Closed as not relevant · Reopen"), the
  resolution is a quote in the activity. Green is kept for one thing, a resolved issue (its
  status line, its check in the list, the "Resolved" event), like "Done" in the sidebar; there
  are no colored badges. The owner's comments look like their thread messages, the agent's like
  its answers. "Conversation" and the overflow menu ("Close as not relevant") sit beside the
  title; the list's tab is "Closed".
- **How.** `inbox.comment` takes optional `attachments` uploaded through the composer's upload
  queue (`attachments.createUploadUrl`). The service delivers through `ThreadMessageIntake`, which
  claims the uploads into the responsible thread (or the thread a first comment starts); the
  entry then keeps the thread's copies in `attachments_json`, since staged uploads are swept.
  The column is added in place on older databases. Empty text with no attachment is refused.
- **Where.** `packages/contracts/src/inbox.ts`, `apps/server/src/inbox/InboxService.ts` (+ test),
  `apps/web/src/components/inbox/InboxComposer.tsx` (new), `InboxIssueDetail.tsx`,
  `InboxPage.tsx`, `inbox.logic.ts`.
- **Phone.** The issue screen reads the same: severity dot and words, the full title in the
  body, the quiet status line with the green resolved check, "Conversation" and a "⋯" menu, and
  an "Activity" feed where the owner's comments are bubbles with their pictures and files and the
  agent's are plain text under its thread's name. The list's tab is "Closed", open rows show a
  severity dot and "Your turn", closed rows a green check or a ban sign. The reply box is the
  thread composer's surface with its "+" (photos or files), attachment strip and round send
  button; the waiting banner sits above it. The reply is a composer draft keyed
  `<environment>:inbox-<issue>`, so it survives a restart and the background upload worker sends
  its files while the owner types; send passes the uploaded ids to `inbox.comment`. Where:
  `apps/mobile/src/features/inbox/` (`InboxComposer.tsx` new), `ThreadFeed.tsx` exports its
  message attachment views, `AppSymbol.tsx` gains `nosign`.

### 2026-10-16 — Fork builds carry the synced release's version

- **What.** After the v0.1.0 sync, fork builds are `0.1.0-sidebar.<run>` instead of
  `0.0.45-sidebar.<run>`, so the version in About and on the release matches the upstream
  release they contain. Desktop and phone update to it as usual. Until the server is updated
  too, a new client connected to a server on a `0.0.45-sidebar` build shows upstream's
  "Version mismatch" notice; the protocol is the same, so everything keeps working.
- **How.** Upstream's tag commit still has the previous version in `package.json` and stamps the
  release version only at release time. The `version` step of the bundle job now takes the
  higher core of `apps/server/package.json` and the tag in FORK.md's "Last synced with upstream
  release" line (the checkout is shallow and the fork carries no upstream tags, so
  `git describe` is not an option).
- **Where.** `.github/workflows/sidebar-desktop.yml`, `FORK.md` (Base line).

### 2026-10-16 — Upstream release v0.1.0

- **What.** Brings in upstream's first stable Orchestrator V2 release, `v0.1.0` (204 commits
  past the 2026-10-12 sync). The fork already ran V2, so nothing migrates. New in this step:
  delegated tasks in their own worktrees, and a delegated task's question now wakes its parent.
  Steering no longer ends running subagents. Opt-in cleanup of settled threads' worktrees
  (Settings › Storage), branch deletion after a PR merges or closes, a timer on the Waiting
  status, full-screen visual replies, and Effect 4.0.4 with OpenCode 2.0.28. Also a long list of
  server performance and reliability fixes (SQLite checkpoints off the event loop, thread-list
  reads on large databases, T3 Connect, SSH, Windows) and Claude/Codex/Cursor/ACP fixes. The
  orchestration protocol stays 2, so new fork clients still talk to servers on the previous
  fork build, and the other way round.
- **How.** Conflicts: the desktop product name and its packaging test keep "T3 Code Sidebar"
  (upstream renamed its own app to "T3 Code (Beta)"). "Fork from this response" in `ChatView.tsx`
  keeps the fork's `useForkThread` on upstream's new callback form, without `useCallback`. The
  composer's `/voice` item moved into upstream's rewritten `onSelectComposerItem`
  (`ChatComposer.tsx`). `ThreadFeed.tsx` keeps upstream's new handoff import. Upstream bumped
  Enriched Markdown to `t3.12` (nested list markers) without touching measurement, so the
  Android height patch applies unchanged and is renamed to `t3.12`. Upstream dropped its
  OpenCode and Effect patches; the lockfile is upstream's plus the fork's packages. Effect 4.0.4
  turned `Crypto.randomUUIDv4` into a function, so the inbox calls `randomUUIDv4()`; the old
  form no longer type-checks and would throw when the service is built. The opt-in worktree cleanup keeps a checkout shared by
  several threads, so a parent's checkout survives when the cascade settles its subagents.
- **Where.** `apps/desktop/package.json`, `scripts/build-desktop-artifact.test.ts`,
  `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/ChatComposer.tsx`,
  `apps/mobile/src/features/threads/ThreadFeed.tsx`, `pnpm-workspace.yaml`,
  `patches/react-native-enriched-markdown@1.2.0-t3.12.patch`,
  `apps/server/src/inbox/InboxService.ts`.

### 2026-10-15 — Agent inbox: issues agents raise and own

- **What.** One place for everything agents need to tell the owner. One problem is one **issue**
  with a description, a responsible thread and a full history; repeats and news about an open
  problem update it instead of starting threads. The owner reads and comments on an issue (the
  comment also reaches the responsible agent's thread, labelled "From inbox"), opens that
  conversation, or closes it as not relevant with a reason. Agents run everything else through
  MCP: they comment, keep the description and the "waiting for your answer" flag current, and
  close an issue themselves once the fix is verified; a solved problem that comes back reopens
  the same issue. The inbox icon shows two counters: blue for issues with unread news, red for
  issues waiting for the owner's answer. An issue that waits a day rises to the top again. New
  items raise a desktop notification with sound. One list covers every connected server, with
  the machine on each card. Desktop, web and the phone; `t3ctl inbox`.
- **How.** A standalone service with its own tables (`fork_inbox_issues`, `fork_inbox_entries`
  in `statev2.sqlite`), not orchestration events: v2 events are keyed to a thread
  (`thread_id NOT NULL`) and there is no other aggregate, and an issue is a notification with
  its own lifecycle, not conversation history; scheduled tasks are built the same way. The
  service creates its tables itself (`ensureSchema`, idempotent) instead of a numbered migration:
  the migrator runs only ids above the newest one recorded, so a fork migration in upstream's
  sequence would silently skip upstream's next migration with that number. Each entry carries
  a sequence; an issue keeps `notableSequence` (unread when above `seenSequence`, which every
  device shares), `alertSequence` (what clients announce) and `lastSequence`. Owner comments
  and notices go into threads through `ThreadManagementService.sendToThread` in queue mode,
  with message ids `inbox:<issue>:<entry>:<thread>` and a `[T3 inbox · issue …]` header the agent
  reads and clients strip (`parseInboxDelivery`). When another thread resolves, reopens or takes
  over an issue, or the owner dismisses it, the responsible and creating threads get a notice.
  The server never changes `waitingForOwner` itself; an issue with no thread gets one launched
  (issue's project or the scratch project, default model) on the owner's first comment. A
  scheduler source adds a silent reminder entry once a day while an issue waits. Clients
  subscribe per environment (`inbox.subscribe`, `inbox.subscribeIssue`) and merge the lists.
  Push to the phone is not built: the existing push path needs upstream's T3 Connect relay and
  sign-in. The planned route is the fork's own Firebase project: an FCM key on each server, the
  app registering its token with every server it connects to, and the server sending `action`
  news directly.
- **Where.** Contracts `packages/contracts/src/inbox.ts` (seams: `index.ts`, the RPC group in
  `rpc.ts`, `clientRpcPermissions.ts`); server `apps/server/src/inbox/InboxService.ts` (tests
  next to it), MCP `apps/server/src/mcp/toolkits/inbox/` (seams: `McpHttpServer.ts`, `ws.ts`
  handlers, `RpcAuthorization.ts`, `RpcInstrumentation.ts`, `runtimeLayer.ts`), agent guidance in
  `packages/provider-core/src/server/orchestrationInstructions.ts`, tool labels in
  `packages/shared/src/t3McpToolPresentation.ts` and `client-runtime/src/t3ToolSummary.ts`;
  client logic `packages/client-runtime/src/inbox.ts`, `state/inbox.ts`, the "inbox" attribution
  in `userMessage.ts`. Web: `apps/web/src/components/inbox/` (page, issue view, sidebar button,
  notification coordinator, thread label), `state/inbox.ts`, route `routes/_chat.inbox.tsx`
  (seams: `SidebarChrome.tsx`, `mainAppLocation.ts`, `__root.tsx`, `MessagesTimeline.tsx`). Phone:
  `apps/mobile/src/features/inbox/` (seams: `Stack.tsx`, `MaterialThreadListToolbar.tsx`,
  `ThreadFeed.tsx`, `AppSymbol.tsx`; no iOS toolbar button). `t3ctl inbox …` in the `t3` skill.
  Needs the server running this build; older servers show no inbox.

### 2026-10-15 — Settling a thread settles its agents

- **What.** Settling a thread also settles the agents under it (Claude/Codex subagents and
  delegated tasks), and theirs, so the project can fold into "Quiet projects" without settling
  each agent by hand. Un-settling the thread un-settles them again. This works from every client,
  from agents and `t3ctl`, and for automatic settlement. An agent that is still running, waiting
  on an approval or has a queued message stays active, along with the agents under it; settling
  the thread again later picks it up. Settling or un-settling an agent never touches its parent;
  archived agents are left alone. A new message to a settled thread re-opens only that thread.
- **How.** A server reactor on the committed `thread.settled` / `thread.unsettled` events (only an
  explicit un-settle, not a re-engaging turn) walks the thread's subagent records, checks each
  child's lineage, and dispatches `thread.settle` / `thread.unsettle` with a command id derived
  from the parent event. Each child's own event carries the cascade one level further. A subagent
  thread no longer runs the project's settle script: it shares its parent's checkout.
- **Where.** `apps/server/src/orchestration-v2/ThreadSettlementCascade.ts` (tests in
  `ThreadSettlementCascade.test.ts`). Seams: the reactor's layer in `apps/server/src/server.ts`;
  one guard in `cleanUpSettledThread`, `ThreadSettlementService.ts` (test: "leaves the settle
  script of a parent's worktree to the parent"). Needs the server running this build.

### 2026-10-15 — Move projects into "Quiet projects" and back by hand, per workspace

- **What.** A project's menu has "Move to quiet projects" / "Move to active projects", on the
  desktop and the phone; on the desktop a folder can also be dragged onto the "Quiet projects"
  header or among the other section's folders. The choice belongs to the open workspace: a project
  can be quiet in one workspace and active in another. A project moved by hand stays where it was
  put, even with new activity, until it is moved back; "Fold automatically" returns it to the
  usual rule (it folds once nothing in it needs a look), which is the same in every workspace.
  "Never fold into quiet projects" became "Move to active projects". Agents:
  `t3ctl ws fold <P> quiet|active|auto [<W>]` (W required when P shows in several workspaces).
- **How.** `sidebarWorkspaces.workspaceFold`: workspace id → project key → "quiet" | "active".
  `alwaysShow` (and sidebar.22's `alwaysQuiet`) are legacy and no longer read; the owner's two
  "Never fold" marks were moved into `workspaceFold` for the workspaces those projects showed in.
  Old clients drop `workspaceFold` when they save the config.
- **Where.** `packages/client-runtime/src/state/sidebarWorkspaces.ts` (`projectFoldModeOf`,
  `setProjectFoldMode`), `isProjectQuiet` (`workspaces.logic.ts`) and `isFolderQuiet`
  (`workspaceNavigator.ts`), the folder menus in `WorkspaceSidebar.tsx` and the mobile
  `WorkspaceChrome.tsx`.

### 2026-10-14 — A project in several workspaces

- **What.** A project can show in several workspaces at once: the same project, the same threads.
  Its menu's "Show in workspaces" ticks every workspace it shows in, on the desktop and on the
  phone; the last one can't be unticked. Dropping a folder on a tile moves the project there;
  with Ctrl held it shows there as well (the tile gets a "+"). "No project" works the same way and
  shows in every workspace until it is placed; it still sits last and tiles now count its
  activity. Each workspace keeps its own project order. Opening a thread stays in the open
  workspace when that workspace shows its project, else goes to the first one that does. Pinned
  threads still show everywhere. Agents: `t3ctl ws show|hide <P> <W>`.
- **How.** `sidebarWorkspaces` gains `placements` (project key → workspace ids) and
  `workspaceProjectOrder` (workspace id → its own order, seeded from `projectOrder`). "No project"
  is stored under the key `no-project` (web and mobile key its folder differently).
  `assignments` keeps a placed project's first workspace for clients that predate this; such a
  client still drops `placements` when it saves the config, so update the phone app too. Needs
  the server running this build (an older one drops the new fields).
- **Where.** `packages/client-runtime/src/state/sidebarWorkspaces.ts`
  (`resolveProjectWorkspaceIds`, `toggleProjectWorkspace`, `dropProjectOnWorkspace`,
  `moveProjectInWorkspace`; tests in `sidebarWorkspaces.test.ts`), `WorkspaceSidebar.tsx`,
  `WorkspaceChrome.tsx` (web and mobile), `useWorkspaceHome.ts`, `useSidebarWorkspaces.ts`.

### 2026-10-14 — Pinned threads in every workspace

- **What.** Pinned shows every pinned thread in every workspace, whatever project it belongs to,
  on the desktop and on the phone. Opening one stays in the open workspace; its own workspace's
  tile still counts its activity. Snoozed and settled threads stay in their own workspace.
- **How.** The desktop moves pinned threads into the shared part of the sidebar model (next to
  "No project"); the phone hands the other workspaces' folders to `buildWorkspaceHomeItems`,
  which takes only their pinned threads.
- **Where.** `WorkspaceSidebar.tsx` (`shared.pinned`, `isSharedThread`); `otherFolders` in
  `useWorkspaceHome.ts` and `workspaceNavigator.ts` (test: "shows threads pinned in other
  workspaces, and nothing else of theirs").

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
  the Android app; in a browser the microphone needs https or localhost. Codex only. (Since
  2026-10-16 no first message is needed; see the newer entry.)
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
