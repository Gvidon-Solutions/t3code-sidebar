# Stage J — repeat with general instructions

**24/24 selected requested effects verified: Sol 8/8, Luna 8/8, 1017 8/8.** This rerun uses the coordinator's compact rewrite (f5b5f66477), plus general rules for execution location, absolute paths, CLI defaults, API recovery and opaque identifiers. No phrase-specific recipe or server-specific workaround was added to the instructions. The evaluated SKILL.md is **24745 bytes**, under 26,000.

[Complete new table data and ordered native calls](mesh-agent-eval-general.json) includes all 81 attempts, provider errors, fixture-invalid runs and selected rows. The [previous overfitted experiment](mesh-agent-eval.json) is historical and is not evidence for this result. “Pass” here means the first domain route selects the proper feature/scope and the requested effect is verified; it does not mean every later tool argument succeeded or every unrelated global policy was followed. Recoveries are visible below and in JSON.

## Setup and fixture validity

Re-synced the isolated HOME and gor before starting. Runtime and topology are unchanged: isolated HOME /tmp/t3-eval-home, base /tmp/t3-eval, :3807, linked full-access to bed GV :13795, GR :13797 and VP :13791. Eval controller is EV. Codex CLI is 0.166.0; DeepSeek is OpenCode + deepseek/deepseek-flash (1017). The CLI was frozen in the isolated HOME so concurrent staged CLI edits could not affect these turns.

An initial backup was accidentally inside skill discovery. One Sol run read the old skill and OpenCode cached its now-moved path. That batch is not a valid full baseline. The first reset then aborted because its UI observer had already exited; the old T3 process was explicitly stopped by its captured PID before a verified fresh process was started. All 30 affected attempts are marked fixtureInvalid, never counted as behaviour passes. The clean generic batch below contains all 24 requests; it was followed by targeted retries. Old skill backups were moved outside discovery and retained, including gor's original backup under ~/.local/state/t3-skill-backups/.

## General changes

- Execute the documented CLI path for covered operations: it preserves configured defaults and resolution. Native APIs do not inherit CLI-only defaults. Read API schemas for raw calls and recover from rejected prerequisites instead of claiming success or assuming no configured default exists.
- Resolve the operation's machine/path before inspection. For files, construct an absolute path in the chosen representation. Initial repository inspection uses the same primary execution location as the mutation.
- MCP tool names belong to t3ctl tool, rather than invented CLI subcommands. Preserve full identifiers and target environments in follow-ups.

These rules apply to any project, machine, language or topic. GLOBAL.md changes stay in the coordinator's existing Как действовать paragraph: **+386 bytes** relative to f5b5f66477, no new section. Its digest is 848cc01ba1cb3b91a54ee093a9347b94e765aa0543560c8f72e604e5b91711c8.

## New matrix

Requests are the exact eight Russian inputs from the coordinator task. “Batch” is the clean full generic batch; provider errors are failures to complete, not behaviour passes. Selected rows may come from later general-only refinements or unchanged retries. First = request to native tool dispatch; total = T3 requestedAt to completedAt, in seconds. Tokens are cumulative provider counters, including cached input; raw components and native timing/session mappings are in JSON.

