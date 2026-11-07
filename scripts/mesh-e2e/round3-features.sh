#!/usr/bin/env bash
# Sourced by round3.sh: every folder, project, thread and session belongs to this N run.
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
# Duplicate path claims use LWW, independently of the receiver or old authority.
rexec vps mkdir -p "$N_ROOT-duplicate-claim"
ctl vps tool t3_project_create "$(jq -nc --arg title "N-duplicate claim $RUN_TS" --arg path "$N_ROOT-duplicate-claim" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-claim-project.json"
claim_project=$(jq -er '.id' "$WORK/N-claim-project.json")
first_claim=$(jq -nc --arg env "$VPS_ENV" --arg path "$N_ROOT-duplicate-claim" --arg id "$claim_project" '{environmentId:$env,path:$path,projectId:$id,role:"primary",transport:"git",createdAt:""}')
first_entries=$(entry "rep/$N_KEY-first/$VPS_ENV" "$first_claim" | jq --arg node "browser-$RUN_TS" '.entries |= with_entries(.value.h = (.value.h | sub("[^.]+$"; $node)))')
ws_rpc vps meshLayout.apply "$first_entries" > "$WORK/N-first-claim.json"
wait_converged 'N first duplicate path claim'
first_claim=$(ws_get vps | jq -c --arg key "rep/$N_KEY-first/$VPS_ENV" '.document[$key].v')
ws_rpc gv meshLayout.apply "$(entry "rep/$N_KEY-peer/$VPS_ENV" "$first_claim")" > "$WORK/N-peer-claim.json"
wait_converged 'N duplicate path claim uses latest clock'
ws_get gv > "$WORK/N-duplicate-claims.json"
jq -e --arg win "$N_KEY-peer" --arg lose "$N_KEY-first" --arg env "$VPS_ENV" '.config.projectMounts[$win]|length==1' "$WORK/N-duplicate-claims.json" >/dev/null
jq -e --arg lose "$N_KEY-first" '(.config.projectMounts[$lose] // [])|length==0' "$WORK/N-duplicate-claims.json" >/dev/null
feature_root="$N_ROOT-features"
feature_title="N-project title $RUN_TS"
feature_legacy="title:${feature_title,,}"
encoded_legacy=$(jq -rn --arg s "$feature_legacy" '$s|@uri')
rexec gor mkdir -p "$feature_root-primary"
rexec gor git init -q "$feature_root-primary"
rexec gor sh -c "printf 'N-source' > '$feature_root-primary/both'; printf 'ignored' > '$feature_root-primary/local.cache'"
ctl gor tool t3_project_create "$(jq -nc --arg title "$feature_title" --arg path "$feature_root-primary" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-feature-local-project.json"
feature_project=$(jq -r '.id' "$WORK/N-feature-local-project.json")
ws_rpc gv meshLayout.apply "$(entry "proj/$encoded_legacy.title" "$(jq -nc --arg s "$feature_title" '$s')")" > "$WORK/N-feature-title.json"
wait_converged 'N migrated legacy project'
feature_id=$(ws_get gor | jq -r --arg alias "$feature_legacy" '.config.projectAliases[$alias]')
[[ "$feature_id" = lp-* ]] || die 'Legacy project id did not migrate'
ctl gor place "$feature_project" --on "$GOR_ENV" --primary --path "$feature_root-primary" --json > "$WORK/N-feature-first-placement.json"
jq -e --arg id "$feature_id" '.logicalKey==$id' "$WORK/N-feature-first-placement.json" >/dev/null
wait_converged 'N first placement preserves migrated identity'
project_options "$feature_title" '{"ignore":["*.cache"]}' > "$WORK/N-ignore-policy.json"
ctl gor place "$feature_title" --on "$GV_ENV" --path "$feature_root-explicit" --transport mutagen --wait 120 --json > "$WORK/N-explicit-place.json"
jq -e --arg path "$feature_root-explicit" '.ready and .representation.path==$path' "$WORK/N-explicit-place.json" >/dev/null
rexec gv test -f "$feature_root-explicit/both"
rexec gv test ! -e "$feature_root-explicit/local.cache"
rexec gv mkdir -p "$feature_root-rejected"
rexec gv sh -c "printf 'N-keep-this' > '$feature_root-rejected/only-loser'"
if ctl gor place "$feature_title" --on "$GV_ENV" --path "$feature_root-rejected" --wait 120 --json > "$WORK/N-explicit-refusal.log" 2>&1; then die 'A different non-empty folder was accepted'; fi
rg -q 'not empty and differs' "$WORK/N-explicit-refusal.log"
test "$(rexec gv cat "$feature_root-rejected/only-loser")" = N-keep-this
ctl gor place "$feature_title" --on "$GV_ENV" --path "$feature_root-explicit" --wait 120 --json > "$WORK/N-explicit-restored.json"
ctl gv projects --json > "$WORK/N-explicit-projects.json"
jq -e --arg path "$feature_root-explicit" '[.[] | select(.workspaceRoot==$path)] | length==1' "$WORK/N-explicit-projects.json" >/dev/null
ctl gor place "$feature_title" --on "$VPS_ENV" --path "$feature_root-external" --transport manual --wait 120 --json > "$WORK/N-manual-place.json"
jq -e '.ready and .representation.transport=="manual"' "$WORK/N-manual-place.json" >/dev/null
ws_rpc vps meshConfig.get '{}' | jq -e --arg project "$feature_title" '.current.doc.projects.overrides[] | select(.project==$project) | .ignore | index("*.cache")!=null' >/dev/null
ctl gor place "$feature_title" --on "$VPS_ENV" --path "$feature_root-external" --transport sshfs --wait 120 --json > "$WORK/N-sshfs-place.json"
jq -e '.ready and .representation.transport=="sshfs"' "$WORK/N-sshfs-place.json" >/dev/null
renamed_title="N-renamed project $RUN_TS"
ws_rpc gv meshLayout.apply "$(entry "proj/$feature_id.title" "$(jq -nc --arg title "$renamed_title" '$title')")" > "$WORK/N-renamed-title.json"
wait_converged 'N shared project title rename'
ctl gor tool t3_project_machines "$(jq -nc --arg p "$feature_project" '{project:$p}')" > "$WORK/N-named-machines.json"
jq -e --arg title "$renamed_title" '.title==$title' "$WORK/N-named-machines.json" >/dev/null
ctl gor tool t3_project_read "$(jq -nc --arg p "$feature_project" '{projectId:$p}')" > "$WORK/N-named-project-read.json"
jq -e --arg title "$renamed_title" '.title==$title' "$WORK/N-named-project-read.json" >/dev/null
named_cursor=0
while :; do
  ctl gor tool t3_project_list "$(jq -nc --argjson cursor "$named_cursor" '{cursor:$cursor,limit:100}')" > "$WORK/N-named-project-page.json"
  if jq -e --arg id "$feature_project" 'any(.projects[]; .id==$id)' "$WORK/N-named-project-page.json" >/dev/null; then
    jq -e --arg id "$feature_project" --arg title "$renamed_title" '.projects[] | select(.id==$id) | .title==$title' "$WORK/N-named-project-page.json" >/dev/null
    break
  fi
  named_cursor=$(jq -r '.nextCursor // empty' "$WORK/N-named-project-page.json")
  [ -n "$named_cursor" ] || die 'Renamed project is absent from MCP pages'
