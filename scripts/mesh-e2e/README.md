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
different runtime/image or a running QA/L/M task and creates only `N-` fixtures.
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

## Keys

Test-bed keys are disposable and tagged `t3-mesh-e2e`; the gor→gvidon tunnel key is a permanent fix and is not removed by teardown.

| Key                     | Private half                 | Authorized on                    | Options                                                                                                                                                                         |
| ----------------------- | ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id_mesh_gor`           | `/opt/t3-mesh-e2e/home/.ssh` | gor `~/.ssh/authorized_keys`     | `from="127.0.0.1,::1",restrict`, comment `t3-mesh-e2e-container-gor`                                                                                                            |
| `id_mesh_gvidon`        | same                         | gvidon `~/.ssh/authorized_keys`  | `from="127.0.0.1,::1",restrict`, comment `t3-mesh-e2e-container-gvidon`                                                                                                         |
| `id_t3_mesh_e2e_vps`    | gvidon `~/.ssh`              | VPS `/root/.ssh/authorized_keys` | `from="78.17.147.89",restrict,port-forwarding,permitlisten="172.17.0.1:22023"`, `…:13795`, comment `t3-mesh-e2e-reverse-gvidon`                                                 |
| `id_t3_mesh_e2e_vps`    | gor `~/.ssh`                 | VPS `/root/.ssh/authorized_keys` | `from="91.77.163.152",restrict,port-forwarding,permitlisten="172.17.0.1:22022"`, `…:13797`, comment `t3-mesh-e2e-reverse-gor`                                                   |
| `id_t3_mesh_e2e_self`   | gvidon `~/.ssh`              | gvidon `~/.ssh/authorized_keys`  | `from="127.0.0.1,::1",restrict,port-forwarding`, comment `t3-mesh-e2e-self`                                                                                                     |
| `id_t3_mesh_e2e_gvidon` | gor `~/.ssh`                 | gvidon `~/.ssh/authorized_keys`  | `from="192.168.1.10",restrict,port-forwarding,permitopen="127.0.0.1:3774"`, comment `t3-gvidon-tunnel` — permanent fix for the pre-existing gor→gvidon tunnel, kept by teardown |

`MESH_E2E_GVIDON_IP` / `MESH_E2E_GOR_IP` override the two `from=` addresses. gor exits through a different route than gvidon (it is not the home public IP), so deploy.sh probes `api.ipify.org` from each side and falls back to the pinned values above.
Every append keeps a timestamped `authorized_keys.bak-t3-mesh-e2e-*` backup.
Teardown removes only lines with the tags above.

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
scripts/mesh-e2e/round2.sh
```

`MESH_E2E_BUILD_CURRENT=1` builds this checkout's HEAD (printed in the log),
regardless of the ref argument, without checking out/cleaning the shared build
worktree. Deployment copies staged `~/.agents/skills/t3-next/scripts` to gor's
`t3-next`, leaving the installed `t3` skill alone.

Round 2 reuses round 1's authenticated WS helpers through
`MESH_E2E_HELPERS_ONLY=1`. Its default evidence directory is
`/tmp/t3-mesh-e2e-round2`; override `MESH_E2E_ROUND2_WORK` to retain another run.
It enables replicas on the test nodes and saves routes through `meshLayout.apply`,
the Settings model. MCP and CLI calls use separate temporary auth directories.
Do not publish those directories: they contain credentials.

`round2-routes.sh` creates a dedicated SSH key whose VPS authorized-key command
is restricted to `docker exec -i t3-mesh-e2e`. This lets Mutagen address paths
inside the container from gor and gvidon without exposing host paths or adding
an SSH daemon. The private key is copied only to gor; the pinned VPS host key
comes from the existing vpn-ops known_hosts. Settings reach routes use the
identity file so T3 generates its managed SSH aliases.

The runner leaves the bed running, the reverse representation and second demo
primary in the layout, and a labelled orphan session for inspection. It removes
the demo's VPS representation in scenario g, preserving its files and registered
project. Re-running allocates another free replica path when the old files are
still there. Assertions and deadlines fail explicitly; no failed acceptance is
silently treated as a pass. `round2.log` and `round2-report.md` record the run.

Round 2 provisions SCP/SFTP support for that container-only SSH endpoint and,
when absent, copies the existing local Codex auth fixture into the isolated
container HOME (override its source with `MESH_E2E_CODEX_AUTH`). Credentials never
enter evidence logs. The installer test temporarily moves only the test server's
`bin` directory aside and proves T3 restores pinned Mutagen on first use.

## N1 transport acceptance

Hold the shared bed lock before deploying or running these scenarios. Build in the current
worktree with `MESH_E2E_BUILD_CURRENT=1`, an owned `MESH_E2E_ARTIFACTS` directory and
`MESH_E2E_IMAGE=t3-mesh-e2e:n1`; the build uses Node 26 and includes system OpenSSH for the
pipe check. `MESH_E2E_REUSE_NETWORK=1 deploy.sh` retains existing keys, tunnels and Mutagen
installation instead of editing the owner's SSH files. The isolated gvidon unit has its own
HOME under its base directory, so replica reconciliation cannot write the owner's SSH config.

`network-proxies.sh up` places a transparent test proxy in front of each server; `block`
rejects external HTTP POST /mcp while preserving WebSocket upgrades and other HTTP routes.
`GET /__N1_network` reports accepted/refused MCP requests and upgrade counts. The proxy state
files live under /tmp with an N1 prefix. `network-rounds.sh 1` and `2` run the existing rounds
with N1 project/thread/file names and reuse the already-provisioned SSH routes. They preserve
other stages' fixtures. `network-proxies.sh down` restores the original server ports and
removes only the N1 proxy units/drop-ins.

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
