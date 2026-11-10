# T3 Mesh — guide for agents

## Android build cache

`scripts/delivery/android-build.mjs` owns resource/ABI selection, native fingerprint invalidation
and APK input keys; `scripts/mobile-android-apk.mjs` runs the profiled Gradle target.
`android-release.mjs` records source/signing/ABI keys beside release assets and verifies their
SHA-256 before reusing a previous APK. Public workflow writes Gradle caches only from `ws`.
Native cache paths enumerate physical package directories: recursive pnpm globs follow dependency
links and can spend minutes walking the store before archiving any files.
The delivery pipeline retains native outputs instead of forcing a clean prebuild. `assets.mjs` stages signed APKs
with immutable OTA assets; `delivery/MobileOta.ts` serves their catalogued hashes through the
existing asset route and native-upgrade notice. Promotion still follows successful rollout.
Generated Android files must not determine prebuild invalidation by mtime: switching refs changes
mtimes without changing native inputs. Expo 58 defaults to cleaning on prebuild: incremental
refreshes require `--no-clean`. Preserved Gradle history also requires declaring native fingerprint
and JS inputs on Expo Updates resource generation. See [delivery.md](../delivery.md#android-builds).

## Retry and bootstrap lifetimes

`mesh/Backoff.ts` defines the shared 1–15 second schedule for peer reconnects,
layout exchange, bootstrap readiness and fork recovery. Expiry cleanup makes seven attempts,
logs exhaustion and retains its durable staging record for recovery after restart; committed
fork intents retain their resumable retry path. Bootstrap polls `pair --check` for readiness
before minting one pairing token. The check reads the runtime descriptor without opening the
auth database.

`T3_MESH_JOINING=1` marks a newly bootstrapped service that is waiting to receive its mesh
config. `MeshConfigMigration` suppresses standalone config seeding while that config is absent;
identity migration proceeds normally after it arrives. `MeshInstall` writes the marker into the
new service environment. Ordinary standalone installations omit it.

## Private delivery

`scripts/delivery/` owns the private builder queue, warm build clone, target allowlist,
serial rollout and stopped-DB/unit rollback. The t3ctl `delivery-client.mjs` forwards requests
to a private socket; customer paths never enter public workflow configuration. Targets read
Delivery health (version, revision, peer watermarks, replicas) and reject conflicting managed versions.
`mesh/DeliveryAdmission.ts` fences run creation inside EventSink write transactions and
allows concurrent provider starts while drain exclusively waits for all admitted starts.
Drain admission counts a node through its run (`JOIN`): an open node whose run already ended
cannot hold a drain. A runless node counts only while it started within the last hour; without
a heartbeat, older ones are stale. Terminal `run.updated` projection writes close their open
child nodes (`orchestration-v2/TerminalRunNodes.ts`: todo lists completed, tool calls
interrupted, approval and input requests cancelled) and complete active todo-list plans, and
migration `084_CloseTerminalRunNodes` repairs the same shapes in existing databases once.
Abandoned persisted fences expire at startup one minute after their deadline. Admission
failures stay typed during outbox/runtime recovery; deferred ids are read once per recovery pass. Its operational journal survives restart;
already accepted dormant starts remain in the outbox without occupying worker slots or spending
retry attempts. Cancellation wakes the worker and queue promotions. Checking provider-session
inactivity alone misses accepted start effects and internal queue promotions.
WS, MCP and `t3ctl drain`, `t3ctl drain status`, `t3ctl drain cancel` expose the same service. The delivery service and the
private systemd transport drain before backup/switch and reopen only after health or rollback.
`scripts/delivery/target.mjs` closes admission with `now` and polls `t3_delivery_drain_status`
until the server reports drained, so a long drain never outlives the HTTP client's request timeout.
Transient updating refusals are never stored as rejected command receipts; client and CLI retries
retain their command/message IDs. The private delivery adapter handles the initial legacy hop
by polling running threads, including subagents, only when the drain-status tool is missing.
Its `legacy-idle` journal entry explicitly means there is no admission fence. It rechecks idle
before stopping, retains backup/health/rollback, and restores the original legacy DB schema.
Capability is probed again on the next delivery, which uses drain after the upgrade.
`scripts/delivery/legacy-idle.node-test.mjs` covers selection, busy/timeout handling and restore.
Explicit `--now` remains available to skip waiting.
Delivery health normalizes N-1 project-title watermarks using the stored entry value, preserving
real project ids ending in `.title`. Database rollback clears layout generations and peer cursors:
restoring a snapshot rewinds sequence numbers, so retaining acknowledgements can strand replicas
behind changes that peers already consider delivered.
The delivery service rechecks its lease after draining: fewer than twelve minutes remaining cancels the fence
and stops before backup or handoff, even when the configured idle deadline is longer.
Manual rollback acquires a fresh fence. The staged database restore carries that current
admission row into the restored database before restart; its historical token cannot authorize
the new operation. Restored health passes before the current fence is released.
See [delivery.md](../delivery.md) for configuration, commands and limitations.

The public release workflow publishes runtime first; Windows consumes its archive without
waiting for the Linux installer. Each platform attaches its artifacts independently.
Server `delivery/` serves signed Expo manifests and immutable assets. Mobile clients match
native fingerprints, check on launch/foreground and can request a previous compatible bundle.
Expo also enforces certificate Digital Signature/Code Signing usages and a native allowlist
of overridable update headers. Those inputs must be baked into the first APK; JavaScript
cannot repair them through OTA. Publish manifests after building that APK: older manifests
are correctly ignored in favor of the embedded bundle.

Desktop's stable custom protocol follows the active connected thread/draft server, but only
when that server's UI is strictly newer than the shell's app version: equal, older and unknown
versions keep the bundled client and its saved connections, and the choice is re-evaluated on
every launch and on a server version change. A disabled saved connection, an unknown environment
and the local backend while it is off are not sources at all; they resolve to the bundled client.
The `app/DesktopUi.ts` service validates saved origins, owns that version and usability decision,
and persists the choice; it also keeps the source and credential per renderer/origin so another
window selecting its own environment cannot change this window. `ipc/methods/ui.ts` accepts only
the main application frame. Web's `DesktopUiCoordinator` waits for in-flight sends (including
server-drain retries), then flushes drafts before reloading for a source/version change; a
bundled-only environment switch is persisted without a reload. About shows UI/shell versions and
actual source.
`ElectronProtocol.ts` pins assets to their document's server, strips local credentials and
compressed-response transport headers, and loads the bundled copy when the document is offline.
Relay-only connections without a direct UI route explicitly use the bundled UI. Never mix
bundled assets into a server document. `apps/desktop/scripts/delivery-ui-proof.mjs` verifies
server switch, server-only UI update, storage/preload preservation and fallback in real Electron.

Read this before changing anything that touches machines, projects across machines, replicas,
the shared sidebar layout, thread moves, files on other machines, the `t3` skill or the agent
instructions. It is the map; the law is `docs/mesh/CONCEPT.md` (v2, wins on conflict) and `docs/sidebar-cross-device.md` §0 (object model,
invariants, conflict policy). Keep both current when you change behaviour.

## What it is

Each installation runs one T3 Code Sidebar server per machine. Linked
together they form a **mesh**: one replicated sidebar layout, projects that live on several
machines, threads that can be created, found, opened, moved and driven on any machine, files
readable from anywhere, and agents that know where they are.

## Object model (short; full text in the spec §0)

| Entity            | What it is                                                                                                      | Where it lives                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Machine           | one T3 server (`environmentId`), label/tag/color/aliases, reported SSH facts                                    | config + layout `machine/<env>`                               |
| Link              | server-to-server MCP session with config-defined permissions                                                    | each server's PeerLinks table                                 |
| Mesh              | machines + links; desired state in the mesh config (`mesh.config`), no central authority                        | layout `mesh.config`, bindings                                |
| Project (logical) | opaque id (the logical key, never shown) + **title** + representations                                          | layout `projTitle/<id>`, `rep/<id>/<env>`, `alias/*`          |
| Representation    | (machine, folder, role primary/replica, transport git/mutagen/sshfs/manual, ignores)                            | layout `rep/*`                                                |
| Sync session      | one Mutagen session per replica (alpha = primary, beta = replica), driven by the side that can ssh to the other | Mutagen daemon of the driving T3 server (`<baseDir>/mutagen`) |
| Thread            | lives on one machine, working dir inside one representation (or "No project")                                   | that machine's DB                                             |
| Workspace         | presentation only: placement, order, fold                                                                       | layout `ws/*`, `place/*`, `fold/*`                            |

Invariants I1–I6 (spec §0) are tested; keep them true: one project per (machine, path), one
session per replica, one title everywhere, **no opaque id or legacy key ever shown to a person**,
workspaces never affect sync/threads/routing, nothing hard-codes a machine.

## How it flows

- **Layout replication.** `packages/shared/src/meshLayout/` owns the LWW map, bounded HLC,
  ordering and materialization. `registry.ts` validates known key families; unknown families
  retain their opaque values. Import/adoption lives under `meshLayout/migration/`, with the
  old-settings adapter in `apps/server/src/mesh/migration/`. `MeshLayoutServiceLive.ts` keeps
  SQLite and the canonical document consistent; corrupt rows move to `mesh_layout_quarantine`.
  The registry validates config/history documents with the canonical contracts schema,
  preserving unknown fields for newer versions.
  Machine projections use the wire schema too: newer reported facts remain in the document,
  while older clients derive exactly the same snapshot as the server sends.
  `MeshReplicator.ts` exchanges local sequence watermarks and store generations over
  `PeerMcpClient`, pushes changes after 200 ms, retries a failed peer exchange on a
  1–15 s backoff and exchanges watermarks every 60 seconds. A changed generation resets
  both peer cursors. Connection-up notifications clear retry backoff before exchanging
  watermarks. Clock rejections and quarantine reasons are
  exposed by `meshLayout.status`. Tombstones require thirty days and acknowledgement from
  every currently linked peer, including read-only and expired links, before collection.
  Authorship records expire after thirty days independently of tombstone acknowledgements.
  Web and mobile mount one `MeshLayoutProvider` each; their hooks adapt RPC and persistence
  to `packages/client-runtime/src/state/meshLayoutClient.ts` (`MeshLayoutStore`). The store
  owns snapshots, subscriptions, optimistic edits and the persisted reconnect outbox.
  Its cache stores documents rather than derived config; rejected edits rebuild from confirmed
  entries plus the remaining outbox. Authorization refusals retain edits for re-authentication.
  `meshLayout/resolveAlias.ts` resolves complete chains; a cycle uses its smallest member,
  excluding the incoming tail. HLC generation refuses clock skew or exhausted counters rather
  than emitting a repeated or decreasing clock. Known keys require canonical URI segments, and
  representation values must match their key environment. Titles use `projTitle/<id>`; old
  `proj/<id>.title` registers migrate without confusing ids ending in `.title`. Cache migration
  runs once with the first server aliases; live merges preserve opaque ids. Config inputs require
  schema one while replicated future revisions remain forwardable and refuse their planners.
  Migrated titles escape glob wildcards. Key helpers encode machine claims/bindings, and malformed
  URI segments are ignored by client materialization paths.
- **Peer receipts.** `peer/connection/PeerReceipts.ts` reserves an in-flight key before SQL
  and atomically inserts its durable intent. Receipt migration 83 adds indexed creation times;
  startup and hourly-on-use sweeps retain thirty days, including interrupted requests. Stored
  responses are capped at 64 KiB of encoded bytes; an oversized response still reaches its
  original caller, while retries receive an explicit 413 receipt rather than repeating work.
- **Bounded peer state.** `PeerMcpClient` hashes HTTP session identities and removes rejected
  sessions on 401, including a failed renewal. `PeerSessions` retains route history only for
  current links/layout machines or live advertisements. `PeerChannel.nextTickDelay` schedules
  heartbeat/death deadlines directly rather than ticking every second. `MeshStateBackup` keeps
  ten completed snapshots, protects the current token, and removes incomplete directories older
  than a day and stale temporary files under its private root.
- **Routing.** A call for another machine goes direct when linked, else through one relay hop:
  `apps/server/src/mesh/MeshRouting.ts` (`callRouted`) used by `PeerForwarding`, files and forks.
- **Replicas.** `apps/server/src/replicas/`: `MutagenInstaller` (pinned 0.18.1, sha256),
  `MutagenRunner` (CLI wrapper, private `MUTAGEN_DATA_DIRECTORY`), `ProjectReplicaService`
  (reconcile on layout change + every 30 s; deterministic session names; state machine;
  registers the project on the replica machine when watching), `ReplicaPaths` (allocation),
  `MeshSsh` (keys and marked SSH blocks), `ReplicaEnvironment` (full-mode dependencies),
  `ReplicaInstructions` (the context note).
