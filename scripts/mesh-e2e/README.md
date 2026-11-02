# T3 Mesh E2E test bed

Three isolated T3 servers for the Mesh feature, all on one build of the fork.
Nothing here touches the live servers: gvidon `:3774` / `~/.t3-sidebar-server`,
Operalia, or the VPS `t3-ws` stack.

```
gvidon ──LAN──▶ gor          gvidon ──WAN──▶ VPS
   │                                          │
   └──────────────WAN────────────────────────▶┘

gor ──WAN──▶ VPS             VPS ──ssh tunnel──▶ gor, gvidon
```

## What runs where

| Machine | Server | Data | Port | Runtime |
| --- | --- | --- | --- | --- |
| gor (`gor.local`, 192.168.1.10) | systemd --user `t3-mesh-e2e.service` | `~/.t3-mesh-e2e` | `127.0.0.1:3797` | `~/.t3-mesh-e2e/runtime/<version>` |
| gvidon (this box) | systemd --user `t3-mesh-e2e-gv.service` | `/tmp/t3-mesh-e2e-gv` | `127.0.0.1:3795` | `~/.t3-mesh-e2e-gv-runtime/<version>` |
| VPS 152.89.244.57 | compose project `t3-mesh-e2e`, container `t3-mesh-e2e` | `/opt/t3-mesh-e2e/home` | `127.0.0.1:3791` | inside image `/opt/t3` |

The VPS container is `uid 10001`, `cap_drop: ALL`, `no-new-privileges`, 2 GiB
RAM, 2 CPUs, no `docker.sock`, loopback-only port. Its image is built from
`scripts/mesh-e2e/Dockerfile` (a copy of `deploy/t3-ws/Dockerfile` plus Mutagen
0.18.1 with a pinned SHA-256 and OpenSSH).

The gor demo repository is `~/xdev-e2e/demo`: a git repo with `node_modules/x.js`
and `.venv/a` present but ignored, for replica/sync tests.

## Commands

```bash
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH

scripts/mesh-e2e/up.sh xdev             # build + deploy + tunnels + status
scripts/mesh-e2e/build.sh xdev          # only build artifacts
scripts/mesh-e2e/deploy.sh              # deploy the artifacts from build.sh
scripts/mesh-e2e/tunnels.sh up|down     # tunnels only
scripts/mesh-e2e/pair.sh [ttl]          # pairing URLs (default 2h)
scripts/mesh-e2e/status.sh              # health of all directions
scripts/mesh-e2e/teardown.sh            # stop + remove keys/tunnels/units
scripts/mesh-e2e/teardown.sh --purge    # also delete data, demo repo, artifacts
```

`build.sh` checks the ref out into `~/.cache/t3-mesh-e2e/build` (a detached git
worktree, never `/tmp`), installs, builds web + server + resource monitor, packs
the `cli-linux-x64` archive, and builds `t3-mesh-e2e:dev`. Artifacts and
`build.env` live in `~/.cache/t3-mesh-e2e/artifacts`. Override with
`MESH_E2E_BUILD_DIR` / `MESH_E2E_ARTIFACTS` / `MESH_E2E_GVIDON_IP` / `MESH_E2E_GOR_IP`.

## URLs from gvidon

`tunnels.sh up` installs two systemd --user units (`t3-mesh-e2e-tunnels.service`
on gvidon and on gor) and keeps these forwards:

| gvidon local | reaches | what |
| --- | --- | --- |
| `127.0.0.1:13795` | gvidon `:3795` (via sshd) | local gv server |
| `127.0.0.1:13797` | gor `:3797` | gor server |
| `127.0.0.1:13791` | VPS `:3791` | VPS server |
| VPS `172.17.0.1:22022` | gor `:22` | reverse tunnel from gor |
| VPS `172.17.0.1:22023` | gvidon `:22` | reverse tunnel from gvidon |
| VPS `172.17.0.1:13797` | gor `:3797` | reverse tunnel from gor |
| VPS `172.17.0.1:13795` | gvidon `:3795` | reverse tunnel from gvidon |

`172.17.0.1` is the VPS `docker0` address, reachable from the container on its
bridge network; host loopback is not.

### Server-to-server origins

Use these in Settings › Machines / peer links:

