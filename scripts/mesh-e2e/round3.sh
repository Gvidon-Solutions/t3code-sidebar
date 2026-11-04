#!/usr/bin/env bash
# Destructive resilience acceptance, exclusively on the shared isolated bed.
set -Eeuo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
trap 'printf "FAIL N round3 line %s, stack %s, exit %s\n" "$LINENO" "${BASH_LINENO[*]}" "$?" >&2' ERR
running=$(t3ctl threads --project 66f7ed98 --status running --json)
if jq -e 'any(.[]; .title | test("xdev (QA|L |M )"))' <<<"$running" >/dev/null; then
  printf 'Bed busy: QA/L/M is running. No deployment or fault injection performed.\n' >&2
  exit 75
fi
export MESH_E2E_HELPERS_ONLY=1
export MESH_E2E_ROUND1_WORK="${MESH_E2E_ROUND3_WORK:-/tmp/t3-mesh-e2e-N-round3}"
. "$(dirname "$0")/round1.sh"
unset MESH_E2E_HELPERS_ONLY
export MESH_E2E_SSH_CONTROL_DIR="$WORK/N-ssh"
mkdir -p "$MESH_E2E_SSH_CONTROL_DIR"
chmod 700 "$MESH_E2E_SSH_CONTROL_DIR"
ws_rpc() {
  local machine=$1 method=$2 payload=${3:-'{}'} first=${4:-} token
  token=$(token_of "$machine")
  node "$WS" rpc "$method" "$payload" ${first:+"$first"} --origin "$(origin_of "$machine")" --token "$token" --timeout 240000
}
printf '%s' "$$" > "$WORK/N-round3-runner.pid"
set -e
TIMEOUT=240
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
  local m=$1; shift
  XDG_CONFIG_HOME="$WORK/N-auth-$m" T3CODE_HOME="$(base_of "$m")" T3CTL_ORIGIN="$(origin_of "$m")" T3CTL_T3_BIN="$WORK/N-t3-$m" node "$REPO_ROOT/agent-kit/skills/t3/scripts/t3ctl.mjs" "$@"
}
T_GV=$(mint_token gv); T_GOR=$(mint_token gor); T_VPS=$(mint_token vps)
GV_ENV=$(descriptor_env "$GV_ORIGIN"); GOR_ENV=$(descriptor_env "$GOR_ORIGIN"); VPS_ENV=$(descriptor_env "$VPS_ORIGIN")
N_KEY="N-$RUN_TS"; N_ROOT="/tmp/$N_KEY"; N_FILE="$N_ROOT/conflict"
rexec() {
  local m=$1; shift
  case "$m" in
    gv) "$@";;
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
mut() { local m=$1; shift; local base; base=$(base_of "$m"); rexec "$m" env "MUTAGEN_DATA_DIRECTORY=$base/mutagen" "$(mut_bin "$m")" "$@"; }
unit() {
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
crash() {
  local before after
  before=$(restart_count "$1")
  case "$1" in
    gv) systemctl --user kill --signal=SIGKILL --kill-whom=main "$GV_UNIT";;
    gor) gor_ssh "systemctl --user kill --signal=SIGKILL --kill-whom=main $GOR_UNIT";;
    vps) rexec vps node -e 'const fs = require("node:fs"); const {pid} = JSON.parse(fs.readFileSync("/home/t3/.t3/userdata/server-runtime.json", "utf8")); if (!Number.isSafeInteger(pid) || pid <= 1 || !fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("/opt/t3/dist/bin.mjs")) throw Error("Invalid captured test server PID"); process.kill(pid, "SIGKILL");';;
  esac
  wait_health "$(origin_of "$1")" "$TIMEOUT"
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
ws_get gv > "$WORK/N-before.json"
restore() {
  local rc=$?
  for m in gv gor vps; do unit "$m" start || rc=1; done
  gor_ssh "systemctl --user start $GOR_TUNNEL_UNIT" || rc=1
  wait_health "$GV_ORIGIN" "$TIMEOUT" || rc=1
  for m in gv vps; do
    if [ -f "$WORK/N-replicas-enabled-before-$m.json" ]; then
      ws_rpc "$m" server.updateSettings "$(jq -nc --argjson enabled "$(cat "$WORK/N-replicas-enabled-before-$m.json")" '{patch:{replicasEnabled:$enabled}}')" > "$WORK/N-restore-engine-$m.json" || rc=1
    fi
  done
  local old; old=$(jq -c '.document["mesh.authority"].v // null' "$WORK/N-before.json")
  ws_rpc gv meshLayout.apply "$(entry mesh.authority "$old")" > "$WORK/N-restore.json" || rc=1
  if [ -S "$MESH_E2E_SSH_CONTROL_DIR/gor" ]; then ssh -F "$GOR_SSH_CONFIG" -S "$MESH_E2E_SSH_CONTROL_DIR/gor" -O exit "$GOR_HOST" || rc=1; fi
  if [ -S "$MESH_E2E_SSH_CONTROL_DIR/vps" ]; then ssh -F "$VPS_SSH_CONFIG" -S "$MESH_E2E_SSH_CONTROL_DIR/vps" -O exit "$VPS_HOST" || rc=1; fi
  exit "$rc"
}
trap restore EXIT
for m in gv gor vps; do rexec "$m" mkdir -p "$N_ROOT"; done
rexec gor git init -q "$N_ROOT"
rexec gor sh -c "printf 'baseline' > '$N_FILE'; dd if=/dev/urandom of='$N_ROOT/payload' bs=1048576 count=32 status=none"
ws_rpc gv meshLayout.apply "$(entry mesh.authority "\"$GOR_ENV\"")" > "$WORK/N-authority.json"
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
  ws_rpc "$m" server.getConfig '{}' | jq '.settings.replicasEnabled' > "$WORK/N-replicas-enabled-before-$m.json"
  # Restart disabled to drain in-flight commands before capturing our daemon.
  ws_rpc "$m" server.updateSettings '{"patch":{"replicasEnabled":false}}' > "$WORK/N-quiesce-$m.json"
  unit "$m" stop
  unit "$m" start
  wait_health "$(origin_of "$m")" "$TIMEOUT"
  ws_rpc "$m" server.getConfig '{}' | jq -e '.settings.replicasEnabled==false' >/dev/null
  base=$(base_of "$m")
  daemon_dir="$base/N-faults/$N_KEY"
  rexec "$m" mkdir -p "$daemon_dir"
  if rexec "$m" node -e 'const s=require("node:net").connect(process.argv[1]); s.once("connect",()=>{s.end();process.exit(0)}); s.once("error",()=>process.exit(1)); s.setTimeout(1000,()=>process.exit(1));' "$base/mutagen/daemon/daemon.sock"; then mut "$m" daemon stop; fi
  end=$((SECONDS+TIMEOUT))
  until daemon_lock "$m" 0; do
    [ "$SECONDS" -lt "$end" ] || exit 1
    sleep 0.1
  done
  rexec "$m" sh -c 'MUTAGEN_DATA_DIRECTORY="$1" nohup "$2" daemon run > "$3/daemon.log" 2>&1 & echo $! > "$3/daemon.pid"' sh "$base/mutagen" "$(mut_bin "$m")" "$daemon_dir"
  wait_daemon "$m"
  captured_pid=$(rexec "$m" cat "$daemon_dir/daemon.pid")
  daemon_lock "$m" "$captured_pid"
  ws_rpc "$m" server.updateSettings "$(jq -nc --argjson enabled "$(cat "$WORK/N-replicas-enabled-before-$m.json")" '{patch:{replicasEnabled:$enabled}}')" > "$WORK/N-enable-before-kill-$m.json"
  mv "$WORK/N-replicas-enabled-before-$m.json" "$WORK/N-replicas-enabled-restored-$m.json"
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
# Pause syncing while partitioned to make both divergent versions deterministic.
for m in gv vps; do
  ws_rpc "$m" server.getConfig '{}' | jq '.settings.replicasEnabled' > "$WORK/N-replicas-enabled-before-$m.json"
  ws_rpc "$m" server.updateSettings '{"patch":{"replicasEnabled":false}}' > "$WORK/N-partition-quiesce-$m.json"
  unit "$m" stop
  unit "$m" start
  wait_health "$(origin_of "$m")" "$TIMEOUT"
  mut "$m" sync list --label-selector t3-logical --template '{{json .}}' > "$WORK/N-before-partition-$m.json"
  while IFS= read -r name; do mut "$m" sync pause "$name"; done < <(jq -r --arg p "$N_ROOT" '.[] | select(.beta.path==$p) | .name' "$WORK/N-before-partition-$m.json")
