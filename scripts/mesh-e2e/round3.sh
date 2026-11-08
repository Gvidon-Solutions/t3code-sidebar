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
  if ! bed_owner=$(worker_ssh 'cat /tmp/mesh-bed.lock/owner'); then
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
PARTITION_ACTIVE=0
CRASH_TARGET=
MOUNT_WATCH_PID=
PLACEMENT_PID=
FROZEN_CONTAINER_ID=
FROZEN_DRIVER_RECORD=
DAEMON_SETTINGS_MACHINE=
DAEMON_SETTINGS_ENABLED=
declare -A CRASH_PEERS=()
source_commit=$(git -C "$REPO_ROOT" log -1 --format=%H -- apps/server/src/replicas/ProjectReplicaService.ts apps/server/src/mesh/MeshSettings.ts packages/shared/src/meshLayout)
git -C "$REPO_ROOT" merge-base --is-ancestor "$source_commit" "$COMMIT" || die "Build lacks N: use MESH_E2E_BUILD_CURRENT=1 build.sh xdev-n, then deploy.sh while the bed is free"
for m in "${BED_MACHINES[@]}"; do
  test "$(descriptor_version "$(origin_of "$m")")" = "${BUILD_VERSION%-mesh.*}" || die "Wrong build on $m"
done
systemctl --user show -p ExecStart --value "$STUDIO_UNIT" | rg -Fq "/$BUILD_VERSION/t3" || die 'Wrong GV runtime path'
worker_ssh "systemctl --user show -p ExecStart --value $WORKER_UNIT" | rg -Fq "/$BUILD_VERSION/t3" || die 'Wrong worker runtime path'
expected_hash=$(sha256sum "$RUNTIME_DIR/t3" | cut -d' ' -f1)
test "$(sha256sum "$STUDIO_RUNTIME_ROOT/$BUILD_VERSION/t3" | cut -d' ' -f1)" = "$expected_hash" || die 'GV binary differs from build'
test "$(worker_ssh "sha256sum ~/.t3-sidebar-server/runtime/versions/$BUILD_VERSION/t3" | cut -d' ' -f1)" = "$expected_hash" || die 'worker binary differs from build'
test "$(cloudbox_ssh 'docker inspect -f "{{.Image}}" t3-mesh-e2e')" = "$(docker image inspect -f '{{.Id}}' "$IMAGE")" || die 'Wrong VPS image'
worker_ssh 'cat /tmp/N1-network-state.json' | jq -e '.cut==false' > "$WORK/N-proxy-ready.json" || die 'Round three requires network-proxies.sh up'
for m in "${BED_MACHINES[@]}"; do
  cat > "$WORK/N-t3-$m" <<RUNNER
#!/usr/bin/env bash
export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH
. '$MESH_DIR/lib.sh'
load_build_env
case '$m' in
 studio) exec '$STUDIO_RUNTIME_ROOT/$BUILD_VERSION/t3' "\$@" ;;
 worker) printf -v args '%q ' "\$@"; worker_ssh "export PATH=\$HOME/.nvm/versions/node/v26.12.1/bin:\$PATH; $WORKER_BIN \$args" ;;
 cloudbox) printf -v args '%q ' "\$@"; cloudbox_ssh "docker exec t3-mesh-e2e node $CLOUDBOX_BIN \$args" ;;
esac
RUNNER
  chmod 700 "$WORK/N-t3-$m"
