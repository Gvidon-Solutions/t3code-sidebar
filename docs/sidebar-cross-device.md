# T3 Mesh: one layout, logical projects, replicas on any machine (fork feature spec)

Owner: Anton. Coordinator: Claude (Operalia). Implementers: agents on gvidon.
Integration branch `xdev` (worktree `/home/user/Repos/t3/t3code-xdev`, from `origin/ws` d439778e41).
Read `AGENTS.md` and `FORK.md` first. Fork code goes into fork-only files; seams into upstream
files stay small and are listed in FORK.md.

## Product in one paragraph

The owner runs T3 servers on several machines (today gvidon, Operalia, gor, a VPS, a Windows
desktop; tomorrow maybe two "main" machines). They form a **mesh**: every server knows the others,
holds a replica of one shared **layout document** (workspaces, placements, order, fold, machine
names/tags, logical projects) and merges edits from any server or client automatically, offline
included. A **logical project** is one card in the sidebar with **representations** on machines:
any number of **primaries** (own `.git`, compute) and **replicas** (working copies synced from
one source representation with Mutagen, both directions). Which machine is primary is
configuration per project, never code. Creating a thread "in project X on machine M" makes M a
replica when needed — mounted, synced, registered, placed — then the thread starts. Agents and
voice can do everything by name: "создай тред в проекте X на Operalia", "открой тред про mount"
— whatever machine it lives on.

## 0. Object model (the law; code must match it exactly)

Primitives (unchanged, owned by T3/upstream or the OS): **Machine** (one T3 server, `environmentId`), **Link** (PeerLink between two machines), **Folder** (a directory on one machine), **Thread** (lives on exactly one machine, has a working directory), **Sync session** (one Mutagen session keeping two folders equal), **Layout document** (the replicated CRDT).

Layers built on them:

1. **Mesh** = machines + links. Exactly one **authority** machine: layout entry `mesh.authority` = environmentId (configurable in Settings › Mesh; the owner's is gvidon; default when unset = the machine with the lowest environmentId among those that ever wrote, shown in the UI as "Authority: <label>"). The mesh needs connectivity, not a full graph: calls relay through linked peers (≤ 2 hops).
2. **Project** (logical) = opaque stable id (the logical key; NEVER shown to the user anywhere — UI, CLI output, MCP text; only ids in JSON fields) + **title** (one name for the whole mesh, renameable from any machine; layout `proj/<id>.title`) + **representations**: (machine, folder path, role, transport, projectId on that machine). Roles: **primary** (owns `.git`, builds, tests; ≥ 0 per project, usually 1) and **replica** (folder kept equal to one primary by one sync session). Legacy keys (`github.com/…`, `<env>:<path>`, `title:…`) are only **aliases** of the id. A server's own project record is the representation's local handle, not the project.
3. **Sync**: one replica ↔ exactly one sync session with its source primary (alpha = primary, beta = replica). Driver = the side that can ssh to the other (replica side first). States: pending → mounting → watching; conflict, error, paused; removed. Ignores: VCS + the configured list.
4. **Presentation**: workspaces (placement, order, fold), machine labels/tags/colors and user-defined aliases stored on `machine/<env>`, the per-row machine strip. Purely organisational; nothing in sync or threads depends on them.

Interfaces: UI (web, desktop, mobile), CLI (`t3ctl`), MCP tools, and **context injection** (every turn knows: machine, project title, representation role, primary + how to run git/builds there, neighbours; `t3_thread_self` for the full picture).

Thread rules: a thread runs on one machine; its working directory is inside one representation of its project (or no project). Moving a thread = same machine → change project/working dir; other machine → transfer (history copied, original archived with a link). Creating a thread "in X on M" = ensure a representation of X on M, then launch there.

### Invariants (tests must assert each)

- I1 Every representation belongs to exactly one project; a (machine, normalized path) pair maps to at most one project.
- I2 Each replica has exactly one sync session (deterministic name), never two; removing the representation terminates it and keeps files.
- I3 The project title is the same on every machine and every surface; renaming changes only the title, never the id.
- I4 No user-visible surface prints an opaque id or a legacy key as a name.
- I5 Workspaces never influence sync, threads or routing.
- I6 Any machine can be primary, replica, both (different projects) or authority; nothing assumes gvidon except the configured authority value.

### Authority and conflicts (owner rule: one machine is 100 % the source of truth)

- File conflicts in a sync session are resolved automatically, no human step: the winner is the **authority's** representation if the authority holds one of the two sides, else the **primary**. Before the losing side's version is replaced, T3 copies it to `<loser folder>/.t3-conflicts/<ISO time>/<relative path>` (ignored by sync), then makes the winner's version propagate (delete/replace on the loser side, flush), and records `repstatus` message "Resolved N conflicts automatically · copies in .t3-conflicts". The UI shows this as a calm note, not an error; the user can open the copies.
- Divergence after a crash, partition or a killed Mutagen daemon: the session is re-established automatically (adopt, resume, or recreate with the same name); if the two sides differ, the same rule decides and the losing files are copied first.
- Layout: entries merge by LWW (no conflicts by construction); ambiguous adoptions (same workspace name, different ids; same project path claimed twice) are decided in favour of the authority's entries.

### Resilience requirements (each with an automated test on the bed)

Kill -9 each server mid-sync and mid-mount; kill the Mutagen daemon; cut a link/tunnel for minutes; restart the authority; reboot order permutations — everything converges without manual steps, no duplicate sessions/projects, no lost file versions (losers in .t3-conflicts), layout identical everywhere.

## Facts from the code today (verify line numbers on xdev)

- Layout = `ServerSettings.sidebarWorkspaces` (`packages/contracts/src/sidebarWorkspaces.ts`),
  per server, replaced whole on write (`packages/shared/src/serverSettings.ts`, "Fork: clients
  always send the whole workspace config"). It is a shared setting
  (`packages/client-runtime/src/state/sharedSettings.ts`): web writes the whole object to every
  server (`apps/web/src/hooks/useSettings.ts`), web reads "first connected remote with workspaces
  by id" (`apps/web/src/components/workspaces/WorkspaceSidebar.tsx`), phone reads the first server
  by id and writes `edit(source.config)` per server
  (`apps/mobile/src/features/workspaces/useSidebarWorkspaces.ts`). Copies drift; phone shows
  Operalia's layout.
- Live data: tile "main" is `workspace-4` on gvidon and `main` on Operalia; keys mix
  `github.com/...`, `<envId>:<path>`, `github-anton/...`; keys of offline environments
  (`e2e6225c…` Windows) must never be pruned.
- Logical project key = client derivation by grouping mode
  (`packages/client-runtime/src/state/projectGrouping.ts`). Synced folders without `.git` have
  `repositoryIdentity: null` and never group by repository.
- Machine label: `apps/server/src/environment/ServerEnvironmentLabel.ts` → `descriptor.label`;
  clients show the label saved at pairing. Mobile row chip is on the RIGHT, always
  (`WorkspaceThreadLine.tsx`); web shows a remote icon on the right (`SidebarThreadRow.tsx`).
- Server-to-server links exist: `PeerLinks` (`apps/server/src/peer/`), stored per server, call the
  peer's `/mcp` with a session made from a pairing code (`packages/contracts/src/peerLink.ts`);
  `PeerMcpClient`, `PeerForwarding`, `RemoteDelegation` (finds a project there only by repository
  key). Gated by setting `linkedEnvironmentsEnabled` (off on Operalia today). Fenced (non
  full-access) links may not change projects/settings (`apps/server/src/mcp/linkOrigin.ts`).
- MCP project toolkit (`apps/server/src/mcp/toolkits/project/tools.ts`): `t3_project_create`,
  `t3_project_clone`, `t3_thread_launch` accept `environmentId` (forwarded over links).
- Contracts already on `xdev` (commit "layout revision, machines, project aliases and mounts"):
  `SidebarWorkspacesConfig` gained `machines`, `projectAliases`, `projectMounts`
  (representations: environmentId, path, projectId?, transport git|mutagen|sshfs|manual,
  role primary|replica, source?, ignores?), `projectMountStatus`.

## Architecture

### 1. Layout document = LWW-map CRDT (fork file `packages/shared/src/meshLayout/` or

`packages/client-runtime/src/state/meshLayout/`, pure, no Effect services)

- `Hlc` string `"<ms:13 digits>.<counter:5 digits>.<envId>"`, compared lexicographically;
  `tick(now, last, envId)`, `receive(local, remote, now)`.
- Document = `Record<key, { v: Json | null, h: Hlc }>`; `null` is a tombstone. `merge(a, b)` =
  per key the higher `h`. Commutative, associative, idempotent (property tests).
- Keys:
  - `ws/<workspaceId>` → `{ name, icon?, color?, sort }`
  - `ws.default` → workspaceId · `ws.quietAfterDays` → number
  - `rule/<id>` → `{ match, workspace, sort }`
  - `place/<projectKey>/<workspaceId>` → `{ sort }` (presence = shown there; `sort` = its order in
    that workspace) — replaces placements/assignments/workspaceProjectOrder
  - `order/<projectKey>` → `{ sort }` shared fallback order (legacy `projectOrder`)
  - `fold/<workspaceId>/<projectKey>` → `"quiet" | "active"`
  - `alias/<key>` → logical key
  - `rep/<logicalKey>/<environmentId>` → representation (fields of `SidebarProjectMount`)
  - `repstatus/<logicalKey>/<environmentId>` → `SidebarProjectMountStatus` (written only by that
    environment's server)
  - `machine/<environmentId>` → `{ label?, tag?, color?, reach?: Record<envId, { ssh: string }> }`
- `sort` values are fractional-index strings (`between(a, b)`), so concurrent reorders merge.
- `materialize(doc) → SidebarWorkspacesConfig` (all existing pure functions and UI keep working on
  it) and `diff(before: SidebarWorkspacesConfig, after: SidebarWorkspacesConfig, doc, hlc) →
  entries` (turns any edit made with today's pure functions into minimal entries; array orders →
  fractional sorts that keep untouched items' keys).
- `importLegacy(config, envId, hlc0)` → entries (migration: old per-server config becomes entries
  with a low clock, so any real edit wins; several servers' imports merge without loss; workspaces
  with the same name but different ids are unified: the id that sorts first wins and the others
  become `alias`-like remaps applied during import).

### 2. Server: `MeshLayoutService` (fork dir `apps/server/src/mesh/`)

- Stores the document in the server DB (new migration, table `mesh_layout_entries(key primary,
  value json, hlc)`), plus the local HLC.
- On first start: `importLegacy(settings.sidebarWorkspaces)`.
- Keeps `settings.sidebarWorkspaces` = `materialize(doc)` so old clients still read it; an old
  client's whole-object write is converted with `diff` (never replaced whole).
- RPCs (contracts `packages/contracts/src/meshLayout.ts`, follow `rpc.ts` patterns and
  `clientRpcPermissions.ts`): `meshLayout.get` (doc + materialized), `meshLayout.apply(entries)`,
  `meshLayout.subscribe` (stream of merged changes). Capability flag `meshLayout`.
- Replication: `MeshReplicator` uses every PeerLink with full access: on change (debounced) and
  every 5 s exchange with each peer (links point one way, so pulls carry the far side's edits) via a fork MCP tool `t3_mesh_exchange` (input: entries newer
  than the peer's last-acked HLC from us + our known watermark of theirs; output: their newer
  entries). One link per pair is enough (the exchange is two-way); entries gossip transitively.
  Backoff on unreachable peers; never blocks anything.
- Mesh membership is the set of links plus `machine/*` entries. Setting
  `meshEnabled` (default true when `linkedEnvironmentsEnabled`).

### 3. Clients (web + mobile)

- Read the layout from any connected server that has the `meshLayout` capability (prefer the
  primary/local one; all are consistent), via `meshLayout.get/subscribe`; fall back to today's
  behaviour for old servers.
- Write: apply the edit with the existing pure functions on the materialized config, `diff` to
  entries, `meshLayout.apply` on one server (it replicates). Persisted offline queue per device
  (entries are idempotent, replay is safe).
- Remove `sidebarWorkspaces` from `SHARED_SERVER_SETTING_KEYS` fan-out (servers replicate now).

### 4. Logical projects

- `resolveLogicalProjectKey(project, config)`: physical key `${envId}:${normalizedRoot}` → a `rep`
  with same env+path → its logical key; else old derivation; then follow `alias` (cycle-safe,
  ≤ 8 hops). Used by `buildProjectGroups` (web + mobile snapshot builders).
- `mergeLogicalProjects(config, from, into)`, `splitLogicalProject`, `addRepresentation`,
  `removeRepresentation`, `setPrimary`. Folder menu: "Merge with…", "Split", "Machines…"
  (list representations with role/state; add replica on machine; make primary; remove).
- Suggest merges: same normalized title on different machines → one-click "Merge" hint in the
  folder menu (not automatic).

### 5. Replicas: `ProjectReplicaService` (fork dir `apps/server/src/replicas/`)

Declarative and per machine: each server reconciles the `rep/*/<self>` entries whose
`transport = "mutagen"` and `role = "replica"`.

- Needs `machine/<self>.reach[source].ssh` (ssh alias/URL to the source machine) — configurable in
  Settings › Machines; local server settings: `mutagenPath` (default `mutagen`), `replicaRoot`
  (default "": same absolute path as the source when free, else `~/t3-replicas/<basename>`),
  `replicaIgnores` (default `node_modules .venv venv __pycache__ .pytest_cache dist build target
  .next .turbo coverage .t3 .claude/worktrees .DS_Store`, no trailing slashes) + `--ignore-vcs`.
- Session: deterministic name `t3-<hash8(logicalKey)>-<envId8>`, labels `t3-logical=<hash8>`
  `t3-env=<envId8>`; `mutagen sync create --mode two-way-safe --ignore-vcs --ignore …
  --default-file-mode-beta=0644 --default-directory-mode-beta=0755 --symlink-mode=portable
  <ssh>:<sourcePath> <localPath>` (alpha = source). Per-key lock; ensure is idempotent (check
  `mutagen sync list --label-selector`; verify `--template '{{json .}}'` on Mutagen 0.18.x).
- State machine → `repstatus` entries (state changes only) + live progress via RPC
  `replicas.status` (polled by the client showing it). First `watching` → register the project via
  ProjectService (reuse an existing project at that root) → write `projectId` into the `rep`.
- Conflicts follow the automatic authority/copy rule in §0, while keeping two-way-safe.
  Scan problems are non-fatal: keep mounting/watching, register on watching, and report
  `skipped` plus bounded `skippedPaths` in live/layout status. Absolute/outside symlinks and
  unreadable files do not prevent other paths from syncing. Blocking runtime/transition or
  disconnected-endpoint failures use `error` with a persisted message, isolated to that copy.
  Never auto-chown. `replicas.retry` resumes/recreates; removing the `rep` entry terminates the
  session and keeps files, archiving nothing. Orphan sessions are reported, not touched.
- Reverse direction works the same: any machine can be a replica of any other; a project can have
  two primaries (`transport: git`, independent checkouts) and replicas of either.
- Disabled unless `replicasEnabled` (server setting); requires a non-fenced caller.

### 5a. Who drives a session, and Mutagen availability (decided after the survey)

- Mutagen 0.18.1: mode flag is `-m/--mode` (no `--sync-mode`); `--label-selector`, `--template
  '{{json .}}'`, `-l/--label`, `--ignore-vcs`, `-i/--ignore`, `--default-*-mode-beta`,
  `--symlink-mode` exist. The ssh endpoint is resolved by OpenSSH (`~/.ssh/config` of the user
  running the daemon).
- A session is driven by ONE side's daemon: the replica's server when `machine/<replica>.reach[source]`
  exists, else the source's server when `machine/<source>.reach[replica]` exists, else the replica
  shows `error: "<replica> cannot reach <source> and back — add an ssh route in Settings › Machines"`.
  The driving server reconciles; the other only reports. Alpha is always the source.
- `reach` value = an ssh destination string (`alias`, `user@host`, `user@host:port`) plus optional
  `identityFile`; T3 writes a managed block `# t3-mesh` into `~/.ssh/config` only when the user saves
  a route with an identity file (never touches other lines).
- Mutagen is installed by T3 itself when missing: `MutagenInstaller` downloads the pinned release
  (0.18.1, sha256-checked) for the host OS/arch into `<baseDir>/bin/mutagen` (+ agents bundle) on
  first use; `mutagenPath` overrides. Each T3 server uses its own `MUTAGEN_DATA_DIRECTORY` under its
  base dir so it never collides with a user's own daemon/sessions (e.g. gvidon's existing
  `mutagen-daemon.service` with sessions `calf-wrapper`, `acc-review` — never touched).
- Existing manual sessions can be adopted: Settings › Machines lists the user's foreign sessions.
  Adoption records `transport: mutagen`, pauses the original, recreates the same endpoints under
  T3's private daemon and terminates the original only after the replacement watches. Conflicts
  preserve the losing versions under the §0 authority rule.

### 2a. Links and routing (decided after the survey)

- Links today: none; `linkedEnvironmentsEnabled=false` on gvidon/Operalia; gor runs 0.0.45 without
  links. HTTP reachability: gvidon→Operalia `https://operalia.bolychev.com:3774`; Operalia→gvidon
  `https://happier.nobodyshurt.com`; gvidon↔gor only through ssh tunnels (gor listens on loopback);
  Operalia↔gor no route.
- The mesh does not need a full graph: layout gossips over any connected graph. Tool calls to a
  machine without a direct link are relayed: `PeerForwarding` forwards to a linked peer that has a
  link to the target (max 2 hops, loop guard by a hop header, the target's access rules still apply).
- `meshEnabled` replication runs only over full-access links. Turning the mesh on in Settings › Mesh
  also turns on `linkedEnvironmentsEnabled` (explain it in the UI).
- `ui_open` gains `environmentId` (thread and file targets); the server forwards a UI request for a
  thread on another machine to the client that shows the calling thread, and the client switches
  environment.

### 6. "New thread in project X on machine M"

- Web folder menu / mobile new-task flow: machine picker (connected environments, tags).
- If M has a `rep` with `projectId`: open the thread draft there.
- Else: write `rep/<X>/<M>` (replica of the first primary, or as chosen), show a pending row in the
  folder with M's tag and state (`mounting…` with progress, Retry on error), never block; when
  `projectId` appears, open the draft there (or, when started with a message, create the thread
  and send it).
- MCP: `t3_project_place` (add/remove representation, optional wait for `watching`),
  `t3_project_machines` (list representations + status), `t3_thread_launch` with `environmentId`
  places the replica first when the project is not there. `RemoteDelegation` resolves projects
  through `rep` entries before the repository match.
- Agents in a replica get a note (thread context) that git and builds run on the primary:
  `ssh <reach> 'cd <primaryPath> && …'`.

### 7. Machine tags and finding threads anywhere

- `machineDisplayOf(config, envId, fallbackLabel)` → `{ label, tag, color }` (tag default: two
  uppercase alphanumerics of the label).
- Tag chip LEFT of the thread title (after the status glyph), web workspace sidebar + mobile
  workspace list, only when the folder's project spans > 1 environment (cross-project sections:
  when > 1 environment connected). Remove the mobile right-side chip; upstream sidebars untouched
  (optional prop on `SidebarThreadRow`). Full label in tooltip/accessibility.
- Settings › Machines (web + mobile): every known environment, label, tag, color, reach (ssh) per
  other machine, link status, replica defaults.
- MCP `t3_thread_search` / `t3_thread_list` accept `environmentId: "all"` (fan out over links, merge
  results with `environmentId` on each) so "открой тред X" works whatever machine holds it; `ui_open`
  already takes environment + thread.

### 8. Skills (`~/.agents/skills/t3`)

`t3ctl machines`, `t3ctl mesh status|link <machine>`, `t3ctl place <project> --on <machine>
[--primary] [--wait]`, `t3ctl new --project P --on <machine>`, `t3ctl find "words"` (all machines),
`t3ctl open <thread>`; SKILL.md triggers with voice phrasing; the mesh paradigm documented once.

### 9. Files anywhere

- Any file on any machine opens in the side panel's file viewer — in a project, outside projects,
  on a replica or a primary. Find the existing file viewer and `ui_open` file support (web + mobile),
  and the server RPCs that read files (projects file read/list); add a mesh-aware path:
  `files.read({ environmentId, absolutePath })` on the machine that holds it (direct client
  connection when the client is connected to it, otherwise forwarded by a connected server over its
  link), with the existing size/binary limits and a permission scope; images/PDF/markdown preview as
  today.
- "Open file…" command (palette + sidebar): machine picker (tags) + path with completion
  (`files.list` on that machine); recent files per machine. Links `t3-file://<envId>/<abs path>` and
  agent output paths resolve to the machine the thread runs on.
- MCP `ui_open` accepts `{ file: { environmentId?, path } }`; agents on any machine can open a file
  from any other machine on the owner's screen.

### 10. Mesh in the interface

- Settings › Mesh (web + mobile): every known machine (from links and layout `machine/*`), with tag,
  status (reachable / unreachable / not linked / not connected from this client), version, last
  sync, replicas count. Actions: "Link with…" (guided pairing: pick a machine this client already
  knows, T3 creates the pairing code on one side and links from the other — no copy-paste when the
  client is connected to both), "Connect this device" (when a mesh machine is known through a link
  but this client has no connection: show its address and a pairing flow), unlink.
- Partial view: a client connected to only some servers still sees the whole layout (it is
  replicated) — projects and threads of machines it cannot reach show greyed with "on <tag>, not
  connected here" and a one-tap connect. Never hide them silently, never duplicate them.
- When a new server joins (link created), it gets the full layout within one exchange; its projects
  appear in the default workspace (or by rules) on every client.
- Status line in the sidebar footer: "Mesh: 3 machines · synced" / "OP unreachable 5 min".

### 11. Agents everywhere understand the mesh

- Global agent instructions on every machine (gvidon, Operalia, gor): `~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md` (and other harnesses' global files that exist), kept identical in content:
  the machines, their roles, the mesh, the `t3` skill and when to use it, Mutagen rules (git and
  builds on the primary), how to open threads/files on any machine.
- Behaviour eval: a list of Russian voice-style requests ("создай тред в проекте X на Operalia
  на соннете", "открой тред про маунт", "покажи файл README из X на гвидоне", "сделай X репликой на
  горе", "что сейчас работает на всех машинах") run as real threads on the test bed with several
  harnesses (Claude, Codex, DeepSeek 1017); pass = right tool calls, first action within seconds, no
  wandering. Fix skills/instructions until all pass.

## Stages and owners

| Stage           | Scope                                                                                                 | Depends on |
| --------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| A — core        | §1 pure CRDT lib, materialize/diff/importLegacy, §4 pure functions, exhaustive tests                  | —          |
| B — tags        | §7 tags UI + Settings › Machines (reads materialized config; write path via current settings until C) | —          |
| C — server mesh | §2 store, RPC, replication over links, legacy compat                                                  | A          |
| D — clients     | §3 web + mobile read/write via mesh, offline queue, §4 UI                                             | A, C       |
| E — replicas    | §5, §6 server + clients + MCP                                                                         | A, C       |
| F — skills      | §8                                                                                                    | C, E       |
| H — files       | §9                                                                                                    | C          |
| I — mesh UI     | §10                                                                                                   | C, D       |
| J — agents      | §11 instructions + behaviour eval                                                                     | F          |
| G — e2e         | test bed and scenarios below; web (Playwright), Android (adb emulator), desktop build                 | all        |

## Test bed (E2E) — never the live gvidon/Operalia servers

- Machine 1 (primary): gor (`ssh -F ~/.local/share/gor-transfer/ssh_config -i ~/.ssh/id_malaniya_25519
  -o IdentitiesOnly=yes gor`), its own T3 test server (restart allowed), demo repo
  `~/xdev-e2e/demo`.
- Machine 2: VPS `152.89.244.57` (`ssh -F ~/.local/share/vpn-ops/ssh_config 152.89.244.57`), NEW
  isolated container `t3-xdev` (compose `/opt/t3-xdev`, 127.0.0.1:3791 only, ≤ 2 GiB RAM, image
  from `xdev` + mutagen + openssh-client). Never touch `t3-ws` or other stacks there.
- Machine 3: gvidon isolated server (`--base-dir /tmp/t3-xdev-gv --port 3795`).
- Clients: web via Playwright on gvidon (ssh -L tunnels), Android emulator on gvidon
  (`scripts/sidebar-mobile-e2e/`), desktop build smoke.
- Scenarios: link all three; legacy configs (copies of the real gvidon and Operalia
  `sidebarWorkspaces`) import and merge without losing a key; edits on each machine and offline
  edits converge; tags left only in multi-machine folders; "new thread on VPS" in the demo project →
  mounting → watching → project registered → thread runs → file edit reaches gor, `.git` and
  `node_modules` did not; reverse (gvidon replica of a VPS primary); two primaries; conflict →
  shown → resolved → Retry; remove replica → session gone, files kept; ensure twice → no
  duplicates; restart a server → state recovered; agent finds and opens a thread on another machine.

## Rules for every agent

- Work only in your own worktree/branch given in your task; commit there (conventional messages,
  e.g. `feat(mesh): …`). Never push, never touch `ws`, never restart/update the live T3 on gvidon
  or Operalia, never edit their settings.
- `export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH` in every shell (hooks need it).
  The pre-commit `knip:check` already fails on `ws` (33 old unused exports): commit with
  `--no-verify` after running yourself `./node_modules/.bin/vp fmt`, `./node_modules/.bin/vp lint`
  (no errors), typecheck and the tests of every package you touched; add no new knip findings.
- Tests for every pure function; FORK.md feature-log entry for your stage.
- Report at the end: branch, commits, files, commands and results, open issues.
