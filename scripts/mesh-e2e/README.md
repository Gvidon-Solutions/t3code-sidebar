# Disposable mesh test bed

The Linux fixture uses three roles: nodeA (local server), nodeB (remote server) and
cloud (Docker container). Each has separate server state and a loopback port; defaults
are 3795, 3797 and 3791. None of the normal deployment or teardown paths operates a
customer's service, data directory or SSH authorization file.

Copy `local.env.example` to the gitignored `local.env`, then set the SSH configurations,
addresses, pinned cloud host keys, Node binary directories and remote fixture paths.
This is the only place for private infrastructure. Required values fail with `${VAR:?}`;
there are no private defaults. Never commit `local.env` or captured commands containing it.

Administrator access must already work with the configured SSH profiles. Provision tunnel
identities in the fixture's `STATE_DIR/ssh` (nodeB uses `NODE_B_STATE_DIR/ssh`). Scripts never
generate or remove keys in the account's real `.ssh`. Cloud host keys must already be pinned
in `CLOUD_KNOWN_HOSTS`; the harness does not trust a network key scan. Servers run with a
sandbox HOME and reconcile their own mesh keys and agent kit there.

```sh
scripts/mesh-e2e/build.sh <verified-ref>
scripts/mesh-e2e/deploy.sh
scripts/mesh-e2e/pair.sh
scripts/mesh-e2e/status.sh
scripts/mesh-e2e/teardown.sh
```

`build.sh` stages a runtime and Docker image; `deploy.sh` installs only the bed units and
container. `pair.sh` links those servers and configures the fixture routes. Acceptance scripts
exercise replication, files, networking and restart recovery using fixture projects.
Core acceptance expects seeded legacy snapshots at `STATE_DIR/legacy/studio.json` and
`cloudbox.json`: include one `main` workspace, an independent workspace and at least two
registered logical projects with placements. Its outside-project file cases require an explicit
`files: all` grant in the isolated bed config. A fresh profile does not inherit those fixtures.
Provision the container home for its image UID, use a private temporary directory for IPC,
and provide Node 26 at the configured remote binary directory before deployment.
Use a unique fixture prefix and acquire the shared bed lock through the configured nodeB SSH
profile before operating shared infrastructure; release it afterward. Keep other runs' data.
`network-acceptance.sh` derives a lock owner from `MESH_E2E_LOCK_OWNER` (default `mesh-network`)
and passes `MESH_E2E_CORE_NAME`, `MESH_E2E_CORE_SCRATCH`, `MESH_E2E_REPLICA_NAME`,
`MESH_E2E_DEMO_TITLE` and `MESH_E2E_ORPHAN_LABEL` to the acceptance scripts; it no longer rewrites
their text. Isolated daemons share `scripts/lib/managed-sshd.mjs` for their OpenSSH config.

Live unit names, port 3774 and normal T3 state directories are rejected before deployment.
`MESH_E2E_ALLOW_LIVE=1` is a separate explicit opt-in, never a deployment default or an
approval inferred from running an acceptance suite. It does not authorize an agent to bypass the owner's
restart rules. `teardown.sh --purge` removes only fixture state and owned keys, and keeps
administrator SSH configuration intact.

Run the local isolation checks without any infrastructure:

```sh
node --test scripts/mesh-e2e/isolation.node-test.mjs
```

## Fast acceptance and unattended nightly

Run `scripts/mesh-fast/run.sh` (or `pnpm mesh:fast`) for isolated acceptance.
See [the fast harness guide](../mesh-fast/README.md) for scenario coverage and artifacts.
Its agreed gate is six minutes on the configured builder; it never acquires the shared bed.

The realistic `acceptance.sh` retains full timers, native runtimes and real providers.
It acquires the bed lock, runs the acceptance suites plus the machine-name and fork beds and the realistic matrix.
The machine-name and fork entrypoints are committed as `machine-name-bed.sh` and `fork-bed.sh`.

Configure the worker host, controller address/port, provider binaries and legacy seed
filenames in ignored `local.env`. Run `install-nightly.sh` on the controller.
It installs a pinned private SSH controller and a systemd user timer on the configured
worker only; it checks the remote hostname before installing. Enable lingering on
that worker so it runs without a login. The controller checks its real user bus.

On the configured worker, enable with
`systemctl --user enable --now mesh-nightly.timer`, disable with
`systemctl --user disable --now mesh-nightly.timer`, and inspect with
`systemctl --user list-timers mesh-nightly.timer`. Results live below
`BED_NIGHTLY_ROOT/results`. Successful runs write a summary without posting.
Failures post one deduplicated attention issue using
`t3ctl inbox post attention … --key mesh-nightly`; notification errors fail the job.

Physical configuration and per-host operational evidence stay private.

For an existing bed, local.env also owns NODE_A_LOCAL, both runtime roots and
NODE_A_TUNNEL_UNIT/NODE_B_TUNNEL_UNIT. These overrides preserve already-provisioned
forwarding instead of selecting nonexistent default units. Keep the private
inventory in persistent storage; local.env may link to it. After merging, run the
installer from the permanent checkout before removing the temporary worktree.