done
ctl gor projects --json > "$WORK/N-named-cli-projects.json"
jq -e --arg id "$feature_project" --arg title "$renamed_title" '.[] | select(.id==$id) | .title==$title' "$WORK/N-named-cli-projects.json" >/dev/null
ctl gv replicas > "$WORK/N-replicas-text.log"
ctl gv mesh status > "$WORK/N-mesh-text.log"
for output in "$WORK/N-replicas-text.log" "$WORK/N-mesh-text.log"; do
  rg -Fq 'N-renamed project' "$output"
  if rg -Fq "$feature_id" "$output" || rg -Fq "$feature_legacy" "$output"; then die 'An internal project key escaped into display text'; fi
done
# Same-machine move into the selected remote project's local representation.
rexec gv mkdir -p "$feature_root-thread-source"
ctl gv tool t3_project_create "$(jq -nc --arg title "N-move source $RUN_TS" --arg path "$feature_root-thread-source" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-move-source.json"
thread_project=$(jq -r '.id' "$WORK/N-move-source.json")
ctl gv tool orchestrator_capabilities > "$WORK/N-idle-capabilities.json"
idle_model=$(jq -ec '.providers[] | select(.driverKind=="codex") | {instanceId:.providerInstanceId,model:"gpt-6-luna"}' "$WORK/N-idle-capabilities.json")
ctl gv tool t3_thread_launch "$(jq -nc --arg p "$thread_project" --arg t "N-local move $RUN_TS" --argjson model "$idle_model" '{projectId:$p,title:$t,modelSelection:$model}')" > "$WORK/N-thread.json"
feature_thread=$(jq -r '.threadId' "$WORK/N-thread.json")
local_project=$(jq -er '.representation.projectId' "$WORK/N-explicit-restored.json")
ws_rpc gv threads.move "$(jq -nc --arg t "$feature_thread" --arg p "$local_project" '{threadId:$t,projectId:$p}')" > "$WORK/N-local-move.json"
jq -e --arg env "$GV_ENV" '.environmentId==$env and .handoffId==null' "$WORK/N-local-move.json" >/dev/null
ctl gv tool t3_thread_read "$(jq -nc --arg t "$feature_thread" '{threadId:$t,limit:1}')" | jq -e --arg p "$local_project" '.thread.projectId==$p' >/dev/null
# Another project has no GV representation: create a copy, wait, then move locally.
rexec gor mkdir -p "$feature_root-copy"
rexec gor git init -q "$feature_root-copy"
ctl gor tool t3_project_create "$(jq -nc --arg title "N-copy before move $RUN_TS" --arg path "$feature_root-copy" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-copy-project.json"
copy_project=$(jq -r '.id' "$WORK/N-copy-project.json")
ctl gor place "N-copy before move $RUN_TS" --on "$GOR_ENV" --primary --path "$feature_root-copy" --json > "$WORK/N-copy-primary.json"
wait_converged 'N project before creating its local copy'
ctl gor place "$copy_project" --on "$GV_ENV" --path "$feature_root-copy-local" --wait 120 --json > "$WORK/N-copy-local.json"
copy_local=$(jq -er '.representation.projectId' "$WORK/N-copy-local.json")
ws_rpc gv threads.move "$(jq -nc --arg t "$feature_thread" --arg p "$copy_local" '{threadId:$t,projectId:$p}')" > "$WORK/N-copy-move.json"
jq -e --arg env "$GV_ENV" '.environmentId==$env and .handoffId==null' "$WORK/N-copy-move.json" >/dev/null
ctl gv tool t3_thread_read "$(jq -nc --arg t "$feature_thread" '{threadId:$t,limit:1}')" | jq -e --arg p "$copy_local" '.thread.projectId==$p' >/dev/null
# Adopt only our own foreign-daemon session. Keep it until private sync watches.
rexec gor mkdir -p "$feature_root-adopt"
rexec gor git init -q "$feature_root-adopt"
rexec gv mkdir -p "$feature_root-adopt-target"
rexec gor sh -c "printf 'N-baseline' > '$feature_root-adopt/both'"
ctl gor tool t3_project_create "$(jq -nc --arg title "N-adoption $RUN_TS" --arg path "$feature_root-adopt" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-adopt-project.json"
ctl gor place "N-adoption $RUN_TS" --on "$GOR_ENV" --primary --path "$feature_root-adopt" --json > "$WORK/N-adopt-primary.json"
wait_converged 'N project before adoption'
# Reversed endpoints exercise adoption from GV's daemon with its existing SSH route.
foreign_name="N-adopt-$RUN_TS"
foreign_home="$GV_BASE_DIR/home"
test "$foreign_home" != "$HOME" || die 'Adoption requires an isolated server HOME'
node - "$(systemctl --user show -p MainPID --value "$GV_UNIT")" "$foreign_home" <<'JS'
const fs=require('node:fs');
const [pid,home]=process.argv.slice(2);
if(!fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').includes(`HOME=${home}`)) throw Error('Foreign daemon HOME must match the isolated server');
JS
foreign_mut() { require_bed_lock || return 1; rexec gv env -u MUTAGEN_DATA_DIRECTORY HOME="$foreign_home" MUTAGEN_SSH_PATH="$GV_BASE_DIR/mesh/ssh/bin" "$(mut_bin gv)" "$@"; }
gor_name=$(ws_rpc gv meshConfig.get '{}' | jq -er --arg env "$GOR_ENV" '.bindings|to_entries[]|select(.value==$env)|.key')
foreign_mut sync create --name "$foreign_name" --mode two-way-safe --ignore-vcs --ignore .t3-conflicts "$feature_root-adopt-target" "t3-$gor_name:$feature_root-adopt" > "$WORK/N-foreign-created.log"
foreign_mut sync flush "$foreign_name" > "$WORK/N-foreign-flushed.log"
foreign_mut sync pause "$foreign_name" > "$WORK/N-foreign-paused.log"
rexec gor sh -c "printf 'N-adopt-loser' > '$feature_root-adopt/both'"
rexec gv sh -c "printf 'N-authority-wins' > '$feature_root-adopt-target/both'"
project_options "N-adoption $RUN_TS" '{"conflicts":"newest-wins"}' > "$WORK/N-adopt-policy.json"
rexec gor node -e 'require("node:fs").utimesSync(process.argv[1],1000000,1000000)' "$feature_root-adopt/both"
rexec gv node -e 'require("node:fs").utimesSync(process.argv[1],2000000,2000000)' "$feature_root-adopt-target/both"
ctl gv replica adopt "$foreign_name" --project "N-adoption $RUN_TS" --json > "$WORK/N-adopt-result.json"
adopt_key=$(jq -r '.logicalKey' "$WORK/N-adopt-result.json")
for _ in $(seq 1 180); do
  ws_get gor > "$WORK/N-adopt-layout.json"
  if jq -e --arg k "$adopt_key" --arg env "$GV_ENV" '.config.projectMountStatus[$k][$env].state=="watching" and ([.config.projectMounts[$k][] | select(.environmentId==$env) | has("adoption")] == [false])' "$WORK/N-adopt-layout.json" >/dev/null; then break; fi
  sleep 1
done
jq -e --arg k "$adopt_key" --arg env "$GV_ENV" '.config.projectMountStatus[$k][$env].state=="watching"' "$WORK/N-adopt-layout.json" >/dev/null
foreign_mut sync list --template '{{json .}}' > "$WORK/N-foreign-after.json"
jq -e --arg n "$foreign_name" 'all(.[]; .name!=$n)' "$WORK/N-foreign-after.json" >/dev/null
test "$(rexec gv cat "$feature_root-adopt-target/both")" = N-authority-wins
rexec gor sh -c "rg -l 'N-adopt-loser' '$feature_root-adopt/.t3-conflicts'" > "$WORK/N-adopt-copies.log"
test "$(rexec gor cat "$feature_root-adopt/both")" = N-authority-wins
wait_converged 'N feature acceptance after adoption'
. "$MESH_DIR/round3-live-regressions.sh"
printf 'PASS N features: explicit/refused paths, display titles, local/copy moves, ignores/transports, adopted conflict copies; evidence %s\n' "$WORK"

assert_feature_recovery() {
  test "$(rexec gv cat "$feature_root-explicit/both")" = N-source
  test "$(rexec gv cat "$feature_root-adopt-target/both")" = N-authority-wins
  test "$(rexec gor cat "$feature_root-adopt/both")" = N-authority-wins
  rexec gor sh -c "rg -l 'N-adopt-loser' '$feature_root-adopt/.t3-conflicts'" > "$WORK/N-adopt-copies-after-recovery.log"
  mut gv sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-feature-sessions-after.json"
  jq -e --arg a "$feature_root-explicit" --arg b "$feature_root-adopt-target" '[.[] | select(.beta.path==$a)]|length==1' "$WORK/N-feature-sessions-after.json" >/dev/null
  jq -e --arg b "$feature_root-adopt-target" '[.[] | select(.beta.path==$b)]|length==1' "$WORK/N-feature-sessions-after.json" >/dev/null
  foreign_mut sync list --template '{{json .}}' > "$WORK/N-foreign-after-recovery.json"
  jq -e --arg n "$foreign_name" 'all(.[]; .name!=$n)' "$WORK/N-foreign-after-recovery.json" >/dev/null
  assert_live_regression_recovery
}
