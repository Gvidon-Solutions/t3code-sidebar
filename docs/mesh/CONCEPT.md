# T3 Mesh v2 — the concept (the law)

Decided with the owner on 2026-11-04. Where this file and `docs/sidebar-cross-device.md` differ,
**this file wins**. Code, CLI, MCP, UI, agent instructions and tests must match it. Do not
redesign it; if something here is impossible, stop and say why in your report.

The product is a personal mesh: one person, any number of machines, each running a T3 server.
Nothing may assume a particular machine, OS, count of machines or the owner's setup.

## 1. Principles

1. **No central machine.** All servers are equal. Any can be off; the others keep working and
   everything converges when it returns. There is no mesh-wide "authority".
2. **Configured, not clicked.** The mesh is described by one **mesh config** (desired state).
   Every server continuously reconciles reality to it and reports status. The UI shows state and
   opens the config; it does not hold settings fields.
3. **One pairing per machine.** The user pairs a machine once (or adds it to the config with
   bootstrap SSH). SSH keys, SSH config, routes, Mutagen, skills, agent instructions are T3's job.
4. **Every action is idempotent and resumable.** A crash at any step is fixed by running it again;
   servers re-run pending reconciliation on start.
5. **No magic for agents.** An agent always knows where it is. Remote execution is an explicit
   command (`t3 run`) with guarantees, never silent interception.
6. **Versions coexist.** Servers and clients of version N and N-1 work together. Unknown layout
   keys and config fields are stored and forwarded, never dropped or fatal.
7. **Honest status.** Anything that is not right is visible with a reason: machine offline,
   replica behind by N files, route failed because …, config field invalid because ….

## 2. Entities

| Entity          | What                                                                                             | Stored in                                   |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Mesh            | the set of linked servers                                                                        | every server                                |
| Machine         | one T3 server (`environmentId`); name, label, tag, color, reach, platform                        | config (settings) + layout (reported facts) |
| Link            | mutual trust between two servers + a persistent connection when reachable                        | both servers (PeerLinks)                    |
| Logical project | opaque id (never shown) + title + representations                                                | layout `proj/*`, `rep/*`, `alias/*`         |
| Representation  | (machine, folder, role `primary` or `replica`, replica mode `lite` or `full`)                    | layout `rep/<id>/<env>`                     |
| Thread          | lives on exactly one machine, working dir inside one representation (or no project)              | that machine's DB                           |
| Workspace       | presentation only: placement, order, fold                                                        | layout `ws/*`, `place/*`, `fold/*`          |
| Mesh config     | desired state: machines, links, ssh, replica rules, ignores, conflict policy, agents, T3 version | layout `mesh.config` (+ history)            |

Invariants I1–I5 of the old spec stay (one project per (machine, path); one sync session per
replica; one title everywhere; no opaque id or legacy key shown as a name; workspaces never
affect sync/threads/routing). I6 becomes: nothing assumes any machine, OS or count; there is no
authority.

## 3. Layout replication (decentralized)

- Every server stores the full layout: small LWW entries with HLC timestamps.
- **Clock guard:** an entry whose HLC physical time is more than 5 minutes ahead of the receiver's
  clock is rejected (logged, counted in status), never stored. Local HLC never jumps more than
  5 minutes ahead of local wall time.
- **Validation:** each known key family has a value schema; invalid values are rejected with a
  reason. **Unknown key families** (written by a newer version) are stored and forwarded as
  opaque values and ignored by materialize.
- **Delivery:** a local change is pushed to linked peers immediately (debounced ≤ 250 ms) over the
  persistent connection; a full watermark exchange runs on (re)connect and every 60 s as a safety
  net. No 5 s polling.
- **Generation:** each server's layout store has a generation id; a peer that sees a new generation
  resets its watermark for that server and re-sends everything.
- **Tombstone GC:** a tombstone older than 30 days and acknowledged by every currently linked peer
  is deleted.
- Representations are separate keys per (project, machine), so concurrent additions never
  conflict. Plain LWW otherwise.
- One client-side layout store in `packages/client-runtime` (with a persisted offline outbox);
  web and mobile only render it.
- Legacy import/adopt lives in a separate one-time migration module, not in the CRDT core.

## 4. Network

