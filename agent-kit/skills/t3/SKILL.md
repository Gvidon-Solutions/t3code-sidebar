---
name: t3
description: "Control T3 Code projects, threads, sessions, workspaces, and linked machines. Use for starting threads with a requested harness or model, reading output, follow-ups, approvals, questions, forks, project placement, settings, and server operations. Resolve machine labels, tags, aliases and SSH destinations from the mesh."
---

# T3 Code control

Use the command covering the user's request. Read this skill once, resolve the target from data, and act within the user's authorization. Answer briefly in the user's language. Do not assume a machine, path, harness, model, workspace, or server topology.

Run `node ~/.agents/skills/t3/scripts/t3ctl.mjs` (Node 22+), or the installed `t3ctl` launcher. It uses the server's MCP and WebSocket RPC APIs. `t3ctl help` lists commands; `tools`, `schema <tool>`, and `tool <name> '<json>'` cover other MCP operations. Inspect a schema before using a generic tool or RPC command.

## Resolve the action and target

- `machines --json` reads the authoritative environment ids, layout labels, tags, user-defined aliases, SSH destinations and links. `mesh status` shows connectivity. Match names generically; never translate a customer's machine name using a built-in table.
- `machines alias <M> list|add <alias>…|remove <alias>…|clear` edits aliases in the shared layout. Settings › Mesh edits the same aliases. Aliases may use any language. Ask only when candidates are ambiguous.
- `projects` resolves projects; `find "…" --all` searches thread titles and content across machines. Preserve full returned thread ids and environment ids. Read a thread before reporting about it.
- A logical project has machine-local representations. Primaries own git; replicas are synchronized working copies. Before file operations, read `tool t3_project_machines '{"project":"<P>"}'` and choose the target representation's absolute path. In a replica, edit files there and run git, builds and tests at its primary using the configured SSH destination and primary path. Never initialize git in a replica.
- `new --project <P> --on <M> "brief"` places a missing replica, waits for registration, and launches there. `place <P> --on <M> [--wait]` only places a representation. No machine is tied to a particular harness: query its capabilities.
- With no explicit model or permissions override, `new` delegates defaults to the destination project's/server's settings. `models` lists provider instances and their catalog. Explicit CLI overrides: `T3CTL_AGENT`, `T3CTL_CODEX_MODEL`, `T3CTL_CLAUDE_MODEL`, `T3CTL_MODE`. A user-requested model must be available at the destination; report failure without substituting another provider.

## Common actions

| Request | Command |
| --- | --- |
| List work | `status [--all]`, `threads [--project P] [--all]` |
| Read a thread | `show <T> [--full]`, `output <T>`, `wait <T> [--timeout 5m]` |
| Start a thread | `new --project <P> [--on M] [--agent INSTANCE --model MODEL] [--file BRIEF] "task"` |
| Continue or fork | `send <T> "message" [--wait]`, `fork <T> [--title TITLE]`, `fork <T> --on <M> [--agent/--model/--effort]` to continue on another machine |
| Move on this machine | `move <T> --project P` |
| Handle a question | `requests <T>`, `answer <T> "answer"`, `approve <T> acceptForSession` |
| Stop requested work | `stop <T>` |
| Find/open | `find "words" --all`, `open <T>`, `open-file <path> [--on M]` |
| Project representations | `tool t3_project_machines '{"project":"<P>"}'`, `place <P> --on M [--wait]`, `replicas` |
| Read a file | `cat <absolute-path> --on M` |
| Organize | `rename <T> TITLE`, `pin/unpin <T>`, `settle/unsettle <T>`, `archive/unarchive <T>` |
| Projects | `project-add <path>`, `project-new <path>`, `project-clone <url> <path>`, `project-config <P>` |
| Workspaces | `ws`, `ws add NAME`, `ws assign <P> <W>`, `ws unassign <P>` |
| Machine aliases | `machines alias <M> list/add/remove/clear` |
| Settings | `settings get [dot.path]`, `settings set '{"key":value}'` |
| Health | `env`, `doctor`, `mesh status`, `server status` |

