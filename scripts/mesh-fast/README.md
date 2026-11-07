# Isolated mesh acceptance

Run from a checkout with Node 26 and frozen dependencies installed:

```sh
scripts/mesh-fast/run.sh
pnpm mesh:fast
scripts/mesh-fast/run.sh --scenario partition --repeat 5
scripts/mesh-fast/run.sh --jobs 2
```

Each scenario starts three fresh source servers (studio, cloudbox, laptop), each
with its own HOME, XDG configuration, state, agent instruction home, managed SSH
home, sshd host key and high loopback ports. No existing mesh, daemon, SSH identity
or server is reused. Inherited T3 command shims and shell startup hooks are removed
before launching fixtures. The system OpenSSH server must be installed at
`/usr/sbin/sshd`; the runner runs it as the current user. Studio refuses inbound
peer upgrades; it dials cloudbox, and laptop reaches it through the one-hop relay.
The replica scenario installs the pinned Mutagen through the production installer.
The installer needs network access on a cold run.

Scenarios run concurrently (two by default). `--jobs` controls concurrency;
`--scenario` selects a name substring; `--repeat` repeats every selected scenario.
A nonzero exit signals a scenario failure or total runtime above 300 seconds.
Each run prints its fresh artifact directory, PASS/FAIL and duration per scenario,
and writes `summary.json`, `junit.xml`, per-node server/proxy/sshd logs and failure
stacks. Test state remains there for diagnosis. Stop private servers before stopping
their private Mutagen daemons; shutdown escalates only captured child PIDs.

## Timing

`T3_MESH_TIME_SCALE=0.01` accelerates source-server mesh timers. It accepts a number
in `(0, 1]`; unset means 1. Production bundles compile
`__T3CODE_PRODUCTION_BUILD__=true` and ignore the variable, even if NODE_ENV is
changed. Source execution with NODE_ENV=production also ignores it.

Scaled timers: heartbeat/dead detection, session tick, reconnect backoff, layout
push debounce and exchange/retry, config/bootstrap/replica reconciliation, rollout
health retry/window, pending fork leases and commit retry, and tombstone age.
Clock guard stays at five minutes: the skew scenario submits a future HLC directly,
so accelerating the wall-clock guard is unnecessary. I/O deadlines and external
installer timeouts retain their normal values.

Production guard verification:

```sh
pnpm --dir apps/server -s build:bundle
T3_MESH_TIME_SCALE=0 node apps/server/dist/bin.mjs --help # succeeds
T3_MESH_TIME_SCALE=0 node apps/server/src/bin.ts --help # rejects invalid scale
```

## Coverage boundary

This runner currently covers the following subset. It does **not** replace the
release bed or constitute completion of Stage T1's full acceptance criteria.

| Existing bed / concept                   | Fast scenario    | Assertions                                                                                                                                         |
| ---------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| round1, round3 partition, CONCEPT §3/§12 | layout-partition | concurrent opaque entries from both leaves converge; both retain edits during hub cut; reconnect delivers both; tombstone propagates               |
| config, CONCEPT §9/§12                   | config-clock     | apply replicates its revision; stale base is refused; +1h HLC is refused and never stored                                                          |
| round2 routes, s1-bed, CONCEPT §5/§6     | replica-ssh      | private managed SSH carries a real Mutagen replica; 1 MiB payload is byte-identical; root dependencies and VCS excluded; one target representation |

Coverage not supplied by this runner: round3 server/Mutagen crashes and restart
orders; mid-transfer faults; delay/drop-idle/reset/IP-change; sleep; N-1;
conflict resolution; R1 run/interrupt/login/ignored-output/concurrency/offline;
F1 fork/provider matrix and running-turn forks; B1 bootstrap/rollout rollback;
C2 collisions; fake provider turns; the remaining round1/round2 assertions.
There is no three-run gor timing proof, full nightly scheduler, or consolidated
realistic-bed inventory in this implementation.