- **Persistent connection.** For every link, each server tries to keep one WebSocket (WSS) to the
  peer's address. Whoever can dial does; if both can, one connection survives (deterministic
  tie-break). The connection is bidirectional: either side sends calls over it.
- **Heartbeat** every 15 s; dead after 45 s without traffic; reconnect with backoff 1 s → 15 s.
- **Calls** (MCP tool calls between servers, layout push, files, threads) go over the connection
  when it is up, else over the existing HTTPS `POST /mcp`; every call has a timeout and is safe to
  retry (idempotency key where it creates something).
- **Relay:** if two machines cannot reach each other, calls and pipes go through one machine both
  reach (max one hop).
- **Linking is mutual.** One pairing code establishes trust in both directions.
- **Link permissions** (from config): `files: all | projects | none`, `replicas: bool`,
  `threads: bool`. Enforced on the receiving side for every forwarded call. `files: projects`
  allows only paths inside a representation folder of a project on that machine (after realpath).
  Read-only links never read files outside projects.
- Only the T3 HTTPS port needs to be reachable from outside, on at least one machine of a pair or
  of a relay.

## 5. SSH (managed by T3, system OpenSSH, no own SSH server)

- Each server owns a mesh key pair `<baseDir>/mesh/ssh/id_ed25519` and reports its public key, its
  OS user, its sshd host key(s) and sshd port over the link.
- With `ssh.mode: managed` (default) each server keeps:
  - a managed block in `~/.ssh/authorized_keys` with the mesh public keys of linked peers that have
    `replicas` permission (`# t3-mesh begin` … `# t3-mesh end`; nothing else touched);
  - a managed block in `~/.ssh/config` with `Host t3-<machine-name>` entries:
    `ProxyCommand <t3 binary> mesh pipe <machine>` (a byte pipe over the persistent connection to
    the peer's sshd on its loopback), `User`, `IdentityFile`, `UserKnownHostsFile` pointing to a T3
    managed known_hosts filled from host keys received over the link (no trust-on-first-use);
  - a route check per peer (`ssh t3-<name> true`), shown as ✓ or the reason.
- `ssh.mode: existing` uses the user's own `~/.ssh/config` host names (configured per machine);
  `off` disables replicas and `t3 run` across machines.
- Users and agents can run `ssh t3-<name>` directly; Mutagen, `t3 run` and port forwarding use the
  same hosts.

## 6. Replicas

- Central feature. Mutagen (pinned version, private data dir), `two-way-safe`, `--ignore-vcs`.
- **Star:** each replica syncs with its project's primary only.
- **Driver:** the replica's server runs the session (`alpha = primary over ssh t3-<primary>`,
  `beta = local folder`).
- **Mode `lite` (default):** files only; dependencies, build outputs and `.git` stay on the primary;
  builds, tests, git, docker run there via `t3 run`. **Mode `full`** (per project in config): the
  replica server also installs the environment locally (detected from lock files: pnpm/npm/yarn/
  bun, uv/pip, cargo, go) and refreshes it when lock files change; git still only on the primary.
- **Ignores:** VCS + root-anchored defaults (`/node_modules`, `/.venv`, `/dist`,
  `/build`, `/target`, `/.t3`, `/.t3-conflicts`) + config and per-project ignores.
  New meshes seed code-only defaults at every depth: dependency environments and caches
  (`node_modules`, `.venv`, `venv`, `__pycache__`, `*.pyc`, `.pytest_cache`, `.ruff_cache`,
  `.mypy_cache`, `.ty_cache`, `.tox`, `.nox`, `.gradle`, `.cache`, `.parcel-cache`, `.turbo`,
  `.next`, `.nuxt`, `.svelte-kit`, `.expo`, `.dart_tool`); outputs (`dist`, `out`, `coverage`,
  `htmlcov`, `.coverage`, `test-results`, `playwright-report`, `.playwright-mcp`, `*.tsbuildinfo`);
  logs and local databases (`*.log`, `*.sqlite`, `*.sqlite3`, `*.db`, `*.db-wal`, `*.db-shm`);
  archives (zip, tar, tar.gz, tgz, 7z,
  rar, iso, dmg), media (mp4, webm, mov, mkv, avi, mp3, wav, flac, ogg), documents
  (pdf, doc, docx, xls, xlsx, ppt, pptx), model weights and data (safetensors, pt, pth,
  ckpt, onnx, gguf, h5, npy, npz, parquet, pkl, pickle, feather, arrow), each extension
  matched as `*.<extension>`. Existing explicit lists are retained on upgrade.
  Changing ignores recreates the session with the same name.
