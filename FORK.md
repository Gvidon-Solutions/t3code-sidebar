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
  tests pass on the Node version `package.json` pins (26.12.1 since v0.1.2; older Nodes fail
  sqlite, WSL and lint-plugin tests). Upstream tests that check desktop identity (app name, id, profile, `~/.t3-sidebar`, WSL
  runtime dir) expect the fork's values, marked `// Sidebar fork:`. When a merge breaks a test,
  fix the fork code or the test; an upstream test that is broken upstream too is dropped or
  fixed the way upstream later did. Upstream CI does not run here (it triggers on `main`).

## Relation to upstream

- **Base.** Last synced with upstream release `v0.1.7` (`322f6544df`, tagged 2026-11-03) on
  2026-11-06 (merge into `ws`); from now on only stable upstream releases are merged.
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
  `deploy/` excluded): JS bundle → independent Linux runtime archive and Linux installers;
  Windows NSIS consumes the runtime archive without waiting for the Linux installer.
  Runtime publishes first and platform jobs attach their artifacts to `sidebar-v<version>` marked
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
  usually a minute or two; set `T3_ANDROID_SIGNING_ENV` to an explicitly selected signing file
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

### 2026-11-09 — Server correctness and repository cleanliness (audit round 4)

- **What.** Mesh acceptance scripts dispatch to the renamed suites instead of missing round
  scripts. Agent-kit skill directories carry a `.t3-managed` marker; an unmanaged or symlinked
  destination and a symlinked instruction file are left alone and reported. Legacy shared
  instructions are removed only as a whole paragraph before the managed block exists. Settings
  patches send only the changed provider instance (shared `buildProviderInstancePatch`; `null`
  deletes) and omission no longer removes. Release builds refuse `T3CODE_*_TEST_BUILD*`.
  Delivery retries accept only the prefixed legacy `T3_UPDATING:` marker. Fork markers neutralize
  newlines/backticks and emit links only for thread or http(s) schemes. A throwing background stop
  is reported as an error frame; peer credential labels are single-line and bounded. The test bed
  verifies every referenced script path exists.
- **How.** `scripts/referenced-scripts.test.ts` walks shell/Node scripts, `knip.jsonc` and docs;
  `MeshAgentKit` owns marker-based exact sync and refuses links; `withoutLegacyInstructions`
  matches blank-line-bounded paragraphs; `packages/shared` owns the per-instance patch builder;
  `scripts/lib/release-env.ts` guards the CLI, archive and desktop entry points;
  `isDeliveryUpdating` checks the `T3_UPDATING:` prefix; `forkMarker` sanitizes and validates;
  control-socket stop errors become frames; `peerSessionLabel` sanitizes. The dead client
  `meshConfigEditor` and its test/export are removed, and stage-coded names and owner live data in
  the cross-device spec are neutral.
- **Where.** `scripts/mesh-e2e/*`, `scripts/lib/release-env.ts`, `scripts/referenced-scripts.test.ts`,
  `scripts/release-env.test.ts`, `apps/server/src/mesh/{MeshAgentKit,ThreadForkService}.ts`,
  `apps/server/src/run/RunWorker.ts`, `apps/server/src/peer/connection/PeerCredentials.ts`,
  `packages/contracts/src/{delivery,settings}.ts`, `packages/shared/src/serverSettings.ts`,
  `packages/client-runtime/src/state/meshLayoutClient.ts`, `docs/mesh/*`,
  `docs/sidebar-cross-device.md`.
- **Handoff.** Client work switches `AddCodexAccountDialog` and
  `buildProviderInstanceUpdatePatch` to the shared `buildProviderInstancePatch` and adds settings
  help text; this stage does not edit `apps/web`.

### 2026-11-08 — F3b client audit fixes and shared machine decisions

- **What.** Web and Android now make the same choices about a draft's machine, its voice button,
  the connect prompt, remove-copy copy and mobile touch areas. A draft never defaults to an
  offline or model-less remembered machine, cards respect the server's replica capability and
  the selected model, and the machine control stays reachable when the hero cards are hidden.
- **How.** `meshLayout/draftMachine.ts` owns the usable-model predicate, default choice, catalog
  readiness and host cycling; cards carry the replica-capability reason and model guidance and
  refresh an unconnected catalog on connect and every minute. The shared
  `voiceAvailability.ts` applies install/auth/project/model checks and targets the draft's real
  machine. `meshConnectPrompt.ts` ignores already-enabled connections and persists dismissal by
  machine id. `gitVisibility.ts` hides git until the layout loads, and web `useMeshLayout`
  throws without its provider. One `removeRepresentationCopy` model serves both Machines views
  and their footer stacks; machine summaries read the Diagnostics state, so manual copies are
  not called synced. Pending sends keep branch/worktree and use plain error text; Android rows
  gain hit slop through `lib/touchTargets`.
- **Where.** client-runtime `state/meshLayout/{draftMachine,draftMachineCards,meshConnectPrompt,
  projectMachineStrip,replicas,gitVisibility,pendingDraftSend}.ts`, `state/meshMachines.ts`,
  `errors/plainMessage.ts`, `voiceAvailability.ts`; web `ChatView`, `ChatComposer`,
  `DraftMachineCards`, `useDraftEnvironmentRouting`, `WorkspaceSidebar`, `WorkspaceChrome`,
  `useMeshLayout`, `MachinesDialog`, `MeshConnectPrompt`, `PendingDraftDelivery`; mobile
  `new-task-flow-provider`, `NewTaskDraftScreen`, `ThreadComposer`, `ThreadRouteScreen`,
  `WorkspaceChrome`, `WorkspaceThreadLine`, `MachinesSheet`, `MeshConnectPrompt`,
  `useForkThread`, `DraftMachineStatus`, `lib/touchTargets`, `lib/appLinking`.

### 2026-11-08 — Server hardening and repository cleanliness

- **What.** Agent-kit reconciliation keeps a harness's skill and managed block whenever its home directory or a configured provider `binaryPath` exists, so a short service-manager PATH cannot delete them; removal touches only our block. Settings patches can delete one provider instance with `null`. Delivery retries recognise the legacy `T3_UPDATING` marker from older peers. The voice test flag is ignored in production builds. Fork markers escape peer-supplied titles. One invalid SSH route no longer fails adoption between healthy machines, and the run plan names disabled SSH accurately. Peer credential labels include the peer's machine label. The background worker control socket reports only parse and signal errors as invalid requests.
- **How.** `MeshAgentKit` reads provider instances; `ServerSettingsPatch.providerInstances` accepts `null` tombstones; provider-core owns one production-gated voice-flag helper; replica routes are built per machine with skipped-route reasons; `isDeliveryUpdating` checks the tag first, then the legacy message. The bundled-worker smoke test runs `t3 run` exec and background start from the built server.
- **Where.** `apps/server/src/mesh/{MeshAgentKit,ThreadForkService}.ts`, `apps/server/src/replicas/ProjectReplicaService.ts`, `apps/server/src/run/{RunPlan,RunWorker}.ts`, `apps/server/src/peer/connection/PeerCredentials.ts`, `packages/contracts/src/{delivery,settings}.ts`, `packages/provider-core/src/server/testFlags.ts`, `scripts/mesh-e2e/platform-smoke.mjs`.
- **Cleanliness.** Removed the private development logs, renamed stage-coded scripts by function, replaced stage-coded fixture prefixes, made the mobile pairing script read the configured bed, unified shell quoting and sleep helpers, and extended the public-repo leakage test with non-Latin machine names and neutral test names. App ids (`com.gvidon.*`) and the fork repository name stay as the owner decided.

### 2026-11-08 — Required mesh services and shared server runtime

- Mesh services now have explicit production dependencies and test layers. Updating refusals preserve a `DeliveryUpdatingError` tag through RPC/MCP; clients and the CLI retry that tag.
- The remote run worker is compiled TypeScript. Older runtimes receive source generated from those same functions. Downloads verify SHA-256 through one helper; SSH options, bounded socket reads and retry schedules share their platform rules. Timer scaling is an injected Context reference, while retention stays fixed.
- Peer identity upgrade reads belong to the auth service. Server fixture environment names use `MESH_E2E_*`. Shared rules are exercised by delivery, runtime, socket, SSH, timing and identity tests.

### 2026-11-08 — Bounded host admission and reboot recovery

Fast acceptance uses the configured builder host with an eight-mesh default,
two simultaneous container boots and bounded native/Mutagen workers. A kernel
admission lock prevents overlapping gates; ownership labels distinguish boots
and PID generations so a later run safely reclaims abandoned Docker containers,
bridges and published ports. Active and foreign resources remain intact. Host
identity and recovery evidence accompany timings. Implementation and real
subprocess/Docker proofs live in `scripts/mesh-fast/{lifecycle,recovery}.mjs`,
`lifecycle.test.ts` and the `runner-reboot-recovery` scenario.
Fresh bootstrap units use the private pinned Mutagen mirror and assert their
test environment. Measured long scenarios start earlier to avoid a slow final wave.
The agreed fast gate ceiling is six minutes. Native preparation overlaps web and
server builds and records cache-build phases. Fixture storage can use a separate
disk via `MESH_FAST_ARTIFACTS_DIR` without changing service/CLI IPC paths; nested
recovery verifies the selected directory and deletion after success. The runner
defaults to `/data/mf`, removes successful run directories itself, and retains
only compact latest reports plus the last three failed runs with ownership guards.
Paused supervisors close their
watchers and reject late restarts; fast cleanup removes only marked payloads and
preserves external symlink targets. The paused-process regression fails before
the watcher fix and passes afterward. The integration case uses pinned HTTPS/bootstrap
trust and upgrades an already-paired previous release. Focused regressions cover
clock correction after quarantine and asynchronous-pong heartbeat scheduling.

### 2026-11-08 — Legacy release transition

- **What.** Private delivery can upgrade a released server that predates admission drain.
- **How.** A missing drain-status tool selects a bounded running-thread idle check, repeated
  before stop; `--now` skips that wait. The journal identifies this unfenced transition.
  Database backup, serial health checks and rollback remain in force. The next delivery
  probes again and uses drain; rollback to the old runtime preserves its original DB schema.
  Health compares canonical title watermarks across N-1, and restored layout generations/cursors
  reset so peers resend changes acknowledged after the snapshot.
- **Where.** `scripts/delivery/target.mjs`, `rollout.mjs`, `legacy-idle.node-test.mjs`.

### 2026-11-08 — Layout and replica-run data-loss fixes