- **Project names anywhere.** `replicas/meshProjectLookup.ts` resolves layout titles/aliases and
  complete paginated peer project lists over the existing relay. `mesh/MeshProjectDirectory.ts`
  also caches minimal source-stamped handles gossiped by mesh exchange, so incoming-only peers
  can resolve projects without outbound credentials. Reads do not enroll representations; place
  persists the actual source. Catalogs rebuild after restart, include deletions and omit unchanged
  snapshots, repository URLs, scripts and model defaults. Missing lookups await updates for 20 s.
- **Replica diagnostics.** Scan problems stay mounting/watching, register normally and carry
  skipped counts plus bounded paths through live status, layout, MCP and both Machines clients.
  Last errors, transition failures and disconnected active endpoints block with persisted messages.
  Ignore changes recreate the session. Conflict copies remain protected from sync. A failed remote
  live-query retains the replicated status; missing RPC reachability is not a sync failure.
- **Threads anywhere.** `t3_thread_self` (who am I), mesh-wide list/search/read/send/wait by id
  (`mcp/McpToolAccess.ts`). **Move** changes the project on the same machine only
  (`ThreadMoveService.ts`; drag, menu, CLI and MCP; no model). **Fork to machine** creates a new
  thread elsewhere (`ThreadForkService.ts`, `forkBundle.ts`, `ForkUploads.ts`, `forkTransport.ts`):
  ensure/place the destination representation and wait for sync, flush it, copy the transcript
  through the last completed turn plus attachments, create the thread with the chosen
  harness/model/effort, optionally send a first message. The original is never archived and keeps
  running; target and source store links both ways (`meshFork`, `meshForks`). Every step has a
  timeout. The target stages an invisible, non-runnable fork in `ForkTransactions.ts`, with a
  token and ten-minute persisted lease. Commit publishes creation, transcript and optional first
  message in one orchestration transaction. The source persists its commit intent and retries
  with 1–15 s backoff, including after restart. The target retains a small token receipt for
  idempotency; startup resumes accepted commits and expires pending forks locally. Abort is
  only a fast cleanup path. Staging and pending attachment blobs are removed after commit or expiry.
  Fork model pickers use `threads.forkCatalog` on the source to read the target catalog over
  the mesh, so clients need no separate connection to each destination. Catalog reads never
  place replicas or stage threads and time out after thirty seconds.
  Fork works on the same machine too. Old handoff "move" data still renders as ordinary links.
  The fork marker escapes peer titles (including newlines and backticks) and machine labels, and
  emits a Markdown link only for `t3-thread:` targets; peer-supplied web URLs stay plain text.
- **Draft machine selection.** Web `components/chat/useDraftEnvironmentRouting.ts` and mobile
  `features/threads/new-task-flow-provider.tsx` resolve the same logical project on the chosen
  machine with `planThreadOnMachine`. Replica status supplies progress and registration; the
  destination's provider catalog drives model choices. Shared selection and availability logic is
  in `packages/client-runtime/src/state/meshLayout/draftMachine.ts`. Pending sends live outside
  route lifetimes: IndexedDB on web, an atomic document file on native, and the shared
  `PendingDraftOutbox` reconciles registration with fixed server command/thread/message IDs.
  Both `PendingMeshDraftCoordinator`s build their machine map with `pendingDraftMachines` and run
  `launchPendingDraft`; each app supplies only its byte-upload adapter and command runner.
- **Files anywhere.** `apps/server/src/files/` (`files.read/list`, forwarded via `callRouted`;
  error reasons travel as `[files:<reason>]`).
- **Context injection.** Every turn gets a short machine/project/representation note (budget in
  `apps/server/src/provider/agentContextBudget.json`; update it to the measured size when you add
  tools or text, and justify growth).
