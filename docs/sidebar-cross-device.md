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
  every 60 s exchange with each peer via a fork MCP tool `t3_mesh_exchange` (input: entries newer
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
  `t3-env=<envId8>`; `mutagen sync create --sync-mode two-way-safe --ignore-vcs --ignore …
  --default-file-mode-beta=0644 --default-directory-mode-beta=0755 --symlink-mode=portable
  <ssh>:<sourcePath> <localPath>` (alpha = source). Per-key lock; ensure is idempotent (check
  `mutagen sync list --label-selector`; verify `--template '{{json .}}'` on Mutagen 0.18.x).
- State machine → `repstatus` entries (state changes only) + live progress via RPC
  `replicas.status` (polled by the client showing it). First `watching` → register the project via
  ProjectService (reuse an existing project at that root) → write `projectId` into the `rep`.
- Conflicts (two-way-safe) → `conflict` with count and paths in `replicas.status`; problems
  (e.g. root-owned files on the source) → `error`. Never auto-chown, never auto-delete.
  `replicas.retry` (resume/recreate), removing the `rep` entry → terminate session, keep files,
  archive nothing. Orphan sessions (label, no entry) are reported, not touched.
- Reverse direction works the same: any machine can be a replica of any other; a project can have
  two primaries (`transport: git`, independent checkouts) and replicas of either.
- Disabled unless `replicasEnabled` (server setting); requires a non-fenced caller.

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

## Stages and owners

| Stage           | Scope                                                                                                 | Depends on |
| --------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| A — core        | §1 pure CRDT lib, materialize/diff/importLegacy, §4 pure functions, exhaustive tests                  | —          |
| B — tags        | §7 tags UI + Settings › Machines (reads materialized config; write path via current settings until C) | —          |
| C — server mesh | §2 store, RPC, replication over links, legacy compat                                                  | A          |
| D — clients     | §3 web + mobile read/write via mesh, offline queue, §4 UI                                             | A, C       |
| E — replicas    | §5, §6 server + clients + MCP                                                                         | A, C       |
| F — skills      | §8                                                                                                    | C, E       |
| G — e2e         | test bed and scenarios below                                                                          | all        |

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
