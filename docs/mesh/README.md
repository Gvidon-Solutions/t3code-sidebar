# T3 Mesh — guide for agents

Read this before changing anything that touches machines, projects across machines, replicas,
the shared sidebar layout, thread moves, files on other machines, the `t3` skill or the agent
instructions. It is the map; the law is `docs/mesh/CONCEPT.md` (v2, wins on conflict) and `docs/sidebar-cross-device.md` §0 (object model,
invariants, authority rule). Keep both current when you change behaviour.

## What it is

Each installation runs one T3 Code Sidebar server per machine. Linked
together they form a **mesh**: one replicated sidebar layout, projects that live on several
machines, threads that can be created, found, opened, moved and driven on any machine, files
readable from anywhere, and agents that know where they are.

## Object model (short; full text in the spec §0)

| Entity            | What it is                                                                                                      | Where it lives                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Machine           | one T3 server (`environmentId`), label/tag/color/aliases, SSH routes to other machines                          | layout `machine/<env>`                                        |
| Link              | server-to-server MCP session (pairing code, full access for the mesh)                                           | each server's PeerLinks table                                 |
| Mesh              | machines + links; one **authority** machine (`mesh.authority`)                                                  | layout                                                        |
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
  `MeshReplicator.ts` exchanges local sequence watermarks and store generations over
  `PeerMcpClient`, pushes changes after 200 ms, retries a failed peer exchange on a
  1–15 s backoff and exchanges watermarks every 60 seconds. A changed generation resets
  both peer cursors. Clock rejections and quarantine reasons are
  exposed by `meshLayout.status`. Tombstones require thirty days and acknowledgement from
  every currently linked full-access peer before collection.
  Web and mobile mount one `MeshLayoutProvider` each; their hooks adapt RPC and persistence
  to `packages/client-runtime/src/state/meshLayoutClient.ts` (`MeshLayoutStore`). The store
  owns snapshots, subscriptions, optimistic edits and the persisted reconnect outbox.
- **Routing.** A call for another machine goes direct when linked, else through one relay hop:
  `apps/server/src/mesh/MeshRouting.ts` (`callRouted`) used by `PeerForwarding`, files, handoff.
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
  (`MeshThreadAccess.ts`), moves: same machine = project change (`threadMove`), other machine =
  **handoff** (`ThreadHandoffService.ts`, `handoffBundle.ts`: transcript + attachments as context,
  any harness/model on the target, original archived with a link).
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
- **UI.** Web `apps/web/src/components/workspaces/` (MachineTag, ProjectMachineStrip
  `A ⇄ B C`, MeshSettingsPanel, MachinesDialog, PendingReplicaRow, MoveProjectDialog,
  MoveThreadModelDialog, MeshFooterStatus, FileMachineTag); mobile
  `apps/mobile/src/features/workspaces/` (same names). Pure logic lives in
  `packages/client-runtime/src/state/{meshLayout/*,machineDisplay,meshMachines}.ts`.

## Interfaces

- **CLI / skill:** `agent-kit/skills/t3` (`SKILL.md`, `scripts/t3ctl.mjs`). Mesh commands:
  `mesh authority [<machine>]`, `replica adopt <session> --project P`,
  `machines`, `machines alias <M> list|add|remove|clear`, `mesh status|link|unlink`, `place/unplace`, `replicas`, `new --on`, `find --all`,
  `threads/status --all`, `open`, `open-file`, `cat`, `move`, `layout get|merge`, `agents sync|status`, `self`.
- **MCP tools** (in the server): `t3_project_place`, `t3_project_machines`, `t3_thread_self`,
  `t3_thread_*` with `environmentId` (or none — ids resolve across the mesh), `t3_files_read/list`,
  `ui_open` with `environmentId`, link-only `t3_mesh_*` and handoff tools.
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

Machine names, tags and aliases are runtime layout data, not CLI constants. Settings › Mesh and
`machines alias` edit the same optional `aliases` array on `machine/<env>`. Alias edits retain the
other machine fields; standalone CLI writes must advance beyond every observed HLC. Unspecified
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
  `round3.sh` (crashes, partitions, authority). They must stay green.
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
  Compare the standalone encoder with shared core for authority, titles, aliases and diagnostics.
- A healthy replicated status must survive a failed optional live-query. Keep the persisted
  diagnostics and log query reachability separately; do not fabricate errors for every remote
  copy. Registered machine strips must keep skipped-file notes instead of replacing them with synced.
- A fresh SCP connection may be rejected while an existing SSH session remains healthy during
  bed restarts. Use the same owned control socket for deployment SSH and SCP. Deployment retries
  happen before fault injection; they are not proof of automatic replica recovery.

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
