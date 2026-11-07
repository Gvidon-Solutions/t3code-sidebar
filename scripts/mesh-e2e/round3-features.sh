#!/usr/bin/env bash
# Sourced by round3.sh: every folder, project, thread and session belongs to this N run.
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
# Duplicate path claims use LWW, independently of the receiver or old authority.
rexec cloudbox mkdir -p "$N_ROOT-duplicate-claim"
ctl cloudbox tool t3_project_create "$(jq -nc --arg title "N-duplicate claim $RUN_TS" --arg path "$N_ROOT-duplicate-claim" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-claim-project.json"
claim_project=$(jq -er '.id' "$WORK/N-claim-project.json")
first_claim=$(jq -nc --arg env "$CLOUDBOX_ENV" --arg path "$N_ROOT-duplicate-claim" --arg id "$claim_project" '{environmentId:$env,path:$path,projectId:$id,role:"primary",transport:"git",createdAt:""}')
first_entries=$(entry "rep/$N_KEY-first/$CLOUDBOX_ENV" "$first_claim" | jq --arg node "browser-$RUN_TS" '.entries |= with_entries(.value.h = (.value.h | sub("[^.]+$"; $node)))')
ws_rpc cloudbox meshLayout.apply "$first_entries" > "$WORK/N-first-claim.json"
wait_converged 'N first duplicate path claim'
first_claim=$(ws_get cloudbox | jq -c --arg key "rep/$N_KEY-first/$CLOUDBOX_ENV" '.document[$key].v')
ws_rpc studio meshLayout.apply "$(entry "rep/$N_KEY-peer/$CLOUDBOX_ENV" "$first_claim")" > "$WORK/N-peer-claim.json"
wait_converged 'N duplicate path claim uses latest clock'
ws_get studio > "$WORK/N-duplicate-claims.json"
jq -e --arg win "$N_KEY-peer" --arg lose "$N_KEY-first" --arg env "$CLOUDBOX_ENV" '.config.projectMounts[$win]|length==1' "$WORK/N-duplicate-claims.json" >/dev/null
jq -e --arg lose "$N_KEY-first" '(.config.projectMounts[$lose] // [])|length==0' "$WORK/N-duplicate-claims.json" >/dev/null
feature_root="$N_ROOT-features"
feature_title="N-project title $RUN_TS"
feature_legacy="title:${feature_title,,}"
encoded_legacy=$(jq -rn --arg s "$feature_legacy" '$s|@uri')
rexec worker mkdir -p "$feature_root-primary"
rexec worker git init -q "$feature_root-primary"
rexec worker sh -c "printf 'N-source' > '$feature_root-primary/both'; printf 'ignored' > '$feature_root-primary/local.cache'"
ctl worker tool t3_project_create "$(jq -nc --arg title "$feature_title" --arg path "$feature_root-primary" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-feature-local-project.json"
feature_project=$(jq -r '.id' "$WORK/N-feature-local-project.json")
ws_rpc studio meshLayout.apply "$(entry "proj/$encoded_legacy.title" "$(jq -nc --arg s "$feature_title" '$s')")" > "$WORK/N-feature-title.json"
wait_converged 'N migrated legacy project'
feature_id=$(ws_get worker | jq -r --arg alias "$feature_legacy" '.config.projectAliases[$alias]')
[[ "$feature_id" = lp-* ]] || die 'Legacy project id did not migrate'
ctl worker place "$feature_project" --on "$WORKER_ENV" --primary --path "$feature_root-primary" --json > "$WORK/N-feature-first-placement.json"
jq -e --arg id "$feature_id" '.logicalKey==$id' "$WORK/N-feature-first-placement.json" >/dev/null
wait_converged 'N first placement preserves migrated identity'
project_options "$feature_title" '{"ignore":["*.cache"]}' > "$WORK/N-ignore-policy.json"
ctl worker place "$feature_title" --on "$STUDIO_ENV" --path "$feature_root-explicit" --transport mutagen --wait 120 --json > "$WORK/N-explicit-place.json"
jq -e --arg path "$feature_root-explicit" '.ready and .representation.path==$path' "$WORK/N-explicit-place.json" >/dev/null
rexec studio test -f "$feature_root-explicit/both"
rexec studio test ! -e "$feature_root-explicit/local.cache"
rexec studio mkdir -p "$feature_root-rejected"
rexec studio sh -c "printf 'N-keep-this' > '$feature_root-rejected/only-loser'"
if ctl worker place "$feature_title" --on "$STUDIO_ENV" --path "$feature_root-rejected" --wait 120 --json > "$WORK/N-explicit-refusal.log" 2>&1; then die 'A different non-empty folder was accepted'; fi
rg -q 'not empty and differs' "$WORK/N-explicit-refusal.log"
test "$(rexec studio cat "$feature_root-rejected/only-loser")" = N-keep-this
ctl worker place "$feature_title" --on "$STUDIO_ENV" --path "$feature_root-explicit" --wait 120 --json > "$WORK/N-explicit-restored.json"
ctl studio projects --json > "$WORK/N-explicit-projects.json"
jq -e --arg path "$feature_root-explicit" '[.[] | select(.workspaceRoot==$path)] | length==1' "$WORK/N-explicit-projects.json" >/dev/null
ctl worker place "$feature_title" --on "$CLOUDBOX_ENV" --path "$feature_root-external" --transport manual --wait 120 --json > "$WORK/N-manual-place.json"
jq -e '.ready and .representation.transport=="manual"' "$WORK/N-manual-place.json" >/dev/null
ws_rpc cloudbox meshConfig.get '{}' | jq -e --arg project "$feature_title" '.current.doc.projects.overrides[] | select(.project==$project) | .ignore | index("*.cache")!=null' >/dev/null
end=$((SECONDS+TIMEOUT))
while :; do
  ws_get cloudbox > "$WORK/N-manual-metadata.json"
  if jq -e --arg key "$feature_id" --arg env "$CLOUDBOX_ENV" 'any((.config.projectMounts[$key] // [])[]; .environmentId==$env and .transport=="manual" and .projectId!=null and ((.ignores // []) | index("*.cache")!=null))' "$WORK/N-manual-metadata.json" >/dev/null; then break; fi
  [ "$SECONDS" -lt "$end" ] || die 'Manual representation metadata did not finish'
  sleep 1