`<T>` is a full thread id, id prefix, or words from its title. `<P>` is a project name/id/path. `<M>` is an environment id/prefix, label, tag, user-defined alias or SSH destination. `--json` returns structured data. `help` describes additional options and commands.

## Working rules

1. Start a new top-level thread only when asked. Give its first message a complete brief: goal, target paths, constraints, acceptance criteria. Use `--file` for longer briefs. Use native orchestration tools for delegation; CLI thread creation is not delegation.
2. Opening a thread or file on the user's screen: use native `ui_open` with the full id and environment id. The CLI's `open` and `open-file` print links for outside clients.
3. Read output with `show <T>` / `output <T>`; answer questions and approvals with `requests`, `answer`, and `approve` within the user's authorization. Fork a session with `fork <T>`, preserving context; `fork <T> --on <M>` creates a new thread on another machine and leaves the original in place. Move a thread between projects on its own machine with `move <T> --project P`.
4. Permanent deletion, bulk mutations, link removal and live server restarts require explicit authorization. Preview a bulk operation before applying it. For a restart or upgrade, explain the target, purpose and rollback first; one approval covers one restart. Never stop unrelated threads or services.
5. Report issues and requested results through the native inbox tools from inside a T3 thread, so the calling thread receives replies. Check for an existing issue first, use a stable dedupe key, keep waitingForOwner accurate, and resolve only after verifying. The CLI inbox is a fallback for outside clients.
6. `t3_thread_self` / `t3ctl self` identifies the current thread and representation. `show`, `send`, `wait`, `stop`, `requests`, and `answer` resolve full thread ids across the mesh. Keep returned `mcp:…` identifiers intact.

## Configuration, installation and verification

Server connection overrides: `T3CODE_HOME`, `T3CTL_ORIGIN`, `T3CTL_UNIT`, `T3CTL_T3_BIN`; remote pairing uses `T3CTL_REMOTE_T3_BIN` and `T3CTL_REMOTE_HOME`. Discover the server identity with `env` and diagnose APIs/auth with `doctor`. Credentials are cached under the user's XDG configuration directory; never print them.

Customer-specific agent instructions and SSH routes belong in `global/GLOBAL.md` and `global/machines.json`, or a directory selected by `T3CTL_AGENTS_CONFIG`. The registry supplies ids, labels, tags, roles, harness files, per-source SSH destinations/options, optional relay ids (`via`), and an optional remote `nodeCommand`. It is installation data, not the runtime machine-name resolver. `agents sync` previews changes by default; `--apply` backs up and verifies writes. `agent-kit/install.sh --dest DIR` stages a skill only; `--to ID[,ID] [--apply]` installs using registry routes. Never install on a live machine without authorization.

`server install` requires `T3CTL_RELEASE_REPO=organization/repository`. Version installation does not authorize activating or restarting it. Use the printed backup to roll back an authorized activation.

Run `T3CTL_OFFLINE_ONLY=1 bash scripts/selftest.sh` for offline checks. Live checks require `T3CTL_ISOLATED_TEST=1` and an explicit `T3CTL_ORIGIN`; use a disposable server base directory and runtime. Full selftests require `T3CTL_SELFTEST_AGENT`, `T3CTL_SELFTEST_MODEL` and `T3CTL_SELFTEST_ALT_MODEL` from the test server's catalog. They can spend real model turns: run them only when that behavior is needed and authorized. Do not use a customer's live state for tests.

The mesh requires meshLayout, replicas, files and project placement APIs. Older servers fall back to legacy layout reads; placement and alias edits explain that a mesh build is required. Legacy layout migration is dry-run first, preserves offline keys, and backs up configs before applying. Never create or remove links or representations unless requested.
