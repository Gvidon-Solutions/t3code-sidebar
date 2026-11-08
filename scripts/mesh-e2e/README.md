# T3 Mesh E2E test bed

Three T3 servers on one build of the fork. gor's **main** server is the first
node (owner-approved in-place switch); gvidon's and the VPS's are isolated test
servers. Nothing here touches gvidon `:3774` / `~/.t3-sidebar-server`, Operalia
or the VPS `t3-ws` stack.

```
gvidon ──LAN──▶ gor          gvidon ──WAN──▶ VPS
   │                                          │
   └──────────────WAN────────────────────────▶┘

gor ──WAN──▶ VPS             VPS ──ssh tunnel──▶ gor, gvidon
```

## What runs where

| Machine                         | Server                                                 | Data                    | Port             | Runtime                                           |
| ------------------------------- | ------------------------------------------------------ | ----------------------- | ---------------- | ------------------------------------------------- |
| gor (`gor.local`, 192.168.1.10) | **main** systemd --user `t3code-sidebar.service`       | `~/.t3-sidebar-server`  | `127.0.0.1:3774` | `~/.t3-sidebar-server/runtime/versions/<version>` |
| gvidon (this box)               | isolated systemd --user `t3-mesh-e2e-gv.service`       | `/tmp/t3-mesh-e2e-gv`   | `127.0.0.1:3795` | `~/.t3-mesh-e2e-gv-runtime/<version>`             |
| VPS 152.89.244.57               | compose project `t3-mesh-e2e`, container `t3-mesh-e2e` | `/opt/t3-mesh-e2e/home` | `127.0.0.1:3791` | inside image `/opt/t3`                            |

The VPS container is `uid 10001`, `cap_drop: ALL`, `no-new-privileges`, 2 GiB
RAM, 2 CPUs, no `docker.sock`, loopback-only port. Its image is built from
`scripts/mesh-e2e/Dockerfile` (a copy of `deploy/t3-ws/Dockerfile` plus Mutagen
0.18.1 with a pinned SHA-256 and OpenSSH).

### Alternate third node after a VPS memory failure

Before raising a container limit, check the VPS with `free -g`. X1 observed only
1 GiB free (2 GiB available), with repeated cgroup OOM kills at the 2 GiB limit.
The third server therefore moved to a separate gor container, preserving its
identity and mounted home, temporary projects and conflict copies. The original
VPS container stays stopped; never run both copies of the same identity.
The alternative uses 4 GiB RAM, 4 CPUs and the same unprivileged/container security
settings. It changes no other VPS stack and requires no gor kernel change.

The X1 alternative is `/tmp/X1-third-bed/compose.yaml` on gor, container
`t3-mesh-e2e`, loopback port 3791. The native gor server remains a separate node.
The preset `/tmp/X1-third.env` exports `VPS_HOST`, `VPS_SSH_CONFIG`,
`MESH_E2E_VPS_DIR`, `MESH_E2E_VPS_SUDO=1` and `MESH_E2E_GOR_TUNNEL_UNIT`;
source it before the round scripts. The latter selects the gor forwarding unit
for partition/restore checks instead of starting the old VPS tunnel.
`vps_ssh` then runs the third-node commands with passwordless sudo, and
`vps_put` streams files through that same connection instead of bypassing it
with scp. The artifact directory in the preset selects the tested build.
For redeployment the preset also sets `MESH_E2E_REUSE_NETWORK=1` and
`MESH_E2E_COMPOSE_TEMPLATE=/tmp/X1-third-compose-template.json`. The template keeps
the relocated mounts, 4 GiB/4 CPU limits and provider egress; `deploy.sh` replaces
its `t3-mesh-e2e:dev` image placeholder with the build image. Without a template,
deployment uses the standard VPS compose file.

The gvidon test-tunnel override `99-X1-third.conf` forwards ports 13797/13791
through gor and reverses 13795/22023 to the isolated gvidon server/SSH.
On gor, `t3-mesh-X1-third-ports.service` forwards the container bridge routes
13797, 13795, 22022 and 22023, plus the runner's loopback 13791 to port 3791.
The former gor-to-VPS test-tunnel unit is disabled and stopped to avoid a port collision;
a reboot otherwise restarts it and occupies the relocated route’s reverse-forward port.
These are bed-only units. The original stopped VPS data remains available at
`/opt/t3-mesh-e2e`; the gor copy preserves file ownership.

