#!/usr/bin/env bash
# Real three-machine replica acceptance. Requires up.sh and round1.sh first.
# Evidence is retained outside the checkout; no live studio/Cloudbox access.
set -uo pipefail
export MESH_E2E_HELPERS_ONLY=1
export MESH_E2E_ROUND1_WORK="${MESH_E2E_ROUND2_WORK:-/tmp/t3-mesh-e2e-round2}"
. "$(dirname "$0")/round1.sh"
unset MESH_E2E_HELPERS_ONLY
export MESH_E2E_SSH_CONTROL_DIR="${MESH_E2E_SSH_CONTROL_DIR:-$WORK/round2-ssh}"
mkdir -p "$MESH_E2E_SSH_CONTROL_DIR"
chmod 700 "$MESH_E2E_SSH_CONTROL_DIR"
TIMEOUT=${MESH_E2E_ROUND2_TIMEOUT:-900}
RPC_TIMEOUT=${MESH_E2E_ROUND2_RPC_TIMEOUT:-900}
PASS=0; FAIL=0; FAILED=()
CTL="$HOME/.agents/skills/t3-next/scripts/t3ctl.mjs"
for m in nodeA nodeB cloud; do
  cat > "$WORK/t3-$m" <<EOF
#!/usr/bin/env bash
export PATH=$NODE_B_NODE_BIN_DIR:\$PATH
. '$MESH_DIR/lib.sh'
load_build_env
case '$m' in
 nodeA) exec '$NODE_A_RUNTIME_ROOT/$BUILD_VERSION/t3' "\$@" ;;
 nodeB) printf -v args '%q ' "\$@"; nodeB_ssh "export PATH=$NODE_B_NODE_BIN_DIR:\$PATH; $NODE_B_BIN \$args" ;;
 cloud) printf -v args '%q ' "\$@"; cloud_ssh "docker exec t3-mesh-e2e node $CLOUD_BIN \$args" ;;
esac
EOF
  chmod 700 "$WORK/t3-$m"