- **What.** Offline edits survive derived-config upgrades; rejected optimistic writes roll back,
  and authorization failures stay queued. Invalid representation keys cannot crash the sidebar.
- **How.** Canonical key validation, monotonic bounded HLC refusal, shared cycle resolution,
  bytewise clock ordering, thirty-day authorship retention and all-linked-peer tombstone GC.
  `t3 run` refuses an unavailable server when the manifest cannot prove local execution is safe.
- **Where.** Shared `meshLayout`, client-runtime `meshLayoutClient`, server
  `MeshLayoutServiceLive`, `MeshReplicator` and `run/RunClient`; regression tests beside them.
- Delivery admission now waits for in-flight starts without serializing independent providers,
  checks effect-only starts, expires abandoned fences on startup, and preserves typed recovery
  failures while reading deferred ids once per recovery pass.
- Peer receipts reserve keys atomically, retain thirty days and cap stored response bytes at
  64 KiB; migration 83 preserves existing receipts while adding indexed creation timestamps.
- Peer route history and revoked HTTP sessions are collected; session cache identities hash the
  bearer. Heartbeats use their actual deadlines. State backups retain ten completed snapshots
  and collect stale temporary files without replacing a resumed token’s original snapshot.
- Shared retry delays stay between one and fifteen seconds. Fork expiry retries are bounded,
  bootstrap checks readiness before minting a token, and rollout failure injection belongs to
  a test layer. `pair --check` probes a running server without opening its auth database.

- Detached run supervisors validate control messages, retain bounded journals and completed
  records, recover lost completion frames, and stop reconnecting to vanished jobs. Termination
  grace is configurable and normal exits no longer send an unconditional process-group kill.

- Cache migration runs once with server aliases, title registers have a separate family and
  migrated project globs escape literal wildcards. Config inputs require schema one while future
  replicated revisions stay forwardable.
- Full replicas retain failed install fingerprints until retry or lock change. Mutagen lifetimes,
  injected environments, ancestry flushes, login shells, SSH config reloads and every conflict-copy
  location have focused regressions. OTA serving and publishing verify content hashes and cache
  catalog indexes; provider recovery logs include causes and mobile layout failures show a dialog.

### 2026-11-08 — Security and repository privacy

- **What.** Public sources contain neutral infrastructure examples. Linked callers, server-delivered
  desktop UI, bootstrap downloads and native mobile upgrades have explicit trust boundaries.
- **How.** Bed infrastructure comes from one ignored local.env and uses isolated units/homes/keys.
  CI signing is restricted to ws and a protected environment; upstream-only secret workflows are
  removed. Peer permissions come from authenticated link records and declared tool domains,
  unknown peers/tools are denied, and imported links never gain unrestricted file access.
  One-time pairing atomically binds client identity; later calls only verify it. Legacy credentials
  upgrade once only against an existing local link/binding, with an audit trail in mesh status.
  SSH destinations are validated and options terminated. Server UI has a separate origin,
  reduced bridge, guarded IPC and compatibility fallback. APK metadata is signed and bytes
  verified; bootstrap pins host keys/runtime hashes and pairs through HTTPS. Agent defaults
  come from customer config.
- **Where.** scripts/mesh-e2e, delivery scripts/workflow, desktop protocol/preload/IPC, mobile
  updates, server auth/MCP/mesh, shared meshConfig/cliRelease. Focused regression tests and
  the real Electron hostile-server proof cover these boundaries. See docs/mesh/README.md and
  docs/delivery.md for setup, including the owner's one-time GitHub environment configuration.

### 2026-11-08 — Android build caching and private APK delivery

- **What.** Local Android builds retain native outputs, reuse identical APKs and publish native
  upgrades through the existing private mobile-update notice. Public CI caches by native fingerprint.
- **How.** Content-based prebuild invalidation, bounded machine-aware Gradle workers/heap, warm
  daemon, configuration/build caches and scan-free profiles. APKs use the existing signing plugin
  and app identity; hot-lane APKs are immutable OTA-store assets promoted after healthy rollout.
- **Where.** `scripts/delivery/android-{build,release}.mjs`, `scripts/mobile-android-apk.mjs`, delivery assets,
  server `delivery/MobileOta.ts`/catalog, `sidebar-desktop.yml`, `docs/delivery.md`.

### 2026-11-07 — Private delivery and independent release artifacts

- **What.** Private clean/hot builder lanes, serial idle-window delivery with stopped-DB backup
  and rollback, self-hosted signed mobile updates, and server-served desktop UI with bundled
  offline fallback. Public CI publishes runtime before independently attaching installers.
- **How.** Machine names/services/paths stay in untracked local configuration. Hot snapshots
  use a temporary Git index and separate branch. Mobile bundles match the native fingerprint;
  changed native configuration requires an APK. Delivery rejects conflicting managed versions.
  Desktop follows its active connected thread/draft server through validated main-frame IPC,
  preserves the stable storage/preload origin and displays UI/shell versions and source in About.
  Server drain atomically fences run admission, preserves dormant sends across restarts and
  lets active turns finish until a deadline. The delivery service and private delivery share it; clients retry
  transient updating refusals with stable IDs. The delivery service stores the idle deadline in mesh config and
  binds `--now` to one target version; the next normal update clears that permission.
- **Where.** `scripts/delivery/`, `docs/delivery.md`, t3ctl delivery client, server `delivery/`,
  mobile update lifecycle/settings, desktop `app/DesktopUi`, protocol/bootstrap and IPC, web
  `DesktopUiCoordinator`/About source row, and `sidebar-desktop.yml`.

### 2026-11-05 — Mesh rollout and platform runtime

Config-driven SSH bootstrap installs a verified runtime and native service, establishes mutual trust and binds its configured name. Runtime versions roll in lexical machine order under a replicated, unanimously granted lease, with the protocol-3 DB backup and rollback launcher and mesh health checks. Servers distribute their bundled skill and managed instruction blocks, migrate installed legacy instructions once, and read model aliases from config. The shared ServerPlatform boundary absorbs the replica command and peer platforms, native service plans and Windows managed SSH transports. CLI/MCP interfaces, fake service-manager tests, native macOS/Windows CI replica smoke and isolated delivery bed scenarios live beside the mesh services and scripts. See docs/mesh/README.md.

### 2026-11-05 — Replica command execution

- **What.** `t3 run` executes lite-replica commands in the primary environment with live output,
  exact exit status, conflict refusal, background jobs and loopback port forwarding. Threads
  receive the runtime command and configurable guards for commands requiring that environment.
- **How.** Resolve through the local server; flush and inspect the replicas v2 sync APIs; use managed
  `t3-<name>` SSH under the user's login shell. A supervisor owns each foreground process group;
  detached primary jobs have list/logs/stop and a replica forwarding guardian. Flush back and
  name ignored outputs. Shell-only guards preserve native harness Git discovery.
- **Where.** `apps/server/src/run/`, CLI/bin/server seams, replica instructions and mesh runtime
  discovery; provider-core environment injection, Codex/OpenCode/ACP shell seams;
  `packages/contracts/src/meshConfig.ts`, `agent-kit/skills/t3/SKILL.md`.

### 2026-11-05 — Managed SSH and replicas v2

- **What.** Mesh-managed keys, pinned `t3-<name>` SSH hosts over persistent pipes,
  per-peer route status and managed/existing/off modes replace the route matrix.
  Settings receive route checks through reported `sshRoutes` and Mutagen transfer lag through
  `ReplicaLiveStatus.lag`, including byte counts when the total is known.
  Replicas run star sessions on their own servers. Full replicas install and refresh
  environments from lock files; lite replicas receive explicit `t3 run` guidance.
- **How.** Marked SSH blocks preserve foreign content and support isolated test homes.
  Ordered ignore changes recreate stable session names. Conflict policies preserve either
  losing endpoint under Windows-safe names. Per-replica locks and bounded steps isolate
  failures; explicit removal checks unsynced paths and keeps files. A verified archive
  fixture removes live downloads from the Mutagen sync integration test.
- **Where.** Server `replicas/`, SSH facts and mesh planners; machine/settings contracts,
  client driver selection and removal of SSH route editors; standalone `t3ctl` managed-host
  resolution and retry routing; `scripts/mesh-e2e/` isolated bed.

### 2026-11-04 — Mesh config core

- **What.** The mesh is now configured by one desired-state document. Machines, link permissions, replica rules, ignores and conflict policy come from it; a one-time migration writes the first revision from existing settings. Authority is gone from layout, clients, CLI and MCP. Link permissions are enforced on the receiving server, and read-only links cannot read files outside project folders.
- **How.** `mesh.config`/history/bindings/status are validated layout entries. The `MeshConfig` service validates schema and references, plans with registered planners, applies with optimistic concurrency (stale base gets a path diff), rolls back as a new revision, keeps fifty revisions and publishes per-server action status. Planners cover display, links, replica placement through `ProjectReplicaService`, representation ignores and conflict policy; SSH and bootstrap add planners later. The schema accepts JSON or YAML and preserves unknown fields. The receiver resolves the authenticated peer environment id (intersecting candidate policies for ambiguous N-1 labels) and applies `effectiveLinkPermissions`; file checks realpath first, replica and thread handlers check their permission, and an unknown peer gets defaults. Existing links migrate to `files: all`.
- **Where.** `packages/contracts/src/meshConfig.ts`, `packages/shared/src/meshConfig/`, server `mesh/{MeshConfig,MeshConfigPlanners,MeshConfigMigration,MeshLinkPermissions}.ts`, shared `meshLayout/registry.ts`, server `mesh/migration/layoutMigration.ts`, `files/FilesService.ts`, `mcp/toolkits/mesh/`; web/mobile Mesh settings and authority pickers; `agent-kit/skills/t3`.

### 2026-11-04 — Persistent peer connections and SSH byte pipes

- **Layout integration.** Layout pushes use authenticated connection events, and connection-up
  activity resets the replicator backoff through PeerLinks.changes. Reconnect/periodic watermark
  exchanges preserve acknowledgement and tombstone safety.

- **What.** Linked servers keep one bidirectional connection, upgrade one-way links to mutual
  trust, relay through one reachable neighbor and expose the SSH byte pipe used by managed SSH.
  Settings and the CLI report direct, relayed and offline states with failure reasons.