Provider traffic from the relocated container uses the original VPS egress: direct gor
egress returned HTTP 403 from the provider. The container sets `HTTP_PROXY`, `HTTPS_PROXY`
and `ALL_PROXY` to the isolated CONNECT bridge on `172.17.0.1:14444`, with private mesh
addresses excluded through `NO_PROXY`. TLS passes through unchanged. Gvidon’s
`t3-mesh-X1-provider-{socks,connect,forward}.service` units and gor’s
`t3-mesh-X1-provider-egress.service` own this route; keep them running for agent acceptance.
They add no listeners or configuration to any other VPS stack.

The recovered container’s base command retains its loopback `13797` route to the gor bridge.
Fault injection adds a separate incoming proxy: while it is active, recreate the container
with both `compose.yaml` and `X1-N1-compose.yaml`. Recreating from the base file alone
removes that overlay; taking fault proxies down must retain the required outbound route.

For acceptance, `/tmp/X1-fresh.env` selects independent X1 profiles on the same ports.
Gvidon uses `/tmp/X1-fresh-studio`; gor’s base and the third container’s home/tmp/var-tmp
mounts live below `~/.local/share/t3-mesh-e2e/X1-recovered` on gor. The preset supplies the
absolute base paths, matching compose template, fixture state and private runtime-copy SSH route.
These options apply to RPC credentials, CLI wrappers, SSH checks, fault proxies and daemon
inspection; an old CLI base directory can silently query another profile.

Gor rebooted on the unchanged 7.0.0-38 kernel during X1’s final repeat and cleared `/tmp`,
including the relocated copies and temporary test credentials. The profiles were rebuilt from
a consistent private mesh snapshot, with jobs/auth sessions removed and new private keys;
links are explicitly paired again. Persistent profile storage prevents a reboot from deleting
the recovered layout and credentials. It does not prevent a reboot from aborting a test.
The original VPS data in `/opt/t3-mesh-e2e` and gor’s original home-based state remain intact.
The earlier stopped container objects preserve their root filesystems, but their old gor `/tmp`
bind mounts were cleared. Native-unit backups are in `/tmp/X1-shared-profile-backups` on gvidon
and under the recovered root on gor. Never start profiles on the same ports simultaneously.

X1 observed a 2.3 MiB shared layout, sustained receiver-window backpressure, and a
256 MiB staging recovery exceeding the 900-second deadline. A fresh three-node profile
sent a checked 16 MiB through a persistent peer connection in 2.7 seconds, versus
102 seconds in the shared profile. The later build also disables Nagle, so this is not
a controlled comparison of layout size alone. Fresh acceptance keeps other stages' data intact; it does not claim
to fix throughput under that accumulated layout load.

Both `/home/t3` and `/tmp` persist on the VPS host. On the first deployment with
the `/tmp` mount, `deploy.sh` copies the stopped container's existing temporary
folders with ownership intact before recreating it, then verifies its canary.
This keeps fixture projects and `.t3-conflicts` copies across deployments.

The gor demo repository is `~/xdev-e2e/demo`: a git repo with `node_modules/x.js`
and `.venv/a` present but ignored, for replica/sync tests.

### gor main-server backup and rollback

Before the first switch, `deploy.sh` stops `t3code-sidebar.service` and writes a
tar of the real data:

```
~/.t3-sidebar-server/userdata.pre-mesh-e2e-20261102T125454Z.tar.gz   # 12 MiB
# pattern: ~/.t3-sidebar-server/userdata.pre-mesh-e2e-<UTC>.tar.gz
```

It is created once (later deploys reuse it). The first unit change also leaves
`~/.config/systemd/user/t3code-sidebar.service.bak-t3-mesh-e2e-<UTC>`, and the
old runtime `0.0.45-sidebar.17` stays under `runtime/versions/`.

Rollback: restore the unit backup (or point `ExecStart` back at
`0.0.45-sidebar.17`), `systemctl --user daemon-reload && systemctl --user
restart t3code-sidebar.service`. If the xdev schema migration must be undone,
stop the service first, move `userdata` aside, and untar the backup above.

The retired separate gor test server (`t3-mesh-e2e.service`, `:3797`,
`~/.t3-mesh-e2e`) is stopped and its unit removed; its data is kept (and removed
only by `teardown.sh --purge`).

