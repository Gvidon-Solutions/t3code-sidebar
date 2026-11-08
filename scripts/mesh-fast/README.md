# Isolated mesh acceptance

On a Linux x64 Docker host, install Node 26, pnpm's frozen dependencies,
OpenSSH server, a C compiler, `flock`, `patchelf`, and Rust's `rustup`. Then provision the
fixture images, browser, web client and real resource monitor once:

```sh
pnpm install --frozen-lockfile
scripts/mesh-fast/setup.sh
scripts/mesh-fast/run.sh
# equivalent
pnpm mesh:fast
```

The command builds source-fingerprinted native test runtimes automatically.
`MESH_FAST_PRODUCT_ROOT` can select a separate prepared product checkout; the
nightly wrapper selects the ref it has just built. Server bundles, CLI routing,
runtime installers and real provider guards use that checkout.
The first invocation also downloads a checksum-pinned Mutagen and the actual
preceding release's source and dependencies. Native builds use a kernel `flock`
so concurrent commands share completed artifacts. Downloads, image creation and
browser/toolchain installation belong to host provisioning; source-dependent
runtime preparation is included in the command's reported wall time. A warm run
reuses only immutable tools/runtimes, never server state, credentials or sessions.
Immutable Mutagen executables and agent archives are hardlinked when the cache
and fixture share a filesystem. Passed cases discard private payloads after all
processes stop, retaining logs, assertion evidence and browser recordings. Failed
cases retain their state. Repeated runs therefore do not copy gigabytes of tools
or accumulate successful private homes.

Ordinary fast servers run the exact Node bundle embedded in the native archive,
with a shared immutable V8 compilation cache. Native single executables cannot
use that cache because their dynamic imports require code caching to be disabled.
Bootstrap, installation, rollout and realistic nightly scenarios still execute
the native artifacts. Behavior that needs only two machines uses a two-node mesh;
relay faults, collisions, grouping and cross-machine matrices keep three.

The cold installer downloads the original checksum-pinned Mutagen archive from
a private loopback mirror, then performs real verification, extraction and sync.
`T3_MESH_TEST_ASSET_ORIGIN` is accepted only by test runtimes; production bundles
and non-test source execution retain the original release URL. Nightly leaves
the mirror unset and downloads from the real release service.
Fresh bootstrap containers receive the same timing scale and pinned archive
mirror through a private systemd drop-in before the real installer creates its
unit. The scenario asserts the running unit's environment, an actual archive
download, replica contents and subsequent rollout/rollback. Nightly omits these
test overrides. This keeps bootstrap independent of public download availability.

Full replicas execute checksum-pinned pnpm against an offline local dependency.
The wrapper records successful frozen installs, and the scenario imports the
installed package as well as checking first-sync and lock-change counts.

Each scenario owns a fresh mini-mesh. Studio runs in a container with its actual
login home set to the fixture home; cloudbox and laptop are isolated processes.
Every machine has private state, HOME, XDG paths, agent instructions, SSH host
keys, sshd and Mutagen data. The mesh owns a Docker bridge with a small explicit
private subnet; host listeners bind loopback or that bridge's gateway. No port is
published on the LAN. Studio refuses inbound peer connections and only dials
out; laptop reaches it through cloudbox. SSH uses the real managed configuration
and authenticated N1 byte pipes. Nothing uses an existing T3 server, physical
machine identity, owner's SSH configuration, VPS or Mutagen daemon.

The harness accepts a machine-name array (`MiniMesh.start(names)`); scenarios
choose their topology. The default runner budgets four logical cores per mesh,
capped at eight on every host. At most eight servers and two containers boot
concurrently, including fresh bootstrap containers. The container permit covers
Docker launch through HTTP readiness; private file preparation and token issuance
use the separate server-start budget. Mutagen uses two Go execution threads per
daemon/agent; native monitor compilation uses four build jobs. Ports
are allocated once per command. `--jobs` is an explicit operator override.

```sh
scripts/mesh-fast/run.sh --scenario crash --repeat 5
scripts/mesh-fast/run.sh --scenario partition --repeat 5
scripts/mesh-fast/run.sh --jobs 8
scripts/mesh-fast/run.sh --host-info
```

