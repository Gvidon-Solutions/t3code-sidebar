# Stage F: `t3ctl` mesh changes — review summary

The skill lives outside the repo at `~/.agents/skills/t3`. This stage works in a copy,
`~/.agents/skills/t3-next`; `SKILL.md`, `scripts/t3ctl.mjs`, `scripts/selftest.sh` and the new
`scripts/t3ctl.unit.test.mjs` here are that copy for review. The coordinator swaps it in after
review.

## What the script now does

Everything still goes through the server's own MCP (`/mcp`) and WebSocket RPC (`/ws`) APIs; no
sqlite and no new server contracts. New commands:

| Command                                                                       | Calls                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machines [--json] [--probe]`                                                 | `t3_environment_read`, `meshLayout.get` (fallback `server.getConfig`), `peerLinks.list`, layout `projectMounts`; probes reachable links with `t3_environment_read` (`environmentId`)                                                                                                        |
| `mesh status [--json]`                                                        | the same plus `replicas.status` (first stream value) and settings (`linkedEnvironmentsEnabled`, `meshEnabled`, `replicasEnabled`)                                                                                                                                                           |
| `mesh link <M> [--url URL] [--ssh DEST] [--access …]`                         | mints `t3 auth pairing create --json` on the target over ssh (`~/.local/bin/t3`, overridable), then `peerLinks.link` with full access and `expectedEnvironmentId`/`expectedLabel`                                                                                                           |
| `mesh unlink <M> --yes`                                                       | `peerLinks.list`, `peerLinks.unlink`                                                                                                                                                                                                                                                        |
| `place <P> --on <M> [--primary] [--source <M2>] [--path PATH] [--wait [dur]]` | `t3_project_place` (`wait` capped at 600 s)                                                                                                                                                                                                                                                 |
| `unplace <P> --on <M> --yes`                                                  | `t3_project_place` with `action: "remove"`                                                                                                                                                                                                                                                  |
| `replicas [--json]`                                                           | `meshLayout.get` + `replicas.status`, merged per (logicalKey, environmentId)                                                                                                                                                                                                                |
| `replica retry <P> --on <M>`                                                  | `replicas.retry` with the representation's logical key                                                                                                                                                                                                                                      |
| `new … --on <M>`                                                              | `t3_project_place` first when the tool exists (wait 600 s), then `t3_thread_launch` with `environmentId` and the remote `projectId`                                                                                                                                                         |
| `find "words" [--all\|--on M]`                                                | tries `t3_thread_search` with `environmentId: "all"`, falls back to one call per linked machine; tags in the output                                                                                                                                                                         |
| `threads --all`, `status --all`                                               | `t3_project_list` + `t3_thread_list` (and `t3_thread_read` for pending requests) per machine                                                                                                                                                                                                |
| `open <T> [--on M]`                                                           | resolves the thread across machines, tries `ui_open` with `target.thread.environmentId`, prints the web URL and `t3-thread://v2/…` link                                                                                                                                                     |
| `open-file <path> [--on M] [--line N]`                                        | prints `t3-file://<envId>/<encoded path>` and tries `ui_open` file target                                                                                                                                                                                                                   |
| `cat <path> [--on M]`                                                         | `files.read` with `environmentId` (preview note on stderr when truncated)                                                                                                                                                                                                                   |
| `layout get [--json]`                                                         | `meshLayout.get`, or the legacy `sidebarWorkspaces` config with a marker                                                                                                                                                                                                                    |
| `layout merge --from <M[,M]> [--dry-run\|--apply]`                            | reads each machine's `layout get --json`, else `settings get sidebarWorkspaces` over ssh; writes JSON backups under `~/.local/state/t3-mesh-migrate/`; legacy configs become zero-HLC entries so `MeshLayoutService.persist` runs the shared `adoptLegacy`; applies with `meshLayout.apply` |

`doctor` gains a `mesh` line (layout RPC or legacy, links/reachable), `mesh tools` and `mesh flags`
lines. Existing commands are unchanged in behaviour; `new` only changes when `--on` is present.

## Machine resolver

`resolveMachineRef` matches, case-insensitively and punctuation-insensitively:

1. full environment id, then an id prefix (`>= 4` chars) or its short form;
2. layout `label`, `tag`, link label, server label, ssh alias (from `machine/<local>.reach[<target>].ssh`
   or the local server's outbound `reach` entry), then partial matches;
3. a small Russian alias table (`гвидон`, `гора`/`горе`, `опералия`, `оп`) plus a simple
   transliteration of any input; prefixes like `на` / `on` / `machine` are stripped.

Ties fail loudly with the candidates. The same resolver backs every `--on` and positional machine
argument (`mesh link/unlink`, `place`, `unplace`, `replica retry`, `open`, `open-file`, `cat`,
`find`, `layout merge --from`).

## Argument parsing

- New boolean flags: `--all`, `--primary`, `--dry-run`, `--apply`, `--probe`, `--raw`.
- `--from` repeats and also accepts a comma-separated list.
- `--wait` is still boolean for `new`, but also accepts a bare number or duration (`--wait 90`,
  `--wait 2m`); a following message word does not get eaten.

## Tests

- `scripts/t3ctl.unit.test.mjs` (`node --test`): argument parsing, resolver (ids, prefixes, labels,
  tags, ssh aliases, Russian forms, ambiguity), the legacy encoder against a fixture generated from
  `@t3tools/shared/meshLayout`'s `encode`, zero-clock entries, and every argument/deep-link builder.
- `scripts/selftest.sh` runs the unit file first (no server needed), with `T3CTL_OFFLINE_ONLY=1` it stops there. `T3CTL_FULL_SELFTEST=1` runs the existing server
  regression suite (cheap Codex turns); with `T3CTL_MESH_E2E=1` adds read-only mesh checks against `T3CTL_ORIGIN`
  (`127.0.0.1:13795/13797/13791`); an allowlist is checked before authentication or writes, accepting only those three test-bed origins. Set
  `T3CODE_HOME`/`T3CTL_T3_BIN` for the isolated gvidon server so t3ctl can mint its token there.
- A full local diff is available with
  `diff -u ~/.agents/skills/t3/scripts/t3ctl.mjs ~/.agents/skills/t3-next/scripts/t3ctl.mjs`;
  `scripts/t3ctl.mjs` here is the complete new file, directly runnable with Node.

## Deliberate limits

- `ui_open` acts as the calling T3 thread, so an outside MCP client (`t3ctl`) cannot drive the
  owner's screen with it. `open` / `open-file` therefore always print the usable web /
  `t3-thread://` / `t3-file://` link and report the `ui_open` reason; an agent inside a thread
  still calls `ui_open` directly.
- Archived threads stay per machine (`threads --all` lists active threads).
- Mesh mutation commands depend on the server build that carries `t3_project_place`,
  `replicas.*` and `meshLayout`; older servers are detected and reported instead of faked.

The review copy includes executable scripts and transport integration tests. Run `node --test docs/skill-t3-next/scripts/t3ctl*.test.mjs docs/skill-t3-next/shared-parity.test.mjs` from the worktree. The parity test imports the real shared CRDT core: it checks encoding, HLC validation and same-name adoption with offline project keys. CLI tests cover calls, ordering, destination environment, guards and search fallback.

Corrections made during verification: valid zero HLC separator, target-side home expansion, retry on the session driver (SSH RPC when remote), remote wait/history routing, backups of destination and sources with unique names, and compatibility with both consolidated and legacy pending-request tools. Unknown machines can be discovered over SSH during linking. Existing legacy sync helper is included; its unused variable and import/comment style were cleaned for repository lint. No contracts or server interfaces changed.
