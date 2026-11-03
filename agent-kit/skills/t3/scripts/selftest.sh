#!/usr/bin/env bash
# Live checks require an explicitly isolated origin and opt-in.
set -uo pipefail
T3CTL=${1:-$(dirname "$(readlink -f "$0")")/t3ctl.mjs}
if [ "${T3CTL_FULL_SELFTEST:-0}" = 1 ]; then
  for required in T3CTL_SELFTEST_AGENT T3CTL_SELFTEST_MODEL T3CTL_SELFTEST_ALT_MODEL; do
    if [ -z "${!required:-}" ]; then echo "selftest: set $required from the test server's model catalog" >&2; exit 1; fi
  done
fi
t() {
  if [ "${T3CTL_FULL_SELFTEST:-0}" = 1 ] && [ "${1:-}" = new ]; then
    node "$T3CTL" "$@" --agent "$T3CTL_SELFTEST_AGENT" --model "$T3CTL_SELFTEST_MODEL"
  else node "$T3CTL" "$@"; fi
}
UNIT="$(dirname "$(readlink -f "$T3CTL")")/t3ctl.unit.test.mjs"
if [ -f "$UNIT" ]; then
  echo "== offline unit checks =="
  if ! node --test "$UNIT"; then echo "selftest: unit checks failed"; exit 1; fi
fi
if ! node --test "$(dirname "$T3CTL")/t3ctl.integration.test.mjs"; then exit 1; fi
if ! node --test "$(dirname "$T3CTL")/agents-sync.test.mjs"; then exit 1; fi
if ! node --test "$(dirname "$T3CTL")/server-runtime.test.mjs"; then exit 1; fi
PARITY="$(dirname "$T3CTL")/../shared-parity.test.mjs"
if [ -f "$PARITY" ]; then
  if ! node --test "$PARITY"; then echo "selftest: shared parity checks failed"; exit 1; fi
fi
if [ "${T3CTL_OFFLINE_ONLY:-0}" = 1 ]; then exit 0; fi
# Validate before any authentication or write, including the original regression suite.
if [ "${T3CTL_ISOLATED_TEST:-0}" != 1 ] || [ -z "${T3CTL_ORIGIN:-}" ]; then
  echo "selftest: set T3CTL_ISOLATED_TEST=1 and T3CTL_ORIGIN for an isolated test server"; exit 1
fi
pass=0; fail=0
check() { # name, command..., expects exit 0 and optional grep pattern in $EXPECT
  local name=$1; shift
  local out; out=$("$@" 2>&1); local rc=$?
  if [ $rc -eq 0 ] && { [ -z "${EXPECT:-}" ] || grep -qiE "$EXPECT" <<<"$out"; }; then pass=$((pass+1)); echo "ok    $name"
  else fail=$((fail+1)); echo "FAIL  $name (rc=$rc)"; sed 's/^/      /' <<<"$out" | tail -8; fi
  EXPECT=
}
if [ "${T3CTL_FULL_SELFTEST:-0}" = 1 ]; then
DIR=$(mktemp -d "$HOME/t3ctl-selftest-XXXX")
git -C "$DIR" init -q && echo "selftest" >"$DIR/README.md" && git -C "$DIR" add -A && git -C "$DIR" -c user.email=t@t -c user.name=t commit -qm init
BR=$(git -C "$DIR" branch --show-current)
P=selftest-$(basename "$DIR")

