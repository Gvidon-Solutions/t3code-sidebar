#!/usr/bin/env bash
set -euo pipefail
export MESH_E2E_HELPERS_ONLY=1 MESH_E2E_ROUND1_WORK="${MESH_E2E_STAGE_M_WORK:-/tmp/stage-m-e2e}"
cd "$(dirname "$0")/../.."
. scripts/mesh-e2e/round1.sh
set -e
unset MESH_E2E_HELPERS_ONLY
CTL="$HOME/.agents/skills/t3-next/scripts/t3ctl.mjs"
for m in nodeA nodeB cloud; do
cat > "$WORK/t3-$m" <<WRAP
#!/usr/bin/env bash
export PATH=$NODE_B_NODE_BIN_DIR:\$PATH
. '$MESH_DIR/lib.sh'
case '$m' in
 nodeA) exec '$NODE_A_RUNTIME_ROOT/$BUILD_VERSION/t3' "\$@" ;;
 nodeB) printf -v args '%q ' "\$@"; nodeB_ssh "export PATH=$NODE_B_NODE_BIN_DIR:\$PATH; $NODE_B_BIN \$args" ;;
 cloud) printf -v args '%q ' "\$@"; cloud_ssh "docker exec t3-mesh-e2e node $CLOUD_BIN \$args" ;;
esac
WRAP
chmod 700 "$WORK/t3-$m"
done
ctl() {
 local m=$1; shift
 local base="$NODE_A_BASE_DIR"
 case "$m" in nodeB) base=$NODE_B_BASE_DIR;; cloud) base=/home/t3/.t3;; esac
 XDG_CONFIG_HOME="$WORK/auth-$m" T3CODE_HOME="$base" T3CTL_ORIGIN="$(origin_of "$m")" T3CTL_T3_BIN="$WORK/t3-$m" timeout 210 node "$CTL" "$@"
}
tool() { local m=$1 name=$2; shift 2; ctl "$m" tool "$name" "$@"; }
MARK=stage-m-$(date +%s)
ctl cloud rpc meshLayout.get '{}' > "$WORK/layout.json"
CLOUD_ENV=$(descriptor_env "$CLOUD_ORIGIN")
PROJECT=$(jq -r --arg e "$CLOUD_ENV" --arg suffix ":$NODE_B_DEMO_DIR" '.config.projectMounts | to_entries[] | select(.key | endswith($suffix)) | .value[] | select(.environmentId==$e and .role=="replica") | .projectId' "$WORK/layout.json" | head -1)
[ -n "$PROJECT" ] || { echo 'Missing demo replica on CLOUD'; exit 1; }
tool cloud t3_thread_launch "$(jq -nc --arg p "$PROJECT" --arg mark "$MARK-self" '{projectId:$p,title:$mark,clientRequestId:$mark,modelSelection:{instanceId:"codex",model:"gpt-6-luna"},runtimeMode:"full-access",message:"Call t3_thread_self exactly once. Then report JSON containing representation.role, primary machine label/path, sync sessionName and state from that result. Do nothing else."}')" > "$WORK/cloud-launch.json"
CLOUD_THREAD=$(jq -r .threadId "$WORK/cloud-launch.json")
tool cloud t3_thread_wait "$(jq -nc --arg t "$CLOUD_THREAD" '{threadId:$t,timeoutMs:180000}')" > "$WORK/self-wait.json"
tool cloud t3_thread_read "$(jq -nc --arg t "$CLOUD_THREAD" '{threadId:$t,view:"messages",limit:100,maxCharsPerItem:16000}')" > "$WORK/self-read.json"
jq -e '[.items[] | select(.type=="assistant_message") | .text] | join(" ") | contains("replica") and (ascii_downcase | contains("nodeB"))' "$WORK/self-read.json" >/dev/null
tool cloud t3_thread_read "$(jq -nc --arg t "$CLOUD_THREAD" '{threadId:$t,view:"activity",limit:100,maxCharsPerItem:50000}')" > "$WORK/self-activity.json"
jq -e 'any(.items[]; .type=="dynamic_tool" and (.text | contains("t3_thread_self")) and ((.text | fromjson).output.representation.role=="replica"))' "$WORK/self-activity.json" >/dev/null
printf 'PASS CLOUD agent self role replica + nodeB primary; thread=%s\n' "$CLOUD_THREAD"
MESSAGE="Call t3_thread_list with environmentId all. Then call t3_thread_send with threadId $CLOUD_THREAD and WITHOUT environmentId, message: Reply exactly $MARK-reply. Wait for that thread using t3_thread_wait by id only, then read it using t3_thread_read by id only. Finish by reporting its answer. Do not run shell commands."
tool nodeA t3_thread_launch "$(jq -nc --arg mark "$MARK-drive" --arg msg "$MESSAGE" '{scratch:true,title:$mark,clientRequestId:$mark,modelSelection:{instanceId:"codex",model:"gpt-6-luna"},runtimeMode:"full-access",message:$msg}')" > "$WORK/nodeA-launch.json"
NODE_A_THREAD=$(jq -r .threadId "$WORK/nodeA-launch.json")
tool nodeA t3_thread_wait "$(jq -nc --arg t "$NODE_A_THREAD" '{threadId:$t,timeoutMs:180000}')" > "$WORK/drive-wait.json"
tool nodeA t3_thread_read "$(jq -nc --arg t "$NODE_A_THREAD" '{threadId:$t,view:"messages",limit:100,maxCharsPerItem:16000}')" > "$WORK/drive-read.json"
jq -e --arg mark "$MARK-reply" '[.items[] | select(.type=="assistant_message") | .text] | join(" ") | contains($mark)' "$WORK/drive-read.json" >/dev/null
printf 'PASS NODE_A agent all-list + remote send/read by id, received reply; thread=%s\n' "$NODE_A_THREAD"
tool nodeA t3_thread_read "$(jq -nc --arg t "$NODE_A_THREAD" '{threadId:$t,view:"activity",limit:100,maxCharsPerItem:16000}')" > "$WORK/drive-activity.json"
jq -e 'any(.items[]; .type=="dynamic_tool" and (.text | contains("t3_thread_list")) and (.text | contains("\"environmentId\": \"all\"")))' "$WORK/drive-activity.json" >/dev/null
for name in t3_thread_send t3_thread_wait t3_thread_read; do
 jq -e --arg name "t3-code.$name" 'any(.items[]; .type=="dynamic_tool" and (.text | contains("\"toolName\": \""+$name+"\"")) and ((.text|fromjson) | .toolName==$name and (.input | has("environmentId")|not)))' "$WORK/drive-activity.json" >/dev/null
done
printf 'Evidence: %s\n' "$WORK"