done
ctl() {
 local machine=$1; shift
 local base="$NODE_A_BASE_DIR"
 case "$machine" in nodeB) base="$NODE_B_BASE_DIR";; cloud) base=/home/t3/.t3;; esac
 XDG_CONFIG_HOME="$WORK/auth-$machine" T3CODE_HOME="$base" T3CTL_ORIGIN="$(origin_of "$machine")" T3CTL_T3_BIN="$WORK/t3-$machine" timeout "$RPC_TIMEOUT" node "$CTL" "$@"
}
tool() { local machine=$1 name=$2; shift 2; ctl "$machine" tool "$name" "$@"; }
all_projects() {
 local machine=$1 cursor merged="$WORK/all-projects-$1.json" next="$WORK/next-projects-$1.json"
 tool "$machine" t3_project_list '{"limit":100}' > "$merged" || return
 cursor=$(jq -r '.nextCursor // empty' "$merged") || return
 while [ -n "$cursor" ]; do
  tool "$machine" t3_project_list "$(jq -nc --argjson cursor "$cursor" '{limit:100,cursor:$cursor}')" > "$next" || return
  jq -s '{projects:(.[0].projects+.[1].projects),nextCursor:.[1].nextCursor}' "$merged" "$next" > "$merged.tmp" || return
  mv "$merged.tmp" "$merged" || return
  cursor=$(jq -r '.nextCursor // empty' "$merged") || return
 done
 cat "$merged"
}
probe() {
 local name=$1; shift
 local start; start=$(now_ms)
 if "$@" > "$WORK/$name.out" 2>&1; then record_pass "$name" "$(elapsed_ms "$start")ms"; else record_fail "$name" "$(elapsed_ms "$start")ms; $WORK/$name.out: $(tail -c 450 "$WORK/$name.out")"; fi
}
vexec() { local args; printf -v args '%q ' "$@"; cloud_ssh "docker exec t3-mesh-e2e $args"; }
wait_ssh() {
 local deadline=$((SECONDS+TIMEOUT)) ssh_result=1
 while [ "$SECONDS" -lt "$deadline" ]; do
  "$@" && return 0
  ssh_result=$?
  sleep 1
 done
 return "$ssh_result"
}
mut() { vexec env MUTAGEN_DATA_DIRECTORY=/home/t3/.t3/mutagen /home/t3/.t3/bin/mutagen "$@"; }
T_NODE_A=$(mint_token nodeA); T_NODE_B=$(mint_token nodeB); T_CLOUD=$(mint_token cloud)
NODE_A_ENV=$(descriptor_env "$NODE_A_ORIGIN"); NODE_B_ENV=$(descriptor_env "$NODE_B_ORIGIN"); CLOUD_ENV=$(descriptor_env "$CLOUD_ORIGIN")
printf 'build=%s environments nodeA=%s nodeB=%s cloud=%s evidence=%s\n' "$BUILD_VERSION" "$NODE_A_ENV" "$NODE_B_ENV" "$CLOUD_ENV" "$WORK"
probe installer-disable ws_rpc cloud server.updateSettings '{"patch":{"replicasEnabled":false}}'
probe installer-clean vexec sh -c 'if test -d /home/t3/.t3/bin; then mv /home/t3/.t3/bin "/home/t3/.t3/bin.before-round2-$1"; fi; test ! -e /home/t3/.t3/bin/mutagen' sh "$RUN_TS"
for m in nodeA nodeB cloud; do probe "enable-$m" ws_rpc "$m" server.updateSettings '{"patch":{"meshEnabled":true,"linkedEnvironmentsEnabled":true,"replicasEnabled":true,"mutagenPath":""}}'; done
ws_rpc nodeB meshConfig.get '{}' > "$WORK/routes-config.json"
NODE_A_NAME=$(jq -er --arg id "$NODE_A_ENV" '.bindings|to_entries[]|select(.value==$id)|.key' "$WORK/routes-config.json")
NODE_B_NAME=$(jq -er --arg id "$NODE_B_ENV" '.bindings|to_entries[]|select(.value==$id)|.key' "$WORK/routes-config.json")
CLOUD_NAME=$(jq -er --arg id "$CLOUD_ENV" '.bindings|to_entries[]|select(.value==$id)|.key' "$WORK/routes-config.json")
jq --arg nodeA "$NODE_A_NAME" --arg nodeB "$NODE_B_NAME" --arg cloud "$CLOUD_NAME" '.current.doc | .ssh = {mode:"managed"} | .machines |= with_entries(.value.ssh = {}) | .machines[$nodeA].label = "NODE_A" | .machines[$nodeB].label = "GR" | .machines[$cloud].label = "VP"' "$WORK/routes-config.json" > "$WORK/routes-doc.json"
BASE=$(jq -er '.current.revision' "$WORK/routes-config.json")
probe routes ws_rpc nodeB meshConfig.apply "$(jq -nc --slurpfile doc "$WORK/routes-doc.json" --arg base "$BASE" '{doc:$doc[0],baseRevision:$base}')"
wait_converged 'routes converge'
probe route-nodeA-nodeB wait_ssh ssh -F "$NODE_A_BASE_DIR/home/.ssh/config" -o BatchMode=yes -o ConnectTimeout=10 "t3-$NODE_B_NAME" hostname
probe route-cloud-nodeB wait_ssh vexec ssh -o BatchMode=yes -o ConnectTimeout=10 "t3-$NODE_B_NAME" hostname
probe route-cloud-nodeA wait_ssh vexec ssh -o BatchMode=yes -o ConnectTimeout=10 "t3-$NODE_A_NAME" hostname
printf -v nodeB_ssh_config '%q' "$NODE_B_BASE_DIR/home/.ssh/config"
probe route-nodeB-cloud wait_ssh nodeB_ssh "ssh -F $nodeB_ssh_config -o BatchMode=yes -o ConnectTimeout=10 t3-$CLOUD_NAME hostname"
if ! ws_rpc nodeB peerLinks.list '{}' | jq -e --arg e "$NODE_A_ENV" '.links[] | select(.environmentId==$e and .access=="full-access")' > "$WORK/nodeB-nodeA-link.json"; then
 code=$(pair_code nodeA)
 probe link-nodeB-nodeA ws_rpc nodeB peerLinks.link "$(jq -nc --arg code "$code" --arg e "$NODE_A_ENV" --arg url "http://127.0.0.1:$NODE_A_LOCAL" '{url:$url,pairingCode:$code,access:"full-access",expectedEnvironmentId:$e}')"
fi