## Commands

```bash
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH

scripts/mesh-e2e/up.sh xdev             # build + deploy + tunnels + status
scripts/mesh-e2e/build.sh xdev          # only build artifacts
scripts/mesh-e2e/deploy.sh              # deploy the artifacts from build.sh
scripts/mesh-e2e/tunnels.sh up|down     # tunnels only
scripts/mesh-e2e/pair.sh [ttl]          # pairing URLs (default 2h)
scripts/mesh-e2e/status.sh              # health of all directions
scripts/mesh-e2e/round3.sh              # N rollout cases and destructive recovery acceptance
scripts/mesh-e2e/teardown.sh            # stop test baggage, keep gor running
scripts/mesh-e2e/teardown.sh --purge    # also delete test data, demo, artifacts
```

`build.sh` checks the ref out into `~/.cache/t3-mesh-e2e/build` (a detached git
worktree, never `/tmp`), installs, builds web + server + resource monitor, packs
the `cli-linux-x64` archive, and builds `t3-mesh-e2e:dev`. Artifacts and
`build.env` live in `~/.cache/t3-mesh-e2e/artifacts`. Override with
`MESH_E2E_BUILD_DIR` / `MESH_E2E_ARTIFACTS` / `MESH_E2E_GVIDON_IP` / `MESH_E2E_GOR_IP`.

For an isolated stage worktree, set `MESH_E2E_BUILD_CURRENT=1` and use your own
`MESH_E2E_ARTIFACTS` directory to build that checkout. `round3.sh` refuses a
different runtime/image or a missing/mismatched bed lock and creates only `N-` fixtures.
Bed units disable systemd's start limit so repeated intentional crashes do not
require a manual reset. Crash acceptance requires an increased systemd/Docker automatic restart counter, without a start command after SIGKILL. Daemon recovery uses a raw socket probe and verifies the captured PID owns the private POSIX lock; its PID/log files stay outside synchronized folders. Round3 owns an SSH control directory to avoid exhausting connection slots.

`deploy.sh` copies the review CLI from this checkout's `agent-kit/skills/t3` to
gor's staged `t3-next` directory. The installed gvidon/Operalia skills and the
`~/.local/bin/t3ctl` wrapper are not modified.

## URLs from gvidon

`tunnels.sh up` installs two systemd --user units (`t3-mesh-e2e-tunnels.service`
on gvidon and on gor) and keeps these forwards:

| gvidon local           | reaches                   | what                       |
| ---------------------- | ------------------------- | -------------------------- |
| `127.0.0.1:13795`      | gvidon `:3795` (via sshd) | isolated gv server         |
| `127.0.0.1:13797`      | gor `:3774`               | gor main server            |
| `127.0.0.1:13791`      | VPS `:3791`               | VPS server                 |
| VPS `172.17.0.1:22022` | gor `:22`                 | reverse tunnel from gor    |
| VPS `172.17.0.1:22023` | gvidon `:22`              | reverse tunnel from gvidon |
| VPS `172.17.0.1:13797` | gor `:3774`               | reverse tunnel from gor    |
| VPS `172.17.0.1:13795` | gvidon `:3795`            | reverse tunnel from gvidon |

`172.17.0.1` is the VPS `docker0` address, reachable from the container on its
bridge network; host loopback is not.

The bed does not manage gor's live T3 tunnel or probe gvidon's live `:3774`.
Its deployment only updates the three test nodes listed above and preserves existing demo edits.

### Server-to-server origins

Use these in Settings › Machines / peer links:

| From          | gor                       | gvidon                    | VPS                      |
| ------------- | ------------------------- | ------------------------- | ------------------------ |
| gor           | `http://127.0.0.1:3774`   | `http://127.0.0.1:13795`  | `http://127.0.0.1:13791` |
| gvidon        | `http://127.0.0.1:13797`  | `http://127.0.0.1:3795`   | `http://127.0.0.1:13791` |
| VPS container | `http://172.17.0.1:13797` | `http://172.17.0.1:13795` | `http://127.0.0.1:3791`  |

Mutagen source paths from the VPS container use the ssh aliases `gor` and
`gvidon` (see `/opt/t3-mesh-e2e/home/.ssh/config`). From gvidon, gor is the
normal `gor` ssh alias and the VPS is `152.89.244.57` (or `127.0.0.1:13791` for
its HTTP). From gor, gvidon is `192.168.1.17`; mutagen 0.18.1 is in
`~/.local/bin` there.

