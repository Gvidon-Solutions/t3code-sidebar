# T3 Mesh — guide for agents

## Android build cache (A1)

`scripts/delivery/android-build.mjs` owns resource/ABI selection, native fingerprint invalidation
and APK input keys; `scripts/mobile-android-apk.mjs` runs the profiled Gradle target.
`android-release.mjs` records source/signing/ABI keys beside release assets and verifies their
SHA-256 before reusing a previous APK. Public workflow writes Gradle caches only from `ws`.
Native cache paths enumerate physical package directories: recursive pnpm globs follow dependency
links and can spend minutes walking the store before archiving any files.
D1 retains native outputs instead of forcing a clean prebuild. `assets.mjs` stages signed APKs
with immutable OTA assets; `delivery/MobileOta.ts` serves their catalogued hashes through the
existing asset route and native-upgrade notice. Promotion still follows successful rollout.
Generated Android files must not determine prebuild invalidation by mtime: switching refs changes
mtimes without changing native inputs. Expo 58 defaults to cleaning on prebuild: incremental
refreshes require `--no-clean`. Preserved Gradle history also requires declaring native fingerprint
and JS inputs on Expo Updates resource generation. See [delivery.md](../delivery.md#android-builds).

## Retry and bootstrap lifetimes (F2b)

`mesh/retryBackoff.ts` defines the shared 1–15 second schedule for peer reconnects,
layout exchange, bootstrap readiness and fork recovery. Expiry cleanup makes seven attempts,
logs exhaustion and retains its durable staging record for recovery after restart; committed
fork intents retain their resumable retry path. Bootstrap polls `pair --check` for readiness
before minting one pairing token. The check reads the runtime descriptor without opening the
auth database.

`T3_MESH_JOINING=1` marks a newly bootstrapped service that is waiting to receive its mesh
config. `MeshConfigMigration` suppresses standalone config seeding while that config is absent;
identity migration proceeds normally after it arrives. `MeshInstall` writes the marker into the
new service environment. Ordinary standalone installations omit it.

## Private delivery (D1)

`scripts/delivery/` owns the private builder queue, warm build clone, target allowlist,
serial rollout and stopped-DB/unit rollback. The t3ctl `delivery-client.mjs` forwards requests
to a private socket; customer paths never enter public workflow configuration. Targets read
B1 health (version, revision, peer watermarks, replicas) and reject conflicting managed versions.
`mesh/DeliveryAdmission.ts` fences run creation inside EventSink write transactions and
allows concurrent provider starts while drain exclusively waits for all admitted starts.
Abandoned persisted fences expire at startup one minute after their deadline. Admission
failures stay typed during outbox/runtime recovery; deferred ids are read once per recovery pass. Its operational journal survives restart;
already accepted dormant starts remain in the outbox without occupying worker slots or spending
retry attempts. Cancellation wakes the worker and queue promotions. Checking provider-session
inactivity alone misses accepted start effects and internal queue promotions.
WS, MCP and `t3ctl drain`, `t3ctl drain status`, `t3ctl drain cancel` expose the same service. B1 and the
private systemd transport drain before backup/switch and reopen only after health or rollback.
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
B1 rechecks its lease after draining: fewer than twelve minutes remaining cancels the fence
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

Desktop's stable custom protocol follows the active connected thread/draft server. The
`app/DesktopUi.ts` service validates saved origins and persists the choice; `ipc/methods/ui.ts`
accepts only the main application frame. Web's `DesktopUiCoordinator` waits for in-flight sends
(including server-drain retries), then flushes drafts before reloading for a source/version
change; About shows UI/shell versions and actual source.
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
- **Draft machine selection.** Web `components/chat/useDraftEnvironmentRouting.ts` and mobile
  `features/threads/new-task-flow-provider.tsx` resolve the same logical project on the chosen
  machine with `planThreadOnMachine`. Replica status supplies progress and registration; the
  destination's provider catalog drives model choices. Shared selection and availability logic is
  in `packages/client-runtime/src/state/meshLayout/draftMachine.ts`. Pending sends live outside
  route lifetimes: IndexedDB on web, an atomic document file on native, and the shared
  `PendingDraftOutbox` reconciles registration with fixed server command/thread/message IDs.
- **Files anywhere.** `apps/server/src/files/` (`files.read/list`, forwarded via `callRouted`;
  error reasons travel as `[files:<reason>]`).
- **Context injection.** Every turn gets a short machine/project/representation note (budget in
  `apps/server/src/provider/agentContextBudget.json`; update it to the measured size when you add
  tools or text, and justify growth).
- **Config editing.** Web `MeshConfigDialog` and mobile `MeshConfigSheet` share
  `client-runtime/state/meshConfigEditor.ts`: load a base revision, validate YAML, request a
  server plan, and apply against that revision. Stale applies retain the draft and show the
  server diff; reload rebases local changes over the latest document and requires a new plan.
  Restoring a layout history revision follows the same plan/apply path. Apply requires a successful
  plan of the current text. Settings groups apply actions by revision and merges client connections
  by the descriptor environment ID. Machine details read optional replica lag and reported SSH
  route checks; absent producer reports remain unknown. Config owns names and SSH settings.
  A draft's selected machine can change before its project registration completes: replica git
  ownership therefore resolves through the source project's logical group, including pending copies.
- **UI.** Web `apps/web/src/components/workspaces/` (MachineTag, ProjectMachineStrip
  `A ⇄ B C`, MeshSettingsPanel, MachinesDialog, PendingReplicaRow, MoveProjectDialog,
  ForkThreadDialog, MeshFooterStatus, FileMachineTag); mobile
  `apps/mobile/src/features/workspaces/` (same names). Pure logic lives in
  `packages/client-runtime/src/state/{meshLayout/*,machineDisplay,meshMachines}.ts`.

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
consumes S1's public `flush/conflicts/problems(replica)` API through `RunSyncLive`. `RunTransport`
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
skill directories through the config `agents/kit` planner action. It writes only the
`<!-- t3-mesh begin -->` … `<!-- t3-mesh end -->` block in the three harness instruction
files. Missing directories are created. Malformed or repeated markers fail reconciliation
before instruction files are written. `agents.manageInstructions: false` disables instruction
writes while skill installation remains enabled. Instruction errors appear in normal config status.

Isolated servers must set `T3_MESH_AGENT_HOME` to their sandbox home; `T3_MESH_AGENT_SOURCE`
can select a fixture skill. CLI release archives carry `agent-kit/skills/t3` next to the
executable, excluding the legacy personal `global` directory. Source development resolves the
checkout kit. Node builds also stage the kit below `dist/agent-kit`, beside the bundled modules, so npm and desktop server distributions install their own version. Instruction rendering uses config machine names/labels and `agents.instructions`;
it never reads personal text from the repository. On first startup, `MeshAgentMigration.ts` imports the old installed `~/.agents/skills/t3/global/GLOBAL.md` into config if instructions are absent. The per-server migration marker prevents later explicit edits from being overwritten. `T3_MESH_LEGACY_GLOBAL` selects another installed legacy file for isolated migration.

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
- Three-machine bed: `scripts/mesh-e2e/README.md` (nodeB main server + isolated studio :3795 +
  VPS container :3791; `up.sh <ref>`, `status.sh`, `tunnels.sh up` when tunnels died).
  `round1.sh` (layout, links, files, old clients), `round2.sh` (replicas on real Mutagen, t3ctl),
  `round3.sh` (crashes, partitions, duplicate claims). They must stay green.
  Runners and fault-proxy units use the configured bed base, runtime root and unit, never an
  installed server's legacy paths. `MESH_E2E_STAGE_PREFIX` namespaces fixture timestamps;
  round two uses this checkout's t3ctl. `isolation.node-test.mjs` verifies helper resolution.
  `config.sh` verifies C1 config planning/apply, stale-base refusal, label/title convergence on
  three servers and a real registered replica. It requires the C1 bed lock and an existing
  deployment; `MESH_E2E_ARTIFACTS` selects its build metadata. Fixtures are C1-prefixed.
- Agent behaviour eval: `docs/mesh-agent-eval.md` records the earlier bed methodology. After
  changing SKILL.md or GLOBAL.md, run model-level routing cases using customer-defined machine
  identities/aliases and configured models; do not make old owner-name translations part of the product contract.

## Operating configured installations

Releases on `ws` build desktop clients, Android and the server runtime. Use the configured
machine's installation scope and discovered service unit. Back up its database, settings and
unit before an update. An owner's active server restarts only with their explicit approval;
use a disposable fixture for development. Provider availability comes from each environment's
catalog, not a machine name or an assumed operating system.

## Lessons already paid for (do not repeat)

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
- The F1 flush boundary uses the existing replica driver lookup and Mutagen runner. When the
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

## Mesh config core (Stage C1)

The desired state is `docs/mesh/CONCEPT.md` §9. `packages/contracts/src/meshConfig.ts` is the open
Effect schema and revision/status envelope; unknown fields survive every round trip. Both JSON and
YAML are accepted (`parseConfig` uses the repo's `yaml` dependency); cyclic and non-finite YAML
values are refused before JSON storage. `packages/shared/src/meshConfig/`
holds the pure policy: `defaults`, `effectiveLinkPermissions`, `projectPolicy` (conflicts, replica
mode, merged ignores), `replicaRules`, `machineByName`/`ByEnvironment`/`ByPeerLabel`, `modelAlias`
and `configDiff` for stale-apply hints.

Storage lives in layout entries: `mesh.config` = `{ revision, doc, author, writtenAt }`,
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

S1 registers the `ssh` planner; B1 (bootstrap, updates, agent instructions) adds planners through the same port; nothing
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

N1 transports must preserve the optional `PeerCallLimits.files` and `replicas` ceilings
(`T3-Files-Limit` / `T3-Replicas-Limit` on HTTP) and the authenticated `peerEnvironmentId` in the
receiving invocation context. The fork receiver passes the replica ceiling through placement and
persisted transactions: a thread may use an existing representation while a denied link cannot
create one implicitly. Relay checks the
origin/destination policy before forwarding and can only narrow the receiving server's own policy.
Raw client `meshLayout.apply` writes cannot change config, history, bindings or reconciliation facts;
use `meshConfig.apply` with a base revision. Migration-only identity and per-pair route metadata is
protected alongside config and bindings. Explicit `machines.<name>.ssh.host` remains public for
existing SSH mode. Older documents remain readable; startup extracts their internal migration fields.

## Persistent peer connections and S1 pipes

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
  machine/<env>.reported; labels and reach policy belong to C1's mesh config.

S1 calls PeerSessions.openPipe({ environmentId, target: "sshd", signal? }). It returns an
Effect of a Node Duplex or a typed PeerConnectionError. The target always connects to the
receiving machine's loopback sshd, at its reported port (22 by default). It requires a full-access
link. Relay selection is transparent, takes at most one hop, and never permits arbitrary TCP
hosts or ports. This is a byte transport; S1 supplies OpenSSH authentication and pins the public
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
C1's receiving-side permissions must run at that same boundary. F1's receive-fork requests and
thread transfers retain creation keys across MCP session renewal and recover pending receipts.
L1 pushes authenticated `mesh.layout.push` events through PeerTransport; incoming events use
the same generation, identity and catalog validation as exchanges. PeerLinks.changes includes
connection-up activity, resetting replication backoff. Confirmed MCP watermark exchanges on
reconnect and every 60 seconds retain acknowledgement/GC safety; disconnected peers use the
HTTP fallback without blocking event pushes to connected peers. F1's creating calls must retain
the same idempotency key across a retry.

PeerChannel, PeerSessions, PeerWire, PeerFacts, PeerReceipts and PeerNetwork tests cover framing,
credit bounds, half-close/interruption, real stopped-reading sockets, both tie arrival orders,
independent reconnects and changed addresses, durable receipts, mutual unlink, incoming-only
reachability and one-hop relay. PeerNetwork disables external POST /mcp after connecting and
checks a 200 MiB relay transfer by byte count and SHA-256.
The CLI subprocess test checks binary stdio, nonzero refusal, stderr diagnostics and that no
database is opened by the ProxyCommand process.
The shared-bed runners live in scripts/mesh-e2e: network-rounds.sh runs both acceptance rounds;
network-bed.sh exercises blocked inbound peers, native SSH transfers/interruption, a three-minute
tunnel cut and automatic server restart. The fault proxy rejects peer HTTP MCP separately from
local agent/CLI MCP. See that directory's README for isolation and cleanup.

### Machine name collision recovery (C2)

`mesh.machineClaim/<environmentId>` retains each join's requested slug and initial machine
settings independently of the name-indexed bindings. `meshConfig/identity.ts` allocates names
in environment-id order, reserving requested stems before suffixes. `MeshConfigMigration`
writes claims for new installations and supplies the local descriptor for an older unbound
installation. `MeshConfig.start` repairs merged bindings and the machine document in a fresh
config/history revision. A unique unchanged machine entry moved to a different config key
moves its binding and claim in the apply transaction. Forget tombstones the claim too.
Never resolve independent joins by LWW of the binding alone: that loses the displaced identity.
Web and mobile share duplicate-title hints and compact offline ages in client-runtime.

### Managed SSH and replicas v2 (S1)

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
sent to a non-driver. R1 inspects after flush; F1 forwards flush to the replica server.
Mutagen's list argument is a **label selector**, not a session name: list managed
sessions and then select the name when inspecting/removing a single session.

`run/RunWorker` keeps completed background records for seven days and bounds each
journal to 10 MiB. `T3CODE_RUN_RETENTION_MS`, `T3CODE_RUN_LOG_BYTES` and
`T3CODE_RUN_KILL_GRACE_MS` override those limits (termination defaults to ten seconds).
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

`platform/ServerPlatform.ts` replaces R1 `RunPlatform.ts` and S1 `PeerPlatform.ts`.
Run launchers and peer/replica transports import it directly, including the shim's lazy native-invocation import. It owns login shell quoting, Windows batch/PTY invocation,
private IPC paths and modes, SSH wrappers and conflict-copy names. The worker source
fragment stays in this boundary because it executes on the primary without module imports.
Existing `run/RunPlatform.test.ts`, `replicas/ReplicaPlatform.test.ts`, peer-facts,
IPC and conflict-copy tests exercise the shared implementation.

### Bootstrap and rolling updates (B1)

`MeshBootstrap.ts` reconciles unbound `machines.<name>.bootstrap` entries. The server that can authenticate to the target detects OS/architecture, verifies the mesh-version release against an independently pinned `t3.runtimeChecksums[archive filename]`, installs a platform service, obtains a pairing credential locally on the target, establishes N1 mutual trust and writes a C2 name binding. Individual step statuses are replicated under `mesh.bootstrapStatus`; a target-side lock and an installation sentinel make retries resumable. SSH keys and host pins live beneath the server base directory, apart from managed SSH blocks.

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

## W1 upstream v0.1.7 integration

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

The bed's `convergence.mjs` captures an all-entry HLC barrier for rounds with live
reports; the default round-one check still requires complete document equality.
This avoids comparing sequential reads as if they were an atomic distributed snapshot.
Round 2 provisions SSH through `meshConfig.apply` and probes bound `t3-<name>` aliases;
the legacy raw-route/key installer is no longer part of that acceptance path.

Explicit folder comparison in `ProjectReplicaService.place` must use the same v2 ignore policy
as reconciliation. Otherwise a populated replica that correctly excludes an ignored file is
rejected when selected again. The existing in-flight-placement test covers that policy boundary.
Round-three fixtures configure ignores and conflict policies through `meshConfig.apply`; their
adoption daemon uses the isolated server HOME, with a guard against the owner's HOME.

Bed conflict scenarios await the resolver’s preserved copy and converged contents; a forced Mutagen flush
can race its intentional pause. R1 canonicalizes local fixture paths before publishing mappings,
because a process reports its physical cwd beneath a symlinked temp root. Its login fixture writes
the profile in both the SSH account’s passwd home and the isolated runtime HOME.
Round three checks lock ownership before destructive operations and leaves shared services untouched
if a host reboot removes the lock. Crash workloads remain 128/256 MiB with mandatory
active-staging and file-hash assertions.
Network acceptance also fences RPC operations and tunnel cleanup after a lost lock.
R1 accepts a run only after automatic conflict resolution, or exit 75 while conflicts remain;
both paths must converge to the primary and preserve the actual losing file without fixture repair.
Round-one diagnostics refresh every node even when earlier snapshots differ, so failure output
cannot accidentally show an older snapshot for a later node.
Its legacy-mirror assertion brackets the settings read with two equal materializations on one
connection; ongoing status reports cannot invalidate an older, separately captured snapshot.
Raw workspace fixtures allocate fractional ranks instead of reusing `zzzz`; otherwise a routine
config diff can repair tied ranks and legitimately compete with the concurrent reorder under test.

The round-three daemon fixture keeps its isolated server stopped until the foreground
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
round three also verifies that crashing one server leaves the others' restart counters unchanged.

An inbound connection can become visible before its reciprocal grant notification commits
the link. NAT acceptance waits for both the direct connection and the stored reachable,
address-free grant before testing the relay.

## X1 upgrade regressions

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
Round-two acceptance follows project pagination and budgets the full server readiness window;
its 128 MiB canary now checks both SHA-256 and replica size.

Local SSH pipe sockets disable Nagle: separate small SSH records otherwise wait for TCP delayed
ACKs even on loopback. The real relay/IPC test exercises split records before its 200 MiB canary.

Existing-session adoption resolves SSH endpoints from machine bindings and the configured SSH mode, just like replica creation. Display titles and labels can change independently of a managed `t3-<name>` alias or an existing SSH host; using them to identify endpoints rejects valid reversed sessions.

Automatic conflict resolution records its Mutagen session id in `repstatus.resolvingConflicts`
before pausing. Keep that intent when publishing errors. After an interruption the driver resets
and resumes only that marked session, then scans again; an unmarked pause remains intentional.
Clearing intent before resume completes can strand the copy after a crash. Legacy whole-object
settings writes leave replica diagnostics to the servers, so older clients cannot erase this intent.

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

`meshConfig/sshHost.ts` is the shared SSH destination validator. Run plans, run transport,
replica routes/endpoints, platform SSH arguments and SSH route checks use it. Destinations are
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
`desktopShell` bridge. Storage is also separated when the selected server changes. It cannot read desktop credentials, catalogs, legacy storage, SSH,
exposure controls or media IPC. Server UI navigation and popup attempts cannot launch native external handlers. Every IPC entry checks the sender's top frame and current
application origin. Protocol routing tracks main-frame navigation events because Electron's
Fetch Request does not retain navigation mode; an HTML Accept header never changes the
source. Documents require protocol `1` and bridge `reduced-1` response headers; incompatible
or unavailable sources redirect to the bundled origin. Server CSP forbids objects and limits
connections to saved catalog origins. Media IPC permits only saved origins, omits credentials
and refuses redirects. The isolated hostile-server proof is documented in delivery.md.

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