probe projects all_projects nodeB
DEMO=$(jq -r --arg root "$NODE_B_DEMO_DIR" '.. | objects | select(.workspaceRoot? == $root) | .id' "$WORK/projects.out" | head -1)
if [ -z "$DEMO" ]; then
 probe register-demo tool nodeB t3_project_create "$(jq -nc --arg root "$NODE_B_DEMO_DIR" '{title:"demo",workspaceRoot:$root}')"
 DEMO=$(jq -r '.id // empty' "$WORK/register-demo.out")
fi
KEY=$(node --input-type=module -e 'import {createHash} from "node:crypto"; console.log("lp-"+createHash("sha256").update(process.argv[1]).digest("hex"))' "$NODE_B_ENV:${NODE_B_DEMO_DIR}")
MARK="round2-$RUN_TS"
LAUNCH=$(jq -nc --arg p "$DEMO" --arg e "$CLOUD_ENV" --arg key "$MARK-a" --arg msg "In your current working directory on this CLOUD replica, use a local shell command to append the exact line $MARK-a to README.md. Mutagen syncs this local edit back to nodeB. Do not access the primary, request a machine link, run git, or create other files. Finish after making the local edit." '{projectId:$p,environmentId:$e,clientRequestId:$key,title:$key,message:$msg,modelSelection:{instanceId:"codex",model:"gpt-6-luna"},runtimeMode:"full-access"}')
wait_replica() {
 local m=$1 key=$2 env=$3 state=$4 copies=${5:-} deadline=$((SECONDS+TIMEOUT))
 while [ "$SECONDS" -lt "$deadline" ]; do
  ws_rpc "$m" replicas.status '{}' --first > "$WORK/status-$m.json" || return
  if jq -e --arg k "$key" --arg e "$env" --arg s "$state" --arg copies "$copies" '.. | objects | select(.logicalKey?==$k and .environmentId?==$e and .state?==$s and ($copies=="" or (.conflictCopies.path? // "")!=""))' "$WORK/status-$m.json" >/dev/null; then cat "$WORK/status-$m.json"; return 0; fi
  sleep 2
 done
 cat "$WORK/status-$m.json"; return 1
}
probe f-transfer-fixture nodeB_ssh "head -c 134217728 /dev/urandom > '$NODE_B_DEMO_DIR/round2-transfer.bin'"
launch_start=$(now_ms)
tool nodeB t3_thread_launch "$LAUNCH" > "$WORK/a-mcp-launch.out" 2>&1 &
launch_pid=$!
probe f-mid-mount wait_replica cloud "$KEY" "$CLOUD_ENV" mounting
probe f-mid-mount-restart cloud_ssh 'docker restart t3-mesh-e2e'
probe f-mid-mount-health wait_health "$CLOUD_ORIGIN" 60
if wait "$launch_pid"; then record_pass a-mcp-launch "$(elapsed_ms "$launch_start")ms including mid-mount restart"; else record_fail a-mcp-launch "see $WORK/a-mcp-launch.out"; fi
probe a-machines tool nodeB t3_project_machines "$(jq -nc --arg p "$KEY" '{project:$p}')"
VPATH=$(jq -r --arg e "$CLOUD_ENV" '.representations[]? | select(.environmentId==$e) | .path' "$WORK/a-machines.out")
probe a-watching wait_replica cloud "$KEY" "$CLOUD_ENV" watching
transfer_checksum() {
 local source_file quoted_source expected actual
 source_file=$(jq -r --arg e "$NODE_B_ENV" '.representations[] | select(.environmentId==$e) | .path' "$WORK/a-machines.out")/round2-transfer.bin
 printf -v quoted_source '%q' "$source_file"
 expected=$(nodeB_ssh "sha256sum $quoted_source" | cut -d' ' -f1) || return
 actual=$(vexec sha256sum "$VPATH/round2-transfer.bin" | cut -d' ' -f1) || return
 printf '128 MiB primary=%s replica=%s\n' "$expected" "$actual"
 [ "$expected" = "$actual" ] && [ "$(vexec stat -c %s "$VPATH/round2-transfer.bin")" = 134217728 ]
}
probe a-transfer-checksum transfer_checksum
probe a-installer vexec sh -c 'test "$(/home/t3/.t3/bin/mutagen version)" = 0.18.1 && sha256sum /home/t3/.t3/bin/mutagen'
probe a-excludes vexec sh -c "test -f '$VPATH/README.md' && test ! -e '$VPATH/.git' && test ! -e '$VPATH/node_modules'"
wait_edit() {
 local marker=$1 deadline=$((SECONDS+TIMEOUT))
 while [ "$SECONDS" -lt "$deadline" ]; do
  if nodeB_ssh "grep -F '$marker' ${NODE_B_DEMO_DIR}/README.md"; then return 0; fi
  sleep 2
 done
 return 1
}
probe a-agent-edit wait_edit "$MARK-a"
probe f-transfer-cleanup nodeB_ssh "rm -f '$NODE_B_DEMO_DIR/round2-transfer.bin'"
probe b-cli-launch ctl nodeB new --project demo --on "$CLOUD_ENV" --agent codex --model gpt-6-luna --title "$MARK-b" "Use a local shell command in your current CLOUD replica directory to append the exact line $MARK-b to README.md. Mutagen syncs the edit to nodeB. Do not access the primary, request a link, run git, or create other files. Finish after making the local edit."
probe b-agent-edit wait_edit "$MARK-b"
# Reverse source endpoint runs through docker exec; no ssh daemon in the container.
probe c-cloud-source vexec sh -c 'mkdir -p /home/t3/round2-primary; cd /home/t3/round2-primary; test -d .git || git init -q; printf "reverse primary\n" > README.md; mkdir -p node_modules; touch node_modules/excluded'
probe c-projects all_projects cloud
cp "$WORK/c-projects.out" "$WORK/cloud-projects.json"
REV=$(jq -r '.. | objects | select(.workspaceRoot?=="/home/t3/round2-primary") | .id' "$WORK/cloud-projects.json" | head -1)
if [ -z "$REV" ]; then
 probe c-register tool cloud t3_project_create '{"title":"round2-primary","workspaceRoot":"/home/t3/round2-primary"}'
 REV=$(jq -r '.id // empty' "$WORK/c-register.out")
