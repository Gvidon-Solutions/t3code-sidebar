# Cross-device projects, shared layout, machine tags, auto-mount (fork feature spec)

Owner: Anton. Coordinator: Claude (Operalia). Implementers: agents on gvidon.
Integration branch: `xdev` (worktree `/home/user/Repos/t3/t3code-xdev`, from `origin/ws` d439778e41).
Read `AGENTS.md` and `FORK.md` first. Fork code goes into fork-only files; seams into upstream
files stay small and are listed in FORK.md.

## Goal (what the owner must feel)

1. One project card in the sidebar even when its folders live on several machines.
2. "New thread in project X on machine M": if X is not on M yet, T3 mounts it there with
   Mutagen (no `.git`), waits for the first sync without blocking the UI, registers the project
   on M in the same workspace, then opens the thread. Status visible: mounting / watching /
   conflict / error, with Retry.
3. The same workspace layout on every client (desktop, web, phone), whatever server sorts first.
4. Configurable machine tags shown LEFT of the thread title, only where a project really spans
   several machines.
5. Agents (and voice) can do all of it: "создай тред в проекте X на Operalia".

## Facts from the code today (verify line numbers on xdev, they may have shifted)

- Layout = `ServerSettings.sidebarWorkspaces` (`packages/contracts/src/sidebarWorkspaces.ts`),
  per server, replaced whole on write (`packages/shared/src/serverSettings.ts`, "Fork: clients
  always send the whole workspace config").
- It is a shared setting (`packages/client-runtime/src/state/sharedSettings.ts`
  `SHARED_SERVER_SETTING_KEYS`): web writes the whole object to every server
  (`apps/web/src/hooks/useSettings.ts`, sharedPatch fan-out). Web reads "first connected remote
  with workspaces by id, primary excluded" (`apps/web/src/components/workspaces/WorkspaceSidebar.tsx`),
  phone reads the first server by id (`apps/mobile/src/features/workspaces/useSidebarWorkspaces.ts`)
  and writes `edit(source.config)` to each server separately. Result: phone shows Operalia's
  layout (`7c65a175…` sorts before gvidon `a714f2fb…`); copies drift; web can overwrite gvidon.
- Live data: tile "main" is `workspace-4` on gvidon and `main` on Operalia; keys mix
  `github.com/...`, `<envId>:<path>`, `github-anton/...`; keys of offline environments
  (`e2e6225c…` Windows) must never be pruned.
- Logical project key = client-side derivation by grouping mode
  (`packages/client-runtime/src/state/projectGrouping.ts` `deriveLogicalProjectKey`,
  `buildProjectGroups`). No stored logical id. Projects synced without `.git` have
  `repositoryIdentity: null` (`packages/contracts/src/project.ts`) and never group by repository.
- Machine label: server `resolveServerEnvironmentLabel`
  (`apps/server/src/environment/ServerEnvironmentLabel.ts`) → `descriptor.label`; clients show
  the label saved at pairing (`apps/web/src/state/environments.ts` `label:
  presentation.entry.target.label`; mobile `savedConnectionsById[envId].environmentLabel`).
  Mobile thread row draws the label chip on the RIGHT always (`WorkspaceThreadLine.tsx`); web
  draws only an icon on the right for remote threads (`SidebarThreadRow.tsx`).
  `projectGroupsSpanEnvironments` exists in `apps/web/src/sidebarProjectGrouping.ts`.
- Precedent for per-machine server setting: `environmentIcon` (settings.ts, capability flag in
  `ServerEnvironment.ts`, read in `contracts/src/server.ts`).
- `delegate_task` to a linked environment finds the project there only by repository canonical
  key (`apps/server/src/peer/RemoteDelegation.ts` resolveRemoteProject). Fenced links may not
  create projects or change settings (`apps/server/src/mcp/linkOrigin.ts` assertNotLinked).
- `ProjectService` rejects registering a workspace root twice on one server.

## Target data model (contracts, fork file `sidebarWorkspaces.ts`)

Add to `SidebarWorkspacesConfig`, every field with a decoding default so old files decode:

```ts
rev: Int >= 0                       // default 0; bumped by every accepted write
updatedAt: string                   // ISO, default ""
machines: Record<EnvironmentId, {   // default {}
  label?: string                    // display name override (≤ 40 chars)
  tag?: string                      // ≤ 3 graphemes, shown on thread rows ("GV", "OP")
  color?: string                    // CSS color
}>
projectAliases: Record<string, string>   // any key → logical key; default {}
projectMounts: Record<string /*logical key*/, ReadonlyArray<{
  environmentId: string
  path: string                      // workspace root on that machine
  projectId?: string                // project registered there, once it is
  transport: "origin" | "mutagen" | "sshfs" | "manual"
  role: "home" | "mirror"
  createdAt: string
}>>                                 // default {}
```

Logical key stays what it is today (no rewrite of existing keys): the home project's current key
IS its logical id. Mounts and aliases make other physical projects resolve to it.

Resolution (one pure function in client-runtime, used by web and mobile grouping):
1. physical key `${environmentId}:${normalizedWorkspaceRoot}`;
2. if some `projectMounts[k]` entry has the same environmentId + normalized path → `k`;
3. else the old derivation (`deriveLogicalProjectKey`);
4. then follow `projectAliases` (cycle-safe, max 8 hops).

Server-local settings (NOT shared, contracts `settings.ts` + patch schema):
- `sidebarWorkspacesHome: boolean` (default false) — this server holds the shared layout.
- `projectMountsEnabled: boolean` (default false), `mutagenPath: string` (default "mutagen"),
  `mountRoot: string` (default ""; empty = same absolute path as home when free, else
  `~/gv/<basename>`), `mountSshHosts: Record<EnvironmentId, string>` (ssh alias of each home
  machine as seen from this server, e.g. `{ "a714f2fb-…": "gvidon" }`),
  `mountIgnores: string[]` (default below).

Default ignores (no trailing slashes — Mutagen treats `name/` badly when a file replaces a dir):
`node_modules .venv venv __pycache__ .pytest_cache dist build target .next .turbo coverage .t3
.claude/worktrees .DS_Store` plus `--ignore-vcs`.

## Stages

### E0 — one layout home, no fan-out (small, ship first)
- client-runtime: `pickWorkspaceLayoutSource(entries, primaryEnvironmentId)` → the connected
  server with `sidebarWorkspacesHome: true`; if none, today's behaviour (web: first remote by
  id with workspaces else primary; phone: first by id). Pure, unit-tested.
