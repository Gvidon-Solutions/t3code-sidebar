# T3 Mesh — guide for agents

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
| Machine           | one T3 server (`environmentId`), label/tag/color/aliases, SSH routes to other machines                          | config + layout `machine/<env>`                               |
| Link              | server-to-server MCP session with config-defined permissions                                                    | each server's PeerLinks table                                 |
| Mesh              | machines + links; desired state in the mesh config (`mesh.config`), no central authority                        | layout `mesh.config`, bindings                                |
| Project (logical) | opaque id (the logical key, never shown) + **title** + representations                                          | layout `proj/<id>.title`, `rep/<id>/<env>`, `alias/*`         |
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
  every currently linked full-access peer before collection.
  Web and mobile mount one `MeshLayoutProvider` each; their hooks adapt RPC and persistence
  to `packages/client-runtime/src/state/meshLayoutClient.ts` (`MeshLayoutStore`). The store
  owns snapshots, subscriptions, optimistic edits and the persisted reconnect outbox.
- **Routing.** A call for another machine goes direct when linked, else through one relay hop:
  `apps/server/src/mesh/MeshRouting.ts` (`callRouted`) used by `PeerForwarding`, files and forks.
- **Replicas.** `apps/server/src/replicas/`: `MutagenInstaller` (pinned 0.18.1, sha256),
  `MutagenRunner` (CLI wrapper, private `MUTAGEN_DATA_DIRECTORY`), `ProjectReplicaService`
  (reconcile on layout change + every 30 s; deterministic session names; state machine;
  registers the project on the replica machine when watching), `ReplicaPaths` (allocation),
  `ManagedSshConfig` (only the `# t3-mesh` block), `ReplicaInstructions` (the context note).
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
  Restoring a layout history revision follows the same plan/apply path. Settings displays
  machine and per-action apply state; config owns names and SSH settings.
- **UI.** Web `apps/web/src/components/workspaces/` (MachineTag, ProjectMachineStrip
  `A ⇄ B C`, MeshSettingsPanel, MachinesDialog, PendingReplicaRow, MoveProjectDialog,
  ForkThreadDialog, MeshFooterStatus, FileMachineTag); mobile
  `apps/mobile/src/features/workspaces/` (same names). Pure logic lives in
  `packages/client-runtime/src/state/{meshLayout/*,machineDisplay,meshMachines}.ts`.

## Interfaces

- **CLI / skill:** `agent-kit/skills/t3` (`SKILL.md`, `scripts/t3ctl.mjs`). Mesh commands:
  `mesh config get|plan|apply|rollback|history`, `mesh status`, `replica adopt <session> --project P`,
  `machines`, `machines alias <M> list|add|remove|clear`, `mesh status|link|unlink`, `place/unplace`, `replicas`, `new --on`, `find --all`,
  `threads/status --all`, `open`, `open-file`, `cat`, `fork --on`, `move --project`, `layout get|merge`, `agents sync|status`, `self`.