done
gor_ssh "systemctl --user stop $GOR_TUNNEL_UNIT"
rexec gor sh -c "printf 'N-authority-wins' > '$N_FILE'"
rexec gv sh -c "printf 'N-gv-loses' > '$N_FILE'"
rexec vps sh -c "printf 'N-vps-loses' > '$N_FILE'"
for m in gv vps; do
  ws_rpc "$m" server.updateSettings "$(jq -nc --argjson enabled "$(cat "$WORK/N-replicas-enabled-before-$m.json")" '{patch:{replicasEnabled:$enabled}}')" > "$WORK/N-partition-enable-$m.json"
  mv "$WORK/N-replicas-enabled-before-$m.json" "$WORK/N-replicas-enabled-restored-$m.json"
done
for _ in $(seq 1 180); do sleep 1; done
gor_ssh "systemctl --user start $GOR_TUNNEL_UNIT"
# The reconciler must resume and resolve automatically; no retry/resume command here.
assert_converged 'N three-minute partition and conflicting edits'
for m in gv vps; do
  rexec "$m" sh -c "find '$N_ROOT/.t3-conflicts' -type f -name conflict -exec cat {} \\;" > "$WORK/N-copies-$m.txt"
  rg "N-$m-loses" "$WORK/N-copies-$m.txt"
done
crash gor
assert_converged 'N authority restart'
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
printf 'PASS N round3: crash/mount/sync, daemon, partition/conflicts, authority, 6 restart orders; evidence %s\n' "$WORK"