## Pairing

`pair.sh` mints fresh one-time tokens with `t3 pair` on each server and prints:

- web on gvidon: `http://127.0.0.1:1379x/pair#token=…`
- Android emulator on gvidon: `http://10.0.2.2:1379x/pair#token=…`

`10.0.2.2` is the emulator's host loopback. For an emulator/device elsewhere,
`adb reverse tcp:1379x tcp:1379x` and use `127.0.0.1`.

## SSH ownership

Replica authentication is managed by T3. `deploy.sh` no longer authorizes container
or loopback keys in the owner's real SSH home. The isolated gvidon unit sets
`T3_MESH_SSH_HOME` and runs an isolated system sshd prepared by `managed-sshd.mjs`.
The old network tunnel setup is infrastructure only; the legacy round scripts predate
managed SSH and must not be used to provision v2 replica routes.

Round 1 requires identical full documents and materialized configs. With active SSH
probes or replica reports, use `MESH_E2E_LIVE_REPORTS=1` for later rounds: each wait
captures the merged per-key HLC watermark and requires every observer to reach it,
including tombstones. Equal clocks must contain equal values. Every snapshot still
checks `config = materialize(document)`; newer reports may advance during the wait.
Local fixture services and their CLI processes must share `TMPDIR` because private
peer-pipe sockets are rooted there.

Round 3 uses project conflict policies and ignores from `meshConfig.apply`, rather
than a global authority or legacy per-representation flags. Its reversed-endpoint
adoption fixture uses `newest-wins` with explicit file mtimes. Foreign sessions
live in the isolated server HOME; the runner verifies that HOME before creating one.
Each recovery deadline defaults to 900 seconds because the staging-crash scenarios
transfer 256 MiB through the relay. Set `MESH_E2E_ROUND3_TIMEOUT` to override it.
Mount-crash checks subscribe to replica status before placing the replica and wait for
a subsequent `mounting` event. Placement runs through a surviving control server;
waiting until both placements finish can miss this transient state entirely.
Daemon preparation temporarily disables replica reconciliation and stops the old daemon
while T3 is still available to close its SSH pipes. The original enable setting is restored
before killing the captured daemon, including on setup failure.
The container daemon check pauses only the recorded T3 process, keeping `docker exec`
available. It records and validates the process start time before resuming, including
error cleanup; native servers use their isolated systemd unit instead.
Partition injection cuts every node’s peer proxy, since either endpoint can initiate a
connection; stopping one forwarding unit does not sever every route in alternate topologies.
Each proxy’s original state is saved and restored independently.
Round 3 requests four-hour test sessions (`MESH_E2E_SESSION_TTL`) so credentials
remain valid across those transfers and the six restart orders.
Use `MESH_E2E_LIVE_REPORTS=1` for round one on a populated bed with ongoing status writers;
it checks delivery of every captured entry and tombstone plus each node's materialization.
The default whole-document equality mode requires quiescent writers.
Legacy-mirror verification brackets each settings read with equal current materializations,
and compares the complete configuration, including machine and replica statuses.
Its fixture parent defaults to `/var/tmp/t3-mesh-round3` to retain evidence across
host reboots. `MESH_E2E_ROUND3_FIXTURES` selects the same absolute parent on all nodes;
that parent's local path can link to a larger artifact disk.
The VPS persists both `/tmp` and `/var/tmp`; deployment copies existing contents before
adding either mount so proxy reconfiguration retains the folders behind durable DB records.
Round 3 requires `MESH_E2E_LOCK_OWNER` (default `N1`) to match the shared lock before
operations; after a lost lock it leaves shared services and settings untouched.

## Teardown

```bash
scripts/mesh-e2e/teardown.sh          # test baggage stopped; gor stays up
scripts/mesh-e2e/teardown.sh --purge  # test data/artifacts/demo removed too
```

It stops both test-bed tunnel units, the isolated gvidon server and the VPS
compose project, removes the tagged `authorized_keys` lines and disposable key
files, and removes the retired gor test unit. It deliberately **leaves gor's
main `t3code-sidebar.service` running** on the xdev build, and never touches
gvidon `:3774`, Operalia or `t3-ws`. `--purge` also removes `~/.t3-mesh-e2e`
(retired test data), the demo repo and build artifacts, but not
`~/.t3-sidebar-server`.