done
ctl() {
  require_bed_lock || return 1
  local m=$1; shift
  XDG_CONFIG_HOME="$WORK/N-auth-$m" T3CODE_HOME="$(base_of "$m")" T3CTL_ORIGIN="$(origin_of "$m")" T3CTL_T3_BIN="$WORK/N-t3-$m" node "$REPO_ROOT/agent-kit/skills/t3/scripts/t3ctl.mjs" "$@"
}
T_GV=$(mint_token studio); T_GOR=$(mint_token worker); T_VPS=$(mint_token cloudbox)
STUDIO_ENV=$(descriptor_env "$STUDIO_ORIGIN"); WORKER_ENV=$(descriptor_env "$WORKER_ORIGIN"); CLOUDBOX_ENV=$(descriptor_env "$CLOUDBOX_ORIGIN")
N_KEY="N-$RUN_TS"; N_ROOT="${MESH_E2E_ROUND3_FIXTURES:-/var/tmp/t3-mesh-round3}/$N_KEY"; N_FILE="$N_ROOT/conflict"
rexec() {
  local m=$1; shift
  case "$m" in
    studio) env HOME="$STUDIO_BASE_DIR/home" MUTAGEN_SSH_PATH="$STUDIO_BASE_DIR/mesh/ssh/bin" "$@";;
    worker) local args; printf -v args '%q ' "$@"; worker_ssh "$args";;
    cloudbox) local args; printf -v args '%q ' "$@"; cloudbox_ssh "docker exec t3-mesh-e2e $args";;
    *) return 2;;
  esac
}
env_of() { case "$1" in studio) echo "$STUDIO_ENV";; worker) echo "$WORKER_ENV";; cloudbox) echo "$CLOUDBOX_ENV";; esac; }
WORKER_REMOTE_BASE="$WORKER_BASE_DIR"
base_of() { case "$1" in studio) echo "$STUDIO_BASE_DIR";; worker) echo "$WORKER_REMOTE_BASE";; cloudbox) echo /home/t3/.t3;; esac; }
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
    studio) systemctl --user "$verb" "$STUDIO_UNIT";;
    worker) worker_ssh "systemctl --user $verb $WORKER_UNIT";;
    cloudbox) cloudbox_ssh "docker $verb t3-mesh-e2e";;
  esac
}
restart_count() {
  case "$1" in
    studio) systemctl --user show -p NRestarts --value "$STUDIO_UNIT";;
    worker) worker_ssh "systemctl --user show -p NRestarts --value $WORKER_UNIT";;
    cloudbox) cloudbox_ssh 'docker inspect -f "{{.RestartCount}}" t3-mesh-e2e';;
  esac
}
crash() {
  require_bed_lock || return 1
  local before after peer
  CRASH_TARGET=$1
  CRASH_PEERS=()
  for peer in "${BED_MACHINES[@]}"; do
    if [ "$peer" != "$CRASH_TARGET" ]; then CRASH_PEERS[$peer]=$(restart_count "$peer"); fi
  done
  before=$(restart_count "$1")
  case "$1" in
    studio) systemctl --user kill --signal=SIGKILL --kill-whom=main "$STUDIO_UNIT";;
    worker) worker_ssh "systemctl --user kill --signal=SIGKILL --kill-whom=main $WORKER_UNIT";;
    cloudbox) rexec cloudbox node -e 'const fs = require("node:fs"); const {pid} = JSON.parse(fs.readFileSync("/home/t3/.t3/userdata/server-runtime.json", "utf8")); if (!Number.isSafeInteger(pid) || pid <= 1 || !fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("/opt/t3/dist/bin.mjs")) throw Error("Invalid captured test server PID"); process.kill(pid, "SIGKILL");';;
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
  maximum=$(ws_get studio | jq '[.document[] | .h | split(".")[0] | tonumber] | max // 0')
  if [ "$maximum" -ge "$now" ]; then now=$((maximum+1)); fi
  jq -nc --arg k "$key" --argjson v "$value" --arg h "$now.00000.$STUDIO_ENV" '{entries:{($k):{v:$v,h:$h}}}'
}
project_options() {
  local project=$1 options=$2 config
  config=$(ws_rpc studio meshConfig.get '{}')
  ws_rpc studio meshConfig.apply "$(jq -nc --argjson config "$config" --arg project "$project" --argjson options "$options" '{baseRevision:$config.current.revision,doc:($config.current.doc | .projects.overrides = ((.projects.overrides // []) + [($options + {project:$project})]))}')"
}
restore_daemon_settings() {
  [ -n "$DAEMON_SETTINGS_MACHINE" ] || return 0
  ws_rpc "$DAEMON_SETTINGS_MACHINE" server.updateSettings "$(jq -nc --argjson enabled "$DAEMON_SETTINGS_ENABLED" '{patch:{replicasEnabled:$enabled}}')" > "$WORK/N-daemon-settings-restored-$DAEMON_SETTINGS_MACHINE.json" || return 1
  jq -e --argjson enabled "$DAEMON_SETTINGS_ENABLED" '.replicasEnabled==$enabled' "$WORK/N-daemon-settings-restored-$DAEMON_SETTINGS_MACHINE.json" >/dev/null || return 1
  DAEMON_SETTINGS_MACHINE=
  DAEMON_SETTINGS_ENABLED=
}
restore_partition() {
  cp "$WORK/N-partition-proxy-before-studio.json" /tmp/N1-partition-state.json || return 1
  mv /tmp/N1-partition-state.json /tmp/N1-network-state.json || return 1
  worker_ssh 'cat > /tmp/N1-partition-state.json && mv /tmp/N1-partition-state.json /tmp/N1-network-state.json' < "$WORK/N-partition-proxy-before.json" || return 1
  cloudbox_put "$WORK/N-partition-proxy-before-cloudbox.json" "$CLOUDBOX_DIR/tmp/N1-partition-state.json" || return 1
  cloudbox_ssh "chmod 644 '$CLOUDBOX_DIR/tmp/N1-partition-state.json' && mv '$CLOUDBOX_DIR/tmp/N1-partition-state.json' '$CLOUDBOX_DIR/tmp/N1-network-state.json'" || return 1
}
resume_container_driver() {
  [ -n "$FROZEN_DRIVER_RECORD" ] || return 0
  local args
  printf -v args '%q ' node "$driver_signal" resume "$(base_of cloudbox)" "$FROZEN_DRIVER_RECORD"
  cloudbox_ssh "docker exec '$FROZEN_CONTAINER_ID' $args" || return 1
  FROZEN_DRIVER_RECORD=
  FROZEN_CONTAINER_ID=
}
ws_get studio > "$WORK/N-before.json"
restore() {
  local rc=$? child child_status
  for child in "$MOUNT_WATCH_PID" "$PLACEMENT_PID"; do
    if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
      kill "$child" || rc=1
      if wait "$child"; then
        printf 'Round three child %s finished during cleanup.\n' "$child"
      else
        child_status=$?
        printf 'Round three child %s cleanup exit %s.\n' "$child" "$child_status" >&2
        [ "$child_status" = 143 ] || rc=1
      fi
    fi
  done
  if ! resume_container_driver; then
    printf 'Could not resume our captured container driver.\n' >&2
    rc=1
  fi
  if require_bed_lock; then
    for m in "${BED_MACHINES[@]}"; do unit "$m" start || rc=1; done
    if [ "$PARTITION_ACTIVE" = 1 ]; then
      restore_partition || rc=1
    fi
    worker_ssh "systemctl --user start $WORKER_TUNNEL_UNIT" || rc=1
    wait_health "$STUDIO_ORIGIN" "$TIMEOUT" || rc=1
    if [ -n "$DAEMON_SETTINGS_MACHINE" ]; then
      wait_health "$(origin_of "$DAEMON_SETTINGS_MACHINE")" "$TIMEOUT" && restore_daemon_settings || rc=1
    fi
  else
    printf 'Bed lock lost; leaving shared services and settings untouched.\n' >&2
    rc=1
  fi
  if [ -S "$MESH_E2E_SSH_CONTROL_DIR/worker" ]; then ssh -F "$WORKER_SSH_CONFIG" -S "$MESH_E2E_SSH_CONTROL_DIR/worker" -O exit "$WORKER_HOST" || rc=1; fi
  if [ -S "$MESH_E2E_SSH_CONTROL_DIR/cloudbox" ]; then ssh -F "$CLOUDBOX_SSH_CONFIG" -S "$MESH_E2E_SSH_CONTROL_DIR/cloudbox" -O exit "$CLOUDBOX_HOST" || rc=1; fi
  exit "$rc"
}
trap restore EXIT
for m in "${BED_MACHINES[@]}"; do rexec "$m" mkdir -p "$N_ROOT"; done
rexec worker git init -q "$N_ROOT"
rexec worker sh -c "printf 'baseline' > '$N_FILE'; dd if=/dev/urandom of='$N_ROOT/payload' bs=1048576 count=32 status=none"
project_options "$N_KEY" '{"conflicts":"primary-wins"}' > "$WORK/N-primary-policy.json"
add_rep() {
  local m=$1 role=$2 control=${3:-studio} env source
  env=$(env_of "$m"); source=null; [ "$role" = primary ] || source="\"$WORKER_ENV\""
  local rep
  rep=$(jq -nc --arg env "$env" --arg p "$N_ROOT" --arg role "$role" --argjson source "$source" '{environmentId:$env,path:$p,pathAllocated:true,role:$role,transport:(if $role=="primary" then "git" else "mutagen" end),createdAt:""} + (if $source==null then {} else {source:$source} end)')
  ws_rpc "$control" meshLayout.apply "$(entry "rep/$N_KEY/$env" "$rep")" > "$WORK/N-add-$m.json"
}
add_rep worker primary
for m in studio cloudbox; do add_rep "$m" replica; done
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
  wait_state studio watching; wait_state cloudbox watching
  wait_converged "$label"
  for m in "${BED_MACHINES[@]}"; do
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
      expected=$(rexec worker sha256sum "$file" | cut -d' ' -f1)
      matched=true
      for m in studio cloudbox; do
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
for m in "${BED_MACHINES[@]}"; do
  for replica in studio cloudbox; do
    ws_rpc studio meshLayout.apply "$(entry "rep/$N_KEY/$(env_of "$replica")" null)" > "$WORK/N-remove-$replica.json"
  done
  wait_converged "N removed replicas before mount crash $m"
  hash=$(node --input-type=module -e 'import {createHash} from "node:crypto"; console.log(createHash("sha256").update(process.argv[1]).digest("hex").slice(0,8))' "$N_KEY")
  end=$((SECONDS+TIMEOUT))
  while :; do
    remaining=0
    for host in "${BED_MACHINES[@]}"; do
      mut "$host" sync list --label-selector "t3-logical=$hash" --template '{{json .}}' > "$WORK/N-removed-$host.json"
      remaining=$((remaining+$(jq length "$WORK/N-removed-$host.json")))
    done
    [ "$remaining" -ne 0 ] || break
    [ "$SECONDS" -lt "$end" ] || exit 1
    sleep 1
  done
  rexec worker sh -c "dd if=/dev/urandom of='$N_ROOT/payload' bs=1048576 count=128 status=none"
  mount_observer=studio; [ "$m" != cloudbox ] || mount_observer=cloudbox
  control=worker; [ "$m" != worker ] || control=cloudbox
  ready="$WORK/N-mount-ready-$RUN_TS-$m"
  node "$WS" wait-replica "$N_KEY" "$(env_of "$mount_observer")" mounting "$ready" --origin "$(origin_of "$mount_observer")" --token "$(token_of "$mount_observer")" --timeout "$((TIMEOUT*1000))" > "$WORK/N-mount-transition-$m.json" &
  MOUNT_WATCH_PID=$!
  end=$((SECONDS+TIMEOUT))
  until [ -f "$ready" ]; do
    kill -0 "$MOUNT_WATCH_PID" 2>/dev/null || { wait "$MOUNT_WATCH_PID"; exit 1; }
    [ "$SECONDS" -lt "$end" ] || exit 1
    sleep 0.1
  done
  add_rep "$mount_observer" replica "$control" &
  PLACEMENT_PID=$!
  wait "$MOUNT_WATCH_PID"
  MOUNT_WATCH_PID=
  printf 'PASS N observed mounting transition before killing %s\n' "$m"
  crash "$m"
  wait "$PLACEMENT_PID"
  PLACEMENT_PID=
  for replica in studio cloudbox; do
    if [ "$replica" != "$mount_observer" ]; then add_rep "$replica" replica; fi
  done
  assert_converged "N mid-mount crash $m"
  rexec worker sh -c "dd if=/dev/urandom of='$N_ROOT/payload' bs=1048576 count=256 status=none; printf '$m-sync' > '$N_FILE'"
  wait_staging "$mount_observer" "$m"
  crash "$m"
  assert_converged "N mid-sync crash $m"
