#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
export MESH_E2E_HELPERS_ONLY=1 MESH_E2E_ROUND1_WORK="${MESH_E2E_STAGE_M_WORK:-/tmp/stage-m-e2e}"
cd "$(dirname "$0")/../.."
. scripts/mesh-e2e/round1.sh
set -e
unset MESH_E2E_HELPERS_ONLY
CTL="$HOME/.agents/skills/t3-next/scripts/t3ctl.mjs"
for m in gv gor vps; do
cat > "$WORK/t3-$m" <<WRAP
#!/usr/bin/env bash
export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH
. '$MESH_DIR/lib.sh'
case '$m' in
 gv) exec '$GV_RUNTIME_ROOT/$BUILD_VERSION/t3' "\$@" ;;
 gor) printf -v args '%q ' "\$@"; gor_ssh "export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH; $GOR_BIN \$args" ;;
 vps) printf -v args '%q ' "\$@"; vps_ssh "docker exec t3-mesh-e2e node $VPS_BIN \$args" ;;
esac
WRAP
chmod 700 "$WORK/t3-$m"
done
ctl() {
 local m=$1; shift
 local base="$GV_BASE_DIR"
 case "$m" in gor) base=/home/user/.t3-sidebar-server;; vps) base=/home/t3/.t3;; esac
 XDG_CONFIG_HOME="$WORK/auth-$m" T3CODE_HOME="$base" T3CTL_ORIGIN="$(origin_of "$m")" T3CTL_T3_BIN="$WORK/t3-$m" timeout 210 node "$CTL" "$@"
}
tool() { local m=$1 name=$2; shift 2; ctl "$m" tool "$name" "$@"; }
MARK=stage-m-$(date +%s)
tool vps t3_project_list '{"limit":100}' > "$WORK/vps-projects.json"
PROJECT=$(jq -r '.projects[] | select(.workspaceRoot | contains("demo")) | .id' "$WORK/vps-projects.json" | head -1)
[ -n "$PROJECT" ] || { echo 'Missing demo replica on VPS'; exit 1; }
tool vps t3_thread_launch "$(jq -nc --arg p "$PROJECT" --arg mark "$MARK-self" '{projectId:$p,title:$mark,clientRequestId:$mark,modelSelection:{instanceId:"codex",model:"gpt-6-luna"},runtimeMode:"full-access",message:"Call t3_thread_self exactly once. Then report JSON containing representation.role, primary machine label/path, sync sessionName and state from that result. Do nothing else."}')" > "$WORK/vps-launch.json"
VPS_THREAD=$(jq -r .threadId "$WORK/vps-launch.json")
tool vps t3_thread_wait "$(jq -nc --arg t "$VPS_THREAD" '{threadId:$t,timeoutMs:180000}')" > "$WORK/self-wait.json"
tool vps t3_thread_read "$(jq -nc --arg t "$VPS_THREAD" '{threadId:$t,view:"messages",limit:100,maxCharsPerItem:16000}')" > "$WORK/self-read.json"
jq -e '[.items[] | select(.type=="assistant_message") | .text] | join(" ") | contains("replica") and (ascii_downcase | contains("gor"))' "$WORK/self-read.json" >/dev/null
printf 'PASS VPS agent self role replica + gor primary; thread=%s\n' "$VPS_THREAD"
MESSAGE="Call t3_thread_list with environmentId all. Then call t3_thread_send with threadId $VPS_THREAD and WITHOUT environmentId, message: Reply exactly $MARK-reply. Wait for that thread using t3_thread_wait by id only, then read it using t3_thread_read by id only. Finish by reporting its answer. Do not run shell commands."
tool gv t3_thread_launch "$(jq -nc --arg mark "$MARK-drive" --arg msg "$MESSAGE" '{scratch:true,title:$mark,clientRequestId:$mark,modelSelection:{instanceId:"codex",model:"gpt-6-luna"},runtimeMode:"full-access",message:$msg}')" > "$WORK/gv-launch.json"
GV_THREAD=$(jq -r .threadId "$WORK/gv-launch.json")
tool gv t3_thread_wait "$(jq -nc --arg t "$GV_THREAD" '{threadId:$t,timeoutMs:180000}')" > "$WORK/drive-wait.json"
tool gv t3_thread_read "$(jq -nc --arg t "$GV_THREAD" '{threadId:$t,view:"messages",limit:100,maxCharsPerItem:16000}')" > "$WORK/drive-read.json"
jq -e --arg mark "$MARK-reply" '[.items[] | select(.type=="assistant_message") | .text] | join(" ") | contains($mark)' "$WORK/drive-read.json" >/dev/null
printf 'PASS GV agent all-list + remote send/read by id, received reply; thread=%s\n' "$GV_THREAD"
tool gv t3_thread_read "$(jq -nc --arg t "$GV_THREAD" '{threadId:$t,view:"activity",limit:100,maxCharsPerItem:16000,expand:"all"}')" > "$WORK/drive-activity.json"
printf 'Evidence: %s\n' "$WORK"