## Notes and limits

- The VPS cannot reach the home LAN directly. Everything VPS→gor/gvidon goes
  through ssh reverse forwards bound to `172.17.0.1`.
- gor→gvidon test traffic uses a local `:13795` forward through the VPS
  reverse forward, independently of the live server's tunnels.
- The VPS has ~15 GiB RAM total and is shared with other stacks. At deploy time
  `deploy.sh` prints free RAM/disk; the container is capped at 2 GiB.
- `tunnels.sh up` re-pins the container's `known_hosts` from `ssh-keyscan` after
  the reverse forwards exist.
- `deploy.sh` uses the VPS `docker compose` project name `t3-mesh-e2e`; do not
  rename it to `t3-ws`.

## Round 1 regression run

After build/deploy and legacy seeding, run `scripts/mesh-e2e/round1.sh`. It tests
steps 3–8 (links, layout adoption, concurrent/offline/restart edits, RPCs, files
and old-client compatibility) and exits nonzero if any assertion fails. It stops
and restarts gor and kills/restarts only the test VPS container. All three nodes
are left running. `--timeout 90` changes each convergence deadline in seconds.

The adoption fixtures are read-only copies in
`~/.local/share/t3-mesh-e2e/legacy/{gvidon,operalia}.json`. Seed these under
`sidebarWorkspaces` in each test server’s `userdata/settings.json` before its
first mesh start; retain gor’s existing data. The runner never reseeds or reads
the live servers. Per-run snapshots and RPC responses are in
`/tmp/t3-mesh-e2e-round1` (override `MESH_E2E_ROUND1_WORK` for parallel runs).
The committed `round1.log` records the latest 45/45 regression pass.

## Round 2 replica acceptance

Build without touching another checkout or the installed `t3` skill:

```bash
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
MESH_E2E_BUILD_CURRENT=1 scripts/mesh-e2e/up.sh xdev
scripts/mesh-e2e/round1.sh
MESH_E2E_LIVE_REPORTS=1 scripts/mesh-e2e/round2.sh
```

`MESH_E2E_BUILD_CURRENT=1` builds this checkout's HEAD (printed in the log),
regardless of the ref argument, without checking out/cleaning the shared build
worktree. Deployment copies staged `~/.agents/skills/t3-next/scripts` to gor's
`t3-next`, leaving the installed `t3` skill alone.

Round 2 reuses round 1's authenticated WS helpers through
`MESH_E2E_HELPERS_ONLY=1`. Its default evidence directory is
`/tmp/t3-mesh-e2e-round2`; override `MESH_E2E_ROUND2_WORK` to retain another run.
It enables replicas on the test nodes. MCP and CLI calls use separate temporary auth directories.
Do not publish those directories: they contain credentials.

Round 2 applies managed SSH through `meshConfig.apply` and resolves the generated
`t3-<name>` aliases from the environment bindings. It uses the isolated SSH homes
and sshd endpoints provisioned by deployment. It does not invoke the legacy
`round2-routes.sh`, write real-user SSH files or configure raw reach routes.

The runner leaves the bed running, the reverse representation and second demo
primary in the layout, and a labelled orphan session for inspection. It removes
the demo's VPS representation in scenario g, preserving its files and registered
project. Re-running allocates another free replica path when the old files are
still there. Assertions and deadlines fail explicitly; no failed acceptance is
silently treated as a pass. `round2.log` and `round2-report.md` record the run.

The real-agent scenarios require Codex authentication in the isolated container
HOME before the run. Credentials never enter evidence logs. The installer test temporarily moves only the test server's
`bin` directory aside and proves T3 restores pinned Mutagen on first use.

## N1 transport acceptance

Hold the shared bed lock before deploying or running these scenarios. Build in the current
worktree with `MESH_E2E_BUILD_CURRENT=1`, an owned `MESH_E2E_ARTIFACTS` directory and
`MESH_E2E_IMAGE=t3-mesh-e2e:n1`; the build uses Node 26 and includes system OpenSSH for the
pipe check. `MESH_E2E_REUSE_NETWORK=1 deploy.sh` retains existing keys, tunnels and Mutagen
installation instead of editing the owner's SSH files. The isolated gvidon unit has its own
HOME under its base directory, so replica reconciliation cannot write the owner's SSH config.