done
# Kill only a private daemon PID captured when this script launched it.
driver_signal="/tmp/$BED_LOCK_OWNER-N-driver-signal.mjs"
cloudbox_put "$MESH_DIR/round3-driver.mjs" "$CLOUDBOX_DIR/tmp/$BED_LOCK_OWNER-N-driver-signal.mjs"
cloudbox_ssh "chmod 644 '$CLOUDBOX_DIR/tmp/$BED_LOCK_OWNER-N-driver-signal.mjs'"
for m in studio cloudbox; do
  base=$(base_of "$m")
  daemon_dir="$base/N-faults/$N_KEY"
  rexec "$m" mkdir -p "$daemon_dir"
  daemon_binary=$(mut_bin "$m")
  ws_rpc "$m" server.getConfig '{}' > "$WORK/N-daemon-settings-before-$m.json"
  DAEMON_SETTINGS_ENABLED=$(jq -r '.settings.replicasEnabled' "$WORK/N-daemon-settings-before-$m.json")
  case "$DAEMON_SETTINGS_ENABLED" in true|false) ;; *) die 'Invalid replica enable setting';; esac
  DAEMON_SETTINGS_MACHINE=$m
  ws_rpc "$m" server.updateSettings '{"patch":{"replicasEnabled":false}}' > "$WORK/N-daemon-settings-disabled-$m.json"
  jq -e '.replicasEnabled==false' "$WORK/N-daemon-settings-disabled-$m.json" >/dev/null
  if ! daemon_lock "$m" 0; then
    mut "$m" sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-daemon-before-stop-$m.json"
    mut "$m" daemon stop
  fi
  if [ "$m" = cloudbox ]; then
    FROZEN_CONTAINER_ID=$(cloudbox_ssh 'docker inspect -f "{{.Id}}" t3-mesh-e2e')
    FROZEN_DRIVER_RECORD="$daemon_dir/server-paused.json"
    rexec cloudbox node "$driver_signal" pause "$base" "$FROZEN_DRIVER_RECORD"
  else
    unit "$m" stop
  fi
  end=$((SECONDS+TIMEOUT))
  until daemon_lock "$m" 0; do
    [ "$SECONDS" -lt "$end" ] || exit 1
    sleep 0.1
  done
  rexec "$m" sh -c 'MUTAGEN_DATA_DIRECTORY="$1" nohup "$2" daemon run > "$3/daemon.log" 2>&1 & echo $! > "$3/daemon.pid"' sh "$base/mutagen" "$daemon_binary" "$daemon_dir"
  wait_daemon "$m"
  captured_pid=$(rexec "$m" cat "$daemon_dir/daemon.pid")
  daemon_lock "$m" "$captured_pid"
  if [ "$m" = cloudbox ]; then resume_container_driver; else unit "$m" start; fi
  wait_health "$(origin_of "$m")" "$TIMEOUT"
  restore_daemon_settings
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
cp /tmp/N1-network-state.json "$WORK/N-partition-proxy-before-studio.json"
worker_ssh 'cat /tmp/N1-network-state.json' > "$WORK/N-partition-proxy-before.json"
cloudbox_ssh "cat '$CLOUDBOX_DIR/tmp/N1-network-state.json'" > "$WORK/N-partition-proxy-before-cloudbox.json"
for state_file in "$WORK"/N-partition-proxy-before*.json; do jq -e '.cut==false' "$state_file" >/dev/null; done
for m in studio cloudbox; do
  mut "$m" sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-before-partition-$m.json"
  jq -e --arg p "$N_ROOT" 'any(.[]; .beta.path==$p and .paused==false and .alpha.connected==true)' "$WORK/N-before-partition-$m.json" >/dev/null
