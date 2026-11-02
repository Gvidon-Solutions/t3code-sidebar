# Mesh E2E round 2 — xdev-g3

Final result: **round 1: 45 PASS / 0 FAIL; round 2: 98 PASS / 2 FAIL (exit 1)**.
Acceptance is **not fully green**: `t3ctl mesh status` omits the remote machine tags.
Product code and contracts were deliberately left unchanged. The three-machine
bed remains running. No push or PR.

Build tested: `0.1.5-mesh.25fcbc27502c`, source
`25fcbc27502cbc73903b64e8f590ea2193ea6512` (xdev and xdev-g3 agreed before this work).
All repository changes are test-bed scripts, evidence, README and FORK.md.
`git diff xdev -- apps packages` is empty.

| Environment          | ID                                   | Endpoint from gvidon   |
| -------------------- | ------------------------------------ | ---------------------- |
| GV, isolated gv test | 375bdc7e-f155-4b27-be6a-bcd165c9b0a8 | http://127.0.0.1:3795  |
| GR, gor              | 34e33796-4717-4293-a955-88c2f740db4d | http://127.0.0.1:13797 |
| VP, VPS container    | 8bd7a7df-310c-48e9-9be9-f65ccd6c05f4 | http://127.0.0.1:13791 |

Commits before the evidence commit: `d4b3ff106f` (safe deployment/helpers),
`d28bf81c76` (replica runner/routes). The evidence commit follows these on xdev-g3.

## Acceptance and proving tests

Every test below is in `round2.sh` unless identified as round 1. The evidence
file contains the final transcript and selected actual RPC/Mutagen/CLI outputs.

| Item                                  | Result               | Done, where and proving tests                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Build/deploy + round 1             | PASS                 | `build.sh` current-checkout mode; `deploy.sh` staged-skill destination. `round1.sh`: **45 PASS, 0 FAIL**, recorded in `round1.log`. The obsolete disabled-replica assertion now checks the real status stream from every node.                                                                                                                                                                                                       |
| 2. Settings-model SSH routes          | PASS                 | `round2-routes.sh` prepares restricted container SSH/SFTP; `routes` applies `machine/*` through `meshLayout.apply`, `routes converge` checks all materializations. `route-gv-gor`, `route-vps-gor`, `route-vps-gv`, `route-gor-vps` execute SSH through those saved destinations.                                                                                                                                                    |
| 3a. MCP launch + self-install + edit  | PASS                 | `installer-disable/clean` moves only the VPS test server's bin aside and asserts Mutagen absent; settings use empty mutagenPath. `a-mcp-launch` calls actual `t3_thread_launch` at gor with the VPS environmentId. `a-watching`, `a-machines`, `a-installer`, `a-excludes`, `a-agent-edit` prove registration, pinned 0.18.1 under the private base directory, no .git/node_modules, and the VPS agent's README marker reaching gor. |
| 3b. t3ctl-next launch                 | PASS                 | `b-cli-launch`: staged CLI, `new --project demo --on vps --agent codex --model gpt-6-luna`; `b-agent-edit` checks its distinct marker on gor.                                                                                                                                                                                                                                                                                        |
| 3c. VPS primary → gv replica          | PASS                 | `c-vps-source/register/place/watching/files`: real VPS git directory with node_modules; placement by MCP, registered GV working copy, README content and both exclusions checked on disk.                                                                                                                                                                                                                                            |
| 3d. Two primaries, one sidebar group  | PASS                 | `d-checkout` uses pinned gor SSH config to clone an independent checkout on gv; `d-place` registers it as primary. `d-grouping` imports the real client-runtime `resolveLogicalProjectKey` and `buildProjectGroups`, asserts three projectIds, two primaries, one group and three members against the materialized layout.                                                                                                           |
| 3e. Conflict and resolution           | PASS                 | `e-pause/alpha/beta/resume` edit one path differently; `e-conflict/path` checks live conflict and round2-conflict.txt; `e-resolve/retry/recovered/flush/content` deletes beta's version, retries, checks watching and exact alpha content.                                                                                                                                                                                           |
| 3f. Idempotency + mid-mount restart   | PASS                 | `f-transfer-fixture` puts 128 MiB on source; `f-mid-mount` records mounting, then restarts only the VPS test container. MCP launch waits through recovery. `f-place-1/2`, `f-launch-1/2`, `f-one-launch`, `f-one-session`, `f-one-project` assert same threadId, exactly one labelled session and project at that path. A second restart is checked by `f-health/recovered`.                                                         |
| 3g. Remove and orphan                 | PASS                 | `g-remove/terminated/files-kept/project-kept` prove termination with retained files and project. `g-orphan-create/reported/list/kept` create an actual labelled local Mutagen session, observe orphan status and prove that exact named session remains. Re-runs reuse the orphan.                                                                                                                                                   |
| 3h. Files and CLI discovery           | **FAIL (tags only)** | All three `h-cat/open/open-target/cat-content` pass, as do find/status/machines and their three tag assertions. `h-mesh` returns all three representations but `h-mesh-tag-GV` and `h-mesh-tag-VP` fail.                                                                                                                                                                                                                             |
| 3i. Provider prompt note              | PASS                 | `i-prompt` selects the actual Codex session transcript containing this run's unique a-marker and requires “Run git and builds on the primary”. This is provider input, not a reconstructed note.                                                                                                                                                                                                                                     |
| 4. Re-runnable runner + log + commits | DONE                 | `round2.sh` reuses round 1's WS/auth/snapshot helpers via helpers-only mode, keeps per-check timings and outputs, and exits nonzero on any assertion failure. `round2.log`, `round2-evidence.log`, this report and FORK.md feature-log entry are committed.                                                                                                                                                                          |