`network-proxies.sh up` places a transparent test proxy in front of each server; `block`
rejects peer HTTP POST /mcp (identified by PeerMcpClient's `t3-peer-environment-id` header)
while preserving local agent/CLI MCP, WebSocket upgrades and other HTTP routes. Without
`peerOnlyMcp:true`, the proxy's `denyMcp` mode rejects every MCP client, as the local check does.
`GET /__N1_network` reports accepted/refused MCP requests and upgrade counts. The proxy state
files live under /tmp with an N1 prefix. `network-rounds.sh 1` and `2` run the existing rounds
with N1 project/thread/file names and reuse the already-provisioned SSH routes. They preserve
other stages' fixtures. `network-proxies.sh down` restores the original server ports and
removes only the N1 proxy units/drop-ins.
The VPS also gets a loopback outbound forwarder to gor's existing SSH tunnel. Pair the VPS
to `http://127.0.0.1:13797`; Docker bridge addresses themselves do not qualify for plain HTTP
under `peerOrigin`. Set `denyPeer:true` in the VPS front proxy state to reject inbound `/peer`
connections while preserving its outbound connection and local control RPCs.

After `network-rounds.sh 1`, run `network-bed.sh nat`, then `network-rounds.sh 2` to cover
incoming-only reachability during replica operations. `network-bed.sh ssh` uses the packaged
native binary for pinned-key SSH uploads/downloads and interruption, asserting that peer
connections survive. `network-bed.sh faults` cuts the dedicated test tunnel for three minutes,
then kills the server PID captured by the container wrapper and requires automatic recovery.
Run `network-bed.sh restore` before `network-proxies.sh down` so the healthy mesh no longer
depends on the temporary outbound forwarder. Every command requires the N1 bed lock.

`network-ssh.mjs <binary> <base-dir> <machine> <user> <host-keys-json>` runs OpenSSH through
the actual `t3 mesh pipe` ProxyCommand, pins reported host keys, checks a 200 MiB upload and
download by SHA-256, interrupts an upload and verifies a new SSH session. Use
`N1_SSH_PREPARE_ONLY=1` to generate an isolated client public key first, authorize that key
only in the test sshd, and pass its private path with `N1_SSH_IDENTITY` for the test run.
No key, token or generated known_hosts file belongs in the repository.

For an independent local check while the shared bed is occupied, run
`N1_IMAGE=t3-mesh-e2e:n1 node scripts/mesh-e2e/network-local.mjs` after building that image.
It starts two isolated source servers and one disposable container, exercises incoming-only
reachability, a relayed file read and the full SSH transfer/interruption checks. It uses owned
temporary homes and keys, stops its captured child processes and removes only its own container.
Set `N1_FAULTS=1` to cut its outbound network for three minutes and kill the captured server
PID afterward; the check requires automatic restart, restored relay calls and no HTTP MCP use.

## F1 web journey

`f1-web.mjs` drives a real Chromium HTML drag, confirms the model-free project move,
checks the persisted destination and unchanged history/model, then opens Fork to machine.
It saves before/confirmation/after/dialog PNGs and a WebM under `--shots`.
Use an isolated server, a completed fixture thread with history, and a private Playwright
storage-state file paired to that server. The CLI inherits `T3CODE_HOME`, `T3CTL_ORIGIN`,
`T3CTL_T3_BIN` and `XDG_CONFIG_HOME`; keep auth files outside the evidence directory.

```bash
node scripts/mesh-e2e/f1-web.mjs \
  --origin http://127.0.0.1:6664 --storage-state /tmp/F1-auth/browser.json \
  --thread-title 'F1 Drag with history' --thread-id '<fixture-thread-id>' \
  --target-title 'F1 Studio' --target-project-id '<local-target-project-id>' \
  --shots /tmp/t3-f1-shots
```

The thread must initially belong to another project. The runner uses `dragTo` and the
real confirmation button; it does not dispatch synthetic drag events or mutate app stores.

## S1 fresh managed-SSH acceptance

Hold the bed lock with owner `S1`. `s1-bed.mjs` uses a fresh data/home tree for
studio (isolated :3795), laptop (isolated :3799 on the device host) and cloudbox
(a disposable VPS container). It never switches the laptop's main server. Pass
administrator SSH argument arrays in `S1_LAPTOP_SSH` and `S1_CLOUDBOX_SSH`, an
assembled runtime directory in `S1_BED_RUNTIME`, the test image in `S1_BED_IMAGE`
and a fresh absolute `S1_BED_ROOT`. Include the verified pinned Mutagen binary
and agents archive alongside the runtime. The caller owns the physical port and
must stop any previous **isolated** :3795 bed server first.

The runner prepares isolated system sshd host keys/configuration, but creates no
client key and writes no authorized_keys line. It links machines, applies a config
with replica rules, checks all six managed hosts (including a peer with inbound
`/peer` blocked), root-ignore anchoring, both conflict policies and explicit removal
with unsynced refusal and retained files. A separate full-mode project executes a fake
pnpm binary, checks its first install, changes the lock file and checks one refresh
plus the ready status. It saves private OAuth/control state under
the owned root with 0600 permissions; never publish that file. `S1_KEEP_BED=1` retains
its owned administrator forwards while the caller inspects results. Stop those
forwards through the retained runner session, stop the owned `S1-mesh-*` units and
container when done, and release the lock. Keep fixture data; do not clean another
stage's project, session, service or container.

## R1 command execution acceptance

`apps/server/src/run/run.integration.ts` owns a real local sshd container and a private
Mutagen daemon/session. Build `apps/server/src/run/testFixtures/sshd.Dockerfile` as
`t3-run-sshd-test:local`, then run `pnpm --dir apps/server test:run-integration` with Node 26,
Docker, Mutagen, nvm and uv installed. Set `R1_RUN_BINARY` to an assembled runtime executable
to exercise the packaged CLI and worker instead of the source entrypoint. No owner SSH files
or Mutagen sessions are used.

`r1-harness.mjs` tests shell guards in real Codex and OpenCode threads on a temporary server.
Set `R1_CODEX_BINARY` and `R1_OPENCODE_BINARY` to installed native binaries and choose an
available Codex model with `R1_CODEX_MODEL`. It uses the existing Codex and DeepSeek credentials
only to make private copies, removes those copies on exit, disables OpenCode updates and
saves command evidence under `R1_HARNESS_EVIDENCE`. The login profiles deliberately reset
PATH; both guarded commands must report 127 while OpenCode's own Git discovery still runs.
These are paid integration turns, so this runner is explicit rather than part of the unit suite.

Hold the shared lock with owner `R1` before `r1-bed.mjs`. Provide `R1_BED_RUNTIME` (assembled
runtime plus pinned `mutagen` and `mutagen-agents.tar.gz`), `R1_BED_IMAGE` (an existing bed
image), a fresh `R1_BED_ROOT`, and administrator SSH argument arrays in `R1_LAPTOP_SSH` and
`R1_CLOUDBOX_SSH`. Stop the previous isolated :3795 unit first. The runner owns `R1-mesh-*`
units, a disposable VPS container and private homes, and uses real S1 managed hosts and sync
APIs. `r1-bed-scenarios.mjs` checks the CONCEPT §12 run scenarios, background forwards and
converged project layouts/session counts. The connection-cut scenario severs the command’s N1 SSH byte pipe using its captured
ProxyCommand PID; servers and other sessions stay up. The offline scenario pauses only its
own VPS container.
The conflict fixture briefly stops its second replica driver and restarts its own isolated
driver, so the automatic conflict policy cannot consume the conflict before the run gate sees it.
The second driver is restored in a finalizer. Afterward stop the owned units/container,
restore the previous isolated :3795 unit and release
the lock. Keep fixture files and conflict copies; never publish `control.json` or auth state.

### B1 bootstrap and rollback

Hold the shared bed lock as `B1`. Build two complete archives from this worktree with
embedded versions `0.1.5` and `0.1.6` (restore package.json afterwards), using the normal
CLI build and `build-cli-archive.ts`; put each archive and its `SHA256SUMS` in
`/tmp/B1-releases/v<VERSION>`. These are private test releases served by the fixture,
with the same artifact naming and SHA256 verification as production.

Build `b1-sshd.Dockerfile` on the gor bed host, then start the fresh container:

```sh
docker build -f b1-sshd.Dockerfile -t b1-bootstrap-sshd .
docker run -d --name B1-bootstrap --label stage=B1 --privileged --cgroupns=host \
  --network host --tmpfs /run --tmpfs /tmp \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw b1-bootstrap-sshd
```

It contains systemd and OpenSSH, without Node or T3. The privileged cgroup mount is
for this isolated Linux service-manager fixture. The test generates its SSH key
under its private root, supplies it through the one-time credential API, and never
provisions real user SSH files. Set `B1_LAPTOP_SSH` to the VPS administrator SSH argv
and `B1_CLOUDBOX_SSH` to the gor administrator SSH argv as JSON arrays, then run:

```sh
B1_BED_ROOT=/tmp/B1-bed-unique node scripts/mesh-e2e/b1-bed.mjs
```

The fixture temporarily stops the existing isolated gvidon bed unit on :3795,
starts private protocol-3 launchers, bootstraps the container from config, checks a
real replica rule, and applies a three-server rollout with a forced health failure
on the second machine. It restores the original isolated bed unit and stops its
own server units and SSH tunnels. Remove its `B1-bootstrap` container afterwards,
then release the bed lock. Retained private state includes both SQLite backups and
launcher outcomes for inspection. Never substitute the live :3774 base directory.

`node scripts/mesh-e2e/platform-smoke.mjs` exercises two local servers, config,
managed SSH and a real replica on the host OS. It uses private homes and daemon
state. The Windows/macOS workflow runs this same fixture on native runners;
Linux execution alone cannot prove those operating systems' native behavior.

Observed B1 acceptance output (private 0.1.5 → 0.1.6 fixture releases):

```text
PASS fresh container: sshd active; no T3 or Node
PASS config rule places real replica {"machine":"cloudbox","state":"watching","file":"B1-bootstrap-replica"}
PASS three-server rollout: cloudbox updated, laptop rolled back, studio untouched {"studio":"0.1.5","laptop":"0.1.5","cloudbox":"0.1.6"}
PASS B1 bootstrap and serial rollout rollback acceptance
PASS linux/x64: two servers, mesh config, managed SSH, real replica watching and matching file
```

Every server's final update status reported `Rollout stopped: Injected mesh rollout
health failure; apply a new config revision to retry`. Both attempted servers had
pre-download SQLite snapshots; the final server had no rollout marker or launcher
update record. The fresh container used the actual root systemd service manager.

The round-three daemon fixture suspends its verified isolated server process only while
starting the foreground fault-test daemon, then resumes it before the crash. Background
status readers can otherwise win the private daemon lock even with replicas disabled.
The EXIT cleanup resumes a suspended server before restoring its settings.

Sequential transport acceptance waits for manual-folder policy metadata and its delivery
before requesting SSHFS on the same representation key. Otherwise a concurrent ignores
enrichment can legitimately win the whole-entry LWW race; config revision delivery alone
does not prove that the per-representation policy action has completed.

The N1 test sshd accepts the normal managed authorized_keys as well as its separate
ephemeral-key file. Replacing the managed file would break replica and run access
while the independent pinned-key transfer scenario is active.

Round 3 requires `network-proxies.sh up` for its partition case. It saves and cuts the
primary's inbound proxy state and stops its outbound tunnels, then waits for both
replica endpoints to disconnect before writing divergent versions. The engine stays
enabled and sessions stay running; no pause/retry/resume command runs during the outage
or recovery. Normal completion and EXIT cleanup restore the captured proxy state.

Round two follows project-list cursors when reusing a populated bed. Its command and
sync deadlines default to 900 seconds, matching the server’s 15-minute replica readiness
budget rather than cutting off a slow 128 MiB transfer after 180 seconds.
`MESH_E2E_ROUND2_RPC_TIMEOUT` and `MESH_E2E_ROUND2_TIMEOUT` override those bounds.
The transfer check compares both SHA-256 hashes and requires exactly 128 MiB on the replica.

Round three’s runtime-copy fixture accepts `MESH_E2E_RUNTIME_SSH_DESTINATION`,
`MESH_E2E_RUNTIME_SSH_IDENTITY` and `MESH_E2E_RUNTIME_SSH_KNOWN_HOSTS` for a
relocated bed. Use a private bed account/key and a known-host file pinned from that
bed’s host key. The route is copied into the disposable runtime fixture; it never
reads or changes the administrator’s SSH configuration.