done
wait_converged 'N manual representation metadata before transport change'
ctl worker place "$feature_title" --on "$CLOUDBOX_ENV" --path "$feature_root-external" --transport sshfs --wait 120 --json > "$WORK/N-sshfs-place.json"
jq -e '.ready and .representation.transport=="sshfs"' "$WORK/N-sshfs-place.json" >/dev/null
renamed_title="N-renamed project $RUN_TS"
ws_rpc studio meshLayout.apply "$(entry "proj/$feature_id.title" "$(jq -nc --arg title "$renamed_title" '$title')")" > "$WORK/N-renamed-title.json"
wait_converged 'N shared project title rename'
ctl worker tool t3_project_machines "$(jq -nc --arg p "$feature_project" '{project:$p}')" > "$WORK/N-named-machines.json"
jq -e --arg title "$renamed_title" '.title==$title' "$WORK/N-named-machines.json" >/dev/null
ctl worker tool t3_project_read "$(jq -nc --arg p "$feature_project" '{projectId:$p}')" > "$WORK/N-named-project-read.json"
jq -e --arg title "$renamed_title" '.title==$title' "$WORK/N-named-project-read.json" >/dev/null
named_cursor=0
while :; do
  ctl worker tool t3_project_list "$(jq -nc --argjson cursor "$named_cursor" '{cursor:$cursor,limit:100}')" > "$WORK/N-named-project-page.json"
  if jq -e --arg id "$feature_project" 'any(.projects[]; .id==$id)' "$WORK/N-named-project-page.json" >/dev/null; then
    jq -e --arg id "$feature_project" --arg title "$renamed_title" '.projects[] | select(.id==$id) | .title==$title' "$WORK/N-named-project-page.json" >/dev/null
    break
  fi
  named_cursor=$(jq -r '.nextCursor // empty' "$WORK/N-named-project-page.json")
  [ -n "$named_cursor" ] || die 'Renamed project is absent from MCP pages'
done
ctl worker projects --json > "$WORK/N-named-cli-projects.json"
jq -e --arg id "$feature_project" --arg title "$renamed_title" '.[] | select(.id==$id) | .title==$title' "$WORK/N-named-cli-projects.json" >/dev/null
ctl studio replicas > "$WORK/N-replicas-text.log"
ctl studio mesh status > "$WORK/N-mesh-text.log"
for output in "$WORK/N-replicas-text.log" "$WORK/N-mesh-text.log"; do
  rg -Fq 'N-renamed project' "$output"
  if rg -Fq "$feature_id" "$output" || rg -Fq "$feature_legacy" "$output"; then die 'An internal project key escaped into display text'; fi
