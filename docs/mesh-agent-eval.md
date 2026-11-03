# Stage J — agent instructions and behaviour eval

Date: 2026-11-03. Branch: xdev-j. Implementation commit: bdab71bc46.

Part 1 implemented and applied only to gor. Part 2 is **blocked, not passed**: all 16 Codex runs failed before model tools with `workspace routing discovery failed`; all eight DeepSeek launch attempts were rejected because OpenCode is disabled for demo. No evidence supports changing the owner's instructions, so GLOBAL.md is unchanged. There is no successful after result.

## Scope and installation

- Canonical body SHA-256: `3b3855c24f8c1e6193dacd47bdfbf14b26cf19b54927e1ee40e30af39a2d781d`. Both repo copies and staged/deployed skill bodies match /tmp/GLOBAL.md byte for byte.
- Staged source: `~/.agents/skills/t3-next`; review copy: `docs/skill-t3-next`. No writes to gvidon's installed t3 skill or global harness files.
- Gor installed skill backed up to `~/.agents/skills/t3.before-stage-j-20261103`, then staged skill copied to gor's t3-next and t3 using SCP/tar. No runtime redeploy or T3 restart. Gor's existing xdev server already reports database migration 77 and meshLayout/replicas capabilities.
- Applied `node ~/.agents/skills/t3-next/scripts/t3ctl.mjs agents sync --to gor --apply` after dry-run diff. Backups: gor `~/.local/state/t3-agents-sync/2026-11-03T08-45-54-386Z-746378/`, preserving old .claude/CLAUDE.md and .codex/AGENTS.md. Final status: both in sync; OpenCode harness directory absent. Backups retained.
- machines.json declares machine identity, role, harness file candidates and SSH destinations/options per source. Each target probes its installed harness directories and skips absent ones. Operalia → gor uses gvidon as the SSH intermediary. Gvidon/Operalia sync was not applied or read remotely.
- No changes to CRDT, logical project helpers, RPC contracts, or MeshLayoutService. Formatter ignores only the two canonical Markdown bodies to preserve the owner's bytes.

## Bed and provider diagnostics

Only bed origins 13797 (gor), 13795 (isolated GV), 13791 (VPS container) were used. Live gvidon :3774 and Operalia were not accessed. Gor bed tags are GR/GV/VP; the canonical physical-machine header retains GOR as supplied by the coordinator. Demo already had primary representations on gor and GV. The seed launch below created the VPS replica and an idle mount thread before the matrix.