`--scenario` selects a name substring. `--repeat` creates fresh meshes on each
iteration; failures are never retried. Every case reports PASS/FAIL and duration.
The final line reports total wall time, with the agreed default 360-second ceiling. A
watchdog shuts down owned fixtures and fails the command when the ceiling is
exceeded. `--budget-seconds` explicitly changes that ceiling for smaller hosts:
the independent hosted CI job uses two meshes and 2700 seconds; performance
acceptance on either configured host keeps the default 360 seconds. Existing build jobs
have no dependency on this job.

The gate runs on the host where the command is invoked. The delivery builder's
configured `gate` command selects that host: the example's local command runs on
the configured builder, whether that is gvidon or gor. Provision either using the
same commands above. An explicit SSH gate must point to the prepared candidate
checkout on the selected host. There is no implicit remote host or fallback.
`--host-info`, the first output line, `runner.json` and `summary.json.host` record
the actual hostname, boot identity, available CPUs and concurrency. Host names
are evidence, never fixture identities. Treat gor's unexplained hard resets as
an infrastructure fault; a successful gate does not establish hardware stability.

One user-wide kernel lock admits a single runner or provisioning command across checkouts. A concurrent
command exits 75 before changing Docker resources. The lock releases on process
death and reboot; no persistent PID lock can strand the next run.
Every fixture container/bridge carries labels with a stable machine hash, UID,
boot UUID, runner PID/start time and run UUID. Containers use `--restart=no`.
Before preparing runtimes, the next command removes only labelled abandoned
resources on this host owned by this UID, collecting their last logs in
`recovery.json`. Previous-boot PIDs are never signalled; same-boot PID reuse is
checked by process start time. Active owners and unlabelled resources survive.
An abandoned bridge with a foreign attachment fails closed before any removal.
Removing stale publications frees their ports; host listeners died with the
reboot. Failed scenario directories remain available for diagnosis.

`runner-reboot-recovery` exercises this with real running Docker services: a
previous boot publishes a TCP port with `restart=always`, a reused current PID
has a different start time, active and foreign containers coexist, and a foreign
network attachment prevents cleanup. A subsequent real `run.sh` command must
perform startup recovery; the scenario then verifies removal, port rebinding
and preservation. `lifecycle.test.ts` kills a real lock owner and proves admission
is released, concurrent refusal and the eight-mesh default.

The printed private artifact directory contains `junit.xml`, `summary.json`, `preparation.json`,
server/proxy/sshd logs, failure stacks and convergence barriers. The F1 case adds
screenshots and a WebM recording. Process supervisors record the exact child PID
and generation: crash cases kill that child and observe automatic recovery.
Cleanup only stops tracked children, named containers/networks and each fixture's
private Mutagen daemon. SIGINT/SIGTERM also trigger cleanup.
Shutdown waits for each private daemon's POSIX lock after requesting its stop:
the listener can already be gone while final cache writes are still running.
The tiny source-fingerprinted C helper uses `F_SETLKW`; Linux `flock` locks do
not contend with Mutagen's POSIX locks. No cleanup or scenario retries are used.
Paused supervisors close their filesystem watchers during shutdown; queued
restarts cannot launch after shutdown starts. Fast teardown kills tracked direct
server children after assertions; native launchers and realistic runs retain
graceful shutdown. Private Mutagen daemons still receive their stop request and
must release the POSIX lock before passed payloads are removed.

Native preparation builds web and server bundles concurrently, then stages the
current web output into both real version archives. It retains a complete workspace
snapshot because the shared Vite config imports desktop build metadata. Independent
version trees use native copy-on-write copies where supported. Bundler workers use
one quarter of available CPUs, capped at 32; compilation and extraction failures
are reported together after all builds finish. `preparation.json` describes the
immutable runtime cache's build, including phase timings; a warm lookup reuses it.
Generated Astro types and mobile preview output do not change the runtime source
fingerprint. Passed payload deletion preserves diagnostics and never follows
fixture symlinks into external data.

## Timing and providers

`T3_MESH_TIME_SCALE` is the only server timing knob. `(0,1]` is accepted in source
execution; unset or `1` preserves defaults. The runner uses `0.04` for ordinary
bundled servers, `0.075` for native launcher/previous-version meshes, or `0.2`
on hosts with fewer than eight logical CPUs to keep health windows usable while
native subprocesses start. It scales
heartbeat/dead detection, reconnect backoff, exchange/retry/debounce, config,
bootstrap and replica reconciliation, rollout health windows, pending fork leases
and commit retry, and tombstone age. The five-minute clock guard remains real;
the skew case shifts a server process's clock by one hour without changing the
host clock.