## Recorded timings

Every assertion timing is in `round2.log`; selected milestones:

| Proving test | Observed time                       |
| ------------ | ----------------------------------- |
| a-mcp-launch | 38420ms including mid-mount restart |
| a-agent-edit | 4731ms                              |
| b-cli-launch | 2843ms                              |
| b-agent-edit | 4737ms                              |
| c-place      | 656ms                               |
| c-watching   | 176ms                               |
| d-grouping   | 737ms                               |
| e-conflict   | 31553ms                             |
| e-recovered  | 756ms                               |
| f-recovered  | 31342ms                             |
| g-terminated | 1183ms                              |

## Remaining failure: exact reproduction and cause

From this checkout, with the bed running:

```bash
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
export XDG_CONFIG_HOME=/tmp/t3-mesh-e2e-round2-proof/auth-gor
export T3CODE_HOME=/home/user/.t3-sidebar-server
export T3CTL_ORIGIN=http://127.0.0.1:13797
export T3CTL_T3_BIN=/tmp/t3-mesh-e2e-round2-proof/t3-gor
node ~/.agents/skills/t3-next/scripts/t3ctl.mjs machines
node ~/.agents/skills/t3-next/scripts/t3ctl.mjs mesh status
```

`machines` prints GV, GR and VP. `mesh status` prints only GR in its header;
peer lines use raw link labels and representation lines use environment-id
prefixes. Thus `grep -w GV` and `grep -w VP` against that output exit 1. The
same assertions fail on consecutive full real-bed runs. Exact output is in
`round2-evidence.log`.

Suspected cause, confirmed by source inspection: staged
`~/.agents/skills/t3-next/scripts/t3ctl.mjs:2174-2190` formats the local tag but
formats links using `link.label` and representations using
`row.rep.environmentId.slice(0, 8)`, without looking up remote machine tags.
No CLI/product fix was made because the task explicitly forbids product changes.

## Exact reproduction from a deployment

```bash
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
MESH_E2E_BUILD_CURRENT=1 scripts/mesh-e2e/up.sh xdev
scripts/mesh-e2e/round1.sh
MESH_E2E_ROUND2_WORK=/tmp/t3-mesh-e2e-round2-proof scripts/mesh-e2e/round2.sh
```

Expected current result: round 1 exits 0; round 2 exits 1 for the two remote-tag
assertions. The runner never accepts those failures as success.

Round 1 uses the chain gv→gor→VPS without a direct gv↔VPS link. Round 2 adds a
full-access gor→gv link through a separate test tunnel (`gor :13795` → VPS reverse
forward → gv :3795). This is necessary for CLI fan-out from gor. The layout
holds all four required SSH routes. VPS SSH keys are restricted to shell/SFTP
inside `t3-mesh-e2e`; they cannot run commands on the VPS host.

The test fixture copies an existing Codex auth file into the isolated VPS HOME
only when it is absent; it never logs credentials. It uses two cheap Luna turns
per run. To make the file-edit assertion deterministic the brief explicitly asks
for a local shell edit in the replica and forbids requesting a primary link.

## Verification commands

Every shell starts with the PATH export shown above.

- `./node_modules/.bin/vp fmt`: exit 0; exact final summary in `round2-validation.log`.
- `./node_modules/.bin/vp lint`: exit 0, zero errors; six inherited warnings.
- `(cd packages/contracts && pnpm -s typecheck)`: exit 0, `$ tsc --noEmit`.
- `(cd packages/shared && pnpm -s typecheck)`: exit 0, `$ tsc --noEmit`.
- `(cd packages/client-runtime && pnpm -s typecheck)`: exit 0, `$ tsc --noEmit`.
- `(cd apps/server && pnpm -s typecheck)`: exit 0, `$ tsc --noEmit`.
- `(cd apps/mobile && pnpm -s typecheck)`: exit 0, `$ tsc --noEmit`.
- `(cd apps/web && pnpm -s typecheck)`: exit 1, `Command "typecheck" not found`.
  Exactly the same command from `/home/user/Repos/t3/t3code-xdev/apps/web`
  gives the same error. Web defines a Vite+ task instead of a package script:
  `(cd apps/web && ../../node_modules/.bin/vp run typecheck)` exits 0,
  `~/apps/web$ tsc --noEmit`.