- **Conflicts:** resolved automatically. Policy per project from config, default `primary-wins`
  (alternative `newest-wins`). The losing version is copied to
  `<loser>/.t3-conflicts/<ISO-time-with-dashes>/<relative path>` before being replaced. Status note,
  not an error.
- **Scan problems** (broken symlinks, unreadable files) are warnings with the file list; one
  replica's failure never affects another; every reconcile step has a timeout; no global lock
  across replicas.
- **Lifecycle:** created when a thread is started on a machine without a representation, by a
  config rule, or explicitly; removed only explicitly and only when it has no unsynced changes
  (else refuse with the list). Removing keeps the files.
- Every thread's context states the representation, its mode, the primary, sync state, and how to
  run commands there.

## 7. `t3 run`

`t3 run [--bg] [--ports P[,P]] [--timeout D] -- <command…>` (the `t3` binary of the T3 runtime,
on PATH of every thread):

1. Resolve where it is: ask the local server which representation contains the cwd. Not in a
   lite replica → run the command locally, unchanged.
2. `mutagen sync flush` the session; then check the session's conflicts and problems; if any
   affect files, refuse with the list (exit 75) instead of running on stale files. Flush timeout →
   refuse with the reason.
3. Run over `ssh t3-<primary>` in the mapped directory (same relative path) under a **login
   shell** of the primary's user (same environment the primary's T3 uses for its own threads),
   wrapped in a supervisor that kills the whole process group when the connection drops or on
   SIGINT/SIGTERM. Allocate a TTY only when stdin is a TTY.
4. Stream stdout/stderr live; rewrite exactly the primary's project-root prefix to the replica's
   root in output; nothing else.
5. Exit with the remote exit code (255 + message for transport failures, never a fake 0).
6. Flush again so outputs come back; if the command wrote into ignored paths (e.g. `dist/`), print
   one line saying those stayed on the primary.
7. `--bg` starts a tracked background process on the primary (listable, stoppable, reattachable
   via `t3 run --logs/--stop <id>`); `--ports` forwards those ports to the replica machine's
   loopback while the process runs.

In a lite replica, plain `git`, `pnpm`/`npm`/`yarn`/`bun`, `uv`, `pytest`, `make`, `cargo`, `go`,
`docker` called from a thread's shell print one line — "This is a lite replica of <title>; the
environment is on <machine>. Use: t3 run <same command>" — and exit 127, without running anything
(shims on PATH of threads whose cwd is in a lite replica; the list is configurable).

## 8. Threads across machines

- **No cross-machine move.** The old handoff "move" (copy + archive original) is removed.
- **Fork to machine:** creates a new thread on the chosen machine with any harness/model/effort,
  a copy of the transcript up to the last completed turn and its attachments, title "<title>
  (fork)". Steps: ensure a representation of the project there (place a replica, wait until
  synced) → flush sync → copy → launch. Failure at any step creates nothing and leaves the
  original untouched, with the reason. Links both ways: the fork shows "forked from …", the
  original lists its forks. Staging data is deleted after success or failure.
- **Same machine:** a thread can be moved to another project (drag in the sidebar, menu, CLI,
  MCP). No model is needed for that.
- All machines see and drive all threads (list, read, send, stop, fork) through links.

## 9. Mesh config

One document, stored as layout entry `mesh.config` = `{ revision, doc, author, writtenAt }`, history
`mesh.configHistory/<revision>` (keep the last 50). Edited only through apply with the base
revision (optimistic concurrency: a stale base is rejected with a diff to rebase on).

