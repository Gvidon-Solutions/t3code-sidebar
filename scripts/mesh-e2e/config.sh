#!/usr/bin/env bash
# Config acceptance on an already deployed bed; leaves only C1-prefixed fixtures.
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
export MESH_E2E_HELPERS_ONLY=1
export MESH_E2E_ROUND1_WORK="${MESH_E2E_CONFIG_WORK:-/tmp/t3-mesh-e2e-C1}"
. "$(dirname "$0")/round1.sh"
set -euo pipefail
unset MESH_E2E_HELPERS_ONLY
BED_LOCK_OWNER=${MESH_E2E_LOCK_OWNER:-C1}
[ "$(worker_ssh 'cat /tmp/mesh-bed.lock/owner')" = "$BED_LOCK_OWNER" ] || die "acquire the $BED_LOCK_OWNER bed lock first"
chmod 700 "$WORK"
CTL="$REPO_ROOT/agent-kit/skills/t3/scripts/t3ctl.mjs"
WORKER_DATA_DIR="$WORKER_BASE_DIR"
for machine in worker cloudbox; do
  cat > "$WORK/t3-$machine" <<EOF
#!/usr/bin/env bash
export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH
. '$MESH_DIR/lib.sh'
load_build_env
printf -v args '%q ' "\$@"
case '$machine' in
  worker) worker_ssh "$WORKER_BIN \$args" ;;
  cloudbox) cloudbox_ssh "docker exec t3-mesh-e2e node $CLOUDBOX_BIN \$args" ;;
esac
EOF
  chmod 700 "$WORK/t3-$machine"
done
ctl() {
  local machine=$1
  local base
  shift
  case "$machine" in worker) base=$WORKER_DATA_DIR ;; cloudbox) base=/home/t3/.t3 ;; esac
  XDG_CONFIG_HOME="$WORK/auth-$machine" T3CODE_HOME="$base" T3CTL_ORIGIN="$(origin_of "$machine")" \
    T3CTL_T3_BIN="$WORK/t3-$machine" node "$CTL" "$@"
}
vexec() {
  local command
  printf -v command '%q ' "$@"
  cloudbox_ssh "docker exec t3-mesh-e2e $command"
}
T_GV=$(mint_token studio)
T_GOR=$(mint_token worker)
T_VPS=$(mint_token cloudbox)
WORKER_ENV=$(descriptor_env "$WORKER_ORIGIN")
CLOUDBOX_ENV=$(descriptor_env "$CLOUDBOX_ORIGIN")
TITLE="C1-config-$RUN_TS"
ROOT="/tmp/$TITLE"
worker_ssh "mkdir -p '$ROOT/node_modules'; git init -q '$ROOT'; printf '%s\\n' '$TITLE' > '$ROOT/README.md'; printf 'node_modules/\\n' > '$ROOT/.gitignore'; printf 'ignored\\n' > '$ROOT/node_modules/private'; git -C '$ROOT' rev-parse --is-inside-work-tree"
ctl worker tool t3_project_create "$(jq -nc --arg title "$TITLE" --arg root "$ROOT" '{title:$title,workspaceRoot:$root}')" > "$WORK/project.json"
PROJECT=$(jq -er '.id' "$WORK/project.json")
ctl worker tool t3_project_place "$(jq -nc --arg project "$PROJECT" --arg machine "$WORKER_ENV" --arg path "$ROOT" '{project:$project,machine:$machine,role:"primary",path:$path}')" > "$WORK/primary.json"
ctl worker mesh config get --json > "$WORK/before.json"
TARGET=$(jq -er --arg env "$CLOUDBOX_ENV" '.bindings|to_entries[]|select(.value==$env)|.key' "$WORK/before.json")
NEW_LABEL=$(jq -r --arg target "$TARGET" 'if .current.doc.machines[$target].label=="C1" then "C1+" else "C1" end' "$WORK/before.json")
ws_get worker > "$WORK/layout-before.json"
jq -e --arg title "$TITLE" --arg env "$CLOUDBOX_ENV" '
  .config as $c | [$c.projectTitles|to_entries[]|select(.value==$title)|.key] as $keys |
  [$keys[] as $key | $c.projectMounts[$key][]? | select(.environmentId==$env)] | length==0