- **How.** Authenticated WebSocket framing multiplexes deadline/cancellable MCP calls,
  notifications and credit-controlled half-closed Duplex streams; deterministic dial selection,
  heartbeat and independent jittered reconnects recover network loss. Durable creation receipts
  and command identities prevent duplicate work across reconnects and restarts. Calls use the
  existing authenticated MCP router; disconnected and N-1 peers retain HTTP fallback. Pipe
  resets leave the link up even when older pipe frames are still in flight.
- **Where.** Server peer/connection services, PeerMcpClient, mesh routing and MCP receipt boundary;
  contracts and client-runtime machine state; web/mobile Mesh settings and t3ctl mesh status.
  The t3 mesh pipe CLI bridges local private IPC to the peer's loopback sshd; its pipe contract is
  documented in docs/mesh/README.md.

### 2026-11-04 — T3 Mesh — Fork to machine, local-only move

- **What.** A thread can be forked to another machine as a new thread with any harness/model/effort; the original stays put and keeps running. Cross-machine "move" is gone. Moving between projects on one machine is a plain local move and needs no model.
- **How.** Fork ensures the destination representation (place replica, wait for sync), flushes the session, copies the transcript through the last completed turn and its attachments, creates the thread with `<title> (fork)`, records links both ways (`meshFork`/`meshForks`), and optionally sends a first message. Target ids are deterministic; target preparation persists an invisible, non-runnable pending fork and a commit token for ten minutes. Commit atomically publishes the thread, history and optional first message. A durable source outbox retries commit with capped backoff; token receipts make retries idempotent. Pending leases and commit intents recover after restart; uncommitted forks expire and delete staging locally. The old handoff receiver and its undo/archive flow were removed; archived "moved to" messages still render as ordinary thread links. Web and Android add "Fork to machine…" with machine titles/labels and target model availability obtained through the source mesh connection; the same-machine move dialog uses project and machine titles. `t3ctl` gains `fork --on` and `move --project`.
- **Where.** contracts `threadFork.ts`/`threadHandoffData.ts`; server `mesh/{ThreadForkService,ForkTransactions,ForkMcp,ForkUploads,forkBundle,forkTransport,forkRecord,ThreadMoveService}.ts`, orchestrator `thread.fork.record`/`thread.fork.linked`; client-runtime `threadCommands`, `meshLayout/threadMove`; web `ForkThreadDialog`, thread menu, sidebar drag and move dialog; mobile `ForkThreadSheet`, move sheet and thread menu; `agent-kit/skills/t3`.

### 2026-11-03 — T3 Mesh — authority and automatic conflict copies

- **What:** a configurable authority, automatic conflict copies, stable project identities, explicit replica folders, safe takeover of manual Mutagen sessions, and recovery across server/daemon/tunnel interruptions.
- **How:** the existing CRDT carries `mesh.authority`, server membership, browser-edit authorship and `proj/<id>.title`. Legacy project keys migrate deterministically to opaque ids and remain aliases; existing session identities survive migration. The driver keeps two-way-safe, preserves the losing files locally or over SSH, then resets and flushes. Manual sessions are paused before takeover and terminated only after private sync watches. Requested paths are validated without reallocating them; obsolete asynchronous checks cannot replace a corrected request. First placements reuse migrated title/repository aliases through one shared record-identity helper; MCP lists and details read the same shared title without rewriting local storage. Scan problems carry non-fatal skipped-file counts and bounded paths; blockers retain messages and failures stay scoped to one copy. Project lookup reads layout metadata, paginated peer records over the existing relay and minimal project catalogs gossiped through existing mesh exchanges, including incoming-only machines; it preserves the actual source machine and never enrolls a representation during a read. Moves prefer a local representation and can prepare one before moving. CLI service control detects user/system units and installs from public releases or linked caches without requiring `gh` authentication.
- **Where:** shared `meshLayout`, contracts, server `mesh/`, `replicas/` and thread context; shared client grouping/moves/status and the `projectEntities.ts` title reader, web/mobile Mesh and Machines; `agent-kit/skills/t3`; isolated-bed resilience scripts.

### 2026-11-03 — T3 Mesh — draft machine selection

- **What:** new-thread composers offer machine tags, connection state and project-copy availability. Drafts retain their text while a replica mounts; a send waits for registration. Model availability offers a machine or local-model correction.
- **How:** both clients reuse logical project resolution and the replica plan, consume replica status for progress and Retry, and persist sends before acknowledgement in a shared outbox, delivered by app-root workers after navigation or restart. Fixed receipt IDs make response-loss retries idempotent. Device preferences remember the project’s selected machine. Provider catalogs follow the destination and unavailable mobile models stay visible and disabled with their reason. Machine names prefer mesh layout identities and label collisions are disambiguated and logged.
- **Where:** client-runtime `meshLayout/{draftMachine,draftMachineChoices,pendingDraftSend}`; web composer routing, environment selector and `DraftMachineHint`; mobile new-task flow, environment control and picker, model options and device preferences. Mesh contracts and server interfaces are unchanged.

### 2026-11-03 — T3 Mesh — agent kit and the mesh guide

- **What.** The `t3` skill (t3ctl), the owner's canonical agent instructions and their machine map now
  live in this repository and are installed from it; one guide explains the whole mesh to agents.
- **How.** `agent-kit/skills/t3` is the source of truth; `agent-kit/install.sh` (dry run by default,
  `--apply` with backups, `--dest` for test beds) copies the skill to every machine and renders the
  instructions through `t3ctl agents sync`. `docs/mesh/README.md` maps the object model, code,
  interfaces, testing, live operations and past lessons; AGENTS.md points to it.
- **Where.** `agent-kit/`, `docs/mesh/README.md`, `AGENTS.md`, `vite.config.ts` (format exclusions).

### 2026-11-06 — Upstream release v0.1.7

- **What.** Brings in upstream's `v0.1.7` (659 changes from 160 contributors). Kiro joins as an
  Early Access provider; administrators get managed policies (including Windows Group Policy);
  one-time scheduled tasks; child approvals answered from the parent conversation; shareable thread
  links that open outside T3 Code; usage filters by provider and model; and a model/reasoning
  switch history in conversations. Plus 591 bug fixes and performance improvements across server,
  providers, desktop, web and mobile.