| From | gor | gvidon | VPS |
| --- | --- | --- | --- |
| gor | `http://127.0.0.1:3797` | not routed (not required) | `http://127.0.0.1:13791` |
| gvidon | `http://127.0.0.1:13797` | `http://127.0.0.1:3795` | `http://127.0.0.1:13791` |
| VPS container | `http://172.17.0.1:13797` | `http://172.17.0.1:13795` | `http://127.0.0.1:3791` |

Mutagen source paths from the VPS container use the ssh aliases `gor` and
`gvidon` (see `/opt/t3-mesh-e2e/home/.ssh/config`). From gvidon, gor is the
normal `gor` ssh alias and the VPS is `152.89.244.57` (or `127.0.0.1:13791` for
its HTTP).

## Pairing

`pair.sh` mints fresh one-time tokens with `t3 pair` on each server and prints:

- web on gvidon: `http://127.0.0.1:1379x/pair#token=…`
- Android emulator on gvidon: `http://10.0.2.2:1379x/pair#token=…`

`10.0.2.2` is the emulator's host loopback. For an emulator/device elsewhere,
`adb reverse tcp:1379x tcp:1379x` and use `127.0.0.1`.

## Keys

All keys are disposable and tagged `t3-mesh-e2e`.

| Key | Private half | Authorized on | Options |
| --- | --- | --- | --- |
| `id_mesh_gor` | `/opt/t3-mesh-e2e/home/.ssh` | gor `~/.ssh/authorized_keys` | `from="127.0.0.1,::1",restrict`, comment `t3-mesh-e2e-container-gor` |
| `id_mesh_gvidon` | same | gvidon `~/.ssh/authorized_keys` | `from="127.0.0.1,::1",restrict`, comment `t3-mesh-e2e-container-gvidon` |
| `id_t3_mesh_e2e_vps` | gvidon `~/.ssh` | VPS `/root/.ssh/authorized_keys` | `from="78.17.147.89",restrict,port-forwarding,permitlisten="172.17.0.1:22023"`, `…:13795`, comment `t3-mesh-e2e-reverse-gvidon` |
| `id_t3_mesh_e2e_vps` | gor `~/.ssh` | VPS `/root/.ssh/authorized_keys` | `from="91.77.163.152",restrict,port-forwarding,permitlisten="172.17.0.1:22022"`, `…:13797`, comment `t3-mesh-e2e-reverse-gor` |
| `id_t3_mesh_e2e_self` | gvidon `~/.ssh` | gvidon `~/.ssh/authorized_keys` | `from="127.0.0.1,::1",restrict,port-forwarding`, comment `t3-mesh-e2e-self` |

`MESH_E2E_GVIDON_IP` / `MESH_E2E_GOR_IP` override the two `from=` addresses. gor exits through a different route than gvidon (it is not the home public IP), so deploy.sh probes `api.ipify.org` from each side and falls back to the pinned values above.
Every append keeps a timestamped `authorized_keys.bak-t3-mesh-e2e-*` backup.
Teardown removes only lines with the tags above.

## Teardown

```bash
scripts/mesh-e2e/teardown.sh          # nothing left running, data kept
scripts/mesh-e2e/teardown.sh --purge  # data/artifacts/demo repo removed too
```

It stops both tunnel units, the two server units and the VPS compose project,
removes the unit files and tagged `authorized_keys` lines, and deletes the
disposable key files. It never stops `t3code-sidebar.service`, Operalia, or
`t3-ws`.

## Notes and limits

- The VPS cannot reach the home LAN directly. Everything VPS→gor/gvidon goes
  through ssh reverse forwards bound to `172.17.0.1`.
- gor does not reach gvidon; that direction is not required (gvidon→gor and
  gvidon→VPS links are enough for mesh gossip).
- The VPS has ~15 GiB RAM total and is shared with other stacks. At deploy time
  `deploy.sh` prints free RAM/disk; the container is capped at 2 GiB.
- `tunnels.sh up` re-pins the container's `known_hosts` from `ssh-keyscan` after
  the reverse forwards exist.
- `deploy.sh` uses the VPS `docker compose` project name `t3-mesh-e2e`; do not
  rename it to `t3-ws`.