| Model | # / request                  | Clean batch outcome | Selected run                                                                                                                    |  First |   Total | Calls in order                                                                                        | Tokens | First route / verified effect |
| ----- | ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -----: | ------: | ----------------------------------------------------------------------------------------------------- | -----: | ----------------------------- |
| Sol   | 1 — новый тред / README      | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Aa1b6140c-eb31-433f-b184-d721a0f6d406)                |  5.179 |  26.335 | read skill → machines → new                                                                           | 118065 | yes / yes                     |
| Sol   | 2 — открыть тред             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A44ca8a48-7d89-46a8-9019-7d43d3c6c07e)                |  4.407 |  23.845 | read skill → find → find → ui_open                                                                    | 114293 | yes / yes                     |
| Sol   | 3 — README на целевой машине | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Ab935a866-0c44-45ba-8c9d-94ba3b5aa492)                |  5.047 |  19.591 | read skill → machines → ui_open                                                                       | 112482 | yes / yes                     |
| Sol   | 4 — реплика                  | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A481b0e84-8602-4048-8e32-b0530df1f3df)                |  3.806 |  14.811 | read skill → machines                                                                                 |  89757 | yes / yes                     |
| Sol   | 5 — что работает             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Afa9a8e85-4fa9-455c-989c-25a238b484d2)                |  4.941 |  21.002 | read skill → status                                                                                   |  87586 | yes / yes                     |
| Sol   | 6 — список машин             | yes                 | [generic-retry](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A5ce6bc80-6e4a-42d0-a58d-8231cf02ffa5)          |  4.199 |  14.579 | read skill → machines                                                                                 |  84342 | yes / yes                     |
| Sol   | 7 — поиск в mesh             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A0f020a1b-8dad-459f-941c-044c6ef3fd57)                |  4.294 |  23.711 | read skill → exec → ui_open                                                                           | 129672 | yes / yes                     |
| Sol   | 8 — коммит на primary        | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A27311ebb-1896-498d-9afa-7b2cb801b74c)                |  5.446 |  28.063 | read skill → machines → t3_project_machines → SSH git → SSH commit                                    | 191032 | yes / yes                     |
| Luna  | 1 — новый тред / README      | no                  | [generic-defaults](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A8ba14b07-ae7b-4740-9b85-bfc8e44da97b)       |  3.181 |  32.283 | exec → read skill → exec → t3_environment_links → machines → new                                      | 259210 | yes / yes                     |
| Luna  | 2 — открыть тред             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A87235489-5edd-43c0-941f-f89ded4902bf)                |  3.136 |  27.566 | read skill → read skill → find → find → exec → ui_open                                                | 202349 | yes / yes                     |
| Luna  | 3 — README на целевой машине | no                  | [generic-retry](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Af6615644-50c9-4ff5-a5d2-91afb4890fcf)          |  2.921 |   9.374 | exec → t3_project_machines → ui_open                                                                  |  98066 | yes / yes                     |
| Luna  | 4 — реплика                  | yes                 | [generic-routing](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A39405ea1-14de-4a96-a08e-7ed9c4ad8e6a)        |  6.120 |  44.589 | exec → t3_project_machines → read skill → machines → place                                            | 218641 | yes / yes                     |
| Luna  | 5 — что работает             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A1f06c9f5-854a-4959-934f-9dd98d29259c)                |  2.786 |  34.195 | exec → read skill → exec → exec → status → t3_environment_links → exec → t3_thread_list               | 377898 | yes / yes                     |
| Luna  | 6 — список машин             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A706ae96d-5cd7-440b-8e77-80ac2470c7f7)                | 63.539 |  74.408 | read skill → read skill → machines                                                                    | 104755 | yes / yes                     |
| Luna  | 7 — поиск в mesh             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A12b61687-1726-4c90-8ac9-307d125c0a28)                | 63.384 |  80.922 | exec → read skill → read skill → t3_environment_links → t3_thread_search → ui_open                    | 210148 | yes / yes                     |
| Luna  | 8 — коммит на primary        | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A9cb4018e-a325-49b1-8874-962c5aed1ba4)                |  6.920 |  31.630 | exec → t3_project_machines → t3_environment_links → exec → SSH git → SSH git → SSH commit             | 221095 | yes / yes                     |
| 1017  | 1 — новый тред / README      | provider stall      | [generic-verified](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A7a6aa5af-fc14-47e6-b8e3-e6e3c123ea83)       |  5.095 |  50.645 | skill → machines → projects → tool → new → wait → wait → wait → output → show → tool → tool → SSH git | 523477 | yes / yes                     |
| 1017  | 2 — открыть тред             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A684dee32-4e6b-489e-bd7d-8741e1eb94ed)                | 49.032 | 311.817 | skill → find → threads → find → find → machines → ui_open                                             | 240710 | yes / yes                     |
| 1017  | 3 — README на целевой машине | yes                 | [generic-filecheck](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A30b1d7d4-108a-4bb0-8b3e-130beae70460)      |  4.292 |  26.321 | skill → machines → project-machines → tool → cat → cat                                                | 196172 | yes / yes                     |
| 1017  | 4 — реплика                  | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Ac449c27e-46e0-4bf6-a605-f7cc83661d03)                | 55.730 | 110.144 | skill → t3_project_machines → machines → place                                                        | 149145 | yes / yes                     |
| 1017  | 5 — что работает             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A1f84e631-778d-46a8-99b2-8fc12c556f6a)                | 89.368 | 211.022 | skill → status                                                                                        | 108813 | yes / yes                     |
| 1017  | 6 — список машин             | yes                 | [generic](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A7165be2b-5443-4c82-b528-956876c2aafb)                | 48.969 | 226.663 | skill → machines                                                                                      | 105704 | yes / yes                     |
| 1017  | 7 — поиск в mesh             | provider error      | [generic-provider-retry](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A7c9df81f-6137-45ab-8d09-7b28131c238f) | 19.535 |  63.868 | skill → find → find                                                                                   | 113439 | yes / yes                     |
| 1017  | 8 — коммит на primary        | provider error      | [generic-verified](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A347d1fe1-7379-488b-9cf0-4405d6b625a2)       | 13.383 | 109.133 | t3_project_machines → t3_environment_links → SSH git → SSH git → SSH commit                           | 164165 | yes / yes                     |