- **How.** Effect 4.1.2 moved crypto out of `effect/Crypto`: the fork's mesh and inbox services now
  use `SecureRandom.SecureRandom` (`uuidV4()`) and `Digest.Digest`, and their test layers provide
  `NodeCrypto.layer`. The fork's MeshLayout migration first shipped as id 77, which upstream now
  claims, so it is renumbered to 80 and made idempotent; `reconcileForkMeshLayoutMigration` drops the
  old history row so upstream's 77–79 run before it. `layerMcpTransport` now takes a registrations
  layer, so `layerTools` (with the fork's inbox, ui and files toolkits) is passed in, and the mesh MCP
  test passes `Layer.empty`. Upstream dropped the Linux `--class` switch and its `linuxWmClass`
  field; Electron names the window from `setDesktopName`, so the fork drops the field and its
  `StartupWMClass` comment follows the desktop id. The fork still skips xdg-mime registration, and
  its desktop startup test asserts the handler is never called. On the phone, upstream's floating
  tab bar, compact/one-row composer and `ScrollComposeButton` are not adopted: the fork keeps the
  Home-only root, compact FAB with Talk above the dock, and the card composer. The fork does take
  `ComposerDictationError`, `useVisibleThreadShells`, the "Resume thread" label and the memoized
  home scopes. Web keeps `PdfDocumentView` (upstream's new `PdfViewer` PDF tests are dropped), the
  fork's composer menu items (`/voice` beside `workspaceSkillsScanning`), the `progress?.detail`
  update text and the `managedPolicy` contracts export. The new project-grouping label map gains
  `title` ("Group by name"). The new `new-task-flow-provider` test mocks the fork's mesh layout
  because that import chain reaches Expo, which does not load under jsdom. The agent context budget
  takes the measured merge values: 8358 / 10084 / 55771 bytes.
- **Where.** `apps/server/src/persistence/{Migrations.ts,Migrations/080_MeshLayout.ts}`,
  `apps/server/src/{inbox/InboxService,replicas/ProjectReplicaService,replicas/MutagenInstaller,peer/RemoteDelegation}.ts`,
  `apps/server/src/mcp/McpHttpServer.ts`,
  `apps/server/src/replicas/{replicas.testkit,MutagenInstaller.test,Mutagen.integration.test}.ts`,
  `apps/server/src/provider/agentContextBudget.json`,
  `apps/server/src/orchestration-v2/{ThreadForkService,ThreadSettlementCascade.test,Adapters/ClaudeAdapterV2.test,Adapters/CodexAdapterV2.test}.ts`,
  `apps/desktop/src/app/{DesktopApp,DesktopEarlyElectronStartup,DesktopEnvironment,DesktopApp.test}.ts`,
  `scripts/build-desktop-artifact.ts`, `apps/mobile/{app.config.ts,vite.config.ts}`,
  `apps/mobile/src/{App.tsx,lib/appLinking.ts,features/home/{HomeScreen,AndroidHomeFab.android},features/threads/{ThreadComposer,ThreadDetailScreen,new-task-flow-provider.test},features/terminal/ThreadTerminalRouteScreen,features/workspace/WorkspaceRootScreen.android}.tsx`,
  `apps/web/src/{routeTree.gen.ts,sidebarProjectGrouping.ts}`,
  `apps/web/src/components/{chat/{ChatComposer,useComposerMenuItems},files/{BrowserDocumentFrame,AttachmentFilePreview.browser.test},settings/SettingsPanels}.tsx`,
  `packages/contracts/src/{environment,index}.ts`.

### 2026-11-03 — T3 Mesh — Project machine strips

- **What:** project folder rows show primary and replica machine tags, sync status and overflow; all scratch threads share one “No project” folder on web and mobile, including the drawer.
- **How:** a shared pure strip model combines layout representations, live replica status and legacy member environments. Identical chips show primaries, one ⇄ separator, then replicas; only unsynced replicas have status dots. Three chips fit before overflow. Strips open Machines; scratch creation uses the selected machine’s scratch project rather than creating a replica.
- **Where:** `packages/client-runtime/src/state/meshLayout/projectMachineStrip.ts`, `projectGrouping.ts`; web `components/workspaces/{ProjectMachineStrip,WorkspaceSidebar}`; mobile `features/workspaces/{ProjectMachineStrip,WorkspaceChrome,workspaceNavigator,useWorkspaceHome}`, `HomeScreen` and `WorkspaceDrawer`.

### 2026-11-03 — T3 Mesh — global agent instructions

- **What:** one canonical global instruction body with machine headers, drift status, dry-run diffs and backed-up verified sync for installed harnesses. Local `--home` supports isolated eval homes; production-home sync was applied only to nodeB.
- **How:** staged `t3ctl agents sync/status` uses local file operations or pinned SSH routes, with offline render/diff/backup/isolation tests and real Codex/OpenCode eval evidence. Mesh routing resolves configured names and project paths, searches across machines, and runs git on a replica’s primary. General dispatch rules cover API prerequisites and execution location; compact skill tables are excluded from the formatter.
- **Where:** `agent-kit/skills/t3/`, `agent-kit/skills/t3/global/GLOBAL.md`. No product contracts or live machine configuration changed.

### 2026-11-03 — T3 Mesh — session identity and thread access

- **What:** agents can identify their thread and project representation, query threads across the mesh, and address remote threads by id alone. The staged CLI supports the same commands and current pending-question tools.
- **How:** read-only `t3_thread_self` reads local layout, replica runtime and thread lineage; each mesh turn receives a compact identity note (≤600 bytes). MCP routing probes unknown ids through `callRouted`, caches locations and fans out list/search with concurrency four, deadlines and partial failures. Link credentials and mode checks remain authoritative; a full-access intermediary can relay reads to a fenced destination, whose own credential refuses writes. The tool-list budget grows by 242 bytes for the self tool; the dynamic note has its own measured 600-byte ceiling, avoiding full layout injection.
- **Where:** server `mcp/toolkits/thread/self.ts`, `mesh/MeshThreadAccess.ts`, `McpToolAccess.ts`, UI toolkit, `mesh/MeshRelay.ts` and `replicas/ReplicaInstructions.ts`; seams in turn start, Claude's read-only allowlist and additive MCP list/search result fields. Staged skill review copy: `agent-kit/skills/t3/`. No mesh CRDT contracts or service interfaces changed.

### 2026-11-02 — T3 Mesh — Replica acceptance

- **What:** real Mutagen replica acceptance across nodeB, isolated studio and the VPS container, including staged `t3ctl-next`.
- **How:** Settings-model SSH routes, authenticated MCP launches, live status, file and session assertions, conflict/retry, restart, removal and orphan checks. Build-current mode avoids the shared build checkout; deploy copies only the staged skill.
- **Where:** `scripts/mesh-e2e/replica-acceptance.sh` and the accompanying run report/log. Product code is unchanged.

### 2026-11-03 — T3 Mesh — cross-device QA corrections

- **What.** Mesh settings use machine-wide scope; linked machines omit unavailable versions.
  Machine names and short default tags agree across menus and file pickers. Files from another
  machine identify their source in web tabs and the native viewer.
- **How.** Registered replicas retain visible conflict/error rows. Independent Git checkouts can
  split out of repository groups, and stale replica failures do not follow a Git primary. Mobile
  preserves offline workspace folders without duplicate rows or unavailable thread actions;
  mesh controls have accessible names, readable tags and 44-point touch targets.
- **Where.** Fork workspace components on both clients; small seams in settings scope, file
  navigation and web panel tabs; shared display/replica helpers in `packages/client-runtime`.
  CRDT core, RPC contracts and server service interfaces stay unchanged.

### 2026-11-02 — T3 Mesh — web accessibility QA

- **What:** machine tags remain readable with pale custom colors in either theme. Pending
  replica errors and the mesh footer expose their full text in tooltips; Retry names its machine
  for screen readers and keyboard actions show focus.
- **How:** tags use the theme foreground over the existing machine tint; truncated rows reuse
  the shared Tooltip primitive. A browser regression checks pale, dark and preset tag colors.
- **Where:** web `components/workspaces/{MachineTag,PendingReplicaRow,MeshFooterStatus}.tsx`
  and `MachineTag.browser.test.tsx`. No mesh contracts or server interfaces change.

### 2026-11-02 — T3 Mesh — Mesh core E2E

- **What:** repeatable three-machine layout, link, restart, file-routing and old-client checks.
- **How:** authenticated WebSocket RPCs against the isolated mesh bed, document/config hashes,
  legacy key-set comparisons, concurrent edits and server recovery; nonzero exit on failures.
- **Where:** `scripts/mesh-e2e/mesh-core-acceptance.sh` and its recorded core log; no product changes.

### 2026-11-02 — T3 Mesh — Settings and status

- **What:** Settings › Mesh replaces Machines on web and mobile; old Machines routes remain aliases. Machine cards edit names, tags, colors and SSH routes and show connections, peer links, versions, last exchange, replicas and conflicts. Guided full-access linking mints a code on a connected target; manual codes cover other machines. Connect opens the pairing form with the known address, unlink asks for confirmation, and the workspace footer opens Mesh.
- **How:** a shared machine union and status model reads layout, representations, every connected server’s links and per-peer replication watermarks. `meshLayout.status` exposes read-only replication state and refreshes once a minute while observed. The mesh switch writes both server flags together.
- **Where:** `packages/client-runtime/src/state/meshMachines.ts`, `packages/contracts/src/meshLayout.ts`, server `mesh/MeshReplicator.ts` and `ws.ts`; web `components/workspaces/Mesh*`, `hooks/useMeshOverview.ts`, settings routes/nav/search and pairing form; mobile `features/settings/{SettingsMachinesRouteScreen,MeshLinkForm,mesh-settings.logic}`, `features/workspaces/{useMeshOverview,MeshFooterStatus,WorkspaceChrome}`, stack/search and ConnectionsNew prefill.

### 2026-11-02 — T3 Mesh — Mesh skills: `t3ctl` and the `t3` skill

- **What.** The `t3` skill can drive the whole mesh by name: list machines and links, link/unlink,
  place a project on a machine (primary or Mutagen replica) and retry it, start a thread on another
  machine, search/list/status across every linked machine, open a thread or file on any machine,
  print a file from any machine, and migrate legacy layouts through the shared adoption path.
  Machine names resolve generically from environment id/prefix, label, tag, ssh alias and
  transliteration. `doctor` gained a mesh section.
- **How.** `t3ctl` keeps using only the server's MCP and WebSocket RPCs: `meshLayout.get/apply`,
  `replicas.status/retry`, `files.read`, `peerLinks.*`, `t3_thread_search/list/read`,
  `t3_project_place`, `t3_thread_launch` with `environmentId`, and `ui_open` with a target
  environment. `mesh link` mints the pairing code on the target over ssh, like `login`, then links
  with full access. Legacy layouts are encoded with the same rules as
  `@t3tools/shared/meshLayout` into zero-HLC entries, so the server runs `adoptLegacy`; backups go
  to `~/.local/state/t3-mesh-migrate/` first.
- **Where.** `agent-kit/skills/t3/` (`SKILL.md`, `scripts/t3ctl.mjs`, offline and transport tests,
  `scripts/selftest.sh`); staged test-bed installs go to `~/.agents/skills/t3-next`. No server
  contracts or app code changed.

### 2026-11-02 — T3 Mesh — Server replication

- **What:** persistent shared sidebar layout, legacy settings compatibility, server gossip and two-hop tool routing.
- **How:** LWW entries retain HLC conflict resolution; local SQLite sequence watermarks drive replication over full-access peer links. Mesh-only MCP calls stay outside agent tool lists. Old settings writes become per-entry diffs and materialized settings remain readable by old clients.
- **Where:** `apps/server/src/mesh/`, migration 077, `packages/shared/src/meshLayout/adoptLegacy.ts`; seams in server layer assembly, WS handlers, MCP authentication, peer forwarding, RPC contracts, permissions and environment capabilities.

### 2026-11-02 — T3 Mesh — new thread on another machine, and the Machines dialog

- **What.** A folder's "New thread" stays as before; a small chevron beside it opens "New thread
  on…" with every connected machine and its tag. Choosing a machine that has no copy of the
  project records a Mutagen replica and shows a pending row at the top of the folder (tag,
  "Mounting on Cloudbox… 42%", "2 conflicts", or the error with Retry). The new-thread draft
  opens there as soon as that machine registers the project. A folder's menu has "Machines…"
  with every representation: machine, Primary/Replica, path, state, conflicts, Make primary,
  Add replica on…, Retry, and Remove (files stay). The phone gets the same "New thread on…"
  submenu and pending rows in its folder list, a "Machines…" sheet, and a long-press machine
  picker in the new-task project list. Servers without the mesh RPCs are listed disabled with
  the reason.
- **How.** `replicaPlan` turns a logical project and target environment into ready/create/pending;
  `planThreadOnMachine` seeds a legacy folder's primary representation before adding the replica
  (`transport: "mutagen"`, source = first primary, same path). `pendingRows` merges the layout's
  last status with the live `replicas.status` stream, and `replicaStatusCopy` keeps the copy in
  one place. The live streams are subscribed per connected environment that advertises
  `capabilities.meshLayout` and merged by (logicalKey, environmentId). Retry goes to the server
  that drives the session (`replicaDriverEnvironment`). Every layout edit still goes through the
  client's one workspace writer: web `WorkspaceSidebar.writeConfig`, phone
  `useSidebarWorkspaces.updateConfig`, so the mesh writer can replace that seam later.
- **Where.** `packages/client-runtime/src/state/meshLayout/replicas.ts` (+ tests),
  `apps/web/src/components/workspaces/{replicas.logic,PendingReplicaRow,MachinesDialog}.tsx`
  (+ logic test), `WorkspaceSidebar.tsx`, `apps/web/src/state/meshReplicas.ts`,
  `apps/mobile/src/features/workspaces/{replicas.logic,MachinesSheet}.ts*` (+ logic test),
  `WorkspaceChrome.tsx`, `workspaceNavigator.ts`, `useWorkspaceHome.ts`,
  `apps/mobile/src/features/panels/WorkspaceDrawer.tsx`,
  `apps/mobile/src/features/threads/NewTaskRouteScreen.tsx`,
  `apps/mobile/src/state/meshReplicas.ts`. Seams: `replicas.status` in the client's
  subscription tags (`packages/client-runtime/src/rpc/client.ts`);
  `capabilities.meshLayout` in `packages/contracts/src/environment.ts`.

### 2026-11-02 — T3 Mesh — files anywhere and cross-machine `ui_open`

- **What.** Opening any file on any machine in the existing viewer: a machine picker with
  tags, path completion, recent files per machine, `t3-file://<environmentId>/<path>` links,
  and `ui_open` thread/file targets that name another environment.
- **How.** `files.read` / `files.list` read absolute host paths with the project read limits
  (1 MiB preview, binary refusal, 64 MiB hard ceiling, server-state paths refused). They run on
  the machine that holds the file; a connected server forwards over its peer link when the
  client is not connected there, using the `t3_files_read` / `t3_files_list` MCP tools. The
  web dialog marks unconnected machines, remembers one recent list per machine, and opens the
  file in the current thread's panel under the target environment; mobile has the same flow as
  an `Open file` route from a folder's menu. Markdown `t3-file:` links and `ui_open` targets
  carry the target environment; clients that cannot reach it say so and offer Connections.
  `ui_open` keeps `environmentId` optional on thread and file targets, so older callers are
  unchanged. Permission scope is the existing strongest file-read scope,
  `filesystem:read`, on both the local RPC and the forwarded tool.
- **Where.** `packages/contracts/src/files.ts`, `packages/contracts/src/uiRequests.ts`,
  `packages/contracts/src/rpc.ts`, `apps/server/src/files/`,
  `apps/server/src/mcp/toolkits/files/`, `apps/server/src/uiRequests/UiRequests.ts`,
  `packages/client-runtime/src/files.ts`, `packages/client-runtime/src/state/files.ts`,
  `packages/client-runtime/src/uiRequests.ts`, `apps/web/src/components/files/OpenFileDialog.*`,
  `apps/web/src/components/files/openFileDialogState.ts`, `apps/web/src/rightPanelStore.ts`,
  `apps/web/src/components/uiRequests/UiRequestCoordinator.tsx`,
  `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/markdown-links.ts`,
  `apps/web/src/components/CommandPalette.tsx`,
  `apps/web/src/components/workspaces/WorkspaceSidebar.tsx`,
  `apps/mobile/src/features/files/OpenFileRouteScreen.tsx`,
  `apps/mobile/src/features/voice-mode/UiRequestCoordinator.tsx`,
  `apps/mobile/src/features/workspaces/WorkspaceChrome.tsx`.

### 2026-11-02 — T3 Mesh — replicas on other machines (server)

- **What.** Server-side project placement and thread launch on a mesh machine, with managed
  Mutagen replicas and live sync state. Web/mobile placement controls are maintained separately.
- **How.** Mutagen 0.18.1 is SHA256-pinned and uses a private daemon directory. A single driver
  reconciles on startup, layout changes and every 30 seconds; reserved destination paths survive
  restart. State RPCs require project operation permission. MCP places/lists representations,
  waits for registration before a remote launch, and replica prompts name the primary's SSH command.
  server replication supplies the MeshLayoutService port; older graphs return a disabled error without it.
- **Where.** `apps/server/src/replicas/`; seams: server runtime, WebSocket/MCP handlers,
  `peer/RemoteDelegation.ts`, `ProviderTurnStartService.ts`, contracts and the capability descriptor.
  Tests include a CRDT test layer, RPC/MCP/runtime integration and real local Mutagen synchronization.

### 2026-11-02 — T3 Mesh — layout CRDT core

- **What.** Pure shared layout CRDT, legacy migration and logical project operations for Mesh.
- **How.** HLC LWW entries, fractional order keys, lossless materialization/diff and deterministic
  workspace-name unification. Placement values distinguish membership from ordering; workspaceOrder
  and empty markers preserve explicit empty legacy collections. Machine reach carries SSH routes.
- **Where.** `packages/shared/src/meshLayout/` (`@t3tools/shared/meshLayout`), logical projects in
  `packages/client-runtime/src/state/meshLayout/` (`./state/mesh-layout`).
  Seams: optional `layout` in `projectGrouping.ts`; `SidebarMachine.reach` in contracts.

### 2026-11-02 — Machine tags

- **What.** Threads from several machines are told apart in the workspace sidebar and on the
  phone: a small colored tag sits left of the title (after the status glyph) and its tooltip or
  accessibility label carries the machine's full name. Tags appear only where a list can mix
  machines: a folder whose project spans environments, or a cross-project section (Pinned,
  Snoozed, No project, search) while more than one environment is connected. Settings › Machines
  (web and phone) lists connected and layout-referenced environments and edits each one's label,
  tag (up to three characters) and color. The phone loses the always-on right-side machine chip,
  and "No project" uses the same display name.
- **How.** `machineDisplayOf` resolves a machine from the shared layout's `machines` entry with
  fallbacks to the server's own label, the label's first two letters/digits, and a workspace-style
  color derived from the environment id. Machine edits go through `setMachineDisplay` and, until
  the mesh writer lands, through one small helper per client that writes the shared
  `sidebarWorkspaces` setting as before. Upstream's `SidebarThreadRow` takes an optional
  `machineTag` prop, so the default and legacy sidebars are unchanged. The workspace grouping
  helper `spansMultipleEnvironments` decides when tags show.
- **Where.** `packages/client-runtime/src/state/machineDisplay.ts` (+ tests),
  `apps/web/src/components/workspaces/{WorkspaceSidebar,WorkspaceThreadRow,MachinesSettingsPanel,machinesConfig}.tsx`,
  `apps/web/src/components/sidebar/SidebarThreadRow.tsx`,
  `apps/web/src/routes/_chat.settings.machines.tsx`,
  `apps/web/src/components/settings/{settingsSearch,SettingsSidebarNav}.tsx`,
  `apps/mobile/src/features/workspaces/{WorkspaceThreadLine,WorkspaceChrome,workspaceNavigator,useWorkspaceHome,useSidebarWorkspaces}.ts*`,
  `apps/mobile/src/features/settings/{SettingsMachinesRouteScreen,SettingsRouteScreen,settings-search}.tsx`,
  `apps/mobile/src/Stack.tsx`.

### 2026-11-02 — T3 Mesh — clients on the mesh (web + mobile)

- **What.** Web and phone read one replicated layout document from any connected mesh-capable
  server, keep the last snapshot offline and queue edits as idempotent CRDT entries. Logical
  projects group through layout `rep` entries, folder menus merge/split representations and
  suggest same-name merges, and a project that lives only on an unreachable machine shows
  greyed with its tag and a one-tap Connect. Servers without `meshLayout` keep the legacy shared
  `sidebarWorkspaces` path unchanged.
- **How.** `pickMeshSource` prefers the primary (web) or first capable server, failover
  resubscribes on disconnect, optimistic edits dedupe against the server echo, and the outbox
  replays on reconnect. Web caches in `localStorage`; mobile caches in its preferences store.
  `sidebarWorkspaces` leaves the shared-setting fan-out only when every connected server with
  workspaces advertises `meshLayout` (`meshLayoutHandlesSidebarWorkspaces`).
- **Where.** `packages/client-runtime/src/state/meshLayoutClient.ts` (`./state/mesh-layout-client`),
  `logicalProjects.ts` helpers; web `hooks/useMeshLayout.ts`, `state/meshLayout.ts`,
  `components/workspaces/WorkspaceSidebar.tsx`, `sidebarProjectGrouping.ts`; mobile
  `features/workspaces/useMeshLayout.ts`, `useSidebarWorkspaces.ts`, `useWorkspaceHome.ts`,
  `WorkspaceChrome.tsx`, grouping call sites and `persistence/mobile-preferences.ts`. Seams:
  `meshLayout` capability and `MeshRpcs` in contracts, mesh tags in `rpc/client.ts`, the
  disabled server RPC seam in `apps/server/src/mesh/`, RPC scopes/instrumentation, and
  `splitSharedServerPatch`.

### 2026-11-01 — Upstream release v0.1.6

- **What.** Brings in upstream's `v0.1.6` (521 changes past the v0.1.5 sync). Side chats answer
  without derailing the main thread; favorite projects can be pinned and old ones archived;
  local commits show in the Diff pane; 1Password supplies provider and source-control
  credentials; the Android Usage page survives layout changes; and the terminal keeps focus on
  hardware Enter. Upstream also reworked file previews with a paged PDF viewer and file cards;
  the fork keeps its continuous `PdfDocumentView`. Plus many server, provider, desktop and
  mobile fixes and performance work.
- **How.** Side chats join the fork's imported-thread fork path in the orchestrator, so both
  the legacy history copy and upstream's digest-backed side chat work. Composer slash commands
  keep the fork's `/voice` next to upstream's `/side` and `/btw`. The inbox keeps its
  attribution and uses upstream's presentation text for context chips. The phone keeps the
  fork's Home-only root and compact composer; upstream's Usage-preservation fix applies in
  split view, and the test now covers only that path. The Android terminal takes upstream's
  `TerminalEnterListener`, which already swallows the hardware Enter key-up, so the fork's
  custom else branch is gone. `PdfDocumentView` stays; upstream's workspace-PDF tests for its
  paged `PdfViewer` are dropped. The agent context budget takes upstream's new baseline plus
  the fork's measured additions. The scratch environment label comes from the connected
  environment again. `forceStopThread` joins the guarded RPC scopes beside the fork's inbox
  methods.
- **Where.** `apps/server/src/orchestration-v2/{Orchestrator,ThreadForkService.test,Adapters/CodexAdapterV2.test}.ts`,
  `apps/mobile/src/features/workspace/{WorkspaceRootScreen.android,workspace-tabs-state.test}.tsx`,
  `apps/mobile/src/features/threads/{ThreadComposer,ThreadFeed,NewTaskRouteScreen}.tsx`,
  `apps/mobile/modules/t3-terminal/android/.../T3TerminalView.kt`,
  `apps/web/src/components/chat/{ChatComposer,TimelineUserMessageRow,useComposerMenuItems}.tsx`,
  `apps/web/src/components/files/{BrowserDocumentFrame,AttachmentFilePreview.browser.test}.tsx`,
  `apps/web/src/{composer-logic,composer-logic.test}.ts`, `apps/web/src/hooks/useThreadActionMenu.ts`,
  `packages/client-runtime/src/userMessage.ts`, `packages/contracts/src/clientRpcPermissions.ts`,
  `packages/provider-core/src/server/orchestrationInstructions.ts`,
  `apps/server/src/provider/agentContextBudget.json`.

### 2026-11-01 — APK install survives the system's cache cleanup

- **What.** Settings › About › Version history no longer fails with "The file is no longer
  available" after the download finishes. The APK is downloaded into the app's documents
  directory instead of cache, its size is checked against the release asset before Android's
  installer opens, and a low-storage or vanished file now explains itself instead of exposing
  the native error.
- **How.** Android trims app cache when storage runs low and can unlink a freshly downloaded
  APK while it is being written, so the file was gone by the time `T3NativeControls.openFile`
  checked it. `installApkFromUrl` keeps one APK in `t3-installer-downloads` under
  `Paths.document`, replaces it on the next install, checks free space from
  `Paths.availableDiskSpace` and rewrites the native "no longer available" failure.
- **Where.** `apps/mobile/src/lib/attachmentDownload.ts`,
  `apps/mobile/src/features/settings/ForkVersionHistory.tsx`.

### 2026-11-01 — Group projects by name across machines

- **What.** A new project-grouping mode, "Group by name": projects with the same name appear as
  one sidebar row on any machine, whatever their folders or git identities. It fixes the phone
  showing, for example, two "CALF Wrapper" folders because one copy lives on studio and the
  other on Cloudbox over SSHFS with no detected repository.
- **How.** `deriveTitleScopedKey` normalizes the title (trim, collapse whitespace, lower case) and
  becomes the logical key for the `title` mode; grouping is client-side, so older servers need no
  change. Available in Settings › Organization on the phone.
- **Where.** `packages/contracts/src/settings.ts`,
  `packages/client-runtime/src/state/projectGrouping.ts`,
  `apps/mobile/src/features/settings/SettingsProjectGroupingRouteScreen.tsx`,
  `apps/mobile/src/persistence/mobile-preferences.ts`,
  `apps/web/src/components/settings/SettingsPanels.logic.ts`.

### 2026-10-31 — Quick model switching works in new-task drafts

- A new-task draft reuses the thread composer, but its quick model sheet wrote settings to the
  synthetic draft thread instead of the flow draft the task starts from. Picking a model,
  reasoning level or runtime now updates the draft itself, so the chip and the started task agree.
- Where: `apps/mobile/src/features/threads/ThreadComposer.tsx`,
  `apps/mobile/src/features/threads/composerSettingsKey.ts`.

### 2026-10-31 — Release APK version survives native cache reuse

- The Android release job stamps `versionName` in the generated Gradle project before every
  build, including cache hits. It rejects a missing version field or invalid release version;
  `versionCode` stays 1 so installing over another fork build keeps its data.
- Where: `.github/workflows/sidebar-desktop.yml`.

### 2026-10-30 — Upstream release v0.1.5

- **What.** Brings in upstream's `v0.1.4` and `v0.1.5` (286 commits past the v0.1.3 sync). A
  "No project" thread can be turned into a project; Antigravity gets Claude and GPT models,
  thinking levels and diff edits; the thread details card shows what you pick, usage limits
  included; Settings switches every installation between Stable and Nightly in one step; new
  threads avoid providers that just hit a usage limit; guest links no longer expose diffs; Claude
  edits open as diffs; Electron 44.10 fixes a Brotli CVE; the undo notice moves to the sidebar
  footer; `t3` starts on Ubuntu without libatomic. Upstream removed its legacy sidebar (the
  "boring sidebar" groups threads into project folders instead), the redesign toggle, the
  in-memory projection store, the per-file effect budget and about 18k lines nothing reached. On
  the phone: "Use last project" for new threads, two-pane Android Settings, an optional One UI
  floating tab bar, link requests for other machines in the composer.
- **How.** Web: the sidebar switch picks the workspace sidebar or upstream's sidebar (the legacy
  option is gone with upstream's file, so is its Settings row). The voice button sits in front of
  upstream's new composer controls; `isServerThread` comes from `routeKind`. The inbox composer
  imports `ComposerPromptEditorTiptap`, the workspace sidebar reads grouping settings and
  `isThreadWorking` from client-runtime. Desktop: `followFeed` keeps its own downgrade flag next to
  upstream's `check({ allowDowngrade })`; the fork still skips the xdg-mime URL handler but runs
  upstream's startup recovery. Server: the voice session layer uses the renamed event sink and
  adapter registry layers; the inbox and ui tools join upstream's `layerTools`, and the agent
  context budget test mocks their services. Upstream's new `agentContextBudget.json` holds the
  fork's measured sizes: its inbox, `ui_open` and voice instructions and tools add about 3.2 KB to
  Claude's and Codex's text and 6.3 KB to the MCP tool list. Mobile: the phone keeps the fork's root (Home only,
  dock instead of navigation, compact FAB with Talk), so the floating tab bar does not apply
  there; the composer keeps the fork's card layout and takes upstream's environment mentions;
  upstream's knip pass had unexported `useThreadProjection`, `useThreadVisibleTurnItems`,
  `composerAttachmentWireMimeType` and `ComposerSurface`, which fork files use. Lint: upstream
  replaced `scripts/effect-budget.json` with `t3code/no-unreasoned-state-sync`, so each fork
  effect now names what it keeps in step; `fileContextMenu.ts` no longer throws inside `try`, so
  the React Compiler compiles it again. The enriched-markdown patch still applies to the vendored
  `t3.16` tarball.
- **Where.** `apps/web/src/components/{AppSidebarLayout,CommandPalette}.tsx`,
  `components/chat/{ChatComposer.tsx,useComposerSend.ts,useComposerMenuItems.ts}`,
  `components/settings/{SettingsPanels.tsx,settingsSearch.ts}`, `components/inbox/InboxComposer.tsx`,
  `components/workspaces/{WorkspaceSidebar.tsx,workspaces.logic.ts}`;
  `apps/desktop/src/{preload.ts,app/DesktopApp.ts,updates/DesktopUpdates.ts}`,
  `packages/contracts/src/{ipc,provider,settings}.ts`, `packages/provider-core/src/server/snapshotProbe.ts`;
  `apps/server/src/orchestration-v2/runtimeLayer.ts`, `mcp/McpHttpServer.ts`,
  `provider/{AgentContextBudget.test.ts,agentContextBudget.json}`; `apps/web/src/fileContextMenu.ts`; `apps/mobile/src/{Stack.tsx,lib/modelOptions.ts}`,
  `features/threads/{ThreadComposer,ThreadFeed,ThreadDetailScreen,thread-list-v2-items}.tsx`,
  `features/home/{HomeScreen,HomeRouteScreen}.tsx`, `state/use-thread-detail.ts`,
  `lib/attachmentUpload.ts`; fork files with effects (lint reasons).

### 2026-10-28 — Upstream release v0.1.3

- **What.** Brings in upstream's `v0.1.3` (about 500 changes past the v0.1.2 sync). Share a
  thread with a guest who watches live and sends messages you approve (Labs); Cmd+K finds the
  right thread first with indexed message search; web Settings and Usage open as large modals
  over the thread; a redesigned UI behind a Beta toggle; previews for office files, fonts,
  archives, SQLite, notebooks and more, audio played inline, PDFs sent to Claude as documents;
  follow-ups steer the running turn by default; the Working section in the sidebar is on by
  default; agent instructions are 60% shorter. On the phone Settings becomes a workspace page,
  video and audio play inline, and the terminal and thread list were rewritten. Plus many
  server, provider and source-control fixes. Upstream promoted its React and Effect lint rules
  to errors and added a per-file React effect budget.
- **How.** Mobile: the enriched-markdown patch is re-created on `t3.16`. The thread list uses
  upstream's `useThreadListV2`, which the workspace Home feeds its project refs and rows. The
  terminal seams (pager tabs, extra keys, "Attach output to chat") sit on the rewritten
  `ThreadTerminal`, with `useTerminalExitNavigation` taking a `pager` exit. The model settings
  sheet is now a route driven by params, so the fork's quick model sheet builds its own session
  and writes the thread draft's settings. The list toolbar's gear opens the new `Settings`
  route. Fork navigation to a thread (fork-from-run, voice, inbox, the drawer) goes through
  `useSelectWorkspaceDetail`. The inbox drops its video modal for upstream's inline playback.
  Sending keeps the keyboard up, as before. Web: the fork's coordinators stay in `__root.tsx`
  next to upstream's moved ones; the thread menu has the fork's agents item and upstream's
  "Share with guest", which the workspace sidebar passes too; the inbox attribution is checked
  before the guest one. The fork's `PdfDocumentView` stays and upstream's `PdfViewer` is unused.
  Server: agent instructions append the fork's inbox, `ui_open` and voice sections to upstream's
  rewritten text; file downloads merge with upstream's media downloads; the inbox provides
  `DocumentText` to message intake. Lint: fork files are added to `scripts/effect-budget.json`
  at their current counts, long fork comments are cut to four lines, and the voice carry-over
  test waits on a `Deferred` instead of polling.
- **Where.** `patches/react-native-enriched-markdown@1.2.0-t3.16.patch`, `pnpm-workspace.yaml`;
  `apps/mobile/src/features/home/{HomeScreen,ThreadListToolbar,thread-swipe-actions}.tsx`,
  `features/terminal/{ThreadTerminalRouteScreen.tsx,useTerminalExitNavigation.ts}`,
  `features/threads/{ThreadComposer,ThreadDetailScreen,ThreadFeed,ThreadRouteScreen,NewTaskDraftScreen}.tsx`,
  `features/workspaces/useForkThread.ts`, `features/voice-mode/`, `features/inbox/`, `Stack.tsx`;
  `apps/web/src/routes/__root.tsx`, `hooks/useThreadActionMenu.ts`,
  `components/{threadActionMenu.logic.ts,workspaces/WorkspaceSidebar.tsx,files/BrowserDocumentFrame.tsx}`;
  `apps/server/src/assets/AssetAccess.ts`, `orchestration-v2/ProjectionStore.ts`,
  `inbox/InboxService.ts`, `packages/provider-core/src/server/orchestrationInstructions.ts`,
  `packages/client-runtime/src/userMessage.ts`; `scripts/effect-budget.json`.

### 2026-10-24 — PDFs keep their place on rebuild; Download in the file menu

- **What.** A PDF in the side panel no longer jumps to page one when the file changes (a LaTeX
  rebuild): the new revision renders behind the shown one and replaces it at the same zoom and
  scroll offset. The view has zoom, fit-width, reload and "Open in browser" buttons, and
  Ctrl/⌘+wheel zooms. Every file's right-click menu (file tree, diff, chat) has **Download**, which
  saves any file, not just previewable ones, from any client.
- **How.** pdf.js (`pdfjs-dist`, loaded only when a PDF opens) replaces the native `<embed>`;
  its stylesheet is wrapped in `@scope` because it sets `color-scheme` on `:root`. A revision
  that fails to parse (still being written) keeps the last good one. File asset resources take
  `disposition: "attachment"`, which skips the preview-type check and signs a one-file download
  URL; the client fetches it into a blob so the desktop shell does not hand it to the browser.
- **Where.** `apps/web/src/components/files/{PdfDocumentView.tsx,pdfStack.ts,BrowserDocumentFrame.tsx}`,
  `apps/web/src/fileContextMenu.ts`, `apps/server/src/assets/AssetAccess.ts`,
  `packages/contracts/src/assets.ts`.

### 2026-10-23 — Upstream release v0.1.2

- **What.** Brings in upstream's `v0.1.2` (260 commits past the v0.1.1 sync). Mermaid diagrams
  render with pele; the composer stays usable during approvals, and sending declines and
  redirects; approvals in full access say why Claude asked; messages from other agents and
  automations fold into one-line rows; `t3 thread` starts, messages and reads threads from the
  terminal; Claude idle compaction gets a global default with per-instance overrides. The phone
  catches up with web: model controls with provider-instance badges, plans, wake status and
  elapsed time on thread rows, undo for archive and thread actions, background work and status
  actions, project and checkout removal. Plus many server, provider and web fixes. Upstream
  deleted about 11k low-signal tests and lints tests against timeouts, wall-clock reads and
  polling. The repo moves to Node 26.12.1 and pnpm 12.14.0.
- **How.** Web: upstream split `MessagesTimeline`, `ChatView` and `ChatComposer`, so the seams
  moved with the code. The inbox attribution is in `TimelineUserMessageRow`, fork-from-run in
  `useTimelineRewind` (through `useForkThread`), `/voice` in `useComposerSend`, and the voice
  slash item in `useComposerMenuItems`. `ChatComposer` keeps the voice button, strip, F8/mute
  keys and `toggleVoice` handle. Mobile: the new-task draft is now the `Thread` route with a
  `draft` param, rendered by `ThreadDetailScreen` and `ThreadComposer`. The fork's composer
  layout (card when focused, ⤢, model chip with effort) stays and takes upstream's submission
  lock, paste handling, height reporting and bottom gutter. The chip shows upstream's
  provider-instance badge; upstream's `ComposerModelControl` and the unused `fab-scroll` are
  dropped. The draft gets voice through a `draftVoice` prop (`NewTaskDraftScreen` creates the
  voice thread and switches the route to it). On Android the thread pager mounts the shared
  thread screen on its chat page through `ThreadScreenInlineOutlet`, and the tab strip sits in
  the header. Share-into-open-draft, the drawer's new thread and cold-start share navigate to
  the draft route. The camera source moved into `useComposerAttachmentActions`.
  `workspaceNavigator` fills the now-required `wokeAt`. Tests: where upstream deleted a test
  file, the fork's cases in it go too (desktop identity, packaging, shared settings); the fork's
  own cases in surviving files stay. The Codex voice-handoff test waits on the harness's change
  signal instead of the removed polling helper. CI: the CLI single-executable builds on
  `engines.node`, which upstream now requires; the pinned `VP_NODE_VERSION` is gone.
- **Where.** `apps/web/src/components/chat/{TimelineUserMessageRow,ChatComposer}.tsx`,
  `chat/{useTimelineRewind,useComposerSend,useComposerMenuItems}.ts`, `AppSidebarLayout.tsx`,
  `CommandPalette.tsx`;
  `apps/mobile/src/features/threads/{ThreadComposer,ThreadDetailScreen,NewTaskDraftScreen,ThreadScreenHost,ThreadRouteScreen,ThreadSettingsSheet,ThreadFeed,NewTaskRouteScreen}.tsx`,
  `state/use-composer-attachment-actions.ts`, `features/panels/WorkspaceDrawer.tsx`,
  `features/workspaces/workspaceNavigator.ts`, `Stack.tsx`, `components/ComposerToolbar.tsx`,
  `lib/modelOptions.ts`, `app.config.ts`;
  `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`;
  `.github/workflows/sidebar-desktop.yml`.

### 2026-10-31 — Phone model picker and machine labels

- Quick-switch model taps pass through the horizontal scroll view while the keyboard is open.
  Holding a model opens its shared nickname editor, which accepts emoji names.
- No project folders, workspace thread rows and the new-task project picker show the destination machine.
- Files: `QuickModelSheet.tsx`, `ThreadSettingsSheet.tsx`, `NewTaskRouteScreen.tsx`,
  `workspaces/WorkspaceChrome.tsx`, `workspaces/WorkspaceThreadLine.tsx`.

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

- **What.** Workspaces (e.g. personal / studio / research / learning) as square
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

### 2026-11-03 — T3 Mesh — Project moves and names

- **What.** Move an idle thread between projects or linked machines from the workspace sidebar or
  the phone's long-press menu. Web supports dragging onto a project and undoing the move.
  Rename logical project folders across connected representations.
- **How.** `thread.move` preserves thread metadata and history and refuses unfinished work.
  Local threads take the destination project root; worktree threads keep their checkout.
  Cross-machine moves use a link-only, retryable handoff: copy the visible transcript and uploaded
  attachments, seed the destination's first context without starting a turn, and archive the source
  with reciprocal environment-aware links. Remote moves ask for confirmation and allow ten seconds
  to undo. `t3_thread_move` and `t3ctl move --project X --on M` use the same service. Logical names use
  `proj/<logicalKey>` LWW entries materialized as decoding-defaulted `projectTitles`; clients
  update each reachable physical project and prefer the layout title.
- **Where.** `apps/server/src/mesh/ThreadHandoffService.ts`, attachment upload store, orchestrator
  and MCP thread/project toolkits; shared `meshLayout`; client-runtime
  project grouping/thread commands; web `workspaces` and mobile `workspaces`/thread menus.

### 2026-11-03 — Move with target model

- Move confirmation on web and mobile reuses the composer model/options picker against the destination environment. It preserves the current selection or chooses the destination catalog default with a notice.
- `threads.move`, MCP `t3_thread_move` and `t3ctl move --agent/--model/--effort` carry the target selection. Local moves update it atomically; cross-machine moves import plain conversation context into the selected harness. Forks discard source handoff ownership so they can move independently.
- Implementation: workspace move dialogs/sheets, shared `meshLayout/moveModel`, `ThreadHandoffService`, orchestration move command and `ThreadForkService`.

### 2026-11-03 — Customer-independent machine configuration

- **What.** Machine aliases are editable in Settings › Mesh on web/desktop and mobile, and with `t3ctl machines alias`. Machine names and provider defaults come from customer configuration.
- **How.** Optional aliases share the existing `machine/*` CRDT entry. The CLI matches ids, labels, tags, aliases and SSH destinations without a built-in machine dictionary, preserves other machine fields, and advances beyond observed layout clocks. Unspecified thread model/permissions stay with the destination's defaults; explicit model discovery targets that machine. Agent-kit installation and instruction sync use registry-defined SSH routes, relays, home-relative paths and remote Node commands.
- **Where.** `SidebarMachine`, client-runtime machine display/overview helpers, web `MeshSettingsPanel`, mobile `SettingsMachinesRouteScreen`, and `agent-kit/`. Regression fixtures use synthetic customer names and paths; personal installation data stays in `agent-kit/skills/t3/global/`.

### 2026-11-04 — Layout replication hardening

- **What.** Layout entries validate against known family schemas while newer families remain
  opaque. Corrupt stored entries are quarantined; clock rejection counts and examples are visible
  in mesh status. Offline workspace edits use one application store and survive persistence reload.
- **How.** Bound HLC generation and reception to five minutes ahead, exchange store generations
  alongside sequence watermarks, debounce layout pushes by 200 ms, retry failed peer exchanges
  on a 1–15 s backoff, exchange safety watermarks every minute, and collect thirty-day
  tombstones only after linked-peer acknowledgement.
  Canonical key migration removes obsolete persisted rows atomically.
- **Where.** Shared `meshLayout/registry.ts` (canonical config contracts), `hlc.ts` and `migration/`; server
  `MeshLayoutServiceLive.ts`, `MeshReplicator.ts` and `mesh/migration/`; client-runtime
  `MeshLayoutStore`, web/mobile `useMeshLayout` providers and application roots.

### 2026-11-05 — Mesh state and agent-facing config editing

- **What.** Settings › Mesh presents machine state and offers "Set up the mesh with an agent"
  ("Fix with an agent" when status is unhealthy); the agent edits the config through `t3ctl` or
  the `t3_mesh_config_*` tools. Plan/apply uses optimistic revision checks; history restoration
  uses the same flow. Forgotten machine facts can be removed separately from active links.
  Compact machine rows merge repeated connections by environment ID and keep opaque hostnames out
  of display names. Apply summaries group human action names by revision; lag and SSH route
  checks accept peer reports. Migration metadata stays outside the editable document, including
  existing history revisions.
- **How.** Config editing lives in the server, contracts, CLI and MCP; web and mobile only render
  state and launch the prepared agent thread. Replica git ownership is shown as
  `git on <machine> · t3 run`; longer project names collapse the machine strip. Fork machine
  selection uses the app combobox and model failures expose provider settings.
- **Where.** Web `workspaces/MeshSettingsPanel`, `ForkThreadDialog`, `BranchToolbar`; mobile
  `settings/SettingsMachinesRouteScreen`, thread context pickers; shared `meshMachines`,
  `meshLayout/replicas`.

### 2026-11-05 — Machine name collision recovery

- **What.** Independently installed servers with equal hostnames keep distinct mesh names;
  older unbound servers repair their identity on startup. Moving a machine's config key keeps
  its binding. Equal titles show platform/host hints, and offline ages use compact durations.
- **How.** Environment-keyed join claims survive replication; deterministic suffix allocation
  repairs the config with a normal history revision. Forget removes claims along with bindings.
- **Where.** Shared `meshConfig/identity`, server `MeshConfig`/`MeshConfigMigration`, shared layout
  registry/diff, client-runtime machine displays, web and mobile Mesh settings.

### 2026-11-05 — Managed agent instructions and schema refusal

- **What.** Servers reconcile bundled t3 skills and managed mesh instruction blocks from config.
  A future-schema config is retained for forwarding and reported as unsupported without running
  local reconciliation.
- **How.** The agents planner installs skills independently of the instruction-management switch,
  validates all existing instruction markers before writing and preserves surrounding text.
  Test homes and skill sources are overridable. CLI archives include the skill without personal data.
- **Where.** Server `mesh/MeshAgentKit.ts`, `MeshConfigPlanners.ts`, `MeshConfig.ts`, config
  contracts and `scripts/build-cli-archive.ts`.

### 2026-11-05 — Shared server platform boundary

- **What.** Replica SSH and remote command execution use one server platform module.
- **How.** Consolidates replica command login shells, invocation resolution and worker/guardian IPC with peer SSH wrappers, private mesh sockets and conflict-copy naming; old module files are removed.
- **Where.** `apps/server/src/platform/ServerPlatform.ts`; existing run, peer and replica platform tests now import it directly.

### 2026-11-07 — Upstream v0.1.7 integration into Mesh v2

- **What.** Integrates upstream v0.1.7 and managed policy with every Mesh v2 stage.
- **How.** Peer refusals preserve link health on both persistent and HTTP transports; address
  discovery refreshes peer names while persistent connections retain incoming-only reachability.
  Upstream migrations keep ids 77–79, MeshLayout uses 80 and PeerConnections 81. Legacy fork
  histories reconcile before migration, retaining layout and call receipts. Mesh cryptography
  uses Effect 4.1.2 Digest/SecureRandom; MCP registrations use the transport-owned request context.
  Portable forks exclude terminal checkpoint bookkeeping, keeping the actual final reply visible
  when imported assistant rows are grouped. The measured tool-list budget grows to 60846 bytes
  with upstream's expanded tools.
  Config reconciliation preserves the HLC of an unchanged status, allowing layout replication
  to become quiescent after a completed action and across server restarts.
  Bed rounds with live status reports verify delivery through a captured all-entry HLC barrier;
  round one retains strict full-document equality.
  Round two uses the v2 config API and managed SSH aliases instead of the legacy key installer.
  Explicit-folder validation uses the configured project ignores, matching the replica session.
  Cancelled peer-pipe callbacks run as scope-owned background fibers with error reporting,
  so replacing a connection cannot terminate the server with an unhandled Promise rejection.
- **Where.** PeerLinks/PeerMcpClient and connection transport, persistence migrations/tests,
  mesh services, replica installer, MCP tool dependencies, mobile model catalog and client tests.

### 2026-11-08 — Fast mesh acceptance and realistic nightly suite

- **What.** Ports the bed rounds and CONCEPT §12 into isolated fault, replica,
  crash, run, fork, configuration, bootstrap, rollout and browser scenarios.
  One command reports each result, wall time and JUnit, retaining failure evidence.
- **How.** Private homes, sshd, Mutagen daemons, bridges and fault proxies; a
  production-guarded timer multiplier; deterministic ACP profiles for fast turns.
  Real provider turns remain nightly. A single bed inventory feeds the realistic
  wrapper, with a worker user timer and failure-only summary/inbox reporting.
  Product tests use neutral machine fixtures and shared branding constants.
- **Where.** Coverage and operation: `scripts/mesh-fast/README.md`; timers:
  `apps/server/src/mesh/MeshTiming.ts`; nightly:
  `scripts/mesh-e2e/{acceptance,install-nightly}.sh`; CI: `mesh-fast.yml`.

### 2026-11-07 — Post-release upgrade fixes

- **What.** Preserves project machine chips through legacy cache upgrades, avoids false offline
  footer reports, uses existing SSH hosts for remote commands, preserves replica ignores and
  seeds code-only defaults for new meshes. Managed instructions identify their own machine.
  Interrupted automatic conflict resolution recovers its owned pause without resuming user pauses.
  Legacy settings writes preserve concurrent workspace renames while repairing sort collisions
  and keep separate RPC-client baselines advanced from the merged response.
  Bed uploads share the configured SSH/sudo transport when the third node moves hosts.
  Acceptance profiles isolate state while preserving the shared bed's existing data.
  Local SSH sockets send split records promptly instead of waiting for delayed TCP ACKs.
- **How.** Canonicalizes cached layout keys, prefers live connectivity, resolves migration titles
  from the project catalog, and keeps representation ignores until config owns every pattern;
  clearing that legacy copy allows later ignore removals. Ignore plans leave native
  representations untouched when no legacy ignore field exists.
- **Where.** Client-runtime mesh state, mobile fixtures, server run/mesh/replica services,
  contracts defaults, shared config migration and mesh acceptance scripts.

### 2026-11-08 — Bound SSH routes during adoption

- **What:** Existing sync sessions remain adoptable after machine display titles change.
- **How:** Resolve their endpoints through the stable machine bindings and managed or existing SSH hosts; ambiguous hosts remain rejected.
- **Where:** `apps/server/src/replicas/adoptionModel.ts`, `ProjectReplicaService.ts` and their tests.

### 2026-11-08 — Public repository hygiene

- **What.** Remove captured bed output and personal fixture names from public sources.
- **How.** The leakage guard covers private hosts, project names and legacy server paths in
  scripts/docs. Workflow policy now checks every workflow for explicit read permissions and
  immutable action revisions; Node setup reads the root package metadata.
- **Where.** `scripts/public-repo-leakage.test.ts`, `scripts/security-workflows.test.ts`,
  `.github/workflows/`, mesh evaluation and workspace fixtures.

### 2026-11-08 — Shared mesh primitives

- **What.** Keep hop identity checks and pinned Mutagen release metadata consistent across
  transports and installation fixtures. Retention durations remain real time in accelerated tests.
- **How.** Shared peer header parsing/formatting and relay validation; one Mutagen release catalog;
  named tombstone, receipt and backup retention; a common TCP port schema. The replica layout
  fixture lives under testFixtures. Retired bed runners are removed; platform smoke uses the fast
  client's RPC/MCP implementation. Round two accepts isolated source paths and titles.
- **Where.** `peer/connection/peerIdentity.ts`, `platform/mutagenRelease.ts`, `mesh/retention.ts`,
  contracts `baseSchemas.ts`, `scripts/lib/shell.mjs` and mesh acceptance scripts.

### 2026-11-08 — Shared client orchestration and neutral fixture names

- **What.** Web and mobile keep only their platform adapters for durable draft launch, sidebar
  forks and replica machine choice; the rest of the orchestration is shared client-runtime code.
- **How.** `launchPendingDraft`/`pendingDraftMachines`, `runThreadFork`, shared machine-choice,
  pending-row, lag, candidate, remove and adopt helpers; internal layout transforms moved off the
  public entry and dead helpers removed. Delivery and mesh scripts share one managed-sshd writer
  and shell helpers, `bed-target.mjs` absorbs bed setup, round scripts take neutral environment
  parameters instead of text rewriting, and stage-coded fixture names are gone.
- **Where.** `packages/client-runtime/src/state/{meshLayout/*,threadForks.ts,meshLayoutClientInternals.ts}`,
  `apps/{web,mobile}/src/**/PendingMeshDraftCoordinator.tsx`, `useForkThread.ts`,
  `replicas.logic.ts`, Machines views, `scripts/lib/{shell,managed-sshd}.mjs`,
  `scripts/delivery/{bed-target,e2e}.mjs` and `scripts/mesh-e2e/`.

### 2026-11-08 — New-thread machine cards and panel git honesty

- **What.** A new thread shows one calm card per machine that can run the project, with the
  main copy as the default. Cards name the copy state ("Synced", "Copying files…", "Out of
  sync"), offer "Will set up a copy here", and dim a machine with no usable models. Reachability
  comes from the mesh, so a machine reached through a peer is never mislabeled "not connected".
  Composer and its bottom row lose the machine chip; a started thread shows its machine tag in
  the header. First run with an incomplete mesh offers one dismissible "Connect to all machines
  in your mesh" action. The right-hand project panel hides Version Control on a lite replica, so
  it can no longer offer Initialize Git where git does not exist. The shared model chip reserves
  room for a provider-instance badge. Android rows are compact again and pinned rows show their
  machine tag. A linked thread's header names only its machine; no raw environment id or
  "From T3 Code peer" text remains. Each machine appears exactly once per project row, with copies
  on unconnected machines dimmed. Disabled machine cards say "Not connected to this device" in
  visible text while their sync state stays in the tooltip. Android shows the connect-all prompt
  too.
- **How.** `meshLayout/draftMachineCards.ts` derives cards and their plain sentences from the
  layout, replica status and destination catalogs; web and mobile render the same rows. The
  default draft machine prefers the project's main copy. `chat/threadDetailsGit.ts` owns the
  panel's git visibility, and `sidebar/meshConnectPrompt.logic.ts` decides what a client can
  reconnect. About and machine versions keep using the build/server values, and project rows no
  longer append a machine suffix. The composer voice toggle is shared by server threads and drafts;
  it follows the thread's provider on its own machine and the draft target machine's provider
  catalog. The deterministic fixture provider reports voice only under
  `T3_MESH_TEST_VOICE_PROVIDER=1`, so screenshots use the real badge without changing production.
- **Where.** `apps/web/src/components/chat/{DraftMachineCards,ChatHeader,ThreadDetailsPanel,
  threadDetailsGit}.tsx|ts`, `apps/web/src/components/sidebar/MeshConnectPrompt*`,
  `apps/web/src/hooks/useLogicalProjectEnvironments.ts`,
  `apps/mobile/src/features/workspaces/{DraftMachineCards,WorkspaceChrome,
  WorkspaceThreadLine,workspaceNavigator}*`, `apps/mobile/src/features/threads/new-task-flow-provider.tsx`,
  `packages/client-runtime/src/state/meshLayout/{draftMachine,draftMachineCards,index}.ts`.

### 2026-11-08 — Mesh UI polish

- **What:** Settings › Mesh no longer edits YAML: it lists machines with one plain status sentence
  and opens a prepared "Set up the mesh with an agent" thread; machine details show project
  sentences with collapsed diagnostics. The fork dialog speaks one plain no-models sentence and
  defaults to a machine other than the source. The project machines dialog uses Main/Copy wording,
  a middle-ellipsized path with a copy button, and refuses to remove the main copy without first
  promoting another copy. Forked-from banners link the source title instead of repeating it.
  Agent-kit files are written only for installed harnesses, and settings patches merge provider
  instances per instance.
- **How:** Config editing stays in server/contracts/CLI/MCP; the web and mobile settings screens
  render state and launch an agent thread. Replica rows shorten the error and keep the full text
  outside the normal UI where still used.
- **Where:** `apps/web/src/components/workspaces/{MeshSettingsPanel,MachinesDialog,ForkThreadDialog}.tsx`,
  `apps/mobile/src/features/settings/SettingsMachinesRouteScreen.tsx`,
  `packages/shared/src/serverSettings.ts`, `apps/server/src/mesh/MeshAgentKit.ts`.