- **Config editing.** The mesh is configured by agents, not by UI forms. Settings › Mesh (web
  and mobile) lists machines with a plain status and launches a prepared thread ("Set up the mesh
  with an agent", or "Fix with an agent" when status is unhealthy); the agent uses
  `t3ctl mesh config …` or the `t3_mesh_config_*` tools. Stale applies retain the draft and show
  the server diff; reload rebases local changes over the latest document and requires a new plan.
  Restoring a layout history revision follows the same plan/apply path. Apply requires a successful
  plan of the current text. Settings groups apply actions by revision and merges client connections
  by the descriptor environment ID. Machine details read optional replica lag and reported SSH
  route checks; absent producer reports remain unknown. Config owns names and SSH settings.
  A draft's selected machine can change before its project registration completes: replica git
  ownership therefore resolves through the source project's logical group, including pending copies.
- **UI.** Web `apps/web/src/components/workspaces/` (MachineTag, ProjectMachineStrip
  `A ⇄ B C`, MeshSettingsPanel, MachinesDialog, PendingReplicaRow, MoveProjectDialog,
  ForkThreadDialog, MeshFooterStatus, FileMachineTag); mobile
  `apps/mobile/src/features/workspaces/` (same names). One `MachineTag` per client draws every
  machine tag: the mesh config `appearance.machineTags` chooses `tinted` (default, machine-coloured
  text on the machine tint), `solid` or `outline`, and `textColor` chooses machine or neutral text;
  `machineTagPalette` moves only lightness for the active theme and keeps the hue. Project strips
  draw up to three tags with `⇄` and use `+N` only from four machines; the project title truncates
  first, and `+N` names the hidden machines for assistive tech and on long-press. Pure logic lives in
  `packages/client-runtime/src/state/{meshLayout/*,machineDisplay,meshMachines}.ts`.
  The Machines views and menus share `machineChoices`/`machineChoiceText`,
  `pendingRowsForProject`, `replicaLagText`, `representationCandidates`,
  `removeRepresentationCopy` and the adopt copy; each app keeps its own controls.
  The sidebar fork sequence (`nextForkTitle`, `planForkPlacement`, `runThreadFork`) is shared in
  `client-runtime/state/threadForks.ts`; app hooks inject the fork command, shell wait, reorder
  and navigation.
  Every place that names an environment uses `machineDisplay.environmentNameOf`: a machine the
  mesh config lists shows its configured tag and title, and only an environment outside any mesh
  keeps the connection's own label (usually its OS hostname). The Environments pages therefore
  list this device's connections by tag + title, muted address, state, switch and an overflow menu
  for routes, permissions and remove; with a mesh they drop the per-server "Linked environments"
  sections, because peer links live in Mesh › machine detail › Diagnostics (with Forget and the
  access each link grants). Settings › Mesh machine rows and both PR-routing lists use the same
  resolver, so three servers that share one host name no longer look like duplicates.
  New-thread machine choice is one card per machine, derived by
  `meshLayout/draftMachineCards.ts` (primary first; single machine hides the cards). Its
  reachability comes from mesh peer state, not this client's connections, so a machine the
  mesh reaches says "Available through <machine>" instead of "not connected". Sidebar project
  tags use the same `meshMachineReachable` rule: only a machine the mesh reports offline is
  dimmed. Reachability needs a live direct/relayed connection, a fresh exchange (two minutes) or
  a linked peer that is itself live; a stale or merely configured link does not count. The composer no longer carries a machine chip; a started thread names the machine in
  its header. A lite
  replica never offers Initialize Git in the right panel: `chat/threadDetailsGit.ts` hides
  Version Control there, because git lives on the main copy. First run with an incomplete mesh
  shows one dismissible "Connect to all machines in your mesh" prompt; it switches saved
  connections back on and sends never-added machines to Connections. The reduced desktop server
  UI never shows that prompt or the Settings › Mesh connect-all action: it has no saved
  connections there and cannot act on them. Project rows draw one tag
  per machine; copies on machines this client is not connected to are dimmed in the same strip.
  A linked thread's header shows its machine tag only, never a peer label or environment id.
  The composer voice toggle follows the thread's provider on its own machine and, for a draft,
  the target machine's provider catalog; the fixture agent reports voice only when
  `T3_MESH_TEST_VOICE_PROVIDER=1` is set, and production builds ignore that flag.

### Client draft, voice and prompt rules

Shared client-runtime decisions keep web and Android answering these questions the same way:

- `meshLayout/draftMachine.ts` provides the one "has usable models for this project" predicate
  (`hasUsableDraftModels`, built on `defaultUsableDraftModel`), the host rule
  (`draftMachineCanHostCopy`: an existing copy, a replica-capable server, or a scratch draft),
  the machine-usable rule (`draftMachineUsable`), the default-machine choice
  (`defaultDraftMachine`: a remembered machine only wins while connected and usable; otherwise
  the main copy, then any usable machine, else the main copy so its card explains why),
  `draftMachineCatalogsKnown` so neither client pins the default before provider catalogs load,
  `savedDraftMachineChoice` so only an explicit choice is remembered, and
  `nextSelectableDraftMachine` for `composer.cycleHost` (connected and usable only, wraps).
  Web and mobile build the same candidate rows from these helpers.
- `meshLayout/draftMachineCards.ts` disables a machine that cannot host a copy (server without
  the `replicas` capability and no existing copy), carries the selected model's availability as
  guidance, and web refreshes an unconnected machine's catalog when it connects and every minute.
- `voiceAvailability.ts` (client-runtime) is the one decision for every entry point on web and
  mobile (`resolveComposerVoiceAvailability`): composer, command palette and "Talk" apply
  install/auth/availability/project enablement and a usable voice model against the thread's own
  machine or the draft's target machine. The mic and the agent thread are hidden exactly when a
  voice thread could not start; a direct launch that still finds no model says so instead of
  doing nothing. The draft voice thread is created on the same target machine the button was
  judged against (hidden while a machine switch has no project on the target yet).
- `meshLayout/meshConnectPrompt.ts` excludes saved connections that are already enabled (switching
  them on again is a no-op), records dismissal per machine, prunes machines that left the mesh,
  and only records ids whose switch succeeded. Web and mobile persist that set the same way;
  Settings › Mesh repeats the action as "Connect to all machines".
- `meshLayout/gitVisibility.ts` hides git only while a mesh source is genuinely loading or the
  folder is a lite replica. Without a mesh every folder is an ordinary project, so single-machine
  clients keep git; web `useMeshLayout` still throws without its provider rather than silently
  degrading to a single-machine view. Mobile's thread header names the machine tag, web keeps the
  workspace name readable by sizing the titlebar icons down.
- `meshLayout/replicas.ts` `removeRepresentationCopy` is the one remove-copy dialog model (role,
  other copies, `Make <machine> the main copy` choices); `replicaLagText` is gone. Machine detail
  project sentences read the same live/stored state as Diagnostics, so a manual copy says
  "copy not synced automatically". `meshMachines.meshProjectRows` takes live statuses.
- Pending draft sends keep the chosen branch and worktree path; their error line uses
  `errors/plainMessage` instead of `String(error)`. Mobile touch rows keep their compact visual
  density and reach 44–48 dp through `lib/touchTargets` hit slop.
- Agent prompts are built in `state/meshMachines.ts` for web and mobile. Peer-provided labels,
  project titles and failure reasons are single-line, length-capped and quoted as data; a typed
  address loses credentials, query and fragment; the whole prompt is capped below the `/new`
  link limit with a visible truncation note. `AgentFixActions` (web) and `MeshAgentFixActions`
  (mobile) carry the source machine in the link's `env`, and their accessible names name the
  machine or problem. New-thread links accept `env` so the prepared thread opens on the machine
  that must run the fix, not the most recently updated thread's machine.
- Settings › Mesh on both clients launches the same setup, offline, replica and failed-update
  agent actions; mobile shows `mesh.updateFailure/*` problems and disables setup without a mesh
  source. Diagnostics show local, human times instead of raw ISO strings, and machine copy rows
  use Main/Copy wording everywhere. Machine cards keep disabled reasons in visible text and under
  `aria-disabled` while staying focusable. Unconnected catalogs refresh only while a machine is
  unconnected, with one bounded request key per project and destination.

### Client fallback, home and draft choice

- **Desktop fallback.** `ElectronProtocol` appends the attempted `server` to the bundled
  fallback URL; web `desktopBundledFallback.ts` reads it and `DesktopBundledOffline` draws
  "Can't reach <server> — Retry". The offline page requires a known direct server: a bundled URL
  with no server is the normal bundled client, never an outage. Retry drops `bundled` so the
  shell tries the saved server again. "Choose another server" keeps `bundled=1` and drops only
  the address, so Settings stays bundled while a server is down and leaving Settings cannot loop
  back into the page. The label falls back to the address for an unnamed IP machine. The dev
  target-origin path also returns a plain retry page instead of dying.
- **Home and draft choice.** mobile `useSidebarWorkspaces` applies client-runtime
  `withImplicitWorkspace`, so a mesh with machines but no configured workspaces still shows one
  "Personal" folder list. Card wording separates a scratch draft (`draftHasProject: false`, no
  copy language) from a project destination that lacks a copy. Unknown replica capability is not
  a refusal: only a server known to lack it says "Can't set up a copy".
- **Usable fork target.** `defaultForkTarget` picks the first other connected machine with a
  model, then any connected other machine so its card explains why.
- **Wording and access.** Short copy errors (`Can't reach <source>` / `Copy failed`) keep the
  reason in `replicaStatusDetail`; user copy says "copy". `mod+alt+h` cycles the draft host and
  arrow keys move between selectable cards. Clipboard failures show the prompt selected for
  manual copy on both clients.
- **Theme and version.** `ThemeRouteSync` subscribes every route, including `/pair`, `/connect`,
  `/connect-agent` and guest pages, to the saved/system appearance. Release bundle CI sets
  `APP_VERSION` and `scripts/verify-app-version.mjs` checks the built client contains it.

### Client draft model and project naming

- **One draft model answer.** `draftMachineModelUsable` is the only resolver for a machine card,
  fork target and new-thread menu: the person's explicit selection when there is one, otherwise
  the machine's own default usable model. Cards therefore say "No models here" only when no model
  can run there; an explicit choice that is missing says "Model not available here". Card text
  stays within `DRAFT_MACHINE_CARD_TEXT_MAX`; the full sentence lives in the tooltip and
  `aria-description`. Web and mobile pass only the explicit composer selection to these decisions.
- **Draft identity and destination.** `useHandleNewThread` resolves the mesh logical key and a new
  draft lands on the main copy unless the caller passes `environmentSelection: "manual"` (a picked
  machine). `mainRepresentationRef` supplies that copy; a stored manual choice is preserved.
- **Project picker and names.** The command palette groups representations through the replicated
  layout, so one logical project has one row. Descriptions use `projectMachineTags` (config titles,
  main copy first); a non-mesh project shows a muted path tail, never "Local" or an OS hostname.
  Link sources are named from the same machine list.
- **Ordering.** Settings › Mesh puts this machine first then sorts by title
  (`sortMeshMachinesForSettings`); the Machines dialog and sheet put the main copy first then sort
  copies by title (`sortRepresentationsMainFirst`). New-thread machine choices use the same rule.
- **Offline machines.** A thread detail keeps its last synchronized conversation when the machine
  cannot answer; the composer is read-only and the banner names the configured machine rather than
  its hostname (`offlineConversationStatus`). A thread whose conversation was never saved shows a
  centred `offlineConversationEmptyText` pane with Retry. After the reconnect window a still-retrying
  environment reads as offline, not "reconnecting". Sidebar strips dim tags that the mesh reports
  offline even before this client's socket drops (`offlineMeshEnvironmentIds`), the footer says
  `<machine> is offline`, and machine detail project rows read "last known: …".
- **Provider instance patches.** Web settings send one instance through the shared
  `buildProviderInstancePatch`; adding a Codex account no longer sends the whole map, so an omitted
  instance survives the server merge and `null` deletes exactly one.
- **Agent-kit adoption.** `MeshAgentKit` adopts a recognisable unmarked skill directory once
  (backing it up beside the managed copy), keeps every file it did not write, and removes only
  files its manifest lists. Any other unmarked directory is left untouched and reported.

### Link source and offline messages

- **Link source follows the serving machine.** `defaultLinkSource` was already given the primary
  environment, but `LinkWithDialog` froze that value with `useState` at mount. Saved connections
  resolve from local storage before the primary environment descriptor arrives, so a client opened
  on studio kept cloudbox selected. The dialog now keeps only the person's explicit pick as state
  and falls back to the live default (the environment that serves this UI), dropping a pick whose
  machine is no longer offered.
- **Offline thread says it once.** While the centred `offlineConversationEmptyText` pane is shown,
  `showsEnvironmentUnavailableBanner` suppresses the machine banner on web and
  `connectionFloatingStatus` returns no pill on mobile. The composer stays disabled and its
  placeholder is the short `<machine> is offline` (`offlineComposerPlaceholder`). A saved
  conversation keeps the banner that explains it is read-only.

### Offline conversation and machine cards

- **Offline thread.** Web `OfflineConversationEmptyState` replaces the blank timeline when a server
  thread has no saved projection and its environment stayed unavailable for
  `ENVIRONMENT_RECONNECT_WARNING_GRACE_MS`; mobile `projectThreadContentPresentation` does the same
  after `useReconnectWindow`. Both use `offlineConversationEmptyText` and offer Retry. The composer
  banner passes `reconnecting: false` once that window passed.
- **Offline machine cards.** `draftMachineCards` carries the mesh's `offline` state and its
  `offlineMachineText` age from `DraftMachineCards` and the mobile new-task flow, so the card says
  "Offline" while a machine the mesh reaches but this device does not is named
  "Available through <machine>" (its `viaLabel` or the mesh). "Not connected here" stays only for
  a machine the mesh does not reach. The age is the tooltip.
- **Machine tags.** `projectMachineStrip` takes `offlineEnvironmentIds`; a tag is muted when the
  mesh reports it offline, independent of this client's connection. Web keeps the tag in the
  breadcrumb immediately after the thread title (the title truncates first); the project picker
  shows tags only and keeps names in its tooltip/`aria-label`. Link dialogs start from
  `defaultLinkSource` (this machine first).
- **Desktop fallback.** `ElectronProtocol` adds the attempted server's configured name to the
  bundled fallback URL; `DesktopBundledOffline` shows plain copy, names the machine by that name
  or its host/address, keeps the address as a muted detail, and uses no "bundled UI" wording.

### Draft identity, machine choice and offline fallbacks

- **One draft key.** Web `state/draftProjectKey.ts` resolves the mesh logical project (falling back
  to the grouping key) and plans re-keys for drafts made before the mesh snapshot loaded. The
  new-thread handler, the PR draft flow, the bootstrap project expander and draft routing use it;
  the handler also finds a pre-snapshot draft by its grouping key and remaps it, and
  `useDraftProjectKeyReconcile` re-keys persisted drafts once the layout arrives. The
  `composerDraftStore` gained `rekeyLogicalProjectDraft`, which never steals another draft's key.
- **Stored machine choice.** `useHandleNewThread` writes `environmentSelection` on every draft
  write: an explicit "New thread on…" pick and an existing manual choice stay manual, a plain new
  thread is automatic. `useDraftEnvironmentRouting` writes `auto` for the automatic default
  (`draftEnvironmentSelection`) and re-applies that default when the main copy returns, so an
  offline fallback returns home while a manual pick and a load-balanced choice do not.
- **Destination defaults.** New-draft env-mode defaults read the project file, project settings and
  workspace root from the destination machine's copy, not the clicked copy.
- **Cycle host.** `composer.cycleHost` uses `draftMachineCandidate`, the same effective-model rule
  as the cards and mobile, so it works with no explicit model selected.
- **Composer grace.** `composerEnvironmentUnavailableState` keeps the editor usable during the
  2 s reconnect window (connecting/reconnecting) and never blocks a draft, which may queue its
  message for a machine that is currently unreachable.
- **Desktop escape hatch.** The offline page keeps Retry primary and adds "Choose another server":
  `desktopBundledLocalSettingsUrl` points at the bundled Settings › Connections, and the root
  renders the normal branch for `/settings/*` in bundled mode (`showsDesktopBundledFallback`).
  `desktopFallbackServerLabel` never turns an IPv4/IPv6 literal into a name, caps a configured
  name and keeps the address as a muted detail. `ElectronProtocol` stores only `origin.origin` and a
  capped name in the fallback URL.
- **Wording and caches.** `offlineMachinePrompt` strips the age separator once; mobile Home and
  Settings › Mesh use `replicaConnectionFixText` and the web "this machine" ordering rule (a phone
  has none). A thread detail keeps its saved conversation on `EnvironmentRpcUnavailableError` only
  and clears it on terminal failures, per thread key. Command-palette project rows add a muted
  path tail only for duplicate titles. Both `MeshConnectPrompt`s guard the reconnect sequence with
  a ref, merge a dismissal made meanwhile and leave never-added machines undismissed.
- **Android follow-ups.** `offlineLogicalProjects` returns the representations on unreachable
  machines even when another copy is connected, so `buildHomeProjectScopes` adds their project
  refs to the reachable scope: cached threads on an offline machine stay in the folder and the
  folder keeps its multi-machine tags (`machineTagOffline` dims the row's tag). The connect prompt
  skips a machine the mesh reports offline (`online: false`); only an online machine that this
  device has not added or switched on is actionable. `forkMachineChoices` drops the thread's own
  machine, orders usable machines first and keeps a no-model machine visible but disabled with
  "No models here" and its tag. The new-task screen renders the project heading and machine cards
  together in the centred hero instead of pinning the cards above the composer.

## Interfaces

`t3 run [--bg] [--ports P[,P]] [--timeout D] -- <command…>` runs locally outside a lite
replica. Inside one, it flushes, refuses conflicting/problem files with exit 75, executes in the
primary's login environment, streams output and flushes results back. `--list`, `--logs ID
[--follow]` and `--stop ID` manage detached jobs; ports bind only to the replica's loopback.
Ignored outputs are named with “stayed on <machine>”. The timeout bounds synchronization and
remote execution. Plain environment commands explain how to use `t3 run` and exit 127;
configure their names with `replicas.remoteCommands`.

When the server socket is unavailable, `RunClient` permits local execution only after a valid
manifest proves the cwd is outside a lite replica. Missing or invalid manifests refuse with 75.

The runtime CLI and private local-server socket live in `apps/server/src/run/Run{Cli,Client,Ipc,Control}.ts`.
`RunPlan` maps the nearest representation's relative cwd onto its primary. `RunPreparation`
consumes the replicas v2 public `flush/conflicts/problems(replica)` API through `RunSyncLive`. `RunTransport`
uses managed `t3-<name>` hosts; `RunWorker` owns process groups and the primary's job registry.
`RunGuardian` keeps background forwards alive and flushes completion; `ServerPlatform` owns launch
quoting and IPC addresses. `RunOutput` maps complete root prefixes across UTF-8 chunks while
emitting unrelated bytes immediately. Runtime/PTY discovery is restricted to replica-enabled
peers (`t3_run_runtime`).

`RunEnvironment` and `RunManifest` supply thread runtime launchers, atomic representation data
and configurable command shims. Provider shell startup overlays, Codex shell policy and the
OpenCode shell hook apply guards to agent commands while native harness discovery retains real
Git. Preserve this distinction: adding shims to the harness process's PATH breaks providers.
Each preparation has an independent deadline; scan problems block execution even when the
ordinary replica status presents them as warnings. Keep completion metadata chunked as well
as stdout/stderr: a dependency install can retain more paths than one transport frame.

`pnpm --dir apps/server test:run-integration` exercises the real CLI, sshd and isolated Mutagen
session (build `testFixtures/sshd.Dockerfile` as `t3-run-sshd-test:local` first). It owns all
keys, daemon state and containers. The runtime tests use neutral project/machine names.

- **CLI / skill:** `agent-kit/skills/t3` (`SKILL.md`, `scripts/t3ctl.mjs`). Mesh commands:
  `mesh config get|plan|apply|rollback|history`, `mesh status`, `replica adopt <session> --project P`,
  `machines`, `machines alias <M> list|add|remove|clear`, `mesh status|link|unlink`, `place/unplace`, `replicas`, `new --on`, `find --all`,
  `threads/status --all`, `open`, `open-file`, `cat`, `fork --on`, `move --project`, `layout get|merge`, `agents sync|status`, `self`.
- **MCP tools** (in the server): `t3_project_place`, `t3_project_machines`, `t3_thread_self`,
  `t3_thread_*` with `environmentId` (or none — ids resolve across the mesh), `t3_thread_fork`
  (`environmentId` = thread's machine, `targetEnvironmentId` = destination), `t3_files_read/list`,
  `ui_open` with `environmentId`, link-only `t3_mesh_*` and the `t3_thread_receive_fork` receiver.
- **Agent instructions:** config `agents.instructions`, rendered into managed blocks in the harness instruction files.

## Runtime agent-kit reconciliation

`mesh/MeshAgentKit.ts` installs the bundled skill into the shared and Claude/Codex/OpenCode
skill directories through the config `agents/kit` planner action. The `.t3-managed` marker holds
a manifest of the files T3 wrote. A sync removes only files named by the previous manifest that
the bundle no longer ships; it never deletes a file or directory it did not write, so an owner's
`global/GLOBAL.md`, extra agents or notes inside the managed directory stay. A `skills/t3`
directory without the marker is adopted only when its `SKILL.md` names `t3` and it has
`scripts/t3ctl.mjs`: the old directory is copied once to a sibling `t3.backup-<timestamp>`, every
existing file is treated as unknown (kept), and our shipped files are updated. Any other unmarked
directory, a symlinked skill directory, or a symlinked instruction file is left untouched and
reported as a config validation failure. It writes only the
`<!-- t3-mesh begin -->` … `<!-- t3-mesh end -->` block in the three harness instruction files.
Missing directories are created. Malformed or repeated markers fail reconciliation before
instruction files are written. `agents.manageInstructions: false` disables instruction writes
while skill installation remains enabled. Instruction errors appear in normal config status.

Legacy shared instructions are dropped only as a whole paragraph (or run of paragraphs) bounded
by the file edge or blank lines, and only before the managed block exists. A mid-line mention,
owner text beside the paragraph, and an adjacent blockquote stay untouched; the one-time
migration never edits a file that already has our block.

A harness counts as installed when its binary resolves on the server's PATH, when a provider
instance for its driver names an existing absolute `config.binaryPath`, or when its home
directory exists. A short service-manager PATH therefore cannot remove a customer's skill or
managed block. Only a positively absent harness loses our skill directory and block, and
removing the block never trims text outside it.

Isolated servers must set `T3_MESH_AGENT_HOME` to their sandbox home, `T3_MESH_SSH_HOME` to
their sandbox SSH home and `T3_MESH_SSHD_DIR` to the fixture sshd directory; these are supported
operator overrides. `T3_MESH_AGENT_SOURCE` (a fixture skill) and `T3_MESH_LEGACY_GLOBAL` (another
installed legacy file) are test hooks, and production builds ignore them. CLI release archives carry `agent-kit/skills/t3` next to the
executable, excluding the legacy personal `global` directory. Source development resolves the
checkout kit. Node builds also stage the kit below `dist/agent-kit`, beside the bundled modules, so npm and desktop server distributions install their own version. Instruction rendering uses config machine names/labels and `agents.instructions`;
it never reads personal text from the repository. On first startup, `MeshAgentMigration.ts` reads the old installed `~/.agents/skills/t3/global/GLOBAL.md` into config if instructions are absent, before any config reconcile can adopt the skill directory. The per-server migration marker prevents later explicit edits from being overwritten.

Replicated future-schema config remains stored and forwarded, but `MeshConfig.start` refuses to
run planners or identity repair for it and publishes `Unsupported schema` as a failed status.

## Agent kit staging and aliases

`agent-kit/install.sh --dest DIR` stages a local copy. Servers distribute their bundled kit; no machine registry or personal instructions are shipped. `t3ctl agents sync` reapplies the current config and reports reconciliation status.

Model shortcuts come from `agents.aliases`. Built-in initial config defaults include opus/sonnet/haiku/fable (Claude), luna/astra/sol (Codex), and deepseek/1017 (OpenCode). The CLI contains no model shortcut table; removing a configured alias removes that shortcut. Machine aliases remain `machines.<name>.aliases`. Unspecified models and permissions are resolved by the destination server.

Never format `agent-kit/skills/t3/**`. Keep the skill general and compact.

## Testing

- Skill: `T3CTL_OFFLINE_ONLY=1 bash agent-kit/skills/t3/scripts/selftest.sh` includes shared-core
  parity when run from the checkout. `node --test agent-kit/install.test.mjs` verifies staging.
- Unit/integration: the package suites (`pnpm -s test` per package; web with `--maxWorkers 4`),
  `vp lint` 0 errors, `typecheck` in contracts/shared/client-runtime/server/mobile and
  `vp exec tsc --noEmit -p apps/web/tsconfig.json`. Commit with `--no-verify` only because of the
  old knip baseline; add no new knip findings.
- Script wiring: `scripts/referenced-scripts.test.ts` fails when a script path named from
  `scripts/*.{sh,mjs,cjs}`, a `knip.jsonc` entry, or a repository document does not exist, or when
  a shell script assembles a script filename from a variable.
- Release builds refuse to start when any `T3CODE_*_TEST_BUILD*` flag is enabled:
  `apps/server/scripts/cli.ts`, `scripts/build-cli-archive.ts`,
  `scripts/build-desktop-artifact.ts`, `scripts/delivery/builder.mjs` and the web build call
  `scripts/lib/release-env.ts`; `scripts/release-env.test.ts` proves the subprocess exit and
  message. The delivery builder also runs `scripts/verify-app-version.mjs` on the built client,
  which matches the release version exactly rather than accepting a longer prefix.
- Three-machine bed: `scripts/mesh-e2e/README.md` (a main server, an isolated same-host server
  and a container; `up.sh <ref>`, `status.sh`, `tunnels.sh up` when tunnels died).
  `mesh-core-acceptance.sh` (layout, links, files, old clients), `replica-acceptance.sh` (replicas on real Mutagen, t3ctl),
  `resilience-acceptance.sh` (crashes, partitions, duplicate claims). They must stay green.
  Runners and fault-proxy units use the configured bed base, runtime root and unit, never an
  installed server's legacy paths. `MESH_E2E_FIXTURE_PREFIX` namespaces fixture timestamps;
  Replica acceptance uses this checkout's t3ctl. `isolation.node-test.mjs` verifies helper resolution.
  `config.sh` verifies mesh config planning/apply, stale-base refusal, label/title convergence on
  three servers and a real registered replica. It requires the config bed lock and an existing
  deployment; `MESH_E2E_ARTIFACTS` selects its build metadata. Fixtures are config-prefixed.
- Agent behaviour: after changing SKILL.md or GLOBAL.md, run model-level routing cases using
  customer-defined machine identities/aliases and configured models; do not make personal
  name translations part of the product contract.

## Operating configured installations

Releases on `ws` build desktop clients, Android and the server runtime. Use the configured
machine's installation scope and discovered service unit. Back up its database, settings and
unit before an update. An owner's active server restarts only with their explicit approval;
use a disposable fixture for development. Provider availability comes from each environment's
catalog, not a machine name or an assumed operating system.

## Lessons already paid for (do not repeat)

- Name an environment from the mesh config, never from the OS hostname. A three-machine bed on one
  host made every Environments row "shared-host"; `environmentNameOf` is the one resolver both clients
  use, and a client outside a mesh keeps the saved host label.
- Peer links have one home: Settings › Mesh › machine detail › Diagnostics, where the config's
  names, the link access and Forget are together. Listing per-server link sections on Environments
  duplicated the Mesh UI and repeated the same host name.
- Forget must remove the machine binding and detach replica source references as well as
  reported facts, or materialization reconstructs the forgotten machine. Keep replica folders.
- Shell readiness is a store milestone. Project visibility is not a receipt: quiet folders,
  workspace filtering and responsive composer labels can hide or duplicate the project title.

- A temporary RPC handler spread after the real ones silently disabled the feature: never leave
  fallback handlers that can shadow real ones; test that each RPC reaches its real handler.
- Replication must use local sequence watermarks, not HLC ranges (late old-clock entries).
- Every server must adopt legacy layouts into the received document by name (no duplicate tiles).
- Mutagen scan problems (invalid symlinks, unreadable files) are warnings, not errors; never let
  one replica's failure mark the others; the error text must reach the layout status.
- An explicit representation path wins over allocation.
- Thread lookups must fall back to the local machine when the server cannot fan out.
- Calendar-dependent tests break (UsageService); use `Clock`, relative dates.
- A test run launched from a T3 thread inherits the agent's run shims on PATH. The shared test
  setup removes them and the `T3CODE_RUN_*` variables, so a fixture `git` cannot call the installed
  server and leave an idle vitest worker.
- Agent-kit scenarios must seed a harness home (or binary): managed skill copies and instruction
  blocks follow installed harnesses, and a scenario that expects them without one is wrong.
- Headless Chromium can crash at launch under a fully concurrent run; retry that launch, then let
  the scenario assert. Payload cleanup retries because a superseded server can still flush logs.
- Many parallel agents on one emulator/bed collide: coordinate devices; bed runs that restart
  servers must not overlap other agents' runs.
- A draft's machine list must include machines without a representation of its project; deriving
  choices only from existing physical projects hides the very destination that needs a replica.
- Replica registration is asynchronous. Persist the complete send intent before acknowledging
  Send; keep delivery at the app root. A restart or lost server response must reuse the receipt
  IDs. Test navigation, storage reopening, registration and exactly one destination launch.
  After acknowledgement, clear the submitted composer content only if its raw prompt still
  matches the persisted submission; a newer edit must survive promotion to the thread.
- Saved connection labels can be identical hostnames for different server instances. Draft
  pickers prefer layout identities, deduplicate environment IDs, disambiguate equal labels by
  distinct configured tag then endpoint host/port, and log collisions. Cached provider health
  on an unreachable connection must never produce a model's switch-machine suggestion.
- Provider authentication and model availability belong to the destination machine. Keep an
  unavailable explicit selection visible, and test catalog caching when adding pending targets.
- The standalone CLI layout encoder must stay in parity with shared core, including `projTitle/*`
  title entries. Extend `agent-kit/skills/t3/shared-parity.test.mjs` when adding layout fields;
  CLI-only fixtures can otherwise miss data silently.

- Owner-specific host dictionaries and remote shell commands survive copied test fixtures unless
  audited explicitly. Product code and skill instructions must resolve customer data; keep personal
  topology only in agent-kit `global/` and clearly identified documentation examples. Test alias edits
  with unrelated labels, multilingual aliases, relay routes and destination-provided model defaults.

- Incoming-only links support bidirectional exchange but cannot initiate a routed RPC. Resolve
  names from minimal catalog gossip as well as active queries; do not silently create new links.
  A CLI local-only precheck can defeat a correct mesh resolver before the RPC is sent.
- Session scan diagnostics may be truncated: preserve Mutagen's omitted counts, bound the path
  list and keep scanning warnings distinct from blockers. Register watching copies despite warnings.
- Ignore changes must reach the running session. Compare the full ordered ignore configuration;
  missing configuration is not proof that an old session already matches.
- Build parity fixtures from `materialize({})` so schema additions do not leave undefined maps.
  Compare the standalone encoder with shared core for titles, aliases and diagnostics.
- A healthy replicated status must survive a failed optional live-query. Keep the persisted
  diagnostics and log query reachability separately; do not fabricate errors for every remote
  copy. Registered machine strips must keep skipped-file notes instead of replacing them with synced.
- A fresh SCP connection may be rejected while an existing SSH session remains healthy during
  bed restarts. Use the same owned control socket for deployment SSH and SCP. Deployment retries
  happen before fault injection; they are not proof of automatic replica recovery.
- Fork staging is keyed by fork id and lives under `<stateDir>/fork-uploads`. It is deleted after a
  successful commit and after pending expiry or abort; do not treat leftover staging as a thread. A fork's
  target id is deterministic (`fork:<sha256>`), so retrying the same operation is idempotent.

- Fork links must survive both server shell projections and the client shell conversion; testing
  full thread records alone misses links disappearing from the sidebar and mobile menus.
- Fork cleanup removes chunk directories and temporary pending attachment blobs; claimed copies
  belong to the destination thread. Even a same-machine fork must copy attachments independently.
- The fork flush boundary uses the existing replica driver lookup and Mutagen runner. When the
  session is driven elsewhere it routes a link-only flush to that driver; a primary has no session.
  The replica server owns the session; a primary has no session.

- Canonicalizing logical keys only in memory leaves obsolete SQLite rows available to the
  replication sequence reader. Persist removals in the same transaction as canonical inserts;
  compare persisted keys and the snapshot, then restart in the regression test.
- A server identity outlives its layout database. Sequence numbers alone cannot distinguish
  an empty replacement store from an already acknowledged store; exchange a persisted store
  generation as well and reset both cursors when it changes.
- A push that failed because the peer was restarting was only retried by the next 60-second
  safety exchange, and that exchange could skip a peer whose stored pull time was a few
  milliseconds ahead. A machine killed mid-sync therefore stayed divergent for another minute.
  Retry each failed peer exchange on a short backoff, and let the periodic exchange always run.

- Removing polling must preserve project discovery: local project commits publish catalog
  changes, and received catalog changes trigger relay delivery even when the layout did not
  change. Listening only to layout entries leaves a newly created, unplaced project invisible
  until the minute exchange and makes the remote lookup deadline expire.
- A replica's `watching` status is not a file-delivery barrier after a crash: it can describe
  the last completed cycle while a new scan or transfer is pending. Crash acceptance waits for
  the actual file hashes to match within its deadline as well as the replicated layout hash.
  Likewise, an ignore update must await the replacement session's requested configuration;
  the previous session can still report `watching` before the new layout reaches its machine.
  Await the resulting diagnostics too, since session replacement first publishes `mounting`.
- Quiesce and drain replica reconciliation before constructing conflicting test files: it
  automatically resumes paused sessions and can otherwise overwrite a fixture during setup.

- A config with no `ws/<id>` entries means "one implicit Personal workspace", not "no workspace
  mode". Web had the stand-in; mobile's Home did not, so it hid every project folder behind
  "No threads yet". Use `withImplicitWorkspace` on both clients.
- A bare `machine/<env>` layout fact is not a configured machine. First-config migration must
  keep it only when a link, a project copy or the local server still references that machine;
  otherwise it revives a forgotten machine as active.
- An unreachable desktop server must reach a real bundled page, not an empty protocol response.
  Add the attempted server to the fallback URL so the page can name it and retry.
- `replicaStatusCopy` is visible row text: keep it to one short sentence and leave the server's
  long reason to `replicaStatusDetail`'s tooltip.
- A machine tag has one component per client. Inline tints drift (white text on a near-black tint
  on Android read as a different grey tag); configurable appearance belongs in the replicated mesh
  config, not in each surface. Hiding tags behind "+N" while the title has room makes people guess
  what "+1" means: draw every tag up to three and truncate the title instead.

## Mesh config core

The desired state is `docs/mesh/CONCEPT.md` §9. `packages/contracts/src/meshConfig.ts` is the open
Effect schema and revision/status envelope; unknown fields survive every round trip. Both JSON and
YAML are accepted (`parseConfig` uses the repo's `yaml` dependency); cyclic and non-finite YAML
values are refused before JSON storage. `packages/shared/src/meshConfig/`
holds the pure policy: `defaults`, `effectiveLinkPermissions`, `projectPolicy` (conflicts, replica
mode, merged ignores), `replicaRules`, `machineByName`/`ByEnvironment`/`ByPeerLabel`, `modelAlias`
and `configDiff` for stale-apply hints.

`appearance.machineTags` is presentation only: the schema validates `style`/`textColor`, apply
stores it with the rest of the document, and materialize copies it into the broadcast
`SidebarWorkspacesConfig.appearance` so every client of every machine draws the same tag without a
new reconcile action. Storage lives in layout entries: `mesh.config` = `{ revision, doc, author, writtenAt }`,
`mesh.configHistory/<revision>` (last fifty; older ones are tombstoned), bindings
`mesh.machineBinding/<name>`, and each server's `mesh.configStatus/<environmentId>`. `mesh.configReplica/<project>/<environment>` tracks rule-owned placements and
`mesh.linkPolicy/<receiver>/<peer>` reports installed permissions. These are
key families in `packages/shared/src/meshLayout/registry.ts`; the server's `validateEntries.ts`
uses that registry and reserves config writes for `meshConfig.apply`.

`apps/server/src/mesh/MeshConfig.ts` is the service: `current`, `changes`, `plan`, `apply`,
`rollback`, `history`, `status`, and `start` (the layer starts it). Apply is serialized, validates
the schema and references, checks `baseRevision`, writes current and history together, and reports a
path-level diff for a stale base. `MeshConfigPlanners` is the extension port: each planner has a
stable name, a read-only `plan(doc, previous)` effect returning actions and an idempotent
`reconcile(action, doc)` effect. Planners capture their dependencies in their registration layer;
the executor supplies the layout service. An action names its executing environment (or a bound
machine name); each server executes only its own actions.
Diff sides are optional on the wire: an absent `before` means an added field, an absent `after`
means a removed field, and `null` remains an actual config value.

Registered planners (`mesh/MeshConfigPlanners.ts`):

| Planner     | Plans                                       | Reconcile                                                                           |
| ----------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `machines`  | machine label/title/color/alias changes     | binds joined machines, removes obsolete display facts; materialization reads config |
| `links`     | effective permission changes for every pair | publishes installed policy; receivers read the config                               |
| `conflicts` | per-project conflict-policy changes         | reconciles sessions using project policy                                            |
| `ignores`   | per-project ignore changes                  | writes merged ignores and recreates affected sessions                               |
| `replicas`  | place/remove actions for config rules       | calls `ProjectReplicaService.place`, including `action: remove`                     |

The managed SSH layer registers the `ssh` planner; the bootstrap, update and agent-instruction layer adds planners through the same port; nothing
else should grow a second reconciliation path. Every action has a sixty-second deadline, failures do
not cancel other actions, and status keeps `done` / `in_progress` / `failed` plus the reason, for
every server.
Completed actions remain visible for their revision when the observed diff disappears, including
after restart. Planner action ids must be stable and namespaced by planner.

Link permissions are enforced on the receiving server by `mesh/MeshLinkPermissions.ts`: the peer
machine is resolved from its environment id in the signed OAuth session; N-1 sessions use legacy
labels excluding the receiver itself. Ambiguous labels use the intersection of candidate policies;
re-linking supplies an exact signed identity. Then `effectiveLinkPermissions` decides
`files`, `replicas` and `threads`. Files resolve real paths first; `projects` allows only this
machine's representation roots, `none` refuses, and an unknown peer falls back to the configured
defaults. A read-only link never reads outside project folders even when the config says `all`.
Replica placement, thread tools and the private fork receiver check their permission at the receiving handler.
Peer WebSocket frames carry the same file/replica ceilings as HTTP calls. Both relay transports
intersect receiver and destination policies; receipt replay checks current permissions before
returning a saved result, so a policy change cannot expose an earlier authorized response.

Migration (`mesh/MeshConfigMigration.ts`, shared `meshConfig/migration.ts`) writes the first
revision from legacy labels, tags, colors, public SSH user/port, ignores and existing link permissions.
Name-to-environment bindings live in `mesh.machineBinding/`; legacy aliases, peer labels and SSH
host/routes live in protected `mesh.machineMigration/` entries. Existing revisions and history are
cleaned idempotently on startup, preserving unknown public fields. Internal migration data never
belongs in the editable document.

Interfaces: MCP `t3_mesh_config_get`, `t3_mesh_config_plan`, `t3_mesh_config_apply`,
`t3_mesh_config_rollback`, `t3_mesh_config_history`, `t3_mesh_status`; WS `meshConfig.get/plan/apply/status`;
CLI `mesh config get|plan|apply|rollback|history` and `mesh status`. The CLI prints JSON for `get`;
JSON and YAML are accepted on plan/apply.

Reconciliation runs on config, binding and project/representation changes, resumes on startup, and
retries failed actions every thirty seconds. Reported status is replicated; an unreported or stale
server is shown as waiting rather than done. Conditional and manual replica rules do not eagerly
materialize copies: thread placement uses the existing replica service when that lifecycle is triggered.
Queued observations always reconcile the current revision; reported machine facts do not schedule
config work. Project actions retry only that project's driven sessions, so an unrelated stalled
replica cannot hold a config action behind a full-mesh scan.

Peer transports must preserve the optional `PeerCallLimits.files` and `replicas` ceilings
(`T3-Files-Limit` / `T3-Replicas-Limit` on HTTP) and the authenticated `peerEnvironmentId` in the
receiving invocation context. The fork receiver passes the replica ceiling through placement and
persisted transactions: a thread may use an existing representation while a denied link cannot
create one implicitly. Relay checks the
origin/destination policy before forwarding and can only narrow the receiving server's own policy.
Raw client `meshLayout.apply` writes cannot change config, history, bindings or reconciliation facts;
use `meshConfig.apply` with a base revision. Migration-only identity and per-pair route metadata is
protected alongside config and bindings. Explicit `machines.<name>.ssh.host` remains public for
existing SSH mode. Older documents remain readable; startup extracts their internal migration fields.

Settings patches merge `providerInstances` per instance; `null` deletes that instance. A map that
omits an instance keeps the saved one: sending the whole map no longer removes anything, so
clients send only the changed instance through the shared `buildProviderInstancePatch`.
`t3ctl settings set` accepts the same tombstone. Delivery-updating errors keep the
`DeliveryUpdatingError` tag and also accept a legacy message that starts with `T3_UPDATING:`
from N-1 peers and clients; the substring elsewhere in tool or user text is not a refusal.

## Persistent peer connections and SSH pipes

A link maintains one authenticated WebSocket at GET /peer. PeerSessions reconciles each link
independently; the lower environment ID's outbound socket wins simultaneous dials. A peer
with no advertised address can receive calls on its outbound connection. Plain WS follows the
same loopback/encrypted-tailnet origin restriction as the HTTP peer client. Reverse credentials
are minted locally, exchanged on the authenticated connection and persisted in the secret store;
legacy one-way links upgrade when their first connection succeeds. Unlink revokes both sets of
credentials and sends the remote unlink before closing when the peer is reachable.

Code boundaries:

- PeerChannel owns JSON framing, per-call deadlines/cancellation, notifications, pipe credit and
  half-close. PeerWire adapts ordered WebSocket I/O with bounded queues and scoped cleanup.
- PeerSessions owns deterministic selection, heartbeat (15 s / 45 s), independent reconnect
  backoff (1–15 s, jitter), direct-route advertisements and a maximum of one relay hop.
- PeerCallDispatcherLive invokes the existing authenticated MCP router in process. It does not
  POST to a loopback HTTP endpoint. PeerMcpClient uses a connected route first and retains HTTPS
  MCP fallback for disconnected or N-1 peers; existing routing/files/thread/layout callers use
  that same service. PeerTransport is the shared construction-time slot that breaks the router
  and peer-client dependency cycle, so every caller observes the same connection manager.
- PeerReceipts stores creation responses across reconnects/restarts. The request key is scoped
  to the original caller through a relay; payload/access changes cannot reuse it. Standard
  creating tools receive deterministic command IDs on a resumed request. An unfinished unknown
  extension tool is refused explicitly instead of replaying an unclassified side effect.
  The frame layer does not cache answers: every repeated key reaches current authentication
  and permission checks before the receipt is read.
- PeerFacts reads system public SSH host keys, global sshd port (including Include files), OS,
  architecture, version and user; absent keys are reported as absent. ServerPlatform owns system
  paths and private local socket permissions. Facts and connection observations are written to
  machine/<env>.reported; labels and reach policy belong to the mesh config.

A caller invokes PeerSessions.openPipe({ environmentId, target: "sshd", signal? }). It returns an
Effect of a Node Duplex or a typed PeerConnectionError. The target always connects to the
receiving machine's loopback sshd, at its reported port (22 by default). It requires a full-access
link. Relay selection is transparent, takes at most one hop, and never permits arbitrary TCP
hosts or ports. This is a byte transport; the caller supplies OpenSSH authentication and pins the public
host keys received in facts. There is no SSH implementation or private SSH key in the pipe.

Honor write() backpressure or use pipeline(). Each direction starts with 256 KiB of receiver
credit and sends at most 32 KiB per data frame. end() sends EOF on the writable half while the
readable half remains open; destroy(error) resets both halves and preserves the reason. A
cancelled AbortSignal resets that pipe. Resetting a pipe leaves the connection and other calls
up, discarding that pipe's frames still in flight. Known offline machines retain their identity
and report a missing connection. Connection loss fails outstanding calls, pipes and writes;
streams do not resume after a reconnect. Start a fresh SSH session after a transport
failure. Attach an error handler before using a returned Duplex. The manager's event(env,
name, body) returns false if delivery could not be queued; events are unacknowledged, so layout
replication must retain its reconnect/watermark safety net.
There are at most 128 pending calls and 128 pipes per connection; JSON frames are limited to
32 MiB and transport queues to 64 MiB. Calls default to a 60 s deadline. Use the existing
server-scoped PeerSessions service; another manager would own competing sockets.

The server binary exposes t3 mesh pipe <machine-name-or-env> [--base-dir <server-base>].
PeerPipeIpc resolves the name using the local server's links/layout, then bridges stdin/stdout
through the live network. It opens no state database or peer credential in the ProxyCommand
process. Unix IPC lives in a private per-user directory with a 0600 socket; Windows uses a named
pipe. Diagnostics go to stderr. Use the same base directory as the running local server.
Names resolve through configured titles, labels, tags, aliases and environment IDs; known
offline machines retain their names.

Mesh status includes direct / relayed (via) / offline since, last error and source/observation
time. The shared client machine builder chooses current observations before stale replicated
facts; web/desktop Settings, mobile Settings and t3ctl mesh status consume these states.
t3_mesh_routes keeps its N-1 array result by default; details:true adds connections alongside
routes. Link enablement and mode limits are checked before receipt replay in McpHttpServer;
The receiving-side permissions must run at that same boundary. the fork receiver requests and
thread transfers retain creation keys across MCP session renewal and recover pending receipts.
Layout replication pushes authenticated `mesh.layout.push` events through PeerTransport; incoming events use
the same generation, identity and catalog validation as exchanges. PeerLinks.changes includes
connection-up activity, resetting replication backoff. Confirmed MCP watermark exchanges on
reconnect and every 60 seconds retain acknowledgement/GC safety; disconnected peers use the
HTTP fallback without blocking event pushes to connected peers. Fork creating calls must retain
the same idempotency key across a retry.

PeerChannel, PeerSessions, PeerWire, PeerFacts, PeerReceipts and PeerNetwork tests cover framing,
credit bounds, half-close/interruption, real stopped-reading sockets, both tie arrival orders,
independent reconnects and changed addresses, durable receipts, mutual unlink, incoming-only
reachability and one-hop relay. PeerNetwork disables external POST /mcp after connecting and
checks a 200 MiB relay transfer by byte count and SHA-256.
The CLI subprocess test checks binary stdio, nonzero refusal, stderr diagnostics and that no
database is opened by the ProxyCommand process.
The shared-bed runners live in scripts/mesh-e2e: network-acceptance.sh [core|replica|all] seeds
the fixture and dispatches to mesh-core-acceptance.sh or replica-acceptance.sh;
network-bed.sh exercises blocked inbound peers, native SSH transfers/interruption, a three-minute
tunnel cut and automatic server restart. The fault proxy rejects peer HTTP MCP separately from
local agent/CLI MCP. See that directory's README for isolation and cleanup.

### Machine name collision recovery

`mesh.machineClaim/<environmentId>` retains each join's requested slug and initial machine
settings independently of the name-indexed bindings. `meshConfig/identity.ts` allocates names
in environment-id order, reserving requested stems before suffixes. `MeshConfigMigration`
writes claims for new installations and supplies the local descriptor for an older unbound
installation. `MeshConfig.start` repairs merged bindings and the machine document in a fresh
config/history revision. A unique unchanged machine entry moved to a different config key
moves its binding and claim in the apply transaction. Forget tombstones the claim too.
Never resolve independent joins by LWW of the binding alone: that loses the displaced identity.
Web and mobile share duplicate-title hints and compact offline ages in client-runtime.

### Managed SSH and replicas v2

`replicas/MeshSsh.ts` owns the server key under `<baseDir>/mesh/ssh` and the
`ssh` planner in `MeshConfigPlanners.ts`. `peer/connection/PeerFacts.ts` publishes
its public key in `machine/<env>.reported.meshPublicKey`. `replicas/sshBlocks.ts`
replaces only marked blocks and classifies route failures. Authorization includes
bound mesh peers with effective replica permission, including peers reached through
one linked neighbor: the final sshd authenticates the original peer's SSH key.
No per-pair SSH route matrix remains in the runtime, clients or contracts; only the
one-time config migration reads old route values from the stored layout. The standalone
`t3ctl` resolves the same managed/existing hosts from bindings and directs retry to
the replica server; its legacy import preserves raw old values only for migration.

Managed hosts are `t3-<config-name>` and use the runtime's absolute `mesh pipe`
command, explicit base directory and peer-reported pinned host keys. Existing mode
uses `machines.<name>.ssh.host`. Off mode removes managed access and pauses owned
sessions. SSH facts participate in config reconciliation so key rotation updates
the blocks without a config edit; connection counters do not trigger that work.
Route checks also publish `machine/<self>.reported.sshRoutes[environmentId]` with
`status: ok|failed|unknown`, an optional reason and ISO `checkedAt`. Off/denied/unprobed
routes are unknown; completed probes publish ok or failed. Peer hello frames carry
this map, and connection-state updates preserve the latest locally reported checks.

Set `T3_MESH_SSH_HOME` to an isolated home for test servers. Route checks pass its
`.ssh/config` explicitly. Mutagen uses isolated ssh/scp wrappers on POSIX and an
native executable wrappers on Windows. This does not redirect a system sshd's
AuthorizedKeysFile. The bed's `managed-sshd.mjs` prepares a separate system OpenSSH
daemon configuration and host key; `T3_MESH_SSHD_DIR` makes PeerFacts report those
facts. Its temporary-home fixture disables sshd StrictModes because `/tmp` is
writable; the SSH directory and files remain 0700/0600. No real user's SSH files
are provisioned by the bed deploy helper.

`replicas/ProjectReplicaService.ts` drives each local replica only, with remote
primary alpha and local beta. Ignore changes recreate the deterministic session
name. Defaults anchor generated outputs at the root while excluding nested
node_modules. `ReplicaEnvironment.ts` installs full-mode environments after sync,
persists a lock-content fingerprint under ignored `.t3`, and refreshes on changes;
replica messages report environment installing/ready/failed with the failure reason.
Choosing `full` in a placement or config rule explicitly authorizes package managers and
lifecycle scripts from synchronized project files. A failed fingerprint is stored in
`.t3/environment.failed` with its attempt count and retry deadline. The same lock gets at most
three attempts, with one- and two-minute delays that survive restart; exhaustion requires an
explicit Retry or lock change. This replaces endless thirty-second install retries.
The runner uses the injected environment and stops its private daemon at scope shutdown.
Before replacing ignores or endpoint paths it flushes and verifies the old session so pending
deletions keep their ancestry. Conflict reports carry every losing location for both clients.
Remote scripts use the target platform's login shell. SSH reconciliation reloads sshd
configuration and selects source/bundled entrypoints from runtime facts.
`ReplicaLiveStatus.lag` reports remaining staging files in either direction. `bytesBehind`
is included only when the remaining total is known (the final file in each active
queue); Mutagen reports the current file size, not a total queue size. A clean watching
session reports zero lag. Unmeasured connecting/paused/conflicted states omit lag.
The primary remains the place for git in either replica mode.

`platform/ServerPlatform.ts` owns SSH process arguments, isolated transport wrappers and
portable Node fs conflict preservation. There is no remote `sh` conflict script.
Both primary-wins and per-path newest-wins archive the loser before resetting sync;
archive timestamps contain no colons. Scan problems remain warnings with paths.
Session operations serialize per replica, not behind a global replica lock. Mutagen
and SSH subprocesses have deadlines; environment installs are bounded separately.
Changing placement can invalidate an old check without waiting for that check's lock.
Atomic directory reservation also avoids an allocator-wide lock. Automatic reconciliation
preserves a manually paused session; only an explicit retry or reversal of SSH off resumes it.

Removing a config rule leaves existing replicas in place. Explicit removal first
compares endpoint manifests and refuses with the unsynced paths or scan problems;
a clean removal terminates only the owned session and retains the files.

`ProjectReplicaService.flush({ logicalKey, environmentId })` flushes an owned
session; false means no local session is owned and the caller must resolve the
driver. `conflicts(ref)` returns conflict roots; `problems(ref)` returns transport,
transition and scan-problem paths. Inspection rejects missing sessions and requests
sent to a non-driver. The replica command runner inspects after flush; the fork path forwards flush to the replica server.
Mutagen's list argument is a **label selector**, not a session name: list managed
sessions and then select the name when inspecting/removing a single session.

`run/RunWorker` keeps completed background records for seven days and bounds each
journal to 10 MiB. A background control request whose stop throws is reported as an error frame
and closes that socket; it must not escape the promise as an unhandled rejection.
`T3CODE_RUN_RETENTION_MS`, `T3CODE_RUN_LOG_BYTES` and `T3CODE_RUN_KILL_GRACE_MS` override those limits (termination defaults to ten seconds).
Journal rotation preserves complete frames; observers recover completion from the durable
record. A missing supervisor marks the outcome lost instead of reconnecting forever.
The forwarding guardian stops for missing jobs, backs off transient failures and caps its log.
Ignored directories are pruned during output inspection and reported as whole directories;
this warning is conservative because nested writes cannot be detected without scanning them.
SSH uses a fifteen-second connection deadline and fifteen-second keepalives.

`delivery/MobileOta` caches decoded manifests and an asset index until the atomically published
catalog changes. Serving and publishing verify content hashes; corrupt bytes cannot replace an
existing catalog. Provider startup fallbacks log their original causes while preserving accepted
turn ingestion. Mobile layout failures show a dialog, including a clock-skew refusal.

The context note states representation, lite/full mode, primary and sync state;
lite replicas say `build/test/git: t3 run <cmd>`. `AgentContextBudget.test.ts`
measures the unchanged 600-byte dynamic ceiling and the static budgets (8334 Claude,
10060 Codex, 59417 tool-list bytes). Field bounds reserve room for the command hint.

The former Mutagen integration test downloaded a 102172827-byte release inside the
test with no HTTP deadline and registered daemon cleanup before successful startup.
On this host Node fetch aborted at 10 and 30 seconds while curl completed; a failed
startup could make cleanup enter installation again. `MutagenFixture.ts` now caches
and verifies the pinned archive with a bounded preparation step; the test exercises
installation against that local archive and uses a private daemon/data directory.
The production installer bounds download headers, body and extraction. A stalled
HTTP fixture proves the deadline. The synchronization phase uses the verified local archive;
a cold fixture cache performs one bounded download before starting the private daemon.

### Shared server platform boundary

`platform/ServerPlatform.ts` replaces the replica command and peer platforms.
Run launchers and peer/replica transports import it directly, including the shim's lazy native-invocation import. It owns login shell quoting, Windows batch/PTY invocation,
private IPC paths and modes, SSH wrappers and conflict-copy names. The worker source
fragment stays in this boundary because it executes on the primary without module imports.
Existing `run/RunPlatform.test.ts`, `replicas/ReplicaPlatform.test.ts`, peer-facts,
IPC and conflict-copy tests exercise the shared implementation.

### Bootstrap and rolling updates

`MeshBootstrap.ts` reconciles unbound `machines.<name>.bootstrap` entries. The server that can authenticate to the target detects OS/architecture, verifies the mesh-version release against an independently pinned `t3.runtimeChecksums[archive filename]`, installs a platform service, obtains a pairing credential locally on the target, establishes mutual trust and writes a machine name binding. Individual step statuses are replicated under `mesh.bootstrapStatus`; a target-side lock and an installation sentinel make retries resumable. SSH keys and host pins live beneath the server base directory, apart from managed SSH blocks.

Use `t3ctl mesh machines add cloudbox --ssh user@host[:port]`. SSH agent authentication is automatic; `--identity-file PATH` supplies a key path once. Passwords use the existing one-time secret API: request a secret, then call `t3_mesh_bootstrap_credential` with `kind: password`, `secretRef` and `projectId` (CLI flags `--secret-ref`/`--project-id`). Passwords are consumed into memory, passed only through SSH_ASKPASS's child environment and discarded after the attempt. Unused credentials expire after five minutes. They are never layout/config fields or status text. Authentication failure requires a fresh secret. Bootstrap requires service-manager permissions; Linux user services also require permission to enable linger.

`MeshRuntimeArchive.ts` shares release URL/platform naming and SHA256SUMS parsing with the existing runtime installer. `MeshInstall.ts` executes `platform/ServerPlatform.ts` service plans: Linux systemd user+linger or root system unit, macOS launchd agent, Windows SCM host. The Windows host implements ServiceBase and supervises the launcher process tree.

`t3ctl mesh update VERSION --plan` plans a config edit; without `--plan` it applies it. `--max-wait 5m` sets `t3.drain.maxWaitMs`; `--now` binds `t3.drain.skipForVersion` to that target only. A normal update clears the skip flag even for the same version, preserving other policy fields. WS `meshConfig.updateVersion`, MCP `t3_mesh_update` and config plan/apply share the typed policy. `MeshRollout.ts` orders bound config names lexically. A candidate obtains durable votes from every configured server before publishing the layout lease (owner/token/expiry). Outstanding votes fence a partitioned owner even after expiry; recovery by that owner releases them only when its launcher has no pending update. The existing protocol-3 launcher backs up the stopped state DB, installs/verifies and trials the selected runtime. Activation starts peer replication before the trial checks version, peer layout convergence and resumed replicas. Failure reason is recorded outside the DB so rollback preserves it; the restored server publishes a stop marker for that config revision before releasing its lease. A new config revision is required to retry. Unit trial failures are injected through `MeshRollout.layerTest`.

CLI operations have MCP equivalents `t3_mesh_machine_add`, `t3_mesh_update`, `t3_mesh_status` and the credential API. Peer-only update voting accepts trusted full-access links. Test servers set `T3_MESH_AGENT_HOME`, `T3_MESH_SSH_HOME`, private sshd and Mutagen data directories. Native Windows/macOS replica smoke coverage lives in `.github/workflows/mesh-platform-smoke.yml`.

During a trial, the HTTP readiness gate admits authenticated full-access peer
replication and update-control calls, including their MCP initialization. Other
commands stay gated. Gating `/peer` and all local `/mcp` dispatch until commit
would deadlock an incoming-only peer's layout convergence and replica resumption.
A failed mesh trial atomically records its reason and exits the trial child, so
protocol-3 launchers, including N-1 launchers, restore the DB immediately instead
of waiting for the generic preparation timeout. The runtime startup tests assert
activation → mesh health → launcher commit → lease release.

## Upstream v0.1.7 integration

Upstream migration ids 77–79 are reserved; MeshLayout is 80 and PeerConnections is 81.
`persistence/Migrations.ts` reconciles legacy fork history before the migrator reads its highest
id. Both fork migrations are idempotent so existing layout and creation receipts survive;
`Migrations.test.ts` covers sidebar.60, the v2 connection schema and plain upstream v0.1.7.

`PeerMcpClient` records transport outcomes before decoding tool results on either transport.
A tool refusal is a healthy answer; missing/malformed responses still mark the link failing.
`PeerLinks` refreshes labels from identity-checked discovery and retains persistent reachability
when HTTP discovery cannot reach an incoming-only peer. Effect crypto dependencies are explicit
Digest/SecureRandom services. MCP toolkit registrations belong inside `layerMcpTransport` so its
per-request invocation context reaches mesh handlers. Provider catalogs carry managed policy
alongside provider/settings subsets used by the mobile draft machine picker.

Portable fork entries omit internal checkpoint rows: importing one after the final reply would
make it the terminal assistant message in upstream's grouped timeline. `mesh/forkBundle.test.ts`
retains message attachments and tool outputs while asserting that the actual reply remains last.

The local network fixture explicitly grants `files: all` before reading its non-project proof
file and waits for that revision on every node; the default `projects` permission rejects it.
Its temporary root honors `TMPDIR` so large SSH transfer artifacts can stay off the root disk.

`MeshConfig.publishStatus` compares the persisted value before advancing its HLC. Repeated
reconciliation and service restarts must not generate new layout entries for an unchanged
status; otherwise background reports prevent the mesh from becoming quiescent.

The bed's `convergence.mjs` captures an all-entry HLC barrier for runs with live
reports; the default core check still requires complete document equality.
This avoids comparing sequential reads as if they were an atomic distributed snapshot.
Replica acceptance provisions SSH through `meshConfig.apply` and probes bound `t3-<name>` aliases;
the legacy raw-route/key installer is no longer part of that acceptance path.

Explicit folder comparison in `ProjectReplicaService.place` must use the same v2 ignore policy
as reconciliation. Otherwise a populated replica that correctly excludes an ignored file is
rejected when selected again. The existing in-flight-placement test covers that policy boundary.
Resilience fixtures configure ignores and conflict policies through `meshConfig.apply`; their
adoption daemon uses the isolated server HOME, with a guard against the owner's HOME.

Bed conflict scenarios await the resolver’s preserved copy and converged contents; a forced Mutagen flush
can race its intentional pause. The replica command fixtures canonicalize local fixture paths before publishing mappings,
because a process reports its physical cwd beneath a symlinked temp root. Its login fixture writes
the profile in both the SSH account’s passwd home and the isolated runtime HOME.
Resilience checks lock ownership before destructive operations and leaves shared services untouched
if a host reboot removes the lock. Crash workloads remain 128/256 MiB with mandatory
active-staging and file-hash assertions.
Network acceptance also fences RPC operations and tunnel cleanup after a lost lock.
Replica command acceptance considers a run only after automatic conflict resolution, or exit 75 while conflicts remain;
both paths must converge to the primary and preserve the actual losing file without fixture repair.
Core diagnostics refresh every node even when earlier snapshots differ, so failure output
cannot accidentally show an older snapshot for a later node.
Its legacy-mirror assertion brackets the settings read with two equal materializations on one
connection; ongoing status reports cannot invalidate an older, separately captured snapshot.
Raw workspace fixtures allocate fractional ranks instead of reusing `zzzz`; otherwise a routine
config diff can repair tied ranks and legitimately compete with the concurrent reorder under test.

The resilience daemon fixture keeps its isolated server stopped until the foreground
fault-test daemon owns the private lock, then starts the server before killing the captured daemon.
A socket can still be opening while its daemon already holds the lock; lock ownership is the
readiness boundary for deciding whether an old daemon needs stopping. The legacy
replicasEnabled setting does not disable reconciliation when v2 config is active.

Sequential transport acceptance waits for manual-folder policy metadata and its delivery
before requesting SSHFS on the same representation key. Otherwise a concurrent ignores
enrichment can legitimately win the whole-entry LWW race; config revision delivery alone
does not prove that the per-representation policy action has completed.

The partition fixture cuts the primary's inbound proxy and outbound tunnels, then waits
for both replica endpoints to disconnect before writing divergent versions. It leaves
the engine and sessions running: a user pause is persistent, and Mutagen resume requires
a reachable endpoint. No pause/retry/resume command runs during this outage or recovery.

Peer callback bridges use scope-owned `runForkWith` fibers and error reporting. An externally
aborted `runPromiseWith` can still reject after interruption handling; discarding that Promise
can terminate Node when an in-flight pipe closes during connection replacement. Awaited RPC
calls retain their Promise results. The tie-break test cancels an in-flight connector, and
Resilience also verifies that crashing one server leaves the others' restart counters unchanged.

An inbound connection can become visible before its reciprocal grant notification commits
the link. NAT acceptance waits for both the direct connection and the stored reachable,
address-free grant before testing the relay.

## Isolated fast scenarios

`scripts/mesh-fast/run.sh` owns independent three-server process meshes, private
homes and OpenSSH servers, and a private Mutagen daemon per replica driver.
Its scenario registry and coverage boundary are in `scripts/mesh-fast/README.md`.
The initial config/bindings must converge before applying a test edit; otherwise
startup identity reconciliation can supersede the revision being asserted.
`mesh/MeshTiming.ts` scales source-only mesh scheduling; the server pack definition
unconditionally disables scaling in production artifacts. Default-duration service
and peer tests continue to run at scale one.

A runner launched from a T3 thread must remove inherited `T3CODE_RUN_*` paths and
shell hooks before starting fixtures. Otherwise even fixture Git invokes the installed
server CLI shim, coupling the test environment to the owner’s runtime and adding a
process launch to every Git call.

### Fast and nightly acceptance (mesh fast suite)

[`scripts/mesh-fast/README.md`](../../scripts/mesh-fast/README.md) maps the realistic
bed scenarios and CONCEPT §12 to isolated mini-meshes. `pnpm mesh:fast` owns all
server state, SSH identities, daemons, private bridges and fault proxies; it never
uses the shared bed. `MeshTiming.ts` scales test timers while normal production
bundles ignore the knob. Native fixture builds are explicitly marked test builds.
The runner reports wall time and JUnit and bounds startup separately from scenario
concurrency. It deletes complete successful run directories, replacing only compact
`latest/` reports; three failed runs retain their full diagnostics. Ownership and
live-process checks protect unrelated paths during retention. Storage defaults to
the short `/data/mf` path, including its tool cache.
Use `MESH_FAST_ARTIFACTS_DIR` with a short path to move fixtures to a separate disk.
Changing global `TMPDIR` can split IPC discovery between installed services and
their clients; artifact storage must not change that rendezvous directory.
`lifecycle.mjs` admits one runner per user/host and reclaims only labelled resources
from a previous boot or dead runner. Boot identity plus process start time prevents
PID reuse from targeting a live process; cleanup never signals old host PIDs. The
same local command gates either configured builder host, capped at eight meshes,
eight server starts and two container starts; host identity is recorded in results.
`runner-reboot-recovery` proves real Docker cleanup, port reuse and preservation of
active/foreign resources. An unowned bridge attachment aborts reclamation.
Allocate all peer routes before taking server startup permits: a three-node mesh
must not wait for a peer queued behind its own permit budget. Fresh bootstrap's
private systemd unit also needs test timings and the archive mirror; inheriting
only the initiating server's environment leaves it dependent on public downloads.

The realistic inventory lives in `scripts/mesh-e2e/bed-config.sh`; shell bed
helpers use neutral roles and resolve physical destinations through that file.
`acceptance.sh` holds the shared bed lease for a realistic nightly run.
`install-nightly.sh` installs the worker timer plus a separate controller SSH
endpoint; `nightly.mjs` stores summaries and posts the stable `mesh-nightly` inbox
issue only for failures. The installer never restarts an owner's T3 server.
It rejects a mismatched worker before installing services. The realistic matrix
and provider guards use the freshly built product checkout through
`MESH_FAST_PRODUCT_ROOT`; native build failures cannot select an older installed
resource monitor.

Two fixture constraints matter: settle private machine claims before pairing,
otherwise automatic collision reconciliation can supersede a test's config
revision; reserve ports for the whole command, since releasing a port-zero socket
can otherwise hand the same port to another concurrently starting fixture.

Machine binding repair and rename can publish a newer config revision after an apply;
its scenarios wait for the requested binding and equal documents, rather than
requiring every observer to catch the intermediate revision. Supervisor specs
are published by rename so fs.watch never parses a truncated JSON file.

The browser runs inside its fixture's stable network namespace: creating and
removing other Docker bridges otherwise causes Chromium ERR_NETWORK_CHANGED.
Run the host-based web unit suite while local mesh networking is idle. Before
pruning passed payloads, wait for the private Mutagen POSIX lock: its listener closes
before final cache writes finish, so `daemon stop` alone is not an exit barrier.
`flock` uses a different lock namespace on Linux; the fixture's C helper uses
`F_SETLKW` so it actually waits for Mutagen's final cache writes.
Fast replica commands use real OpenSSH control connections to separate native process
startup from SSH's three-second connection budget; the control connections and
all remote process-tree fault assertions remain real. The realistic replica variant
uses fresh connections. Provider defaults are disabled in private fixture
settings, and fake profiles or explicit nightly native profiles are enabled there.

Ordinary fast servers execute the same bundle embedded in the native executable,
using an immutable Node compilation cache; the native SEA must disable its own
code cache to support dynamic imports. Bootstrap/rollout and the realistic suite
retain native execution. Two-machine cases avoid an unused third server, while
relay and collision cases retain their full topology. Full-mode tests run real,
checksum-pinned pnpm offline and import the installed local dependency.

Heartbeat polling must scale along with its deadline: a one-second polling tick
can miss an accelerated heartbeat. `timing-heartbeat` proves this with a real idle
cutoff above the scaled heartbeat period that the old poller misses. Reading proxy metrics
must not restart that cutoff; timeout listeners are attached once per socket.

The daemon crash fixture starts its captured foreground daemon before T3 clients
exist. Stopping an auto-started daemon during capture races clients that can start
another one. The fixture kills its captured lock owner during staging and verifies
recovery retains one session.

Replica command and bootstrap service ports use the same command-wide allocator as sshd and
server ports. Probing a free host port separately can select a port already in use
inside a fixture container, including its private sshd port.

A private SSH HOME does not change sshd's initial working directory for a host
user. The fixture's forced command enters that private home before running SSH
or SFTP commands; `replica-ssh` asserts both cwd and HOME through managed routes.
Bootstrap systemd uses its own cgroup namespace without mounting host cgroups.

A convergence barrier accepts a tombstone collected on every peer. It still
rejects a missing live write, an older resurrection, or divergent equal clocks.
The preceding release can expose an epoch-zero migration tombstone while current
peers collect it; requiring its physical retention creates a false failure.
Harness OAuth requests share the normal RPC deadline, while the command's global
wall budget remains authoritative under concurrent authentication work.

Cold Mutagen installation uses a private mirror of the original pinned archive
in fast tests. The real installer still verifies its digest, extracts the tools
and completes synchronization. The loopback-only asset override is unavailable
in production bundles and non-test source execution; nightly retains the public
release URL. This keeps parallel cold installs independent of GitHub throughput.

Daemon crash evidence reads the captured process's own `fdinfo` lock record for
its exact private lock path, then kills that PID during real staging. A global
`/proc/locks` scan can race unrelated lock churn and is unnecessary for ownership.

Native rollout fixtures build their two versions concurrently in independent
source snapshots, then discard those snapshots after extracting self-contained
archives. Source-dependent preparation stays inside the agreed six-minute wall budget.

Realistic machine-name and fork wrappers retain the runner's short temporary paths. Putting
Mutagen homes under nested nightly result directories exceeds Unix socket path
limits; the wrapper's persistent suite log records each private artifact root.

## Upgrade regressions

Client layout snapshot merges canonicalize legacy project keys before materialization, including
offline caches; otherwise competing legacy representations can take the primary path away from
an opaque logical project. `meshLayout/fixtures/upgrade.json` exercises that mixed shape.
The footer uses current direct client or peer connectivity before historical route failures.
Legacy whole-object edits repair sort collisions without copying stale fields over concurrent
workspace renames; the shared layout diff preserves the current row when only its sort is repaired.
The legacy settings RPC keeps each client’s last returned layout separately and advances it to
the merged response, so another client’s read and a later whole-object write cannot reset that base.

`RunPlan` selects configured SSH hosts in existing mode. `RunTransport` owns SSH completion
listeners from spawn. Config migration resolves missing layout titles through the local project
catalog; replica reconciliation retains representation-specific ignores until the config contains
every pattern. It then clears the legacy copy so later config removals take effect.
Bed transport checks verify ignores in config; migrated representations no longer duplicate them.
Ignore reconciliation preserves a native representation’s clock when it has no legacy ignores;
adding an empty legacy field can otherwise race with an operator’s new placement.
New settings and mesh configs seed `DEFAULT_REPLICA_IGNORES` (code-only); existing explicit lists
are preserved. Agent-kit reconciliation receives the local identity from the server binding.

Bed command fixtures set their own run socket and manifest as well as the home directory.
An agent thread already has run variables; inheriting its socket makes a raw fixture CLI resolve
against the caller’s server instead of the isolated bed.
Deployment also resumes a stopped test VPS container, preserving its mounted temporary folders
before recreation.

The acceptance runner can place its third container on another administrator SSH host with
`MESH_E2E_VPS_DIR` and `MESH_E2E_VPS_SUDO`; uploads use the same privileged transport.
The bed guide records the alternate routing and the single-active-identity constraint.
Independent acceptance profiles set `MESH_E2E_GV_BASE_DIR` and `MESH_E2E_GOR_BASE_DIR`
consistently for credentials, CLI runners, SSH and daemon probes; mixing bases can query the
preserved profile while testing another server.
Replica acceptance follows project pagination and budgets the full server readiness window;
its 128 MiB canary now checks both SHA-256 and replica size.

Local SSH pipe sockets disable Nagle: separate small SSH records otherwise wait for TCP delayed
ACKs even on loopback. The real relay/IPC test exercises split records before its 200 MiB canary.

Existing-session adoption resolves SSH endpoints from machine bindings and the configured SSH mode, just like replica creation. Display titles and labels can change independently of a managed `t3-<name>` alias or an existing SSH host; using them to identify endpoints rejects valid reversed sessions.

Automatic conflict resolution records its Mutagen session id in `repstatus.resolvingConflicts`
before pausing. Keep that intent when publishing errors. After an interruption the driver resets
and resumes only that marked session, then scans again; an unmarked pause remains intentional.
Clearing intent before resume completes can strand the copy after a crash. Legacy whole-object
settings writes leave replica diagnostics to the servers, so older clients cannot erase this intent.

The realistic bed reads its physical infrastructure from ignored local.env.
The nightly installer retains legacy seeds in private persistent storage.
The fast lifecycle case cancels a container before node readiness; ownership is
recorded at spawn, so cancellation cannot lose containers awaiting descriptors.
Conflict tests await the persisted resolution intent clearing before user pauses.

## Security boundaries

`MeshLinkPermissions.ts` requires distinct local and peer environment IDs bound in the mesh
config. A missing config, missing binding, unknown peer ID, or legacy label-only session denies
files, replicas and threads. Labels are migration input, never a runtime permission identity.
`EnvironmentAuth` binds a registered client's peer identity in the same database transaction
that consumes its owner-entered one-time pairing code. The exchange names both environments;
registration metadata and signed token claims alone confer no identity. Reverse grants use the
already-bound connection identity. `/peer` never adopts a header identity: unbound tokens return
401 and conflicting headers or relay hops return 403 on both transports. Migration 82 snapshots
existing credentials; only those can acquire a binding on first authenticated use with a matching
local outgoing link or `mesh.machineBinding`. The durable upgrade is logged and listed in
`meshLayout.status.legacyIdentityUpgrades` and `t3ctl mesh status` (including `--json`); unknown
peers and new unbound tokens must pair again.
An HTTP relay request carries `[sender]`; a forwarded call carries `[origin, relay]`. Both
transports check the list against the bound sender, including the initial one-element form.
HTTP idempotency namespaces use the authenticated peer ID (or session ID); relay caller IDs
partition keys only inside that bound relay's namespace. Legacy
label matching lives only in `meshConfig/migration.ts`. Import defaults to project files;
existing config revisions are untouched. An unrestricted link requires an explicit `files: all`
config override, whose permissions are listed in the plan before apply.

`meshConfig/sshHost.ts` owns SSH destination validation and `resolveMeshHost` for managed, existing and disabled modes. `platform/ServerPlatform.ts` owns `sshOptions` and `sshConfigPath`. Run plans, run transport, replica routes/endpoints and SSH route checks use these helpers. Destinations are
configured aliases or host names, with user and port held separately. SSH argument lists end
options with `--` before the destination. This keeps a config value from becoming an SSH option
or changing Mutagen endpoint syntax.

New configs leave agent aliases empty; aliases belong in customer config. Delivery clean-agent
launches inherit project settings unless explicitly configured. Android signing runs only on
`ws` through the protected `android-release` environment; see [delivery.md](../delivery.md#android-signing-boundary).

MCP tool declarations carry a domain in `McpToolDomain.ts` annotations. Receiving handlers
and forwarded calls derive the same policy from those declarations. Linked callers cannot
invoke unclassified or owner-only tools; file, replica and thread domains obey the respective
link limits. Repository-wide filesystem operations require `files: all`; the file SDK also
supports project-only access with realpath checks. Computer-control, secret and configuration
administration tools require a direct owner caller. Mesh protocol calls require a session bound
to a peer record.

The public harness keeps infrastructure in the ignored `scripts/mesh-e2e/local.env`; its
tracked example uses neutral roles. Deploy/teardown use sandbox homes, bed units and bed
ports, and never edit administrator SSH authorization. Live unit/data/port overrides require
`MESH_E2E_ALLOW_LIVE=1` in addition to the owner's operational approval. See the harness guide
for pinned infrastructure SSH keys and isolation tests. Git history is not rewritten by this
cleanup; removing historical disclosures is a separate repository-owner decision.

Desktop server UI uses a separate `t3code://server-<webContentsId>-<source hash>` origin and a reduced
`desktopShell` bridge. The shell serves it only while its server version is strictly newer than the
bundled client; an equal, older or unknown version, a disabled/unknown connection and the local
backend while off all keep the bundled origin. Storage is also separated when the selected server
changes. The source and credential are tracked per window/origin: each server-UI window keeps its
own document and bearer while another window selects a different environment. It cannot read desktop credentials, catalogs, legacy storage, SSH,
exposure controls or media IPC. Server UI navigation and popup attempts cannot launch native external handlers. Every IPC entry checks the sender's top frame and current
application origin. Protocol routing tracks main-frame navigation events because Electron's
Fetch Request does not retain navigation mode; an HTML Accept header never changes the
source. Documents require protocol `1` and bridge `reduced-1` response headers; incompatible
or unavailable sources redirect to the bundled origin. Server CSP forbids objects and limits
connections to saved catalog origins. Media IPC permits only saved origins, omits credentials
and refuses redirects. The isolated hostile-server proof is documented in delivery.md.

Server-UI HTTP stays on the same `t3code://server-…` origin; the shell proxy forwards it and
injects the bearer the trusted bundled client handed over at `ui.select`, so the reduced renderer
never holds a credential. Browser-session cookies from the pairing flow live in the shell's jar,
not in renderer storage. WebSocket upgrades cannot run over a custom scheme, so the client mints RPC and media tickets
through the proxy and connects to the server's own WSS origin. Media tickets carry the same
access for preview streams, device mirroring and their EventSource/HTTP requests. A document
selected with an injected credential is preflighted against `/api/auth/session`; a rejected
credential opens the bundled client in its normal state (not the offline page), so saved bearer
connections keep working. Retry and the cooldown return to the un-flagged app URL. Source hosts
use a salt persisted once per install (the embedded window id is per process, so only the main
window is normally stable across launches). Server-host documents require the main-frame
navigation recorded for the window; subframe navigations never get credentials. Credentialed
subresources must carry the bridge's per-window proof header. Chunk and preload failures before mount show "Reconnecting to <machine>…", reload after the
server answers, or fall back to the built-in version; the budget clears only after a healthy
mount, and after mount an overlay appears and the mounted app is left alone. The real
session proof (`delivery-server-ui-proof.mjs`) covers pairing, preview/media, restart recovery
and the authenticated bundled fallback in delivery.md.

Bootstrap requires an explicit HTTPS `reach.address`, an accepted OpenSSH public key in
`bootstrap.hostKey`, and a pinned runtime digest in `t3.runtimeChecksums` before download.
The plan displays the SSH SHA-256 fingerprint; obtain and compare the key through a trusted
channel before applying it. SSH uses a private per-attempt known_hosts file with strict checking,
ignores global host keys, and never retries an OS probe after authentication rejection.
Services bind loopback by default. Set `bootstrap.listenHost` explicitly when the HTTPS reverse
proxy needs a different listener; opening a public interface is a config decision. Release
URLs use the fork repository and HTTPS-only overrides. OTA native-upgrade metadata is signed
by the OTA key, constrained to the configured update origin, and downloaded APK bytes are
SHA-256 checked before the installer opens.

The OTA publisher writes the signed native-upgrade payload to `catalog.nativeUpdate`;
`MobileOta.status` transports it unchanged. `native-update-verification.ts` verifies the pinned
certificate and update origin; `verified-apk.ts` hashes the cached file and grants the Android
installer read-only access. Legacy unsigned URLs produce no download action. Desktop Settings ›
About can return from the reduced server UI to trusted local settings without exposing credentials.

The mesh fast suite integration with the identity migration pairs the actual previous release
before upgrading one peer; new unbound old clients remain refused. Bootstrap
fixtures now use private HTTPS trust and pin both host keys and runtime hashes.
Future-row quarantine must also recover the saved HLC from retained valid rows:
otherwise the bounded clock refuses every startup write after clock correction.
Heartbeat scheduling caps a pending-pong wait at the next ping interval, since
an asynchronous pong can shorten a deadline after its sleep was scheduled.

## Public source hygiene

`scripts/public-repo-leakage.test.ts` checks tracked text and compressed fixtures for private
infrastructure and fixture names, including the VPS address prefix, T3 state directories outside the
fixture home, owner home paths, bare machine names and VPN host suffixes. Keep run output outside
tracked sources and use neutral
identities in evaluation captures. `scripts/security-workflows.test.ts` checks all workflows
for explicit repository read permissions and immutable external actions; Node setup uses
`package.json` as its version source.

Peer HTTP headers use `peer/connection/peerIdentity.ts` for hop parsing and formatting;
HTTP and persistent relay paths share its identity/loop rules. Do not filter empty hop
segments during parsing: malformed lists must reach validation and be refused.
`platform/mutagenRelease.ts` owns the pinned target/version/archive/digest catalog used by
production installation and integration fixtures. Retention values in `mesh/retention.ts`
are independent of scheduling acceleration, including tombstones and durable receipts.

The orphan standalone bootstrap/run/replica bed runners have been retired in favor of
`scripts/mesh-fast`; native platform smoke imports the same client. Shared local shell helpers
live in `scripts/lib/shell.mjs`, including named command timeouts and buffers; delivery setup
stages that dependency with its remote script. `scripts/lib/managed-sshd.mjs` writes the isolated
OpenSSH configuration for the delivery bed, platform smoke and both bed runners.
`scripts/delivery/bed-target.mjs` now both stages fixtures and applies one target, so the former
bed-setup entry point is gone. Acceptance scripts take neutral `MESH_E2E_*_NAME`,
`MESH_E2E_DEMO_TITLE` and `MESH_E2E_ORPHAN_LABEL` values instead of rewriting fixture text.
Replica acceptance reads `MESH_E2E_LOCAL_PRIMARY_ROOT`, `MESH_E2E_REVERSE_ROOT`,
`MESH_E2E_REVERSE_TITLE` and `MESH_E2E_DEMO_TITLE`, matching nightly isolation.

Production layers require delivery admission, mesh config/layout and peer transport. A missing
layer is a construction error; tests install explicit layers from `testFixtures/meshServices.ts`.
Inject node identity and failure layers before constructing a service: its methods keep those
dependencies. Multi-node fixtures use fresh config layers and keep unused toolkit dependencies
inside registration, so one node cannot replace another node’s handlers or request scope.
`DeliveryUpdatingError` is a wire tag carried through RPC and MCP causes. Retry code checks that
tag, so arbitrary tool text cannot delay a request. The admission SQL and interrupt planning
share `ADMISSION_GATED_EFFECT_TYPES`.

`MeshTiming.MeshTimeScale` supplies liveness timing through Context; each service captures its
own timer. Production builds ignore the environment override. `mesh/Backoff.ts` owns capped
exponential delays and explicit jitter, while `mesh/retention.ts` stays in real elapsed time.
`platform/Download.ts` verifies archive SHA-256 before publishing bytes and preserves each
caller's stall/body deadline. `platform/readLine.ts` bounds IPC bytes and time and restores
trailing stream bytes. `run/RunWorker.ts` is compiled TypeScript; its compatibility source is
generated from the same worker and platform functions. `RunWorkerBundle.test.ts` bundles that
module with the shipped minifier and runs its exec and background-start actions, so a bundle
that hoists or renames helpers fails before release. `auth/PeerIdentities.ts` owns legacy
identity upgrade queries; replication reads that service instead of auth tables.

Middleware captures only its required service keys with `Context.make`; capturing the whole
construction context can replace the request scope and prevent cancellation from reaching a
remote tool. The real peer-network cancellation test covers this boundary.