Normal production bundles compile `__T3CODE_PRODUCTION_BUILD__=true` and ignore
the knob even with `NODE_ENV=test`. Source execution also ignores it with
`NODE_ENV=production`. Only the harness's explicit `T3CODE_MESH_TEST_BUILD=1`
builds turn off that compile-time guard. These private artifacts carry a
`.mesh-fast-fixture` marker, use synthetic versions and must never be published.
`MeshTiming.test.ts` proves default durations, production selection, invalid
values, and actual scaled heartbeat/dead/reconnect behavior.

```sh
pnpm --dir apps/server -s build:bundle
T3_MESH_TIME_SCALE=0 NODE_ENV=test node apps/server/dist/bin.mjs --help # exit 0
T3_MESH_TIME_SCALE=0 NODE_ENV=test node apps/server/src/bin.ts --help # exit 1
```

`fake-agent.mjs` is a deterministic ACP provider exposed as two profiles,
`fakeCodex` and `fakeOpenCode`. It performs real file edits,
calling-thread MCP requests and interruptible partial turns. Tests exercise real
orchestration, persistence, placement, relay, history copying and provider
selection with those profiles. Native Codex/OpenCode protocol and paid model
turns remain in the realistic nightly scripts; the fast command spends no model
credits. Full-mode dependency installation uses checksum-pinned real pnpm offline and
checks both lockfile changes and exact successful install counts.

## Coverage map

Each new scenario ends with an all-entry HLC barrier, equal materialized project
layouts, unique representation IDs and unique private Mutagen session names.
Conflict cases additionally assert the losing bytes remain on disk. The three
original scenarios assert their corresponding convergence/uniqueness properties.
Small transfers retain the real staging or byte-counter fault milestone.