- Web `WorkspaceSidebar.tsx` and mobile `useSidebarWorkspaces.ts` read AND write only that source
  (`serverEnvironment.updateSettings({ environmentId: source, input: { patch } })`). Remove
  `sidebarWorkspaces` from `SHARED_SERVER_SETTING_KEYS` so writes stop fanning out.
- Every write sets `rev = base.rev + 1`, `updatedAt = now`.
- If the home is configured but disconnected: show the cached last config read-only with a small
  "Layout home offline" note (E3 adds the queue).
- Settings UI (web Settings › Organization or the workspace settings; mobile settings): toggle
  "Keep the shared sidebar layout on this server" (sets `sidebarWorkspacesHome`).

### E1 — machine tags and labels
- client-runtime: `machineDisplayOf(config, environmentId, fallbackLabel)` → `{ label, tag, color }`;
  tag default = first two letters of the label, uppercase, alphanumerics only.
- Web workspace sidebar + mobile workspace list: a small tag chip LEFT of the title (after the
  status glyph), colored by `color`. Show it only when the thread's folder group spans more than
  one environment; in cross-project sections (Pinned, Working shelf, No project) show it when
  more than one environment is connected. Remove the mobile right-side chip; on web keep the
  upstream row for upstream sidebars (add an optional prop to `SidebarThreadRow`, minimal seam).
  Full label in tooltip / accessibilityLabel.
- Settings › Machines (web and mobile): list known environments (connected + those referenced in
  the layout), edit label, tag, color; writes go to the layout home.
- Use `machineDisplayOf` labels in the workspace sidebar, folder menus and new-thread machine picker.

### E2 — logical projects: mounts, aliases, merge/split
- Pure functions: `resolveLogicalProjectKey`, `mergeLogicalProjects(config, fromKey, intoKey)`
  (alias from→into; union placements; into keeps its order, from is removed from orders; fold of
  into wins; mounts concatenated; idempotent), `splitLogicalProject(config, key)` (drop aliases
  pointing at it from that key), `addProjectMount`, `removeProjectMount`.
- Wire into `buildProjectGroups` (optional `layout` input) and the web/mobile snapshot builders.
- Folder menu: "Merge with…" (pick another folder) and "Split" when aliases exist. Web + mobile.
- Migration helper (pure, tested): `mergeLayoutConfigs(home, others[])` — home wins for
  workspaces/assignments/fold/order; foreign workspace ids remapped by equal name; placements
  unioned; rules deduped after remap; foreign-only keys appended; nothing pruned.

### E3 — revision check and offline queue
- Server: a `sidebarWorkspaces` patch whose `rev` is not `current.rev + 1` is rejected with a
  typed error (find how `server.updateSettings` reports failures; keep old clients working: a patch
  without the new fields still applies).
- Clients keep the edit as a pure function: on rejection refetch and re-apply (max 3 tries).
- Offline: queue edits (persisted per device), replay on reconnect, toast on a dropped edit.