done
PARTITION_ACTIVE=1
jq '.cut=true' "$WORK/N-partition-proxy-before-studio.json" > /tmp/N1-partition-state.json
mv /tmp/N1-partition-state.json /tmp/N1-network-state.json
jq '.cut=true' "$WORK/N-partition-proxy-before-cloudbox.json" > "$WORK/N-cloudbox-cut.json"
cloudbox_put "$WORK/N-cloudbox-cut.json" "$CLOUDBOX_DIR/tmp/N1-partition-state.json"
cloudbox_ssh "chmod 644 '$CLOUDBOX_DIR/tmp/N1-partition-state.json' && mv '$CLOUDBOX_DIR/tmp/N1-partition-state.json' '$CLOUDBOX_DIR/tmp/N1-network-state.json'"
jq '.cut=true' "$WORK/N-partition-proxy-before.json" | worker_ssh 'cat > /tmp/N1-partition-state.json && mv /tmp/N1-partition-state.json /tmp/N1-network-state.json'
worker_ssh "systemctl --user stop $WORKER_TUNNEL_UNIT"
for m in studio cloudbox; do
  end=$((SECONDS+TIMEOUT))
  while :; do
    mut "$m" sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-partition-disconnected-$m.json"
    if jq -e --arg p "$N_ROOT" 'any(.[]; .beta.path==$p and .alpha.connected==false)' "$WORK/N-partition-disconnected-$m.json" >/dev/null; then break; fi
    [ "$SECONDS" -lt "$end" ] || die "Primary endpoint on $m did not disconnect"
    sleep 1
  done