EXPECT='ok +ws rpc' check doctor t doctor
EXPECT='added project' check project-add t project-add "$DIR" --title "$P"
EXPECT=providers   check models t models --json
EXPECT='started thread' check new t new --project "$P" --title "st-main" "Reply with exactly: ALPHA"
EXPECT='completed' check wait t wait st-main --timeout 5m
EXPECT='^ALPHA'    check output t output st-main
EXPECT='BETA'      check send-wait t send st-main "Reply with exactly: BETA" --wait --timeout 5m
EXPECT='BETA'      check show t show st-main --messages 2
EXPECT='renamed'   check rename t rename st-main "st-renamed"
for a in pin unpin settle unsettle unread; do EXPECT="$a" check "$a" t "$a" st-renamed; done
EXPECT='snoozed'   check snooze t snooze st-renamed --for 1h
EXPECT='unsnooze'  check unsnooze t unsnooze st-renamed
check set-model t set-model st-renamed --agent "$T3CTL_SELFTEST_AGENT" --model "$T3CTL_SELFTEST_ALT_MODEL"
EXPECT='plan'      check set-mode-plan t set-mode st-renamed plan
EXPECT='default'   check set-mode-default t set-mode st-renamed default
check set-model-back t set-model st-renamed --agent "$T3CTL_SELFTEST_AGENT" --model "$T3CTL_SELFTEST_MODEL"
EXPECT='forked'    check fork t fork st-renamed --title st-fork --message "Reply with the last word you said before this message, only that word."
EXPECT='completed' check fork-wait t wait st-fork --timeout 5m
EXPECT='BETA'      check fork-context t output st-fork
EXPECT='started'   check approval-new t new --project "$P" --mode approval-required --title st-approve "Create a file named ok.txt containing yes with a shell command, then reply DONE."
for i in $(seq 1 30); do t requests st-approve 2>/dev/null | grep -q approval && break; sleep 3; done
EXPECT='approval'  check requests t requests st-approve
EXPECT='accept'    check approve t approve st-approve acceptForSession
for i in $(seq 1 20); do [ -f "$DIR/ok.txt" ] && break; sleep 3; done
check approved-file test -f "$DIR/ok.txt"
t wait st-approve --timeout 3m >/dev/null 2>&1
EXPECT='started'   check question-new t new --project "$P" --plan --title st-ask "Use your request_user_input tool to ask me one question: red or blue (two options). Then reply with my answer."
for i in $(seq 1 30); do t requests st-ask 2>/dev/null | grep -q question && break; sleep 3; done
EXPECT='question'  check question-requests t requests st-ask
EXPECT='=Blue'     check answer t answer st-ask blue
EXPECT='started'   check stop-new t new --project "$P" --title st-stop "Run 'sleep 120' in the shell, then reply DONE."
sleep 15
EXPECT='interrupt' check stop t stop st-stop
EXPECT='feature/st' check worktree t new --project "$P" --worktree feature/st --base "$BR" --title st-wt "Run git branch --show-current and reply with its output only." --wait --timeout 5m
NOTE="$DIR.note.txt"; echo "secret: KIWI" >"$NOTE"
EXPECT='kiwi'      check attach t new --project "$P" --title st-attach --attach "$NOTE" "What is the secret in the attached file? Reply with the word only." --wait --timeout 5m
EXPECT='added workspace' check ws-add t ws add "Selftest WS"
EXPECT='workspace' check ws-assign t ws assign "$P" "Selftest WS"
EXPECT="$P"        check ws-list t ws
EXPECT='back to|assignment removed' check ws-unassign t ws unassign "$P"
EXPECT='removed'   check ws-rm t ws rm "Selftest WS" --yes
EXPECT='ALPHA|BETA' check search t search BETA --project "$P"
EXPECT='done'      check bulk-archive t bulk archive --project "$P" --match st-attach --yes
EXPECT='st-attach' check archived-list t threads --archived --project "$P"
EXPECT='unarchive' check unarchive t unarchive st-attach
EXPECT='"sequence"' check dispatch t dispatch "{\"type\":\"thread.pin\",\"threadId\":\"$(t threads --project "$P" --match st-attach --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].threadId))')\"}"
EXPECT='environment' check rpc t rpc server.getConfig
EXPECT='modelSelection' check tool t tool t3_thread_configure "{\"threadId\":\"$(t threads --project "$P" --match st-attach --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].threadId))')\"}"
EXPECT='candidates|imported' check scan t scan --json
EXPECT='deleted'   check delete t delete st-stop --yes
EXPECT='removed project' check project-remove t project-remove "$P" --yes --force
# T3 leaves the worktree it created; remove it with the temp repo
git -C "$DIR" worktree list --porcelain | awk '/^worktree /{print $2}' | grep -vx "$DIR" | while read -r w; do rm -rf "$w"; rmdir "$(dirname "$w")" 2>/dev/null; done
rm -rf "$DIR" "$NOTE"
fi

mesh_live() {
  echo "== mesh live checks ($T3CTL_ORIGIN) =="
  EXPECT='environmentId' check mesh-env t env --json
  EXPECT='environmentId' check mesh-machines t machines --json
  EXPECT='local' check mesh-status t mesh status --json
  EXPECT='workspaces|legacy' check mesh-layout t layout get
  EXPECT='replica|representations|disabled' check mesh-replicas t replicas --json
  EXPECT='threadId|\[\]' check mesh-threads t threads --all --limit 2 --json
  EXPECT='matches' check mesh-find t find mount --all --json
  EXPECT='needs you|working|done|other|nothing' check mesh-status-all t status --all --json
  local label
  label="$(t env --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).label||"")}catch{}})' 2>/dev/null)"
  if [ -n "$label" ]; then
    EXPECT='dry run' check mesh-layout-merge t layout merge --from "$label" --dry-run
  fi
  local tid
  tid="$(t threads --all --limit 1 --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);console.log(a[0]?.threadId||"")}catch{}})' 2>/dev/null)"
  if [ -n "$tid" ]; then
    EXPECT='t3-thread://' check mesh-open t open "$tid" --json
  fi
  if [ -n "${MESH_E2E_CAT_PATH:-}" ]; then
    EXPECT='.' check mesh-cat t cat "$MESH_E2E_CAT_PATH"
  fi
}
if [ "${T3CTL_MESH_E2E:-0}" = 1 ]; then
  mesh_live || exit 1
fi

echo "selftest: $pass ok, $fail failed"
[ "$fail" -eq 0 ]