The JSON records the full exact prompt, ordered native tool inputs, intermediate API/shell errors, first-route judgement and outcome for every eligible run. Invalid fixtures are explicitly ungraded. This is not one uninterrupted 24-pass batch.

## Verification on the bed

- Request 1: all three selected parents created a child in the current VP project representation; each child completed and edited README. [Sol child](t3-thread://v2/8bd7a7df-310c-48e9-9be9-f65ccd6c05f4/mcp:8406a29a-5c96-47f0-b044-254b8cfa6607), [Luna child](t3-thread://v2/8bd7a7df-310c-48e9-9be9-f65ccd6c05f4/mcp:9f16c4f3-a4dd-4820-92fe-ebf574250a67), [1017 child](t3-thread://v2/8bd7a7df-310c-48e9-9be9-f65ccd6c05f4/mcp:95f4afbb-24f1-4b18-9770-24b8c547e1f3). Project IDs were checked, not just thread creation receipts.
- Request 2: an authenticated UI subscriber received the three selected caller requests targeting the VPS [mount seed](t3-thread://v2/8bd7a7df-310c-48e9-9be9-f65ccd6c05f4/mcp:fc221127-ae2b-466d-96ec-ad7e03ff858a) with the correct full IDs.
- Request 3: Sol/Luna UI packets target the absolute GV representation path. 1017 read that absolute path and returned the complete README in its answer; its fenced content equals the verified file. This proves transport delivery/readback, not pixel-level device rendering.
- Request 4: the actual demo representation on GV is replica/watching, source GR. Existing replicas were handled idempotently. Other projects' conflicts were not modified.
- Requests 5/6: status --all and machines were checked against current reachable GV/GR/VP/EV and preserved known QA records.
- Request 7: all selected searches use cross-machine enumeration and identify the VPS [conflict seed](t3-thread://v2/8bd7a7df-310c-48e9-9be9-f65ccd6c05f4/mcp:ec5e0aed-26fc-4134-a709-897ea7829748). No claim of absence on unreachable environments is verified.
- Request 8: selected git commands all run through SSH to GR primary, including initial git inspection. Actual commits: Sol bb504e7, Luna c3fcc0b, 1017 bb949e7. .git was checked absent in eval/GV/VP replicas.
- Final README captures from GR/GV/VP are byte-identical: SHA-256 af2d1409043faa9f7e5aec4268fb08ef61f0e3c6fc47660472bdde8676a819fe.

## Failures, confusion and limitations

Luna initially opened a source-primary file, then in the clean batch chose the correct machine but a relative file path. The general absolute-path rule fixed that. Its native new-thread call also lacked a project model default; explaining CLI default semantics led to a successful CLI launch with the configured Codex Luna default. Its mutation retry used registry resolution and place successfully.

1017 encountered actual Service is too busy and Internal Server Error responses, plus provider stalls. These attempts remain in JSON, including an optional repeat stopped before its first tool call and a search stopped after its effect but before a final answer; neither counts as successful. Unchanged retries completed. Residual recoveries remain: shortened child IDs caused follow-up failures; an invented CLI subcommand and an ambiguous friendly machine alias were recovered; JSON filtering used python3 despite the existing uv rule. The mesh effects above are verified, but this is not a claim of perfect tool or global-policy compliance.

## Artifacts, sync and concurrent work

The committed evaluated skill is 24745 bytes, SHA-256 6c9f7d9bf6ddd552eae723a723c1b2f47691ac7124983ae45e85bd875006fc7f. GLOBAL.md and its skill copy match. The isolated HOME and gor were updated; gor reports Claude/Codex in sync, OpenCode harness absent. Backups are retained; the final gor instruction backup is recorded in /tmp/stage-j-general-evidence/gor-sync-final.txt.

The shared staged file changed concurrently later: another stage appended Session identity and thread ids across the mesh and padded its tables back to 43,839 bytes. Only table padding was removed, preserving that appendix and all semantic content; shared staged size is **25399 bytes**. It is not the evaluated snapshot. Gor and this branch retain the evaluated 24745-byte version; the isolated HOME was frozen. No later-stage source content was reverted.

The formatter now explicitly ignores docs/skill-t3-next/SKILL.md. Before/after SHA-256 comparison proves vp fmt did not touch it. No formatting command was directed at the skill, and no padding was reintroduced in the committed copy.

## Acceptance record

| Item                                                          | Status / location                      | Proof                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Updated instructions on isolated HOME and gor, backups kept   | done — private HOME and gor only       | sync readback, gor Claude/Codex status both in sync; gor backup 2026-11-03T10-31-56-995Z-2058766               |
| Eight fresh requests per model                                | done — 24 selected threads in new JSON | 81-attempt ledger; each model has all eight distinct completed selected rows                                   |
| Latency, total, ordered calls, first route, tokens, confusion | done — matrix and JSON                 | native provider session mapping plus t3ctl show --activity; selected timestamps and counters asserted          |
| Actual requested effects                                      | done — bed GV/GR/VP                    | child completion/project checks, UI packets, README equality, replica state and primary commits detailed above |
| General wording, minimal GLOBAL additions, compact skill      | done — d86f35f9fb                      | reviewed diff from f5b5f66477; GLOBAL +386 bytes; size/hash assertions; no phrase recipes                      |
| No formatter padding                                          | done — vite.config.ts ignore           | SKILL SHA-256 unchanged across formatter run; evaluated size 24745 bytes                                       |
| Offline implementation tests and baseline comparison          | done — checks below                    | 28 passing tests, lint zero errors; web/knip failures reproduced on xdev                                       |

## Checks

Every shell exports PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH. Product contracts/interfaces were not changed.

- ./node_modules/.bin/vp fmt: exit 0; Finished in 6979ms on 6764 files using 128 threads. SKILL.md excluded; hash unchanged.
- ./node_modules/.bin/vp lint: exit 0, 0 errors, existing warnings only.
- T3CTL_OFFLINE_ONLY=1 bash docs/skill-t3-next/scripts/selftest.sh: tests 7 / pass 7 / fail 0; tests 12 / pass 12 / fail 0; tests 7 / pass 7 / fail 0.
- node --test docs/skill-t3-next/shared-parity.test.mjs: tests 2 / pass 2 / fail 0. Total **28 passed**, zero failed/skipped/todo.
- Size assertion: committed skill 24745 < 26000; shared staged 25399 < 26000.

Exact typecheck commands and results:

```sh
(cd packages/contracts && pnpm -s typecheck)       # exit 0, no output
(cd packages/shared && pnpm -s typecheck)          # exit 0, no output
(cd packages/client-runtime && pnpm -s typecheck)  # exit 0, no output
(cd apps/server && pnpm -s typecheck)              # exit 0, no output
(cd apps/web && pnpm -s typecheck)                 # exit 1: Command "typecheck" not found
(cd apps/mobile && pnpm -s typecheck)              # exit 0, no output
(cd apps/web && pnpm exec vp run typecheck)        # exit 0, tsc --noEmit (cache replay)
```

The exact web pnpm command also fails on baseline /home/user/Repos/t3/t3code-xdev/apps/web:

```text
Error: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL
  × Command "typecheck" not found
```

./node_modules/.bin/vp run knip:check fails on xdev-j and baseline xdev: Unused exports (48); vp run: 1/2 successful. The complete findings sections compare identically (diff exit 0), zero new findings. All exact logs are in /tmp/stage-j-general-evidence/. The runtime effects/selection assertions used to build this report verify 24 completed rows, five UI deliveries, full README readback, three completed child edits, replica role/state and remote-only git commands.

All requested work is confined to xdev-j, staged skill files and the authorized test machines/HOME. No push, live gvidon :3774/global file/installed skill change, Operalia access or owner inbox write. Isolated processes are stopped after evidence collection; test data and backups remain.