done
# Same-machine move into the selected remote project's local representation.
rexec studio mkdir -p "$feature_root-thread-source"
ctl studio tool t3_project_create "$(jq -nc --arg title "N-move source $RUN_TS" --arg path "$feature_root-thread-source" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-move-source.json"
thread_project=$(jq -r '.id' "$WORK/N-move-source.json")
ctl studio tool orchestrator_capabilities > "$WORK/N-idle-capabilities.json"
idle_model=$(jq -ec '.providers[] | select(.driverKind=="codex") | {instanceId:.providerInstanceId,model:"gpt-6-luna"}' "$WORK/N-idle-capabilities.json")
ctl studio tool t3_thread_launch "$(jq -nc --arg p "$thread_project" --arg t "N-local move $RUN_TS" --argjson model "$idle_model" '{projectId:$p,title:$t,modelSelection:$model}')" > "$WORK/N-thread.json"
feature_thread=$(jq -r '.threadId' "$WORK/N-thread.json")
local_project=$(jq -er '.representation.projectId' "$WORK/N-explicit-restored.json")
ws_rpc studio threads.move "$(jq -nc --arg t "$feature_thread" --arg p "$local_project" '{threadId:$t,projectId:$p}')" > "$WORK/N-local-move.json"
jq -e --arg env "$STUDIO_ENV" '.environmentId==$env and .handoffId==null' "$WORK/N-local-move.json" >/dev/null
ctl studio tool t3_thread_read "$(jq -nc --arg t "$feature_thread" '{threadId:$t,limit:1}')" | jq -e --arg p "$local_project" '.thread.projectId==$p' >/dev/null
# Another project has no GV representation: create a copy, wait, then move locally.
rexec worker mkdir -p "$feature_root-copy"
rexec worker git init -q "$feature_root-copy"
ctl worker tool t3_project_create "$(jq -nc --arg title "N-copy before move $RUN_TS" --arg path "$feature_root-copy" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-copy-project.json"
copy_project=$(jq -r '.id' "$WORK/N-copy-project.json")
ctl worker place "N-copy before move $RUN_TS" --on "$WORKER_ENV" --primary --path "$feature_root-copy" --json > "$WORK/N-copy-primary.json"
wait_converged 'N project before creating its local copy'
ctl worker place "$copy_project" --on "$STUDIO_ENV" --path "$feature_root-copy-local" --wait 120 --json > "$WORK/N-copy-local.json"
copy_local=$(jq -er '.representation.projectId' "$WORK/N-copy-local.json")
ws_rpc studio threads.move "$(jq -nc --arg t "$feature_thread" --arg p "$copy_local" '{threadId:$t,projectId:$p}')" > "$WORK/N-copy-move.json"
jq -e --arg env "$STUDIO_ENV" '.environmentId==$env and .handoffId==null' "$WORK/N-copy-move.json" >/dev/null
ctl studio tool t3_thread_read "$(jq -nc --arg t "$feature_thread" '{threadId:$t,limit:1}')" | jq -e --arg p "$copy_local" '.thread.projectId==$p' >/dev/null
# Adopt only our own foreign-daemon session. Keep it until private sync watches.
rexec worker mkdir -p "$feature_root-adopt"
rexec worker git init -q "$feature_root-adopt"
rexec studio mkdir -p "$feature_root-adopt-target"
rexec worker sh -c "printf 'N-baseline' > '$feature_root-adopt/both'"
ctl worker tool t3_project_create "$(jq -nc --arg title "N-adoption $RUN_TS" --arg path "$feature_root-adopt" '{title:$title,workspaceRoot:$path}')" > "$WORK/N-adopt-project.json"
ctl worker place "N-adoption $RUN_TS" --on "$WORKER_ENV" --primary --path "$feature_root-adopt" --json > "$WORK/N-adopt-primary.json"
wait_converged 'N project before adoption'
# Reversed endpoints exercise adoption from GV's daemon with its existing SSH route.
foreign_name="N-adopt-$RUN_TS"
foreign_home="$STUDIO_BASE_DIR/home"
test "$foreign_home" != "$HOME" || die 'Adoption requires an isolated server HOME'
node - "$(systemctl --user show -p MainPID --value "$STUDIO_UNIT")" "$foreign_home" <<'JS'
const fs=require('node:fs');
const [pid,home]=process.argv.slice(2);
if(!fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').includes(`HOME=${home}`)) throw Error('Foreign daemon HOME must match the isolated server');
JS
foreign_mut() { require_bed_lock || return 1; rexec studio env -u MUTAGEN_DATA_DIRECTORY HOME="$foreign_home" MUTAGEN_SSH_PATH="$STUDIO_BASE_DIR/mesh/ssh/bin" "$(mut_bin studio)" "$@"; }
gor_name=$(ws_rpc studio meshConfig.get '{}' | jq -er --arg env "$WORKER_ENV" '.bindings|to_entries[]|select(.value==$env)|.key')
foreign_mut sync create --name "$foreign_name" --mode two-way-safe --ignore-vcs --ignore .t3-conflicts "$feature_root-adopt-target" "t3-$gor_name:$feature_root-adopt" > "$WORK/N-foreign-created.log"
foreign_mut sync flush "$foreign_name" > "$WORK/N-foreign-flushed.log"
foreign_mut sync pause "$foreign_name" > "$WORK/N-foreign-paused.log"
rexec worker sh -c "printf 'N-adopt-loser' > '$feature_root-adopt/both'"
rexec studio sh -c "printf 'N-authority-wins' > '$feature_root-adopt-target/both'"
project_options "N-adoption $RUN_TS" '{"conflicts":"newest-wins"}' > "$WORK/N-adopt-policy.json"
rexec worker node -e 'require("node:fs").utimesSync(process.argv[1],1000000,1000000)' "$feature_root-adopt/both"
rexec studio node -e 'require("node:fs").utimesSync(process.argv[1],2000000,2000000)' "$feature_root-adopt-target/both"
ctl studio replica adopt "$foreign_name" --project "N-adoption $RUN_TS" --json > "$WORK/N-adopt-result.json"
adopt_key=$(jq -r '.logicalKey' "$WORK/N-adopt-result.json")
for _ in $(seq 1 180); do
  ws_get worker > "$WORK/N-adopt-layout.json"
  if jq -e --arg k "$adopt_key" --arg env "$STUDIO_ENV" '.config.projectMountStatus[$k][$env].state=="watching" and ([.config.projectMounts[$k][] | select(.environmentId==$env) | has("adoption")] == [false])' "$WORK/N-adopt-layout.json" >/dev/null; then break; fi
  sleep 1
done
jq -e --arg k "$adopt_key" --arg env "$STUDIO_ENV" '.config.projectMountStatus[$k][$env].state=="watching"' "$WORK/N-adopt-layout.json" >/dev/null
foreign_mut sync list --template '{{json .}}' > "$WORK/N-foreign-after.json"
jq -e --arg n "$foreign_name" 'all(.[]; .name!=$n)' "$WORK/N-foreign-after.json" >/dev/null
test "$(rexec studio cat "$feature_root-adopt-target/both")" = N-authority-wins
rexec worker sh -c "rg -l 'N-adopt-loser' '$feature_root-adopt/.t3-conflicts'" > "$WORK/N-adopt-copies.log"
test "$(rexec worker cat "$feature_root-adopt/both")" = N-authority-wins
wait_converged 'N feature acceptance after adoption'
. "$MESH_DIR/round3-live-regressions.sh"
printf 'PASS N features: explicit/refused paths, display titles, local/copy moves, ignores/transports, adopted conflict copies; evidence %s\n' "$WORK"

assert_feature_recovery() {
  test "$(rexec studio cat "$feature_root-explicit/both")" = N-source
  test "$(rexec studio cat "$feature_root-adopt-target/both")" = N-authority-wins
  test "$(rexec worker cat "$feature_root-adopt/both")" = N-authority-wins
  rexec worker sh -c "rg -l 'N-adopt-loser' '$feature_root-adopt/.t3-conflicts'" > "$WORK/N-adopt-copies-after-recovery.log"
  mut studio sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-feature-sessions-after.json"
  jq -e --arg a "$feature_root-explicit" --arg b "$feature_root-adopt-target" '[.[] | select(.beta.path==$a)]|length==1' "$WORK/N-feature-sessions-after.json" >/dev/null
  jq -e --arg b "$feature_root-adopt-target" '[.[] | select(.beta.path==$b)]|length==1' "$WORK/N-feature-sessions-after.json" >/dev/null
  foreign_mut sync list --template '{{json .}}' > "$WORK/N-foreign-after-recovery.json"
  jq -e --arg n "$foreign_name" 'all(.[]; .name!=$n)' "$WORK/N-foreign-after-recovery.json" >/dev/null
  assert_live_regression_recovery
}