else
 probe c-register jq -e --arg id "$REV" '.. | objects | select(.id?==$id)' "$WORK/cloud-projects.json"
fi
probe c-place tool cloud t3_project_place "$(jq -nc --arg p "$REV" --arg m "$NODE_A_ENV" '{project:$p,machine:$m,wait:90}')"
REV_KEY=$(node --input-type=module -e 'import {createHash} from "node:crypto"; console.log("lp-"+createHash("sha256").update(process.argv[1]).digest("hex"))' "$CLOUD_ENV:/home/t3/round2-primary")
probe c-watching wait_replica nodeA "$REV_KEY" "$NODE_A_ENV" watching
CPATH=$(jq -r '.representation.path' "$WORK/c-place.out")
reverse_files() { test -f "$CPATH/README.md" && test ! -e "$CPATH/.git" && test ! -e "$CPATH/node_modules" && grep -F 'reverse primary' "$CPATH/README.md"; }
probe c-files reverse_files
# Independent second primary of demo.
checkout_demo() {
 local ssh_command
 printf -v ssh_command '%q ' ssh -F "$NODE_B_SSH_CONFIG" -i "$NODE_B_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no
 if [ ! -d /tmp/t3-mesh-round2-primary/.git ]; then
  GIT_SSH_COMMAND="$ssh_command" git clone -q "$NODE_B_HOST:${NODE_B_DEMO_DIR}" /tmp/t3-mesh-round2-primary || return
 fi
 git -C /tmp/t3-mesh-round2-primary rev-parse --is-inside-work-tree
}
probe d-checkout checkout_demo
probe d-place tool nodeB t3_project_place "$(jq -nc --arg p "$KEY" --arg m "$NODE_A_ENV" '{project:$p,machine:$m,role:"primary",path:"/tmp/t3-mesh-round2-primary",wait:90}')"
wait_converged 'three representations converge'
ws_get nodeB > "$WORK/grouping.json"
grouping() (
 cd "$REPO_ROOT" || exit
 node --input-type=module - "$WORK/grouping.json" "$KEY" <<'JS'
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert.default;
import * as NodeFS from "node:fs";
const { readFileSync } = NodeFS;
import { resolveLogicalProjectKey } from "./packages/client-runtime/src/state/meshLayout/logicalProjects.ts";
import { buildProjectGroups } from "./packages/client-runtime/src/state/projectGrouping.ts";
const [file, key] = process.argv.slice(2);
const { config } = JSON.parse(readFileSync(file, "utf8"));
const reps = config.projectMounts[key];
assert.equal(reps.length, 3);
assert.equal(reps.filter((rep) => rep.role === "primary").length, 2);
assert.equal(
  new Set(
    reps.map((rep) =>
      resolveLogicalProjectKey(
        { environmentId: rep.environmentId, workspaceRoot: rep.path },
        config,
        () => "unmatched",
      ),
    ),
  ).size,
  1,
);
assert(reps.every((rep) => rep.projectId));
console.log(JSON.stringify(reps));

const projects = reps.map((rep) => ({
  environmentId: rep.environmentId,
  id: rep.projectId,
  workspaceRoot: rep.path,
  title: "demo",
  repositoryIdentity: null,
  createdAt: rep.createdAt,
  updatedAt: rep.createdAt,
  pinned: false,
  archivedAt: null,
}));
const groups = buildProjectGroups({
  projects,
  layout: config,
  settings: {
    sidebarProjectGroupingMode: "separate",
    sidebarProjectGroupingOverrides: {},
  },
});
assert.equal(groups.length, 1);
assert.equal(groups[0].key, key);
assert.equal(groups[0].members.length, 3);
console.log("one sidebar group, three physical representations");
JS
)
probe d-grouping grouping
probe sessions mut sync list --label-selector t3-logical --template '{{json .}}'
SESSION=$(jq -r --arg path "$VPATH" '.[] | select(.beta.path==$path) | .name' "$WORK/sessions.out")
probe e-quiesce ws_rpc cloud server.updateSettings '{"patch":{"replicasEnabled":false}}'
probe e-drain cloud_ssh 'docker restart t3-mesh-e2e'
probe e-health wait_health "$CLOUD_ORIGIN" 60
probe e-ssh-ready wait_ssh vexec ssh -o BatchMode=yes -o ConnectTimeout=10 "t3-$NODE_B_NAME" true
probe e-pause mut sync pause "$SESSION"
probe e-alpha nodeB_ssh "printf 'alpha-$MARK\n' > ${NODE_B_DEMO_DIR}/round2-conflict.txt"
probe e-beta vexec sh -c "printf 'beta-$MARK\n' > '$VPATH/round2-conflict.txt'"
probe e-resume mut sync resume "$SESSION"
probe e-enable ws_rpc cloud server.updateSettings '{"patch":{"replicasEnabled":true}}'
probe e-recovered wait_replica cloud "$KEY" "$CLOUD_ENV" watching copies
probe e-flush mut sync flush "$SESSION"
probe e-content vexec grep -F "alpha-$MARK" "$VPATH/round2-conflict.txt"
probe e-preserved-loser vexec sh -c 'find "$1/.t3-conflicts" -type f -name round2-conflict.txt -exec cat {} \; | grep -F "$2"' sh "$VPATH" "beta-$MARK"
wait_converged "resolved conflict status converges before placement retries"
for n in 1 2; do probe "f-place-$n" tool nodeB t3_project_place "$(jq -nc --arg p "$KEY" --arg m "$CLOUD_ENV" '{project:$p,machine:$m,wait:90}')"; probe "f-launch-$n" tool nodeB t3_thread_launch "$LAUNCH"; done
probe f-one-launch node --input-type=module -e 'import{readFileSync}from"node:fs";import assert from"node:assert/strict";const a=JSON.parse(readFileSync(process.argv[1])),b=JSON.parse(readFileSync(process.argv[2]));assert(a.threadId);assert.equal(a.threadId,b.threadId);console.log(a.threadId)' "$WORK/f-launch-1.out" "$WORK/f-launch-2.out"
probe f-restart cloud_ssh 'docker restart t3-mesh-e2e'
probe f-health wait_health "$CLOUD_ORIGIN" 60
probe f-recovered wait_replica cloud "$KEY" "$CLOUD_ENV" watching
probe f-sessions mut sync list --label-selector t3-logical --template '{{json .}}'
probe f-projects all_projects cloud
probe f-one-project jq -e --arg path "$VPATH" '[.. | objects | select(.workspaceRoot?==$path)] | length==1' "$WORK/f-projects.out"
probe f-one-session jq -e --arg s "$SESSION" '[.[]|select(.name==$s)]|length==1' "$WORK/f-sessions.out"
NODE_A_PROJECT=$(jq -r --arg e "$NODE_A_ENV" --arg k "$KEY" '.config.projectMounts[$k][] | select(.environmentId==$e) | .projectId' "$WORK/grouping.json")
for m in nodeA nodeB; do
 case "$m" in nodeA) p=$NODE_A_PROJECT;; nodeB) p=$DEMO;; esac
 probe "h-fixture-$m" tool "$m" t3_thread_launch "$(jq -nc --arg p "$p" --arg t "$MARK-$m" '{projectId:$p,title:$t,modelSelection:{instanceId:"codex",model:"gpt-6-luna"}}')"
