#!/usr/bin/env bash
# Destructive resilience acceptance, exclusively on the shared isolated bed.
set -Eeuo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
trap 'printf "FAIL N round3 line %s, stack %s, exit %s\n" "$LINENO" "${BASH_LINENO[*]}" "$?" >&2' ERR
export MESH_E2E_HELPERS_ONLY=1
export MESH_E2E_SESSION_TTL=${MESH_E2E_SESSION_TTL:-4h}
export MESH_E2E_ROUND1_WORK="${MESH_E2E_ROUND3_WORK:-/tmp/t3-mesh-e2e-N-round3}"
. "$(dirname "$0")/round1.sh"
unset MESH_E2E_HELPERS_ONLY
BED_LOCK_OWNER=${MESH_E2E_LOCK_OWNER:-N1}
require_bed_lock() {
  local bed_owner
  if ! bed_owner=$(gor_ssh 'cat /tmp/mesh-bed.lock/owner'); then
    printf 'Bed lock is unavailable.\n' >&2
    return 1
  fi
  if [ "$bed_owner" != "$BED_LOCK_OWNER" ]; then
    printf 'Bed belongs to %s, expected %s.\n' "$bed_owner" "$BED_LOCK_OWNER" >&2
    return 1
  fi
}
require_bed_lock || die 'Acquire the shared bed lock before round three'
export MESH_E2E_SSH_CONTROL_DIR="$WORK/N-ssh"
mkdir -p "$MESH_E2E_SSH_CONTROL_DIR"
chmod 700 "$MESH_E2E_SSH_CONTROL_DIR"
ws_rpc() {
  require_bed_lock || return 1
  local machine=$1 method=$2 payload=${3:-'{}'} first=${4:-} token
  token=$(token_of "$machine")
  node "$WS" rpc "$method" "$payload" ${first:+"$first"} --origin "$(origin_of "$machine")" --token "$token" --timeout 240000
}
printf '%s' "$$" > "$WORK/N-round3-runner.pid"
set -e
TIMEOUT=${MESH_E2E_ROUND3_TIMEOUT:-900}
PAUSED_SERVER=
PAUSED_SERVER_PID=
PARTITION_ACTIVE=0
CRASH_TARGET=
declare -A CRASH_PEERS=()
source_commit=$(git -C "$REPO_ROOT" log -1 --format=%H -- apps/server/src/replicas/ProjectReplicaService.ts apps/server/src/mesh/MeshSettings.ts packages/shared/src/meshLayout)
git -C "$REPO_ROOT" merge-base --is-ancestor "$source_commit" "$COMMIT" || die "Build lacks N: use MESH_E2E_BUILD_CURRENT=1 build.sh xdev-n, then deploy.sh while the bed is free"
for m in gv gor vps; do
  test "$(descriptor_version "$(origin_of "$m")")" = "${BUILD_VERSION%-mesh.*}" || die "Wrong build on $m"
done
systemctl --user show -p ExecStart --value "$GV_UNIT" | rg -Fq "/$BUILD_VERSION/t3" || die 'Wrong GV runtime path'
gor_ssh "systemctl --user show -p ExecStart --value $GOR_UNIT" | rg -Fq "/$BUILD_VERSION/t3" || die 'Wrong gor runtime path'
expected_hash=$(sha256sum "$RUNTIME_DIR/t3" | cut -d' ' -f1)
test "$(sha256sum "$GV_RUNTIME_ROOT/$BUILD_VERSION/t3" | cut -d' ' -f1)" = "$expected_hash" || die 'GV binary differs from build'
test "$(gor_ssh "sha256sum ~/.t3-sidebar-server/runtime/versions/$BUILD_VERSION/t3" | cut -d' ' -f1)" = "$expected_hash" || die 'gor binary differs from build'
test "$(vps_ssh 'docker inspect -f "{{.Image}}" t3-mesh-e2e')" = "$(docker image inspect -f '{{.Id}}' "$IMAGE")" || die 'Wrong VPS image'
gor_ssh 'cat /tmp/N1-network-state.json' | jq -e '.cut==false' > "$WORK/N-proxy-ready.json" || die 'Round three requires network-proxies.sh up'
for m in gv gor vps; do
  cat > "$WORK/N-t3-$m" <<RUNNER