done
rexec worker sh -c "printf 'N-primary-wins' > '$N_FILE'"
rexec studio sh -c "printf 'N-studio-loses' > '$N_FILE'"
rexec cloudbox sh -c "printf 'N-cloudbox-loses' > '$N_FILE'"
for _ in $(seq 1 180); do sleep 1; done
require_bed_lock || die 'Bed lock lost during partition'
restore_partition
worker_ssh "systemctl --user start $WORKER_TUNNEL_UNIT"
PARTITION_ACTIVE=0
# The reconciler must resume and resolve automatically; no retry/resume command here.
assert_converged 'N three-minute partition and conflicting edits'
for m in studio cloudbox; do
  rexec "$m" sh -c "find '$N_ROOT/.t3-conflicts' -type f -name conflict -exec cat {} \\;" > "$WORK/N-copies-$m.txt"
  rg "N-$m-loses" "$WORK/N-copies-$m.txt"
done
crash worker
assert_converged 'N primary restart'
for order in 'studio worker cloudbox' 'studio cloudbox worker' 'worker studio cloudbox' 'worker cloudbox studio' 'cloudbox studio worker' 'cloudbox worker studio'; do
  for m in "${BED_MACHINES[@]}"; do unit "$m" stop; done
  for m in $order; do unit "$m" start; wait_health "$(origin_of "$m")" "$TIMEOUT"; done
  assert_converged "N restart order $order"
  assert_feature_recovery