Mount seed: [mount — Stage J seed](t3-thread://v2/8bd7a7df-310c-48e9-9be9-f65ccd6c05f4/mcp:fc221127-ae2b-466d-96ec-ad7e03ff858a). It has no message and spends no agent turn.

Codex CLI 0.160.1 reported no reachable daemon control socket. Started the existing installed daemon on gor with `codex app-server daemon start` (PID 3373699; managed version 0.162.1). This did not fix the routing error. Its stderr separately records token refresh HTTP 403 `unsupported_country_region_territory`. These observations do not prove that auth is the sole cause of the routing failure. No credentials were copied or changed, and no network restriction was bypassed.

An initial Sol request 6 and a Luna request 6 also failed with the same routing error; the full matrix below consists of fresh threads after the daemon start and skill deployment. OpenCode is unavailable: CLI model validation reports no models, and direct t3_thread_launch returns `Provider instance "opencode" is disabled for project …`. No substitute model was used.

## Requests and expected first domain action

Reading the applicable t3 skill and resolving machine/project names count as legitimate setup. Workspace preparation is server activity, not a model tool call.

| #   | Exact owner request                                              | Expected action / verification                                           |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | создай тред в проекте demo на впс, пусть допишет строку в README | new --project demo --on vps; verify appended README on primary           |
| 2   | открой тред про маунт                                            | find mount --all (маунт → mount), then open remote thread                |
| 3   | покажи README из demo на гвидоне                                 | resolve demo representation; cat/open-file README --on gvidon            |
| 4   | сделай demo репликой на гвидоне                                  | place demo --on gvidon; verify replica role and watching                 |
| 5   | что сейчас работает на всех машинах                              | status --all                                                             |
| 6   | какие у меня машины                                              | machines / mesh status                                                   |
| 7   | найди тред про конфликт на всех машинах                          | find конфликт --all; include all machines                                |
| 8   | в реплике demo на впс закоммить изменения                        | project machines; ssh to its primary; git commit there, never on replica |

## Before/after matrix

First-tool latency is N/A because no model tool call occurred. Total is completedAt − requestedAt from t3ctl show --activity --full --json, including provider startup/retries. Tool order is empty for every Codex run; their only command_execution item is server "Workspace ready". Tokens are unavailable in these activity responses. "Blocked" is not a correct outcome or a wording failure. No model confusion can be observed before inference.

| Model         | Request | Thread                                                                                                        | First tool | Total (s) | Tools in order | First action right? | Outcome before                 | Outcome after                  | Tokens |
| ------------- | ------: | ------------------------------------------------------------------------------------------------------------- | ---------- | --------: | -------------- | ------------------- | ------------------------------ | ------------------------------ | ------ |
| gpt-6.1-sol   |       1 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3A60c00874-9b27-47b8-b24b-e2697d39bfcb) | N/A        |    63.971 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6.1-sol   |       2 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3A5294f179-f8a1-4131-b4ad-42cb07bce9b8) | N/A        |    65.640 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6.1-sol   |       3 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3Ada4f179e-c6d2-42dc-bf2a-0065a3a84831) | N/A        |    66.160 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6.1-sol   |       4 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3A9a776e62-ee45-4219-aad1-507b60189121) | N/A        |    67.528 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6.1-sol   |       5 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3A82197ab4-ee86-48ac-b4d7-43b257b05cae) | N/A        |    68.587 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6.1-sol   |       6 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3Af2e43962-c9d6-4797-abca-e0cfa9a8fbcb) | N/A        |    69.757 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6.1-sol   |       7 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3A7c5c7586-f262-4e71-ae6f-ef8900dd0579) | N/A        |    71.096 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6.1-sol   |       8 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3A4401b028-0cd9-4585-a55e-3e8383ebfcb2) | N/A        |    71.349 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6-luna    |       1 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3Aa4561dce-ccc3-4a93-b073-91f1cbb47d19) | N/A        |    71.968 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6-luna    |       2 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3A294a913a-e981-4bee-9526-25d2007d38b0) | N/A        |    72.622 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6-luna    |       3 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3A13283193-5b15-4081-ba3e-ee1df668710c) | N/A        |    73.290 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6-luna    |       4 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3Abc4c874d-ecc3-4c02-a8ca-d3d67ac814f7) | N/A        |    73.675 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6-luna    |       5 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3Ad8f7b220-6686-406d-ac92-aa40bc6c7627) | N/A        |    74.860 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6-luna    |       6 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3Afb278210-38d1-46ac-81c8-96a66010e742) | N/A        |    74.718 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6-luna    |       7 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3A22f63cc1-7ab4-4488-bc5f-ed38e74be3e9) | N/A        |    75.014 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| gpt-6-luna    |       8 | [run](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3Ac46809ff-b601-45bb-8475-efe16fe81ecb) | N/A        |    75.232 | none           | unobserved          | blocked: routing error         | not run; same provider blocker | N/A    |
| DeepSeek 1017 |       1 | launch rejected (no thread created)                                                                           | N/A        |       N/A | none           | unobserved          | unavailable: provider disabled | unavailable                    | N/A    |
| DeepSeek 1017 |       2 | launch rejected (no thread created)                                                                           | N/A        |       N/A | none           | unobserved          | unavailable: provider disabled | unavailable                    | N/A    |
| DeepSeek 1017 |       3 | launch rejected (no thread created)                                                                           | N/A        |       N/A | none           | unobserved          | unavailable: provider disabled | unavailable                    | N/A    |
| DeepSeek 1017 |       4 | launch rejected (no thread created)                                                                           | N/A        |       N/A | none           | unobserved          | unavailable: provider disabled | unavailable                    | N/A    |
| DeepSeek 1017 |       5 | launch rejected (no thread created)                                                                           | N/A        |       N/A | none           | unobserved          | unavailable: provider disabled | unavailable                    | N/A    |
| DeepSeek 1017 |       6 | launch rejected (no thread created)                                                                           | N/A        |       N/A | none           | unobserved          | unavailable: provider disabled | unavailable                    | N/A    |
| DeepSeek 1017 |       7 | launch rejected (no thread created)                                                                           | N/A        |       N/A | none           | unobserved          | unavailable: provider disabled | unavailable                    | N/A    |
| DeepSeek 1017 |       8 | launch rejected (no thread created)                                                                           | N/A        |       N/A | none           | unobserved          | unavailable: provider disabled | unavailable                    | N/A    |

Raw launch and activity evidence remains in `/tmp/stage-j-eval/`; the table retains durable thread links. Collected with `t3ctl show <threadId> --activity --full --json` against gor. No README edits, UI opens, replica placement by an evaluated agent, cross-machine searches, or primary commits happened: those outcomes cannot be verified or marked passed. The only placement was the evaluator's mount seed. GLOBAL.md wording changes: none. Skill wording changes: the requested sync/status row and canonical-source line only; other diff is formatting. Re-running model failures against identical unavailable providers cannot measure wording improvements.

## Acceptance accounting

