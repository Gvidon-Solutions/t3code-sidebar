# Agent kit

Everything the owner's agents use to work with T3 and the mesh, versioned with the fork:

- `skills/t3/` — the `t3` skill: `SKILL.md`, `scripts/t3ctl.mjs` (CLI over T3's MCP and WS RPC),
  `scripts/agents-sync.mjs`, tests (`scripts/*.test.mjs`, `selftest.sh`, `shared-parity.test.mjs`).
- `skills/t3/global/GLOBAL.md` — the owner's canonical agent instructions (Russian, his voice);
  `global/machines.json` — machines, roles, SSH routes, harness files.
- `install.sh` — installs the skill and renders the instructions onto every machine.

How the mesh works and how to change any of this: `docs/mesh/README.md`.
