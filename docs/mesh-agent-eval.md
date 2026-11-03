# Stage J — mesh agent behaviour eval

**24/24 selected acceptance runs pass: Sol 8/8, Luna 8/8, DeepSeek 1017 8/8.** Real bed effects were checked, including two kinds of delivered UI events, remote child edits and primary commits. Branch: xdev-j. No push or PR. Product contracts and services were not changed.

The complete ordered calls, timings, usage and all 81 recorded matrix/baseline attempts are in [mesh-agent-eval.json](mesh-agent-eval.json). Selection is explicit; failed/interrupted and slower intermediate attempts remain in that ledger. This is task and first-route correctness, not a claim that the models never make a recoverable schema/CLI mistake.

## Environment repair and isolation

Gvidon uses Codex 0.166.0. Copied that exact standalone release (all helper binaries) to gor, retained 0.160.1 and its previous symlink target, and restarted **gor's test T3 only**. A fresh request still failed with `workspace routing discovery failed`: [gor retry](http://127.0.0.1:13797/34e33796-4717-4293-a955-88c2f740db4d/mcp%3Ae674cb9f-28d9-436b-83bf-ff27c0f645a3). No product fix was attempted for this backend error. Gor rollback: point `~/.codex/packages/standalone/current` back to the saved release target in `/tmp/j-codex-previous-target`, then restart its test T3.

Used the authorized fallback: private HOME `/tmp/t3-eval-home` (0700), copied regular files for Codex auth/config and OpenCode auth (0600), bed runtime `0.1.5-mesh.25fcbc27502c`, base dir `/tmp/t3-eval`, port 3807. Source auth/config were only read; no symlinks to mutable credential state. Disabled unrelated MCP servers, hooks and plugins in the **copy**. Installed staged t3-next as this HOME's t3 skill, rendered globals into its Codex/OpenCode files via `agents sync --to gvidon --home /tmp/t3-eval-home --apply`. The explicit HOME option is local-only and defaults to the local machine.

Linked the eval server with full access to gor 13797, isolated GV 13795 and VPS container 13791. Eval tag EV distinguishes it from GV. Registered an actual Mutagen replica of gor's demo in the eval HOME; configured a private SSH wrapper with the pinned gor host key and a private Mutagen daemon directory. No writes to live gvidon :3774, its installed skill/global instructions, Operalia, ws or other worktrees. The existing bed build was reused; deploy.sh was not rerun.

OpenCode was enabled only in the isolated server, with exact `deepseek/deepseek-flash` (custom model registration was needed because its catalog exposed only V4 Pro). Initial probes stalled; one title request logged `Service is too busy`. A direct one-token API probe returned HTTP 200. Reloading the isolated OpenCode provider then allowed full tool turns. Case 7 later stalled after skill load, was interrupted and rerun unchanged; its successful retry took 78.553 s overall. No alternate model was substituted.

CLI defaults in this fixture are Codex Luna via `T3CTL_AGENT=codex` / `T3CTL_CODEX_MODEL=gpt-6-luna`, so request 1 starts a harness available on the test VPS. Parent models remain exactly those listed below.

## Requests

1. «создай тред в проекте demo на впс, пусть допишет строку в README»
2. «открой тред про маунт»
3. «покажи README из demo на гвидоне»
4. «сделай demo репликой на гвидоне»
5. «что сейчас работает на всех машинах»
6. «какие у меня машины»
7. «найди тред про конфликт на всех машинах»
8. «в реплике demo на впс закоммить изменения»

## Before/after

Times are seconds from T3 requestedAt. First tool uses native dispatch timestamps (Codex custom-tool metadata / OpenCode tool state), **not the activity item's completion time**. Total uses T3 completedAt. Usage is cumulative across a run's model calls, including cached input. Codex native total already includes cached input; OpenCode total here is input + output + reasoning + cache-read + cache-write. Raw components are in the JSON. Skills and inventory are allowed setup; “first right” evaluates the first domain route, including correct machine/search scope.