| Acceptance item                                                         | Status and location                                                  | Proving test/evidence                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Unchanged canonical body in staged skill and repo                       | done: global/GLOBAL.md, docs/agents-global/GLOBAL.md                 | canonical SHA-256 test and cmp against /tmp/GLOBAL.md                                        |
| Machine metadata and header plus canonical body                         | done: global/machines.json, agents-sync.mjs                          | render preserves entire body test; SSH transport test                                        |
| Local/SSH sync, targets, dry-run unified diff                           | done: agents-sync.mjs and t3ctl agents dispatch                      | diff tests, read non-mutation test, SSH sync test (including unknown target rejection)       |
| Installed harness detection                                             | done: targetOperation                                                | absent OpenCode directory assertion; actual gor status                                       |
| Backup before write and verification; backups retained                  | done: targetOperation, gor backup directory above                    | backup/write/idempotence and collision-refusal tests; actual SSH apply and subsequent status |
| Per-file missing/differs/in-sync status                                 | done: agents status                                                  | target read test exercises all states; gor status verifies final files                       |
| Skill row, Mesh line, offline selftest                                  | done: SKILL.md, scripts/selftest.sh                                  | offline selftest: 7 + 12 + 6 passing tests                                                   |
| Apply only to gor, deploy staged skill there                            | done                                                                 | actual gor SHA-256 + agents status transcript above; no other apply run                      |
| New-thread matrix with exact requests and requested models              | partially done: 16 new Codex threads; eight OpenCode launch attempts | durable links above; provider rejection evidence, not behaviour passes                       |
| VPS mount seed                                                          | done                                                                 | seed link above; remote new created registered representation                                |
| Timings, tool sequence, outcomes, tokens, confusion per run             | done for available telemetry                                         | activity-derived table; N/A explicitly distinguished from zero                               |
| All Sol/Luna cases pass and rerun failing behaviour after wording fixes | **not done: provider blocked before inference**                      | 16 failed runs; no proving behaviour test                                                    |
| DeepSeek cases pass when available                                      | unavailable; provider disabled, no installed harness                 | model discovery and eight explicit launch rejections                                         |
| Repo copies, FORK entry, logical commits                                | done                                                                 | docs/skill-t3-next, docs/agents-global, this report; FORK.md stage entry                     |
| CRDT/contracts remain unchanged                                         | done                                                                 | git diff scope; existing shared parity tests 2/2                                             |

## Verification commands and exact summaries

Every shell used `export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH`. No package source was changed. The complete standalone skill suite is the touched code's test suite; app package tests were not substituted for behaviour evals.

`./node_modules/.bin/vp fmt`: exit 0; `Finished in 6422ms on 6763 files using 128 threads.` (run before this report; final formatting also run after it).

`./node_modules/.bin/vp lint`: exit 0, **0 errors**, six pre-existing warnings.

`T3CTL_OFFLINE_ONLY=1 bash docs/skill-t3-next/scripts/selftest.sh`:

```text
unit:        ℹ tests 7   ℹ pass 7   ℹ fail 0
integration: ℹ tests 12  ℹ pass 12  ℹ fail 0
agent sync:  ℹ tests 6   ℹ pass 6   ℹ fail 0
```

`node --test docs/skill-t3-next/shared-parity.test.mjs`: `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0`. Total standalone tests: 27 passed, zero failed/skipped/todo.

Requested per-package commands (all from xdev-j):

```sh
(cd packages/contracts && pnpm -s typecheck)       # exit 0, no output
(cd packages/shared && pnpm -s typecheck)          # exit 0, no output
(cd packages/client-runtime && pnpm -s typecheck)  # exit 0, no output
(cd apps/server && pnpm -s typecheck)              # exit 0, no output
(cd apps/web && pnpm -s typecheck)                 # exit 1: script does not exist
(cd apps/mobile && pnpm -s typecheck)              # exit 0, no output
(cd apps/web && pnpm exec vp run typecheck)        # exit 0: ~/apps/web$ tsc --noEmit
```

Proved baseline with the exact requested command in `/home/user/Repos/t3/t3code-xdev/apps/web`: same exit 1 and same final output as xdev-j:

```text
Error: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL
  × Command "typecheck" not found
```

`./node_modules/.bin/vp run knip:check` on both xdev-j and baseline `/home/user/Repos/t3/t3code-xdev`: exit 1; `Unused exports (48)`; `vp run: 1/2 successful. (Run vp run --last-details for full details)`. The complete findings sections compare identically with `diff -u <(sed -n '/Unused exports/,$p' /tmp/j-baseline-knip.log) <(sed -n '/Unused exports/,$p' /tmp/j-knip.log)` (exit 0). No new findings. Logs are `/tmp/j-{fmt-final,lint-final,selftest-final,parity-final,knip,baseline-knip,typecheck-results}.log` (typecheck-results has no .log suffix).

No push, PR, or live-server inbox post was made. The owner's explicit prohibition on touching live gvidon/Operalia takes precedence over posting the report to their live inbox. To complete Stage J, the gor Codex routing/auth failure must be repaired, then the exact matrix rerun and actual bed outcomes checked.
