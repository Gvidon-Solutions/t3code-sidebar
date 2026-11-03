# T3 Mesh — guide for agents

Read this before changing anything that touches machines, projects across machines, replicas,
the shared sidebar layout, thread moves, files on other machines, the `t3` skill or the agent
instructions. It is the map; the law is `docs/sidebar-cross-device.md` §0 (object model,
invariants, authority rule). Keep both current when you change behaviour.

## What it is

The owner runs one T3 Code Sidebar server per machine (gvidon, Operalia, gor, …). Linked
together they form a **mesh**: one replicated sidebar layout, projects that live on several
machines, threads that can be created, found, opened, moved and driven on any machine, files
readable from anywhere, and agents that know where they are.

## Object model (short; full text in the spec §0)

| Entity | What it is | Where it lives |
|---|---|---|
| Machine | one T3 server (`environmentId`), label/tag/color, SSH routes to other machines | layout `machine/<env>` |
| Link | server-to-server MCP session (pairing code, full access for the mesh) | each server's PeerLinks table |
| Mesh | machines + links; one **authority** machine (`mesh.authority`, the owner's is gvidon) | layout |
| Project (logical) | opaque id (the logical key, never shown) + **title** + representations | layout `proj/<id>`, `rep/<id>/<env>`, `alias/*` |
| Representation | (machine, folder, role primary/replica, transport git/mutagen/sshfs/manual, ignores) | layout `rep/*` |
| Sync session | one Mutagen session per replica (alpha = primary, beta = replica), driven by the side that can ssh to the other | Mutagen daemon of the driving T3 server (`<baseDir>/mutagen`) |
| Thread | lives on one machine, working dir inside one representation (or "No project") | that machine's DB |
| Workspace | presentation only: placement, order, fold | layout `ws/*`, `place/*`, `fold/*` |

Invariants I1–I6 (spec §0) are tested; keep them true: one project per (machine, path), one
session per replica, one title everywhere, **no opaque id or legacy key ever shown to a person**,
workspaces never affect sync/threads/routing, nothing hard-codes a machine.

## How it flows

- **Layout replication.** `packages/shared/src/meshLayout/` is a pure LWW-map CRDT (HLC clocks,
  fractional order keys, `materialize`/`diff`, `importLegacy`/`adoptLegacy`). Every server stores
  it (`apps/server/src/mesh/MeshLayoutServiceLive.ts`, migration 077, per-entry local `seq`) and
  gossips it to linked peers with `t3_mesh_exchange` (`MeshReplicator.ts`; seq watermarks, pull
  every 5 s, backoff ≤ 15 s, transitive). Clients read/write through `meshLayout.get/apply/subscribe`
  (`packages/client-runtime/src/state/meshLayoutClient.ts`, offline outbox). Old clients writing
  the whole `sidebarWorkspaces` setting are diffed (`MeshSettings.ts`), never replace it.
- **Routing.** A call for another machine goes direct when linked, else through one relay hop:
  `apps/server/src/mesh/MeshRouting.ts` (`callRouted`) used by `PeerForwarding`, files, handoff.
- **Replicas.** `apps/server/src/replicas/`: `MutagenInstaller` (pinned 0.18.1, sha256),
  `MutagenRunner` (CLI wrapper, private `MUTAGEN_DATA_DIRECTORY`), `ProjectReplicaService`
  (reconcile on layout change + every 30 s; deterministic session names; state machine;
  registers the project on the replica machine when watching), `ReplicaPaths` (allocation),
  `ManagedSshConfig` (only the `# t3-mesh` block), `ReplicaInstructions` (the context note).
- **Threads anywhere.** `t3_thread_self` (who am I), mesh-wide list/search/read/send/wait by id
  (`MeshThreadAccess.ts`), moves: same machine = project change (`threadMove`), other machine =
  **handoff** (`ThreadHandoffService.ts`, `handoffBundle.ts`: transcript + attachments as context,
  any harness/model on the target, original archived with a link).
- **Files anywhere.** `apps/server/src/files/` (`files.read/list`, forwarded via `callRouted`;
  error reasons travel as `[files:<reason>]`).
- **Context injection.** Every turn gets a short machine/project/representation note (budget in
  `apps/server/src/provider/agentContextBudget.json`; update it to the measured size when you add
  tools or text, and justify growth).
- **UI.** Web `apps/web/src/components/workspaces/` (MachineTag, ProjectMachineStrip
  `GV ⇄ OP GOR`, MeshSettingsPanel, MachinesDialog, PendingReplicaRow, MoveProjectDialog,
  MoveThreadModelDialog, MeshFooterStatus, FileMachineTag); mobile
  `apps/mobile/src/features/workspaces/` (same names). Pure logic lives in
  `packages/client-runtime/src/state/{meshLayout/*,machineDisplay,meshMachines}.ts`.

## Interfaces

- **CLI / skill:** `agent-kit/skills/t3` (`SKILL.md`, `scripts/t3ctl.mjs`). Mesh commands:
  `machines`, `mesh status|link|unlink`, `place/unplace`, `replicas`, `new --on`, `find --all`,
  `threads/status --all`, `open`, `open-file`, `cat`, `move`, `layout get|merge`, `agents sync|status`, `self`.
- **MCP tools** (in the server): `t3_project_place`, `t3_project_machines`, `t3_thread_self`,
  `t3_thread_*` with `environmentId` (or none — ids resolve across the mesh), `t3_files_read/list`,
  `ui_open` with `environmentId`, link-only `t3_mesh_*` and handoff tools.
- **Agent instructions:** `agent-kit/skills/t3/global/GLOBAL.md` (the owner's canonical text, Russian)
  + `machines.json`; rendered per machine with a one-line header into `~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`.

## The agent kit (skills and instructions live in this repo)

`agent-kit/` is the source of truth; machines hold installed copies. Edit here, commit, then:

```bash
agent-kit/install.sh            # dry run: skill diff per machine + instruction diff
agent-kit/install.sh --apply    # install on gvidon, Operalia, gor (backups under ~/.local/state/t3-agent-kit/)
agent-kit/install.sh --dest ~/.agents/skills/t3-next   # stage for the test bed only
```

Never edit `~/.agents/skills/t3` on a machine directly (it is overwritten), and never run
`vp fmt` on the skill or GLOBAL.md (formatting is excluded on purpose: padded tables waste every
agent's context). Keep SKILL.md under ~26 KB and general — no recipes for specific test phrases.

## Testing

- Unit/integration: the package suites (`pnpm -s test` per package; web with `--maxWorkers 4`),
  `vp lint` 0 errors, `typecheck` in contracts/shared/client-runtime/server/mobile and
  `vp exec tsc --noEmit -p apps/web/tsconfig.json`. Commit with `--no-verify` only because of the
  old knip baseline; add no new knip findings.
- Three-machine bed: `scripts/mesh-e2e/README.md` (gor main server + isolated gvidon :3795 +
  VPS container :3791; `up.sh <ref>`, `status.sh`, `tunnels.sh up` when tunnels died).
  `round1.sh` (layout, links, files, old clients), `round2.sh` (replicas on real Mutagen, t3ctl),
  `round3.sh` (crashes, partitions, authority). They must stay green.
- Agent behaviour eval: `docs/mesh-agent-eval.md` (8 voice-style requests × harnesses on an
  isolated HOME); rerun after changing SKILL.md or GLOBAL.md.

## Operating the live machines

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