```yaml
schema: 1
t3:
  version: 0.1.7-sidebar.1 # target server version; absent = no managed updates
machines:
  gvidon: # machine name: stable slug used everywhere in the config
    label: GV # tag shown in the UI
    title: gvidon
    color: blue
    reach: auto # auto | { address: https://host:port } | { via: <machine> }
    ssh: { user: user, port: 22 } # optional overrides; reported values otherwise
    bootstrap: { ssh: "user@host:22", os: linux } # optional: T3 installs itself there
links:
  default: { files: projects, replicas: true, threads: true }
  overrides:
    - { between: [gvidon, operalia], files: all }
ssh:
  mode: managed # managed | existing | off
projects:
  defaults: { conflicts: primary-wins, replica: lite, ignore: [] }
  overrides:
    - { project: "calf*", replica: lite, ignore: [/data] } # matched by title glob
replicas:
  ignore: ["*.log"]
  rules:
    - { project: "*", on: operalia, when: harness-unavailable } # always | harness-unavailable | manual
agents:
  aliases:
    1017: { harness: opencode, model: deepseek/deepseek-flash }
    sol: { harness: codex, model: gpt-6.1-sol }
  instructions: | # optional shared text, written as its own managed block
    …
```

- Machines join the config by name; when a server joins, its `environmentId` is bound to the name
  (stored next to the doc, not typed by the user). Labels/titles/colors come from the config;
  layout `machine/<env>` keeps only reported facts (version, platform, user, keys, reachability).
- `plan` validates against the schema and lists the actions reconciliation will take (machines to
  bootstrap or update, links to change, ssh blocks to write, replicas to place/remove, sessions to
  recreate, instructions to rewrite). `apply` stores it; servers reconcile; `status` reports per
  item: done / in progress / failed + reason. `rollback <revision>` applies an old revision.
- Interfaces: `t3ctl mesh config get|plan|apply|rollback|history`, `t3ctl mesh status`; MCP
  `t3_mesh_config_get`, `t3_mesh_config_plan`, `t3_mesh_config_apply`, `t3_mesh_status`; the
  Settings › Mesh screen: state (machines: label, title, online, version, reach path, platform;
  replicas: state, lag, last error; last config apply status) + "Edit config" (YAML editor with
  validation, plan preview, apply) + "Link a machine" (pairing code). No other settings fields.
- Existing settings (machine labels/tags/colors, SSH routes, authority, ignores) are migrated into
  the first config revision once.

## 10. Rollout and updates

- **Add a machine:** (a) install T3 there and pair with a code, or (b) add it to the config with
  `bootstrap.ssh`; a server that can reach it installs the T3 runtime of the mesh's version as a
  service (systemd user/system unit on Linux, launchd on macOS, a Windows service), pairs it, and
  reconciliation continues. The bootstrap credential is used once and not stored.
- **Update:** changing `t3.version` updates servers **one at a time**: download/verify runtime →
  switch → health check (server answers, layout converged, replicas resumed) → next. A failed
  check rolls that server back to its previous version and stops the rollout with the reason.
  Nothing updates unless the config says so. Backups of the state DB before each switch.
- **Compatibility:** layout/config/protocol changes must be readable by N-1 (unknown keys/fields
  forwarded). A server refuses a config that needs a newer schema than it knows and reports it.
- **Agent kit:** each server installs the `t3` skill of its own version into
  `~/.agents/skills/t3` (and harness skill dirs it knows) and writes a managed block
  (`<!-- t3-mesh begin -->` … `<!-- t3-mesh end -->`) into `~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`: the mesh block generated from the config
  (machines, how replicas and `t3 run` work, where the skill is) + `agents.instructions` when set.
  Text outside the blocks is never touched. `t3ctl` reads model aliases from the config.
- **Clients** (desktop, Android, web) are built per release by CI; they work with servers N and N-1
  and offer an update when the server is newer.

## 11. Platform layer

Everything OS-specific (paths, shell, service install, ssh binaries, Mutagen binary, file
permissions, conflict-copy names) lives in one platform module per server. Linux is the main
target; macOS and Windows nodes must work through the same code and are covered by CI smoke tests.

## 12. Robustness tests (must stay green; run before every release)

On the bed (gor + VPS container + gvidon isolated server): network cut mid-call and mid-pipe;
`kill -9` of each server and of the Mutagen daemon mid-sync; machine asleep 10 min; proxy that
drops idle connections; IP change; one server on N-1; clock skewed +1 h; conflict right before
`t3 run`; Ctrl-C of a long `t3 run`; `t3 run` with nvm/uv only in the login profile; output into
an ignored folder; two `t3 run` at once; primary offline; fork to every machine/harness pair; fork
while a turn runs; fork into a project with no representation on the target; config apply with a
stale base; bootstrap a fresh container; rolling update with one forced health-check failure.
Every scenario ends converged with no duplicate projects/sessions, no lost file versions and
identical layouts.