| Model |   # | Before first/outcome   | Selected run                                                                                                            | First tool |  Total | Tools in order                                                               | Tokens | First right / verified |
| ----- | --: | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------: | -----: | ---------------------------------------------------------------------------- | -----: | ---------------------- |
| Sol   |   1 | no / no                | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A7e295a15-c264-4092-b512-7c63acd59f86)     |      4.886 | 25.155 | read skill → machines → new VP                                               | 117749 | yes / yes              |
| Sol   |   2 | no / no                | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A01110dd5-e858-4b32-98db-d99dae5e3eb5)     |      4.078 | 16.991 | read skill → find --all → ui.open                                            | 117714 | yes / yes              |
| Sol   |   3 | yes / yes              | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A9cdc7f8f-0355-4605-a59a-990e3900a31a)     |      3.992 | 16.637 | read skill → project.machines → machines → ui.open                           | 121455 | yes / yes              |
| Sol   |   4 | no / yes               | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Ac4facf30-44d3-4343-ad14-037ef6bc6c0a)     |      4.584 | 31.771 | read skill → machines → project_machines(bad arg) → place → project_machines | 151331 | yes / yes              |
| Sol   |   5 | yes / yes              | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A3c1c1a06-ddcb-40a4-90df-3f6a76441b08)     |      3.792 | 18.277 | read skill → status --all                                                    |  87624 | yes / yes              |
| Sol   |   6 | no / no                | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A0eb75de3-e929-4b57-b79d-eaf85b795795)     |      4.349 | 17.993 | read skill → machines                                                        |  84533 | yes / yes              |
| Sol   |   7 | yes / yes              | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A86045b24-1b23-4311-8cc9-1ca2542f083d)     |      4.589 | 23.796 | read skill → find --all → find --all                                         | 118537 | yes / yes              |
| Sol   |   8 | yes / yes              | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A0dde9513-4cde-471c-a91f-cec375b1276e)     |      3.946 | 22.443 | read skill → machines → project.machines → SSH git → SSH commit              | 156395 | yes / yes              |
| Luna  |   1 | no / no                | [serial](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A0958933c-bbbb-4636-b3a1-54e508fd8b83)         |      4.033 | 25.639 | read skill → machines + projects → new VP                                    | 113003 | yes / yes              |
| Luna  |   2 | no / no                | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Af0227568-c5b3-416f-85d3-b88b22ad9dcd)     |      3.388 | 24.621 | read skill → read skill → find --all → ui.open                               | 163810 | yes / yes              |
| Luna  |   3 | no / no                | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Ad931f643-e5da-4c1e-84cd-ceb9f17b1f9d)     |      5.811 | 14.815 | project.machines → ui.open                                                   |  99158 | yes / yes              |
| Luna  |   4 | no / yes               | [serial](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Abf687d6d-468f-45cd-8e85-42f9e8c0a7a2)         |      4.779 | 45.380 | read skill → machines → project.machines                                     | 262126 | yes / yes              |
| Luna  |   5 | yes / yes              | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A11e7e443-ce73-41f4-ad91-f2db3a6a4712)     |      3.659 | 31.943 | read skill → status --all                                                    | 205337 | yes / yes              |
| Luna  |   6 | no / no                | [acceptance](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Ad6c90332-994d-497a-a172-c87cdeac4559)     |      3.693 | 14.153 | read skill → machines                                                        | 104142 | yes / yes              |
| Luna  |   7 | no / yes               | [serial](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Ae7069311-79d9-479b-84f7-61b0eeadf3a0)         |      4.194 | 28.061 | read skill → find --all → find --all → ui.open                               | 215990 | yes / yes              |
| Luna  |   8 | no / yes               | [verified](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Abd66c3b6-9fa4-4270-91fa-09fa98138ddc)       |      4.308 | 18.406 | read skill → SSH git → SSH commit                                            | 169345 | yes / yes              |
| 1017  |   1 | provider recovery gate | [deepseek](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Adc976045-5ceb-448d-8816-1514c19be308)       |      4.746 | 22.422 | skill → machines → projects → runtime defaults → brief → new VP              | 186512 | yes / yes              |
| 1017  |   2 | provider recovery gate | [deepseek](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A79483d0d-84e3-459e-869a-087dbb2212f2)       |      4.465 | 15.544 | skill → find --all → ui.open                                                 | 147448 | yes / yes              |
| 1017  |   3 | provider recovery gate | [deepseek](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A1e387a2d-ab56-42fb-97e8-19eb91fd52a8)       |      4.332 | 20.019 | skill → machines → project_machines → cat GV → ui.open                       | 189948 | yes / yes              |
| 1017  |   4 | provider recovery gate | [deepseek](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A573ec226-b189-4943-91a4-7e8db6f6683b)       |      4.117 | 22.688 | skill → machines → bad project-machines → projects → place → replicas        | 224859 | yes / yes              |
| 1017  |   5 | provider recovery gate | [deepseek](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A68715638-9404-4996-9977-a676fb6ac596)       |      5.396 | 15.612 | skill → status --all                                                         | 109708 | yes / yes              |
| 1017  |   6 | provider recovery gate | [deepseek](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3A0820d2e3-ecbc-4bf3-9dad-a931a39b0733)       |      6.637 | 13.999 | skill → machines                                                             | 107032 | yes / yes              |
| 1017  |   7 | provider recovery gate | [deepseek-retry](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Af0f0901a-6725-4d5d-8687-136b76739bfc) |      4.736 | 78.553 | skill → find --all                                                           | 110629 | yes / yes              |
| 1017  |   8 | provider recovery gate | [deepseek](http://127.0.0.1:3807/db074357-317f-4e5c-bb15-fa08074b06c1/mcp%3Ae38124a2-4486-426d-9132-efd164d9911e)       |      5.601 |  9.923 | SSH git → SSH commit                                                         |  93365 | yes / yes              |

The original gor matrix (16 routing failures) is retained separately as `gor-original` in JSON; those failures never counted as passes. The isolated before matrix found genuine behaviour defects: local-only mount search, opening gor's README instead of GV's, treating a container hostname as an unknown VPS, using global infrastructure names instead of mesh names, and an initial local git status on a replica. Later selected routes fix these.

Residual recoveries are visible in the ledger: some runs guessed an unavailable skill path, used projectId instead of project, or tried a nonexistent project-machines subcommand before recovering. Parallel Luna cases 1/4/7 initially took 41–44 s to the first tool; sequential reruns are selected above and all original timings remain. Selection did not modify the exact owner requests.

## Verified effects

- **Request 1:** each parent created a new thread in the _current_ VPS representation, not an orphan demo project left by older rounds. Verified all three child threads completed and their added lines exist on VPS, gor and GV. Sol child: `65045362`; Luna child: `3b197ca7`; DeepSeek child: `a926774f` (full links in the ledger's parent launch call/result evidence and below).
- **Requests 2/3:** an authenticated WebSocket subscriber to `uiRequests.subscribe` received matching requests from all six selected agent runs. Target thread is VPS `mcp:fc221127-ae2b-466d-96ec-ad7e03ff858a`; target file is GV `/home/user/t3-replicas/demo-2/README.md`. Assertions check caller threadId and both target IDs/path. This proves client delivery, not a pixel capture of a human device.
- **Request 4:** demo on GV is `role: replica`, `state: watching`, path `/home/user/t3-replicas/demo-2`, source gor. Before testing creation, removed its previous _bed representation_, preserving the old independent checkout; the new replica was allocated separately. Later runs correctly handled the already-ready state. Other bed projects/conflicts were left alone.
- **Requests 5/6:** checked status/all and machines output against the connected GV/GR/VP/EV registry, preserving preexisting known/offline environments. Answers no longer substitute the global physical machine list or guess that the VPS hostname means Operalia.
- **Request 7:** selected searches use find with --all, find the seeded VPS title «конфликт — Stage J seed», and return its machine and thread link.
- **Request 8:** verified commits on gor primary: Sol `dabe0ab`, Luna `33e68fa`, DeepSeek `159ba6f`. All selected git commands run through SSH to gor; none runs git locally in the replica. Checked .git absent in eval, GV and VPS replicas. Later request-1 edits can leave README dirty after a request-8 commit; that does not change the verified commit location.
- **Sync proof:** all three README captures are byte-identical, SHA-256 `b3880bf8501fd51b77911e043019efea87817464b47e92c6b8608f34f513cb60`.

Child links: [Sol child](t3-thread://v2/8bd7a7df-310c-48e9-9be9-f65ccd6c05f4/mcp:65045362-1428-4ed7-8eb1-49995117c4d0), [Luna child](t3-thread://v2/8bd7a7df-310c-48e9-9be9-f65ccd6c05f4/mcp:3b197ca7-6825-4c62-81ab-06f2f8aa323a), [DeepSeek child](t3-thread://v2/8bd7a7df-310c-48e9-9be9-f65ccd6c05f4/mcp:a926774f-4859-407b-b115-7449a6dbefe4).

## Instruction changes

GLOBAL.md retains the original body with **one added paragraph near the Mesh heading** (996 extra characters; a few surrounding blank lines differ). It tells agents to read the skill, resolve configured names/paths, prefer CLI fan-out on old servers, translate маунт to mount, select title matches, pass both IDs to ui_open, use GV's representation rather than the source primary, and run even git status on the primary. Each clarification follows an observed failure above. No personal/infrastructure policies were rewritten. Current SHA-256: `6eec8c6fdcbd00cf74c86d2630ca488fb881fc905dbab2f01b073b1f170f64ce`; original SHA-256: `3b3855c24f8c1e6193dacd47bdfbf14b26cf19b54927e1ee40e30af39a2d781d`.

SKILL.md adds a short dispatch section before the large command reference, exact replica git sequencing, explicit runtime defaults and UI-opening requirements. Replaced stale infrastructure details with a pointer to the owner's maintained operations instructions. The bed's old MCP implementation rejects environmentId all as an unlinked machine; CLI find --all already implements the correct fan-out, so no product interface needed changing.

Updated staged t3-next and gor's t3/t3-next copies at the evaluated revision. Final gor global backup: `~/.local/state/t3-agents-sync/2026-11-03T09-18-46-690Z-946160/`; original pre-stage backup `2026-11-03T08-45-54-386Z-746378/` retained. Gor status confirms Claude/Codex in sync; OpenCode directory absent there. Production-home apply remains gor-only; the isolated local HOME was explicitly authorized for this follow-up.

After the selected evals completed, another stage concurrently extended the shared staged CLI (`self`) and appended «Где находится эта сессия» to its global body. Those edits were preserved, not copied into this branch's evaluated snapshots. Final shared body SHA-256 is `6eec8c6fdcbd00cf74c86d2630ca488fb881fc905dbab2f01b073b1f170f64ce`; it was separately synced to gor with backup `2026-11-03T09-36-41-663Z-1193097`, and status reports Claude/Codex in sync. The 24-run proof applies to commit 6c1fd2c11b and global digest 6eec8c6fdcbd00cf74c86d2630ca488fb881fc905dbab2f01b073b1f170f64ce, not to the later stage's new self/all-RPC behaviour. No later-stage CLI/global content was reverted.

## Acceptance evidence

| Item                                                     | Result / where                          | Proving test or live assertion                                                                                                  |
| -------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Canonical body + metadata + machine header               | done: docs/agents-global, skill global/ | canonical digest and render tests; original/revised digest above                                                                |
| Sync target selection, dry-run diff, local/SSH operation | done: agents-sync.mjs, t3ctl dispatch   | unified diff, non-mutating read and SSH transport tests                                                                         |
| Backup, verify, missing harness, idempotence, errors     | done                                    | target-operation test, collision refusal, actual gor apply/status and retained backups                                          |
| Local isolated --home, no remote home override           | done                                    | explicit-HOME test: default local, missing → diff → apply → status, actual HOME untouched, remote/all/relative targets rejected |
| Skill commands + Mesh instructions + selftest            | done                                    | complete standalone suite: 7 unit + 12 integration + 7 sync + 2 parity = 28 passes                                              |
| Gor upgrade and retry, isolated fallback                 | done                                    | 0.166.0 version transcript, new gor failure, isolated real turns                                                                |
| Eight exact requests on Sol and Luna                     | done                                    | 16 selected rows, caller/target assertions, child reads, primary commit and replica checks                                      |
| DeepSeek enabled and exact model used                    | done                                    | isolated settings + OpenCode native DB model IDs; eight selected real turns                                                     |
| Per-run timing, ordered tools, tokens, confusion         | done                                    | JSON ledger, unique native transcript/session matching by model + exact user message + start time                               |
| Improvement and rerun                                    | done                                    | before matrix, after/final/verified/acceptance/serial attempts, DeepSeek retry preserved                                        |
| Repo copies, report, FORK entry, logical commits         | done                                    | commits bdab71bc46, 8f2b1ef84e, 6c1fd2c11b and report commit                                                                    |
| Interfaces unchanged                                     | done                                    | git diff: CLI/skill/docs only; shared parity tests 2/2                                                                          |

## Checks

Every shell exports `PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH`. No product package source changed; full test suites for the changed standalone skill were run.

- `./node_modules/.bin/vp fmt`: exit 0. `Finished in 7129ms on 6764 files using 128 threads.` Final evidence formatting: `Finished in 7305ms on 6765 files using 128 threads.`
- `./node_modules/.bin/vp lint`: exit 0, 0 errors (six existing warnings).
- `T3CTL_OFFLINE_ONLY=1 bash docs/skill-t3-next/scripts/selftest.sh`: `ℹ tests 7 / ℹ pass 7 / ℹ fail 0`; `ℹ tests 12 / ℹ pass 12 / ℹ fail 0`; `ℹ tests 7 / ℹ pass 7 / ℹ fail 0`. No skipped/todo tests.
- `node --test docs/skill-t3-next/shared-parity.test.mjs`: `ℹ tests 2 / ℹ pass 2 / ℹ fail 0`.

Requested package commands and final results:

```sh
(cd packages/contracts && pnpm -s typecheck)       # exit 0, no output
(cd packages/shared && pnpm -s typecheck)          # exit 0, no output
(cd packages/client-runtime && pnpm -s typecheck)  # exit 0, no output
(cd apps/server && pnpm -s typecheck)              # exit 0, no output
(cd apps/web && pnpm -s typecheck)                 # exit 1: Command "typecheck" not found
(cd apps/mobile && pnpm -s typecheck)              # exit 0, no output
(cd apps/web && pnpm exec vp run typecheck)        # exit 0: ~/apps/web$ tsc --noEmit ◉ cache hit, replaying
```

Exact web command on baseline `/home/user/Repos/t3/t3code-xdev/apps/web` also exits 1 with:

```text
Error: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL
  × Command "typecheck" not found
```

`./node_modules/.bin/vp run knip:check`: exit 1 on xdev-j and baseline xdev; both report `Unused exports (48)` and `vp run: 1/2 successful. (Run vp run --last-details for full details)`. Full findings compare identically (diff exit 0), zero new findings. Baseline commands were run in xdev read-only; no other checkout edits. Logs: `/tmp/j-revision-{typecheck-results,knip.log,web-vp.log}`, `/tmp/j-last-{fmt,lint,selftest,parity}.log`, `/tmp/j-baseline-{knip,typecheck-web}.log`.

Native evidence is under the private eval HOME and /tmp/stage-j-*; no credentials are in committed artifacts. The isolated eval server, UI observer and its private Mutagen daemon are stopped after collection; data/backups remain for inspection. Gor's test T3 remains on its preexisting bed build with CLI 0.166.0. No live-server inbox write was made under the explicit live-server prohibition.