| Old script / requirement                                     | Fast scenario                                                                                                                  | Asserted behavior                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner lifecycle                                             | `runner-cancel-boot`                                                                                                           | Cancels immediately after spawning a real container, before node readiness; the captured container and bridge must both be gone.                                                                                                                                                                                     |
| T1 timing knob                                               | `timing-heartbeat`                                                                                                             | Real N1 peers send six heartbeat frames without an idle drop; the cutoff exposes an unscaled polling tick.                                                                                                                                                                                                           |
| round1 steps 3–5                                             | `layout-legacy-edits`                                                                                                          | Independent legacy seeds merge into one main workspace; every source project alias survives; concurrent rename, placement and reorder survive; fold/default/quiet settings and workspace deletion propagate.                                                                                                         |
| round1 legacy mirror, concurrent old client                  | `layout-legacy-concurrent`                                                                                                     | Whole-settings clients cannot erase concurrent granular writes; settings equals materialized document in a stable read window.                                                                                                                                                                                       |
| round1 offline edits; round3 partition                       | `layout-partition`                                                                                                             | Both leaves observe the hub offline, retain independent edits, merge after healing, and propagate a tombstone.                                                                                                                                                                                                       |
| round1 files step 6                                          | `layout-files`                                                                                                                 | Unplaced remote catalog lookup; relayed read/completion; project-root permissions, binary/large/missing-file errors and files:none policy.                                                                                                                                                                           |
| round1 kill/rejoin; round3 restart permutations              | `crash-restart-orders`                                                                                                         | All six restart orders retain writes and finish converged.                                                                                                                                                                                                                                                           |
| round2 installer                                             | `installer-cold`                                                                                                               | Real product installer creates pinned Mutagen from empty bin directories and completes a real replica.                                                                                                                                                                                                               |
| round2 routes, reverse primary, grouping, repeated placement | `replica-policies`, `replica-ssh`                                                                                              | Six managed SSH routes, reverse-source replication, two primaries in one logical group, one target representation, root dependency/VCS exclusions and nested source inclusion; new code-only defaults exclude nested environments, outputs, bytecode, logs, databases, archives, media, documents and model weights. |
| round2 agent launch/send, stage-m identity                   | `threads-fake-provider`                                                                                                        | Placement before launch into a missing representation; request idempotency; real file edit sync, calling-thread replica metadata, remote send/read/list, cross-machine move refusal.                                                                                                                                 |
| round2 CLI paths                                             | `cli-routing`                                                                                                                  | Checkout CLI reads a remote file, finds a remote thread, queries all-machine status, machine inventory, mesh status and replica display without leaking logical keys.                                                                                                                                                |
| round2 conflicts/removal/orphans; s1-bed                     | `replica-conflicts`, `replica-policies`                                                                                        | Primary-wins and newest-wins preserve losers under safe paths; unsynced removal names its path; successful removal retains files/project; foreign orphan remains visible.                                                                                                                                            |
| round2/round3 kill mid-mount and mid-sync; CONCEPT §12       | `crash-{studio,cloudbox,laptop}-{mount,sync}`                                                                                  | Each actual server is SIGKILLed while Mutagen reports staging a 2 MiB random file; supervisor generation changes; the final payload hash and single session survive.                                                                                                                                                 |
| round3 Mutagen daemon kill; CONCEPT §12                      | `crash-mutagen`                                                                                                                | Captured daemon PID owns its private lock and is SIGKILLed during staging; bytes converge through the automatically recovered daemon.                                                                                                                                                                                |
| round3 path claims                                           | `layout-path-claims`                                                                                                           | Competing claims to the same path select the latest HLC consistently.                                                                                                                                                                                                                                                |
| round3 project migration/display/transports                  | `layout-alias-transports`                                                                                                      | Migrated opaque identity survives first placement; explicit legacy global ignores survive upgrade (including copied zip data), per-project ignores work; manual→sshfs metadata changes; project rename is shared through read/machines.                                                                              |
| round3 foreign daemon adoption                               | `replica-foreign-adoption`                                                                                                     | Reversed foreign endpoints are adopted, old session is removed only after private watching, newest winner converges and loser is archived.                                                                                                                                                                           |
| round3 live regressions 8–9                                  | `replica-warnings`, `layout-files`                                                                                             | Unreadable and outside symlink paths are reported but do not prevent registration; ignore changes replace the session and clear warnings; remote lookup works without placement.                                                                                                                                     |
| network-bed / network-local / network-ssh                    | `network-cut`, `network-delay`, `network-drop-idle`, `network-reset`, `network-ip-change`, `network-sleep`, `network-mid-pipe` | Real cut, delay, idle drop, reset, backend IP change, scaled ten-minute sleep, and mid-pipe reset; SSH/file calls recover; native peer-MCP is refused, so relay transport cannot silently fall back to it.                                                                                                           |
| s1-bed full mode                                             | `replica-full`                                                                                                                 | Frozen install runs once, lockfile mutation runs it exactly once more, and ready status is published.                                                                                                                                                                                                                |
| r1-bed / CONCEPT §7, §12                                     | `run-concept`                                                                                                                  | Real login nvm/uv; primary cwd and output mapping; ignored output stays on primary; concurrent runs; lite git guard; conflict gate and loser copy; background logs/list/stop/port forwarding; Ctrl-C and severed pipe kill process trees; offline primary fails cleanly.                                             |
| c2 bed                                                       | `identity-collisions-unknown-version`                                                                                          | Same-host initial identities remain distinct; malformed known entries and future clocks are rejected; opaque future entries survive restart.                                                                                                                                                                         |
| CONCEPT §12 N-1                                              | `mixed-version`                                                                                                                | Actual pinned sidebar.62 source (not a relabeled current server) accepts and forwards an opaque entry and retains it through restart.                                                                                                                                                                                |
| CONCEPT §12 clock skew                                       | `clock-skew-hour`, `config-clock`                                                                                              | Real server clock advances one hour; receiver records/rejects future writes; restarting after clock restoration quarantines them; direct future HLC is also refused.                                                                                                                                                 |
| config / CONCEPT §9                                          | `config-rules-agents`, `config-clock`                                                                                          | Dry plan leaves revision unchanged; rule creates a real replica; title/tag/instructions/history propagate; future schema and stale base are rejected.                                                                                                                                                                |
| b1-bed / CONCEPT §10, §12                                    | `bootstrap-rollout`                                                                                                            | Initially Node/T3-free systemd container bootstraps with an ephemeral SSH credential; a config rule places real bytes; serial rollout updates cloudbox, rolls laptop back on forced health failure, leaves studio untouched, preserves backups and publishes the reason.                                             |
| round3-runtime                                               | `bootstrap-rollout`                                                                                                            | Real native archives install through unauthenticated public HTTP and managed SSH; a separate private system service supports status, journal, versions, version switch and restart through t3ctl.                                                                                                                    |
| f1 bed / CONCEPT §8, §12                                     | `fork-matrix`, `f1-web-journey`                                                                                                | Every destination × fake profile receives completed history; source is unchanged; missing representation is created; active partial turn is excluded; same-machine move works; real browser drag/confirmation/move/fork flows preserve history/model.                                                                |