- **MCP tools** (in the server): `t3_project_place`, `t3_project_machines`, `t3_thread_self`,
  `t3_thread_*` with `environmentId` (or none — ids resolve across the mesh), `t3_thread_fork`
  (`environmentId` = thread's machine, `targetEnvironmentId` = destination), `t3_files_read/list`,
  `ui_open` with `environmentId`, link-only `t3_mesh_*` and the `t3_thread_receive_fork` receiver.
- **Agent instructions:** `agent-kit/skills/t3/global/GLOBAL.md` (the owner's canonical text, Russian)
  and `machines.json`; rendered per machine with a one-line header into `~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`.

## The agent kit (skills and instructions live in this repo)

`agent-kit/` is the source of truth; machines hold installed copies. Edit here, commit, then:

```bash
agent-kit/install.sh            # dry run: skill diff per machine + instruction diff
agent-kit/install.sh --apply    # install on registry machines (backups under ~/.local/state/t3-agent-kit/)
agent-kit/install.sh --dest ~/.agents/skills/t3-next   # stage for the test bed only
```

Machine names, tags and aliases are config data, not CLI constants. `machines alias` applies the
bound machine's optional `aliases` array through config concurrency checks; N-1 servers retain the
layout edit path. Alias edits retain the other machine and unknown config fields. Unspecified
thread model and permissions are resolved by the destination server, never by owner preferences
compiled into the CLI.

Installation routes and personal agent instructions stay in `global/`; `T3CTL_AGENTS_CONFIG` selects
another registry directory. SSH options, relay ids (`via`) and remote `nodeCommand` are data.
`server install` requires an explicit `T3CTL_RELEASE_REPO`.

Never edit `~/.agents/skills/t3` on a machine directly (it is overwritten), and never run
`vp fmt` on the skill or GLOBAL.md (formatting is excluded on purpose: padded tables waste every
agent's context). Keep SKILL.md under ~26 KB and general — no recipes for specific test phrases.

## Testing

- Skill: `T3CTL_OFFLINE_ONLY=1 bash agent-kit/skills/t3/scripts/selftest.sh` includes shared-core
  parity when run from the checkout. `node --test agent-kit/install.test.mjs` verifies staging.
- Unit/integration: the package suites (`pnpm -s test` per package; web with `--maxWorkers 4`),
  `vp lint` 0 errors, `typecheck` in contracts/shared/client-runtime/server/mobile and
  `vp exec tsc --noEmit -p apps/web/tsconfig.json`. Commit with `--no-verify` only because of the
  old knip baseline; add no new knip findings.
- Three-machine bed: `scripts/mesh-e2e/README.md` (gor main server + isolated gvidon :3795 +
  VPS container :3791; `up.sh <ref>`, `status.sh`, `tunnels.sh up` when tunnels died).
  `round1.sh` (layout, links, files, old clients), `round2.sh` (replicas on real Mutagen, t3ctl),
  `round3.sh` (crashes, partitions, duplicate claims). They must stay green.
  `config.sh` verifies C1 config planning/apply, stale-base refusal, label/title convergence on
  three servers and a real registered replica. It requires the C1 bed lock and an existing
  deployment; `MESH_E2E_ARTIFACTS` selects its build metadata. Fixtures are C1-prefixed.
- Agent behaviour eval: `docs/mesh-agent-eval.md` records the earlier bed methodology. After
  changing SKILL.md or GLOBAL.md, run model-level routing cases using customer-defined machine
  identities/aliases and configured models; do not make old owner-name translations part of the product contract.

## Operating the owner's live machines (installation example)

- Releases: push to `ws` builds desktop (Windows/Linux), APK and the server runtime
  (`sidebar-desktop.yml`). Live servers restart **only with the owner's yes** (AGENTS.md).
- gvidon: user unit; `t3ctl server install <ver>` + `server use <ver> --yes`.
- Operalia: **system** unit as root (`/etc/systemd/system/t3code-sidebar.service`), no gh login:
  copy the runtime dir from gvidon, change `ExecStart`, `daemon-reload`, restart. Claude works
  only on Operalia; this thread type cannot run on gvidon.
- Back up `userdata/statev2.sqlite` (`sqlite3 .backup`), `settings.json` and the unit first.

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
- The standalone CLI layout encoder must stay in parity with shared core, including `proj/*`
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
  S1 can replace this boundary when replica ownership changes to replica-side driving.

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

S1 (SSH) and B1 (bootstrap, updates, agent instructions) add planners through the same port; nothing
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

Migration (`mesh/MeshConfigMigration.ts`, shared `meshConfig/migration.ts`) runs once on start when
`mesh.config` is absent. It writes the first revision from the legacy layout: machine labels, tags,
colors and aliases, SSH routes (reported `ssh.user`/`ssh.port` plus preserved route data), replica
ignores, project ignores and existing links (`files: all`, so today's meshes behave as before). It
also writes the name-to-environment bindings. It is idempotent: a present `mesh.config` stops it.

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
use `meshConfig.apply` with a base revision. Migration preserves aliases, routes under machine
`ssh.host`/`ssh.routes`, and legacy peer labels; those optional fields remain forward-compatible.

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
  architecture, version and user; absent keys are reported as absent. PeerPlatform owns system
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