- `./node_modules/.bin/vp run knip:check`: exit 1, `Unused exports (48)`.
  Same command on `/home/user/Repos/t3/t3code-xdev`: exit 1,
  `Unused exports (48)`. No new unused files, dependencies or export names.
  The temporary separate grouping executable was folded into the shell runner,
  so it introduces no unused-file finding.
- `T3CTL_OFFLINE_ONLY=1 bash ~/.agents/skills/t3-next/scripts/selftest.sh`:
  two complete offline suites, **7 tests passed + 12 tests passed**, zero failed,
  cancelled, skipped or todo.
- `bash -n scripts/mesh-e2e/*.sh`: exit 0.
- `git diff --check`: exit 0.

No product package was touched; therefore no product package suite is claimed
as run. The full suites owned by this change are the real-bed round 1 and round 2
runners; their final assertion counts and representative outputs are retained.
Typechecks are not described as tests. No skips/stubs/TODOs were added.

## Earlier iteration failures and their disposition

These are not hidden as passes; the final runner includes their corrections.

| Failure / exact trigger                                                        | Cause and disposition                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP `t3_project_list {"limit":200}`; dependent f/g project checks              | Harness used an out-of-schema limit. Corrected to 100.                                                                                                                                                                                                                                           |
| First agent turn: 401 Missing bearer authentication                            | Container lacked a Codex auth fixture. Added isolated credential provisioning; subsequent real turns edit and sync.                                                                                                                                                                              |
| Reverse placement: `unable to run SCP process: Connection closed`              | Container-only forced SSH command did not yet support SFTP. Added restricted SFTP forwarding and extracted the Debian sftp-server binary after package SHA256 verification. Default apt sandbox cannot setuid with cap_drop ALL; provisioning uses a root sandbox and extracts only that binary. |
| `git clone gor:/home/user/xdev-e2e/demo …`                                     | `gor` is defined in the pinned gor-transfer config, not the default SSH config. Checkout fixture now supplies that config/key explicitly. Settings reach uses a usable LAN destination plus identityFile.                                                                                        |
| place immediately after e-recovered: “Replica is conflict”                     | Local driver's watching state had not yet gossiped to gor. Wait for all three materializations to converge before testing placement idempotency.                                                                                                                                                 |
| `cat` from gor to gv: “environment is not linked”                              | Round 1 intentionally had only gv→gor and gor→VPS edges. Added a normal full-access gor→gv peer link over the isolated test tunnel.                                                                                                                                                              |
| Generic edit brief: agent completed without editing, requesting a primary link | Luna chose a remote workflow instead of local editing. Final test brief specifies a local replica edit, preserving the required real agent turn and primary git/build note. This is not a claim that every vague brief works.                                                                    |
| Intermediate d-grouping MODULE_NOT_FOUND                                       | Runner was changed while an older invocation still referenced its separate grouping file. Final grouping code is inline, imports the actual client-runtime functions, and runs successfully in subsequent full invocations.                                                                      |
| Intermediate e-conflict-path printed true then false                           | jq selected both the managed session and the retained orphan. Assertion now scopes to this logicalKey/environmentId; the real conflict path passes.                                                                                                                                              |

## Operational boundaries and retained fixtures

No live gvidon or Operalia server restart, update, stop, settings write or project
mutation was performed. The inherited initial `up.sh → status.sh` did issue one
read-only descriptor request to live gvidon through gor's :13773; this was noticed,
reported during the work and removed from status.sh. Operalia was not contacted.
Owner-inbox reporting is separate from the test operations.

The installed `~/.agents/skills/t3` was not written. Deployment now copies the
staged skill verbatim to gor's `t3-next` and does not patch its version list.
The build used this checkout directly and did not switch/clean another worktree.
Baseline checks on the explicitly named xdev checkout were read-only code checks.

Retained: all three servers and test tunnels, gor demo with unique README markers,
VPS primary and its gv replica, independent gv primary, preserved VPS demo copies
and project registrations, one reported orphan session, private Mutagen state,
installer-bin backups and isolated Codex auth. No daemon/session from the owner's
normal Mutagen directory was used. The demo's current VPS replica representation
is removed by g; files and projects intentionally remain.