## Realistic nightly suite

`scripts/mesh-e2e/acceptance.sh` retains the realistic bed rounds and real provider
guards, then runs this matrix serially with `MESH_FAST_REALISTIC=1`: scale 1,
128–256 MiB transfers and a real ten-minute sleep. Its bed lock waits for another
stage rather than interrupting it. See the mesh-e2e README for the installed timer,
result locations and enable/disable commands. Do not run that wrapper as a fast
check or against an unleased shared bed.

The C2 and server F1 bed sources were previously uncommitted. Their assertions
now live in `bindings.mjs` and `forks.mjs`; runtime execution reads committed
files only. `scripts/mesh-e2e/c2-bed.sh` and `f1-bed.sh` run the same assertions
at scale 1 from the configured nightly artifact directory. The latter also runs
the content-reading fork through native Codex and OpenCode, using private copies
of their credentials and binaries. Provider paths are the same `R1_*` settings
as the realistic harness. These wrappers create isolated infrastructure and do
not use the shared three-machine bed.

| Original evidence               | Fast scenario                                    | Assertions                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C2 verified / S1 joins          | `c2-concurrent-forward`, `c2-concurrent-reverse` | Two fresh containers have the same hostname; both concurrent join orders yield deterministic `studio`/`studio-2` slugs, identical bindings and config. Removing a binding from stopped private legacy databases exercises repair with a new revision. Rename retains environment binding and SSH destination; both original aliases and the renamed alias execute through managed ProxyCommand. |
| F1 server placement and harness | `f1-replica-content`                             | Target starts without a representation; fork places and syncs a replica; two harness profiles execute `cat README.md` and return the exact random bytes absent from the prompt; source history is unchanged.                                                                                                                                                                                    |
| F1 offline atomicity            | `f1-offline-atomic`                              | Stopped destination produces a reason, no thread/representation/pending transaction is created, and source history remains equal.                                                                                                                                                                                                                                                               |
| F1 pending transaction safety   | `f1-pending-expiry`                              | Real linked-peer receive stages an invisible, unreadable and unrunnable thread. The actual scaled lease timer removes its durable journal; an expired commit is refused.                                                                                                                                                                                                                        |
| F1 lost commit response         | `f1-dropped-commit`                              | A protocol-aware proxy drops exactly the first successful commit response and disconnects the peer. Durable source retry commits exactly one thread, with multiple commit calls and one target receipt.                                                                                                                                                                                         |
| F1 browser catalog              | `f1-web-journey`                                 | Source-only browser authentication loads the destination model catalog through the mesh. An empty destination catalog displays its reason and disables fork. Drag preserves ID, history, run count and model.                                                                                                                                                                                   |

Replica fixtures install the real pinned Mutagen remote agent into their private
homes before mounting. The cold-installer scenario separately exercises its
first installation. During crash cases the proxy forwards peer control traffic
and holds only pipe data after 512 KiB, so the real Mutagen staging state remains
observable until the captured server or daemon is killed. Releasing the latch
allows recovery; no transfer or state transition is mocked.

The runner keeps typed RPC connections per origin and credential, cancels snapshot
streams after their first value, and reconnects after a fixture restart. It never
replays a failed mutation. Native Codex and Claude defaults are disabled in fresh
fixture settings so ambient CLI discovery is outside the fast suite.

Chromium runs in the studio container, with browser artifacts bind-mounted into
its own fixture directory. This prevents other fixtures' bridge changes from
resetting browser requests. Private sshd explicitly disables account rc files,
account environment files and reverse DNS; `replica-ssh` checks sshd's effective
configuration as well as real managed SSH transfers.

Fast R1 reuses scoped, real OpenSSH control connections for its command and
process-tree checks. The cut case kills the captured managed ProxyCommand, and
the offline case uses a fresh connection. The realistic variant retains fresh
connections throughout; the product's three-second SSH timeout is unchanged.

Long scenarios run first, including agent/config/SSH cases that would otherwise
leave an expensive final wave, with independent startup and shutdown work bounded
separately. Each fixture records phase transitions and captured child PIDs.
Tool preparation and native builds use kernel locks, so parallel invocations do
not overwrite a Mutagen archive while another invocation is extracting it.