#!/usr/bin/env bash
export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH
. '$MESH_DIR/lib.sh'
load_build_env
case '$m' in
 gv) exec '$GV_RUNTIME_ROOT/$BUILD_VERSION/t3' "\$@" ;;
 gor) printf -v args '%q ' "\$@"; gor_ssh "export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH; $GOR_BIN \$args" ;;
 vps) printf -v args '%q ' "\$@"; vps_ssh "docker exec t3-mesh-e2e node $VPS_BIN \$args" ;;
esac
RUNNER
  chmod 700 "$WORK/N-t3-$m"
done
ctl() {
  require_bed_lock || return 1
  local m=$1; shift
  XDG_CONFIG_HOME="$WORK/N-auth-$m" T3CODE_HOME="$(base_of "$m")" T3CTL_ORIGIN="$(origin_of "$m")" T3CTL_T3_BIN="$WORK/N-t3-$m" node "$REPO_ROOT/agent-kit/skills/t3/scripts/t3ctl.mjs" "$@"
}
T_GV=$(mint_token gv); T_GOR=$(mint_token gor); T_VPS=$(mint_token vps)
GV_ENV=$(descriptor_env "$GV_ORIGIN"); GOR_ENV=$(descriptor_env "$GOR_ORIGIN"); VPS_ENV=$(descriptor_env "$VPS_ORIGIN")
N_KEY="N-$RUN_TS"; N_ROOT="${MESH_E2E_ROUND3_FIXTURES:-/var/tmp/t3-mesh-round3}/$N_KEY"; N_FILE="$N_ROOT/conflict"
rexec() {
  local m=$1; shift
  case "$m" in
    gv) env HOME="$GV_BASE_DIR/home" MUTAGEN_SSH_PATH="$GV_BASE_DIR/mesh/ssh/bin" "$@";;
    gor) local args; printf -v args '%q ' "$@"; gor_ssh "$args";;
    vps) local args; printf -v args '%q ' "$@"; vps_ssh "docker exec t3-mesh-e2e $args";;
    *) return 2;;
  esac
}
env_of() { case "$1" in gv) echo "$GV_ENV";; gor) echo "$GOR_ENV";; vps) echo "$VPS_ENV";; esac; }
GOR_REMOTE_BASE=$(gor_ssh 'printf "%s/.t3-sidebar-server" "$HOME"')
base_of() { case "$1" in gv) echo "$GV_BASE_DIR";; gor) echo "$GOR_REMOTE_BASE";; vps) echo /home/t3/.t3;; esac; }
mut_bin() {
  local m=$1 configured cache="$WORK/$N_KEY-mutagen-bin-$1"
  if [ ! -s "$cache" ]; then
    configured=$(ws_rpc "$m" server.getConfig '{}' | jq -r '.settings.mutagenPath // empty')
    if [ -z "$configured" ]; then
      configured="$(base_of "$m")/bin/mutagen"
      if ! rexec "$m" test -x "$configured"; then
        configured=$(rexec "$m" sh -c 'command -v mutagen || { test -x "$HOME/.local/bin/mutagen" && printf "%s" "$HOME/.local/bin/mutagen"; }')
      fi
    fi
    [ -n "$configured" ] || die "No Mutagen executable on $m"
    printf '%s' "$configured" > "$cache"
  fi
  cat "$cache"
}
mut() { require_bed_lock || return 1; local m=$1; shift; local base; base=$(base_of "$m"); rexec "$m" env "MUTAGEN_DATA_DIRECTORY=$base/mutagen" "$(mut_bin "$m")" "$@"; }
unit() {
  require_bed_lock || return 1
  local m=$1 verb=$2
  case "$m" in
    gv) systemctl --user "$verb" "$GV_UNIT";;
    gor) gor_ssh "systemctl --user $verb $GOR_UNIT";;
    vps) vps_ssh "docker $verb t3-mesh-e2e";;
  esac
}
restart_count() {
  case "$1" in
    gv) systemctl --user show -p NRestarts --value "$GV_UNIT";;
    gor) gor_ssh "systemctl --user show -p NRestarts --value $GOR_UNIT";;
    vps) vps_ssh 'docker inspect -f "{{.RestartCount}}" t3-mesh-e2e';;
  esac
}
server_process() {
  require_bed_lock || return 1
  local machine=$1 signal=$2 expected=$3 base
  base=$(base_of "$machine")
  rexec "$machine" node -e 'const fs=require("node:fs"),[base,signal,raw]=process.argv.slice(1),expected=Number(raw),{pid}=JSON.parse(fs.readFileSync(base+"/userdata/server-runtime.json","utf8")); if(!["read","SIGSTOP","SIGCONT"].includes(signal)||!Number.isSafeInteger(expected)||expected<0||!Number.isSafeInteger(pid)||pid<=1||pid===process.pid||(signal!=="read"&&expected<=1)||(expected!==0&&pid!==expected))throw Error("Invalid captured test server PID"); const args=fs.readFileSync(`/proc/${pid}/cmdline`,"utf8").split("\0"),index=args.indexOf("--base-dir"); if(!args.includes("serve")||index<0||args[index+1]!==base||fs.statSync(`/proc/${pid}`).uid!==process.getuid())throw Error("PID does not belong to this isolated server"); if(signal!=="read")process.kill(pid,signal); console.log(pid);' "$base" "$signal" "$expected"
}
crash() {
  require_bed_lock || return 1
  local before after peer
  CRASH_TARGET=$1
  CRASH_PEERS=()
  for peer in gv gor vps; do
    if [ "$peer" != "$CRASH_TARGET" ]; then CRASH_PEERS[$peer]=$(restart_count "$peer"); fi
  done
  before=$(restart_count "$1")
  case "$1" in
    gv) systemctl --user kill --signal=SIGKILL --kill-whom=main "$GV_UNIT";;
    gor) gor_ssh "systemctl --user kill --signal=SIGKILL --kill-whom=main $GOR_UNIT";;
    vps) rexec vps node -e 'const fs = require("node:fs"); const {pid} = JSON.parse(fs.readFileSync("/home/t3/.t3/userdata/server-runtime.json", "utf8")); if (!Number.isSafeInteger(pid) || pid <= 1 || !fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("/opt/t3/dist/bin.mjs")) throw Error("Invalid captured test server PID"); process.kill(pid, "SIGKILL");';;
  esac
  wait_health "$(origin_of "$1")" "$TIMEOUT"
  require_bed_lock || return 1
  after=$(restart_count "$1")
  test "$after" -gt "$before"
  printf 'PASS N automatic restart %s: %s -> %s\n' "$1" "$before" "$after" | tee -a "$WORK/N-auto-restart-$1.log"
}
entry() {
  local key=$1 value=$2 now maximum
  now=$(date +%s%3N)
  maximum=$(ws_get gv | jq '[.document[] | .h | split(".")[0] | tonumber] | max // 0')
  if [ "$maximum" -ge "$now" ]; then now=$((maximum+1)); fi
  jq -nc --arg k "$key" --argjson v "$value" --arg h "$now.00000.$GV_ENV" '{entries:{($k):{v:$v,h:$h}}}'
}
project_options() {
  local project=$1 options=$2 config
  config=$(ws_rpc gv meshConfig.get '{}')
  ws_rpc gv meshConfig.apply "$(jq -nc --argjson config "$config" --arg project "$project" --argjson options "$options" '{baseRevision:$config.current.revision,doc:($config.current.doc | .projects.overrides = ((.projects.overrides // []) + [($options + {project:$project})]))}')"
}
ws_get gv > "$WORK/N-before.json"
restore() {
  local rc=$?
  if require_bed_lock; then
    if [ -n "$PAUSED_SERVER" ]; then
      server_process "$PAUSED_SERVER" SIGCONT "$PAUSED_SERVER_PID" >/dev/null || rc=1
    fi
    for m in gv gor vps; do unit "$m" start || rc=1; done
    if [ "$PARTITION_ACTIVE" = 1 ]; then
      gor_ssh 'cat > /tmp/N1-partition-state.json && mv /tmp/N1-partition-state.json /tmp/N1-network-state.json' < "$WORK/N-partition-proxy-before.json" || rc=1
    fi
    gor_ssh "systemctl --user start $GOR_TUNNEL_UNIT" || rc=1
    wait_health "$GV_ORIGIN" "$TIMEOUT" || rc=1
  else
    printf 'Bed lock lost; leaving shared services and settings untouched.\n' >&2
    rc=1
  fi
  if [ -S "$MESH_E2E_SSH_CONTROL_DIR/gor" ]; then ssh -F "$GOR_SSH_CONFIG" -S "$MESH_E2E_SSH_CONTROL_DIR/gor" -O exit "$GOR_HOST" || rc=1; fi
  if [ -S "$MESH_E2E_SSH_CONTROL_DIR/vps" ]; then ssh -F "$VPS_SSH_CONFIG" -S "$MESH_E2E_SSH_CONTROL_DIR/vps" -O exit "$VPS_HOST" || rc=1; fi
  exit "$rc"
}
trap restore EXIT
for m in gv gor vps; do rexec "$m" mkdir -p "$N_ROOT"; done
rexec gor git init -q "$N_ROOT"
rexec gor sh -c "printf 'baseline' > '$N_FILE'; dd if=/dev/urandom of='$N_ROOT/payload' bs=1048576 count=32 status=none"
project_options "$N_KEY" '{"conflicts":"primary-wins"}' > "$WORK/N-primary-policy.json"
add_rep() {
  local m=$1 role=$2 env source
  env=$(env_of "$m"); source=null; [ "$role" = primary ] || source="\"$GOR_ENV\""
  local rep
  rep=$(jq -nc --arg env "$env" --arg p "$N_ROOT" --arg role "$role" --argjson source "$source" '{environmentId:$env,path:$p,pathAllocated:true,role:$role,transport:(if $role=="primary" then "git" else "mutagen" end),createdAt:""} + (if $source==null then {} else {source:$source} end)')
  ws_rpc gv meshLayout.apply "$(entry "rep/$N_KEY/$env" "$rep")" > "$WORK/N-add-$m.json"
}
add_rep gor primary
for m in gv vps; do add_rep "$m" replica; done
wait_state() {
  local m=$1 state=$2 end=$((SECONDS+TIMEOUT)) env
  env=$(env_of "$m")
  while [ "$SECONDS" -lt "$end" ]; do
    ws_rpc "$m" replicas.status '{}' --first > "$WORK/N-state-$m.json"
    if jq -e --arg k "$N_KEY" --arg env "$env" --arg state "$state" '.. | objects | select(.logicalKey?==$k and .environmentId?==$env and .state?==$state)' "$WORK/N-state-$m.json" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
wait_staging() {
  local observer=$1 target=$2 end=$((SECONDS+TIMEOUT))
  while [ "$SECONDS" -lt "$end" ]; do
    mut "$observer" sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-mid-sync-$target.json"
    if jq -e --arg path "$N_ROOT" 'any(.[]; .beta.path==$path and (.status=="staging-alpha" or .status=="staging-beta"))' "$WORK/N-mid-sync-$target.json" >/dev/null; then
      printf 'PASS N observed active staging before killing %s\n' "$target"
      return 0
    fi
    sleep 0.1
  done
  return 1
}
wait_daemon() {
  local m=$1 base end=$((SECONDS+TIMEOUT))
  base=$(base_of "$m")
  while [ "$SECONDS" -lt "$end" ]; do
    if rexec "$m" node -e 'const s=require("node:net").connect(process.argv[1]); s.once("connect",()=>{s.end();process.exit(0)}); s.once("error",e=>{console.error(e.code);process.exit(1)}); s.setTimeout(1000,()=>{console.error("Socket probe timed out");process.exit(1)});' "$base/mutagen/daemon/daemon.sock" > "$WORK/N-daemon-probe-$m.log" 2>&1; then return 0; fi
    sleep 0.1
  done
  cat "$WORK/N-daemon-probe-$m.log" >&2
  return 1
}
daemon_lock() {
  local m=$1 expected=$2 base
  base=$(base_of "$m")
  rexec "$m" node -e 'const fs=require("node:fs"),[file,raw]=process.argv.slice(1),expected=Number(raw); if(!Number.isSafeInteger(expected)||expected<0||expected===1)throw Error("Invalid expected daemon PID"); let stat;try{stat=fs.statSync(file,{bigint:true})}catch(error){if(expected===0&&error.code==="ENOENT")process.exit(0);throw error} const major=((stat.dev>>8n)&0xfffn)|((stat.dev>>32n)&0xfffff000n),minor=(stat.dev&0xffn)|((stat.dev>>12n)&0xffffff00n); const holders=fs.readFileSync("/proc/locks","utf8").split("\n").flatMap(line=>{const f=line.trim().split(/\s+/),p=f[5]?.split(":");return p?.length===3&&["POSIX","FLOCK"].includes(f[1])&&BigInt("0x"+p[0])===major&&BigInt("0x"+p[1])===minor&&p[2]===stat.ino.toString()?[Number(f[4])]:[]});process.exit(expected===0?(holders.length===0?0:1):(holders.includes(expected)?0:1));' "$base/mutagen/daemon/daemon.lock" "$expected"
}
assert_converged() {
  local label=$1 m
  wait_state gv watching; wait_state vps watching
  wait_converged "$label"
  for m in gv gor vps; do
    ws_get "$m" > "$WORK/N-layout-$m.json"
    jq -e --arg k "$N_KEY" '.config.projectMounts[$k] | length==3 and ([.[].environmentId] | unique | length==3)' "$WORK/N-layout-$m.json" >/dev/null
    mut "$m" sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-sessions-$m.json"
    jq -e --arg p "$N_ROOT" '[.[] | select(.beta.path==$p) | .name] | length == (unique | length)' "$WORK/N-sessions-$m.json" >/dev/null
    local cursor=0
    printf '[]' > "$WORK/N-projects-$m.json"
    while :; do
      ctl "$m" tool t3_project_list "$(jq -nc --argjson cursor "$cursor" '{limit:100,cursor:$cursor}')" > "$WORK/N-project-page-$m.json"
      jq -se '.[0] + .[1].projects' "$WORK/N-projects-$m.json" "$WORK/N-project-page-$m.json" > "$WORK/N-projects-$m.next"
      mv "$WORK/N-projects-$m.next" "$WORK/N-projects-$m.json"
      cursor=$(jq -r '.nextCursor // empty' "$WORK/N-project-page-$m.json")
      [ -n "$cursor" ] || break
    done
    jq -e --arg p "$N_ROOT" '[.. | objects | select(.workspaceRoot?==$p and .deletedAt?==null)] | length==1' "$WORK/N-projects-$m.json" >/dev/null
  done
  local expected actual file end=$((SECONDS+TIMEOUT)) matched
  for file in "$N_FILE" "$N_ROOT/payload"; do
    while :; do
      expected=$(rexec gor sha256sum "$file" | cut -d' ' -f1)
      matched=true
      for m in gv vps; do
        actual=$(rexec "$m" sha256sum "$file" | cut -d' ' -f1)
        if [ "$actual" != "$expected" ]; then
          matched=false
          printf '%s %s expected=%s actual=%s\n' "$m" "$file" "$expected" "$actual" > "$WORK/N-file-convergence.txt"
        fi
      done
      if "$matched"; then break; fi
      if [ "$SECONDS" -ge "$end" ]; then
        cat "$WORK/N-file-convergence.txt" >&2
        return 1
      fi
      sleep 1
    done
  done
  for m in "${!CRASH_PEERS[@]}"; do
    actual=$(restart_count "$m")
    [ "$actual" = "${CRASH_PEERS[$m]}" ] || die "Unexpected restart of $m during $CRASH_TARGET crash (${CRASH_PEERS[$m]} -> $actual)"
  done
  if [ -n "$CRASH_TARGET" ]; then
    printf 'PASS N only %s restarted; other server counters unchanged\n' "$CRASH_TARGET"
  fi
  CRASH_TARGET=
  CRASH_PEERS=()
}
. "$MESH_DIR/round3-features.sh"
# Crash each server while its own representation is first mounting, then mid-sync.
for m in gv gor vps; do
  for replica in gv vps; do
    ws_rpc gv meshLayout.apply "$(entry "rep/$N_KEY/$(env_of "$replica")" null)" > "$WORK/N-remove-$replica.json"
  done
  wait_converged "N removed replicas before mount crash $m"
  hash=$(node --input-type=module -e 'import {createHash} from "node:crypto"; console.log(createHash("sha256").update(process.argv[1]).digest("hex").slice(0,8))' "$N_KEY")
  end=$((SECONDS+TIMEOUT))
  while :; do
    remaining=0
    for host in gv gor vps; do
      mut "$host" sync list --label-selector "t3-logical=$hash" --template '{{json .}}' > "$WORK/N-removed-$host.json"
      remaining=$((remaining+$(jq length "$WORK/N-removed-$host.json")))
    done
    [ "$remaining" -ne 0 ] || break
    [ "$SECONDS" -lt "$end" ] || exit 1
    sleep 1
  done
  rexec gor sh -c "dd if=/dev/urandom of='$N_ROOT/payload' bs=1048576 count=128 status=none"
  for replica in gv vps; do add_rep "$replica" replica; done
  mount_observer=gv; [ "$m" != vps ] || mount_observer=vps
  wait_state "$mount_observer" mounting
  crash "$m"
  assert_converged "N mid-mount crash $m"
  rexec gor sh -c "dd if=/dev/urandom of='$N_ROOT/payload' bs=1048576 count=256 status=none; printf '$m-sync' > '$N_FILE'"
  wait_staging "$mount_observer" "$m"
  crash "$m"
  assert_converged "N mid-sync crash $m"
done
# Kill only a private daemon PID captured when this script launched it.
for m in gv vps; do
  # Restart to drain in-flight commands before capturing our daemon.
  unit "$m" stop
  unit "$m" start
  wait_health "$(origin_of "$m")" "$TIMEOUT"
  base=$(base_of "$m")
  daemon_dir="$base/N-faults/$N_KEY"
  rexec "$m" mkdir -p "$daemon_dir"
  daemon_binary=$(mut_bin "$m")
  PAUSED_SERVER_PID=$(server_process "$m" read 0)
  PAUSED_SERVER=$m
  # Freeze status readers while establishing ownership of the fault-test daemon.
  server_process "$m" SIGSTOP "$PAUSED_SERVER_PID" >/dev/null
  if rexec "$m" node -e 'const s=require("node:net").connect(process.argv[1]); s.once("connect",()=>{s.end();process.exit(0)}); s.once("error",()=>process.exit(1)); s.setTimeout(1000,()=>process.exit(1));' "$base/mutagen/daemon/daemon.sock"; then mut "$m" daemon stop; fi
  end=$((SECONDS+TIMEOUT))
  until daemon_lock "$m" 0; do
    [ "$SECONDS" -lt "$end" ] || exit 1
    sleep 0.1
  done
  rexec "$m" sh -c 'MUTAGEN_DATA_DIRECTORY="$1" nohup "$2" daemon run > "$3/daemon.log" 2>&1 & echo $! > "$3/daemon.pid"' sh "$base/mutagen" "$daemon_binary" "$daemon_dir"
  wait_daemon "$m"
  captured_pid=$(rexec "$m" cat "$daemon_dir/daemon.pid")
  daemon_lock "$m" "$captured_pid"
  server_process "$m" SIGCONT "$PAUSED_SERVER_PID" >/dev/null
  PAUSED_SERVER=
  PAUSED_SERVER_PID=
  before=$(restart_count "$m")
  daemon_lock "$m" "$captured_pid"
  printf 'PASS N captured daemon owns private lock %s\n' "$m"
  rexec "$m" sh -c 'kill -9 "$1"' sh "$captured_pid"
  end=$((SECONDS+TIMEOUT))
  while rexec "$m" sh -c 'kill -0 "$1" 2>/dev/null' sh "$captured_pid"; do
    [ "$SECONDS" -lt "$end" ] || exit 1
    sleep 0.1
  done
  # A raw socket probe cannot start a daemon, unlike Mutagen's CLI.
  wait_daemon "$m"
  assert_converged "N killed daemon $m"
  test "$(restart_count "$m")" = "$before"
  printf 'PASS N daemon recovered without server restart %s\n' "$m"
done
# Cut both peer directions before writing divergent versions, without user pauses.
gor_ssh 'cat /tmp/N1-network-state.json' > "$WORK/N-partition-proxy-before.json"
jq -e '.cut==false' "$WORK/N-partition-proxy-before.json" >/dev/null
for m in gv vps; do
  mut "$m" sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-before-partition-$m.json"
  jq -e --arg p "$N_ROOT" 'any(.[]; .beta.path==$p and .paused==false and .alpha.connected==true)' "$WORK/N-before-partition-$m.json" >/dev/null
done
PARTITION_ACTIVE=1
jq '.cut=true' "$WORK/N-partition-proxy-before.json" | gor_ssh 'cat > /tmp/N1-partition-state.json && mv /tmp/N1-partition-state.json /tmp/N1-network-state.json'
gor_ssh "systemctl --user stop $GOR_TUNNEL_UNIT"
for m in gv vps; do
  end=$((SECONDS+TIMEOUT))
  while :; do
    mut "$m" sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-partition-disconnected-$m.json"
    if jq -e --arg p "$N_ROOT" 'any(.[]; .beta.path==$p and .alpha.connected==false)' "$WORK/N-partition-disconnected-$m.json" >/dev/null; then break; fi
    [ "$SECONDS" -lt "$end" ] || die "Primary endpoint on $m did not disconnect"
    sleep 1
  done
done
rexec gor sh -c "printf 'N-primary-wins' > '$N_FILE'"
rexec gv sh -c "printf 'N-gv-loses' > '$N_FILE'"
rexec vps sh -c "printf 'N-vps-loses' > '$N_FILE'"
for _ in $(seq 1 180); do sleep 1; done
require_bed_lock || die 'Bed lock lost during partition'
gor_ssh 'cat > /tmp/N1-partition-state.json && mv /tmp/N1-partition-state.json /tmp/N1-network-state.json' < "$WORK/N-partition-proxy-before.json"
gor_ssh "systemctl --user start $GOR_TUNNEL_UNIT"
PARTITION_ACTIVE=0
# The reconciler must resume and resolve automatically; no retry/resume command here.
assert_converged 'N three-minute partition and conflicting edits'
for m in gv vps; do
  rexec "$m" sh -c "find '$N_ROOT/.t3-conflicts' -type f -name conflict -exec cat {} \\;" > "$WORK/N-copies-$m.txt"
  rg "N-$m-loses" "$WORK/N-copies-$m.txt"
done
crash gor
assert_converged 'N primary restart'
for order in 'gv gor vps' 'gv vps gor' 'gor gv vps' 'gor vps gv' 'vps gv gor' 'vps gor gv'; do
  for m in gv gor vps; do unit "$m" stop; done
  for m in $order; do unit "$m" start; wait_health "$(origin_of "$m")" "$TIMEOUT"; done
  assert_converged "N restart order $order"
  assert_feature_recovery
done
runtime_root="/tmp/N-runtime-$RUN_TS"
gor_ssh "mkdir -p '$runtime_root-source/runtime/versions/0.0.4-N'; printf '#!/bin/sh\nexit 0\n' > '$runtime_root-source/runtime/versions/0.0.4-N/t3'; chmod 700 '$runtime_root-source/runtime/versions/0.0.4-N/t3'"
vps_ssh "mkdir -p '$runtime_root'"
tar -czf "$WORK/N-runtime-scripts.tar.gz" -C "$REPO_ROOT/agent-kit/skills/t3" scripts
scp -q -F "$VPS_SSH_CONFIG" "$WORK/N-runtime-scripts.tar.gz" "$MESH_DIR/round3-runtime.sh" "$VPS_HOST:$runtime_root/"
vps_ssh "tar -xzf '$runtime_root/N-runtime-scripts.tar.gz' -C '$runtime_root'; bash '$runtime_root/round3-runtime.sh' '$runtime_root'" | tee "$WORK/N-system-services.log"
printf 'PASS N round3: crash/mount/sync, daemon, partition/conflicts, primary, 6 restart orders; evidence %s\n' "$WORK"