' "$WORK/layout-before.json" >/dev/null || die 'an existing rule already placed this fixture; the new rule cannot be proved'
jq --arg target "$TARGET" --arg title "$TITLE" --arg label "$NEW_LABEL" '
  .current.doc | .machines[$target].title = ((.machines[$target].title // $target) + " C1") |
  .machines[$target].label = $label |
  .replicas.rules = ((.replicas.rules // []) + [{project:$title,on:$target,when:"always"}])
' "$WORK/before.json" > "$WORK/desired.json"
echo '$ t3ctl mesh config plan --file desired.json'
ctl worker mesh config plan --file "$WORK/desired.json" > "$WORK/plan.txt"
cat "$WORK/plan.txt"
ws_rpc worker meshConfig.plan "$(jq -nc --slurpfile doc "$WORK/desired.json" '{doc:$doc[0]}')" > "$WORK/ws-plan.json"
jq -e '.actions|length>0' "$WORK/ws-plan.json" >/dev/null
BASE=$(jq -er '.current.revision' "$WORK/before.json")
echo '$ t3ctl mesh config apply --file desired.json --base <observed revision>'
ctl worker mesh config apply --file "$WORK/desired.json" --base "$BASE" --json > "$WORK/applied.json"
jq '{revision, renamed: .doc.machines | to_entries | map(select((.value.title//"")|endswith(" C1"))) | map({name:.key,title:.value.title,label:.value.label}), rule: .doc.replicas.rules[-1]}' "$WORK/applied.json"
REVISION=$(jq -er '.revision' "$WORK/applied.json")
echo '$ meshConfig.apply (WS, same desired state, current base)'
ws_rpc worker meshConfig.apply "$(jq -nc --slurpfile doc "$WORK/desired.json" --arg base "$REVISION" '{doc:$doc[0],baseRevision:$base}')" > "$WORK/ws-applied.json"
REVISION=$(jq -er '.revision' "$WORK/ws-applied.json")
if ctl worker mesh config apply --file "$WORK/desired.json" --base "$BASE" > "$WORK/stale.txt" 2>&1; then
  die 'stale apply unexpectedly succeeded'
fi
jq -Rse --arg revision "$REVISION" '
  capture("(?<json>\\{.*\\})").json | fromjson |
  select(.reason=="stale_revision" and .current.revision==$revision and (.diff|type)=="array") |
  {reason,message,currentRevision:.current.revision,diff}
' "$WORK/stale.txt"
deadline=$((SECONDS + 180))
while :; do
  converged=1
  for machine in worker cloudbox studio; do
    ws_rpc "$machine" meshConfig.get '{}' > "$WORK/config-$machine.json"
    jq -e --arg revision "$REVISION" '.current.revision==$revision' "$WORK/config-$machine.json" >/dev/null || converged=0
  done
  ws_get cloudbox > "$WORK/layout-cloudbox.json"
  jq --arg title "$TITLE" --arg env "$CLOUDBOX_ENV" '
    .config as $c | [$c.projectTitles|to_entries[]|select(.value==$title)|.key] as $keys |
    [$keys[] as $key | $c.projectMounts[$key][]? |
      select(.environmentId==$env and .role=="replica" and .projectId!=null) |
      . + {state:$c.projectMountStatus[$key][$env].state} | select(.state=="watching")]
  ' "$WORK/layout-cloudbox.json" > "$WORK/replicas.json"
  if [ "$converged" = 1 ] && jq -e 'length==1' "$WORK/replicas.json" >/dev/null; then
    PATH_ON_TARGET=$(jq -er '.[0].path' "$WORK/replicas.json")
    if vexec sh -c 'test -f "$1/README.md" && test ! -e "$1/node_modules" && test ! -e "$1/.git" && grep -Fx -- "$2" "$1/README.md"' sh "$PATH_ON_TARGET" "$TITLE" > "$WORK/file-check.txt" 2> "$WORK/file-check.err"; then break; fi
  fi
  [ "$SECONDS" -lt "$deadline" ] || die 'config/replica convergence deadline exceeded'
  sleep 2
done
PATH_ON_TARGET=$(jq -er '.[0].path' "$WORK/replicas.json")
cat "$WORK/file-check.txt"
for machine in worker cloudbox; do
  echo "\$ meshConfig.get ($machine)"
  jq --arg target "$TARGET" '{revision:.current.revision,title:.current.doc.machines[$target].title,label:.current.doc.machines[$target].label}' "$WORK/config-$machine.json"
  ws_get "$machine" > "$WORK/layout-$machine.json"
  EXPECTED_TITLE=$(jq -er --arg target "$TARGET" '.machines[$target].title' "$WORK/desired.json")
  jq -e --arg env "$CLOUDBOX_ENV" --arg title "$EXPECTED_TITLE" --arg label "$NEW_LABEL" '.config.machines[$env].label==$title and .config.machines[$env].title==$title and .config.machines[$env].tag==$label' "$WORK/layout-$machine.json" >/dev/null
done
echo 'replica:'
jq '.[0]|{role,transport,path,state,registered:(.projectId!=null)}' "$WORK/replicas.json"
echo '$ t3ctl mesh config history'
ctl worker mesh config history --json > "$WORK/history.json"
jq '{revisions:(.revisions|length),latest:.revisions[0].revision}' "$WORK/history.json"
echo '$ t3ctl mesh status'
ctl worker mesh status --json > "$WORK/status.json"
ws_rpc worker meshConfig.status '{}' > "$WORK/ws-status.json"
jq -e '.servers|length>=2' "$WORK/ws-status.json" >/dev/null
jq -e '.configStatus.servers|length>=2' "$WORK/status.json" >/dev/null
jq '{servers:[.configStatus.servers[]|{environmentId,revision,states:[.actions[].state]|unique}]}' "$WORK/status.json"
echo "PASS C1 config rename, stale base refusal, three-server convergence and real replica ($TITLE)"