done
for m in nodeA nodeB cloud; do
 case "$m" in nodeA) e=$NODE_A_ENV; path=/tmp/t3-mesh-round2-primary/README.md;; nodeB) e=$NODE_B_ENV; path=${NODE_B_DEMO_DIR}/README.md;; cloud) e=$CLOUD_ENV; path=$VPATH/README.md;; esac
 probe "h-cat-$m" ctl nodeB cat "$path" --on "$e"
 probe "h-open-$m" ctl nodeB open-file "$path" --on "$e"
 probe "h-open-target-$m" grep -F "$e" "$WORK/h-open-$m.out"
 probe "h-cat-content-$m" grep -F 'mesh e2e demo' "$WORK/h-cat-$m.out"
done
probe h-find ctl nodeB find round2 --all
probe h-status ctl nodeB status --all
probe h-machines ctl nodeB machines
probe h-mesh ctl nodeB mesh status
for command in find status machines mesh; do
 for tag in NODE_A GR VP; do probe "h-$command-tag-$tag" grep -w "$tag" "$WORK/h-$command.out"; done
done
probe i-prompt vexec sh -c 'files=$(rg -l "$1" /home/t3/.codex/sessions); test -n "$files" && printf "%s\n" "$files" | xargs rg -l "Run git and builds on |t3 run"' sh "$MARK-a"
probe g-remove tool nodeB t3_project_place "$(jq -nc --arg p "$KEY" --arg m "$CLOUD_ENV" '{project:$p,machine:$m,action:"remove"}')"
wait_gone() {
 local deadline=$((SECONDS+TIMEOUT))
 while [ "$SECONDS" -lt "$deadline" ]; do
  mut sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/removed-sessions.json" || return
  if jq -e --arg s "$SESSION" 'all(.[];.name!=$s)' "$WORK/removed-sessions.json" >/dev/null; then return 0; fi
  sleep 2
 done
 return 1
}
probe g-terminated wait_gone
probe g-files-kept vexec test -f "$VPATH/README.md"
probe g-project-list all_projects cloud
probe g-project-kept jq -e --arg path "$VPATH" '.. | objects | select(.workspaceRoot?==$path)' "$WORK/g-project-list.out"
probe g-orphan-create vexec sh -c 'mkdir -p /home/t3/round2-orphan-a /home/t3/round2-orphan-b; export MUTAGEN_DATA_DIRECTORY=/home/t3/.t3/mutagen; if /home/t3/.t3/bin/mutagen sync list --label-selector t3-env=orphan --template "{{json .}}" | jq -e "length > 0"; then exit 0; fi; /home/t3/.t3/bin/mutagen sync create --name round2-orphan -l t3-logical=deadbeef -l t3-env=orphan /home/t3/round2-orphan-a /home/t3/round2-orphan-b'
wait_orphan() {
 local deadline=$((SECONDS+TIMEOUT))
 while [ "$SECONDS" -lt "$deadline" ]; do
  ws_rpc cloud replicas.status '{}' --first > "$WORK/orphan-status.json" || return
  if jq -e '.. | objects | select(.sessionName?=="round2-orphan" and (.message? | startswith("Orphan session")))' "$WORK/orphan-status.json"; then return; fi
  sleep 2
 done
 return 1
}
probe g-orphan-reported wait_orphan
probe g-orphan-list mut sync list --label-selector t3-env=orphan --template '{{json .}}'
probe g-orphan-kept jq -e 'length==1 and .[0].name=="round2-orphan"' "$WORK/g-orphan-list.out"
printf '\nPASS: %d FAIL: %d\n' "$PASS" "$FAIL"
for name in "${FAILED[@]}"; do printf 'FAIL %s evidence=%s/%s.out\n' "$name" "$WORK" "$name"; done
[ "$FAIL" = 0 ]