done
runtime_root="/tmp/N-runtime-$RUN_TS"
worker_ssh "mkdir -p '$runtime_root-source/runtime/versions/0.0.4-N'; printf '#!/bin/sh\nexit 0\n' > '$runtime_root-source/runtime/versions/0.0.4-N/t3'; chmod 700 '$runtime_root-source/runtime/versions/0.0.4-N/t3'"
cloudbox_ssh "mkdir -p '$runtime_root'"
tar -czf "$WORK/N-runtime-scripts.tar.gz" -C "$REPO_ROOT/agent-kit/skills/t3" scripts
cloudbox_put "$WORK/N-runtime-scripts.tar.gz" "$runtime_root/N-runtime-scripts.tar.gz"
jq -n \
  --arg destination "$BED_RUNTIME_COPY_DESTINATION" \
  --arg identityFile "$BED_RUNTIME_COPY_IDENTITY" \
  --arg knownHostsFile "$BED_RUNTIME_COPY_KNOWN_HOSTS" \
  '{destination:$destination,identityFile:$identityFile,knownHostsFile:$knownHostsFile}' > "$WORK/N-runtime-ssh.json"
cloudbox_put "$WORK/N-runtime-ssh.json" "$runtime_root/ssh-copy.json"
cloudbox_put "$MESH_DIR/round3-runtime.sh" "$runtime_root/round3-runtime.sh"
cloudbox_ssh "tar -xzf '$runtime_root/N-runtime-scripts.tar.gz' -C '$runtime_root'; bash '$runtime_root/round3-runtime.sh' '$runtime_root'" | tee "$WORK/N-system-services.log"
printf 'PASS N round3: crash/mount/sync, daemon, partition/conflicts, primary, 6 restart orders; evidence %s\n' "$WORK"
