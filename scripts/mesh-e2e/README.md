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
container. `pair.sh` links those servers and configures the fixture routes. Round scripts
exercise replication, files, networking and restart recovery using fixture projects.
Round one expects seeded legacy snapshots at `STATE_DIR/legacy/studio.json` and
`cloudbox.json`: include one `main` workspace, an independent workspace and at least two
registered logical projects with placements. Its outside-project file cases require an explicit
`files: all` grant in the isolated bed config. A fresh profile does not inherit those fixtures.
Provision the container home for its image UID, use a private temporary directory for IPC,
and provide Node 26 at the configured remote binary directory before deployment.
Use a unique stage prefix and acquire the shared bed lock through the configured nodeB SSH
profile before operating shared infrastructure; release it afterward. Keep other stages' data.

Live unit names, port 3774 and normal T3 state directories are rejected before deployment.
`MESH_E2E_ALLOW_LIVE=1` is a separate explicit opt-in, never a deployment default or an
approval inferred from running a round. It does not authorize an agent to bypass the owner's
restart rules. `teardown.sh --purge` removes only fixture state and owned keys, and keeps
administrator SSH configuration intact.

Run the local isolation checks without any infrastructure:

```sh
node --test scripts/mesh-e2e/isolation.node-test.mjs
```