### E4 — project mounts (server) and "new thread on another machine"
- Contracts `packages/contracts/src/projectMount.ts`: `ProjectMountState = "pending" |
  "mounting" | "watching" | "conflict" | "error" | "paused" | "removed"`, `ProjectMountStatus`
  (logicalKey, home {environmentId, path}, localPath, sessionName, state, progress?, conflicts[],
  problems[], lastError?, projectId?, updatedAt). RPCs (follow the existing rpc.ts patterns and
  permission scopes in `clientRpcPermissions.ts`): `projectMounts.ensure`, `.list`, `.retry`,
  `.remove` (keep files by default), plus a status stream or polling. Capability flag
  `projectMounts` in `ExecutionEnvironmentCapabilities`.
- Server `apps/server/src/projectMounts/`: `MutagenRunner` (spawns `mutagenPath`, parses
  `mutagen sync list --template '{{json .}}'` — verify the template flag on Mutagen 0.18.x, fall
  back to label-selector + text parse), `ProjectMountService` (per-logical-key lock; idempotent
  by deterministic session name `t3-<hash8(logicalKey)>-<envId8>` and labels `t3-logical=<hash>`
  `t3-env=<envId8>`; create dir; `mutagen sync create --name … --label … --sync-mode
  two-way-safe --ignore-vcs --ignore … --default-file-mode-beta=0644
  --default-directory-mode-beta=0755 --symlink-mode=portable <sshHost>:<homePath> <localPath>`
  (alpha = home, beta = here); wait in a background fiber for the first `Watching`; then register
  the project via ProjectService (or reuse the one already at that root); persist records in
  `stateDir/project-mounts.json`; expose status; Retry = resume/recreate; Remove = terminate
  session, keep files, project stays unless asked).
- Conflicts and problems (e.g. root-owned files on the home) map to `conflict` / `error` with the
  paths; never auto-chown, never auto-delete.
- Orphans: sessions with `t3-logical` label and no record are reported, not terminated.
- Security: requires a non-fenced caller with project-write rights; disabled unless
  `projectMountsEnabled`.
- Clients: folder "New thread" offers "on <machine>" for every connected machine with the
  capability. If the project has no mount/project there: call `ensure` on that machine, show a
  pending row in the folder with the machine tag and state (Retry on error), and when it reaches
  `watching` write the mount (with projectId) into the layout (`addProjectMount`) and open the new
  thread draft there. Never block the sidebar.
- Agents: MCP tool `t3_project_mount` (ensure + optional wait) in the project toolkit, and
  `RemoteDelegation` resolves a remote project through layout mounts / same path before the
  repository match. Threads on a mirror get a note that git runs on the home machine
  (`ssh <home> 'cd <path> && git …'`).

### E5 — skills and voice
- `~/.agents/skills/t3` (SKILL.md, `scripts/t3ctl.mjs`): `t3ctl machines`, `t3ctl mount <project>
  --on <machine> [--wait]`, `t3ctl new --project P --on <machine>` (mounts first if needed),
  `t3ctl layout get|merge --dry-run|--apply` (wraps `mergeLayoutConfigs`, backups first).
  Voice phrasing examples in SKILL.md triggers.

## Test bed (E2E) — never the live gvidon/Operalia servers

- HOME: gor (`ssh -F ~/.local/share/gor-transfer/ssh_config -i ~/.ssh/id_malaniya_25519 -o
  IdentitiesOnly=yes gor`), its own T3 server (restart allowed there), demo repo
  `~/xdev-e2e/demo` (git, a few files, a `node_modules` dir that must not sync).
- MIRROR: VPS `152.89.244.57` (`ssh -F ~/.local/share/vpn-ops/ssh_config 152.89.244.57`), a NEW
  isolated container `t3-xdev` (compose `/opt/t3-xdev`, 127.0.0.1:3791 only, ≤2 GiB RAM, image
  from `xdev` + mutagen + openssh-client). Do not touch `t3-ws` or any other stack there.
  The mirror reaches gor via a reverse tunnel opened from gor.
- CLIENT: gvidon, ssh -L tunnels to both servers; scripted RPC/MCP checks plus Playwright web.
- Scenario: pair both; mark gor layout home; layout edits from either client land on gor only;
  phone/web read the same; tags left of titles only in the multi-machine folder; "new thread on
  VPS" in the demo project → mounting → watching → project registered → thread opened → agent
  edits a file → it appears on gor and `.git`/`node_modules` did not sync; make a conflict →
  `conflict` shown → resolve → Retry → watching; remove mount → session gone, files kept;
  ensure twice → no duplicate session/project; restart mirror server → state recovered.

## Rules for every agent

- Work only in your own worktree/branch given in your task; commit there with clear messages
  (conventional style, e.g. `feat(workspaces): …`). Never push, never
  touch `ws`, never restart or update the live T3 on gvidon or Operalia, never edit live settings.
- Node 26.12.1: `export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH`. Install deps in your
  worktree; run `vp lint` (no errors), typecheck and the tests of every package you touched.
- Add or update unit tests for every pure function. Add a FORK.md feature-log entry for your stage.
- When done, report: branch, commits, what changed (files), test commands and results, open issues.
