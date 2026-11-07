#!/usr/bin/env bash
# T3 Mesh E2E — round 1, stages 3–8 on the three-machine bed.
#
# Re-runs, against the already seeded bed from `scripts/mesh-e2e/README.md`:
#   3. mesh settings on every server, gv↔gor and gor↔vps links (not gv↔vps)
#   4. convergence, one "main", no lost project keys, legacy settings = materialize(doc)
#   5. concurrent, offline and mid-sync edits
#   6. layout RPC regression and the replicas.status stream
#   7. files.read/files.list across the mesh
#   8. an old client's whole-object settings write next to a concurrent mesh edit
#
# Exit code 0 only when every check passed. The bed is left running and linked.
#
# Usage: scripts/mesh-e2e/round1.sh [--timeout SECONDS]
set -uo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

set +e
load_build_env
require_bins

TIMEOUT="${MESH_E2E_ROUND1_TIMEOUT:-60}"
if [ "${1:-}" = "--timeout" ]; then
  TIMEOUT="${2:-60}"
fi

GV_ORIGIN="http://127.0.0.1:$GV_PORT"
GOR_ORIGIN="http://127.0.0.1:$GOR_LOCAL"
VPS_ORIGIN="http://127.0.0.1:$VPS_LOCAL"
LEGACY_DIR="$STATE_DIR/legacy"
WORK="${MESH_E2E_ROUND1_WORK:-/tmp/t3-mesh-e2e-round1}"
WS="$WORK/ws.mjs"
GOR_BIN="~/.t3-sidebar-server/runtime/versions/$BUILD_VERSION/t3"
VPS_BIN="/opt/t3/dist/bin.mjs"

RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
SCRATCH="round1-$RUN_TS"
SCRATCH_NAME="r1-$RUN_TS"
SCRATCH_NAME_A="r1-a-$RUN_TS"
SCRATCH_NAME_B="r1-b-$RUN_TS"
SCRATCH_NAME_C="r1-c-$RUN_TS"
OLD_A="round1-old-$RUN_TS"
OLD_B="round1-oldb-$RUN_TS"

PASS=0
FAIL=0
FAILED=()
GOR_STOPPED=0
VPS_KILLED=0

record_pass() { PASS=$((PASS + 1)); printf 'PASS  %s%s\n' "$1" "${2:+  ($2)}"; }
record_fail() {
  FAIL=$((FAIL + 1))
  FAILED+=("$1")
  printf 'FAIL  %s%s\n' "$1" "${2:+  ($2)}"
}
check() { # check <name> <command...>
  local name=$1
  shift
  if "$@"; then record_pass "$name"; else record_fail "$name"; fi
}
now_ms() { date +%s%3N; }
elapsed_ms() { echo $(( $(now_ms) - $1 )); }

cleanup_bed() {
  if [ "$GOR_STOPPED" = 1 ]; then
    gor_ssh 'systemctl --user start t3code-sidebar.service' >/dev/null 2>&1 || true
    GOR_STOPPED=0
  fi
  if [ "$VPS_KILLED" = 1 ]; then
    vps_ssh 'docker start t3-mesh-e2e' >/dev/null 2>&1 || true
    VPS_KILLED=0
  fi
}
trap cleanup_bed EXIT

mkdir -p "$WORK/node_modules/@t3tools"
ln -sfn "$REPO_ROOT/packages/shared" "$WORK/node_modules/@t3tools/shared"
cat >"$WS" <<'NODE'
#!/usr/bin/env node
// Minimal T3 WebSocket RPC client for the mesh E2E bed (round1.sh writes this at runtime).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { between, keys, materialize, canonical } from "@t3tools/shared/meshLayout";

const argv = process.argv.slice(2);
const command = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const origin = opt("origin", process.env.R1_ORIGIN || "").replace(/\/$/, "");
const token = opt("token", process.env.R1_TOKEN || "");
if (!origin || !token) {
  console.error("ws.mjs: --origin and --token are required");
  process.exit(2);
}
const timeoutMs = Number(opt("timeout", "30000"));
const overallTimer = setTimeout(() => { console.error("RPC client deadline exceeded"); process.exit(1); }, timeoutMs + 5000);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
}).catch((error) => fail(`ticket request failed: ${error.message}`));
if (!ticketResponse.ok) fail(`ticket request failed: HTTP ${ticketResponse.status}`);
const { ticket } = await ticketResponse.json();

const ws = new WebSocket(
  `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2&clientSurface=cli`,
);
const pending = new Map();
let seq = 0;
let connected = false;
ws.onmessage = (event) => {
  for (const line of String(event.data).split("\n")) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message._tag === "Ping") {
      ws.send(JSON.stringify({ _tag: "Pong" }));
      continue;
    }
    const request = pending.get(message.requestId);
    if (!request) continue;
    if (message._tag === "Chunk") {
      request.chunks.push(...message.values);
      if (request.firstChunk) {
        pending.delete(message.requestId);
        ws.send(JSON.stringify({ _tag: "Interrupt", requestId: message.requestId }));
        request.resolve({ ok: true, value: request.chunks });
      } else {
        ws.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
      }
    } else if (message._tag === "Exit") {
      pending.delete(message.requestId);
      if (request.firstChunk && message.exit._tag === "Success" && request.chunks.length > 0) {
        request.resolve({ ok: true, value: request.chunks });
      } else if (message.exit._tag === "Success") {
        request.resolve({ ok: true, value: message.exit.value });
      } else {
        request.resolve({ ok: false, error: message.exit.cause ?? message.exit });
      }
    } else if (message._tag === "Defect") {
      pending.delete(message.requestId);
      request.resolve({ ok: false, error: message.defect });
    }
  }
};
const opened = new Promise((resolve, reject) => {
  ws.onopen = () => {
    connected = true;
    resolve();
  };
  ws.onerror = () => reject(new Error("websocket connection failed"));
});
try {
  await opened;
} catch (error) {
  fail(error.message);
}

let nextId = 0;
const rpc = (method, payload = {}, { first = false } = {}) =>
  new Promise((resolve, reject) => {
    if (!connected) return reject(new Error("websocket closed"));
    const id = String(nextId++);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      chunks: [],
      firstChunk: first,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
    ws.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }));
    seq++;
  });

const parseJson = (text) => {
  if (text === undefined) return {};
  if (text.startsWith("@")) return JSON.parse(readFileSync(text.slice(1), "utf8"));
  return JSON.parse(text);
};

const call = async (method, payload, options) => {
  const result = await rpc(method, payload, options);
  if (!result.ok) {
    console.log(JSON.stringify({ __error: true, message: JSON.stringify(result.error) }));
    process.exit(1);
  }
  return result.value;
};

const snapshot = () => call("meshLayout.get", {});

const hlcNow = (document, environmentId) => {
  let max = 0;
  for (const entry of Object.values(document)) {
    const milliseconds = Number(String(entry.h).slice(0, 13));
    if (Number.isFinite(milliseconds) && milliseconds > max) max = milliseconds;
  }
  const milliseconds = Math.max(Date.now(), max + 1);
  return `${String(milliseconds).padStart(13, "0")}.00000.${environmentId}`;
};

const editOp = async (op, doc, environmentId) => {
  const h = hlcNow(doc, environmentId);
  const entry = (v) => ({ v, h });
  const workspaceValue = (id) => doc[`ws/${id}`]?.v;
  switch (op.kind) {
    case "addWorkspace":
      return { [`ws/${op.id}`]: entry({ name: op.name, ...(op.color ? { color: op.color } : {}), sort: op.sort ?? "zzzz" }) };
    case "renameWorkspace": {
      const value = workspaceValue(op.id);
      if (!value) throw new Error(`no workspace ${op.id}`);
      return { [`ws/${op.id}`]: entry({ ...value, name: op.name }) };
    }
    case "removeWorkspace": {
      const entries = { [`ws/${op.id}`]: entry(null) };
      for (const key of Object.keys(doc)) {
        if (key.startsWith("place/") && key.endsWith(`/${op.id}`)) entries[key] = entry(null);
        if (key.startsWith(`fold/${op.id}/`)) entries[key] = entry(null);
      }
      return entries;
    }
    case "place":
      return { [keys.place(op.project, op.workspace)]: entry({ sort: op.sort ?? "zzzz" }) };
    case "unplace":
      return { [`place/${encodeURIComponent(op.project)}/${encodeURIComponent(op.workspace)}`]: entry(null) };
    case "reorder": {
      const sorts = op.order.map((id) => workspaceValue(id)?.sort).filter((sort) => typeof sort === "string").sort();
      if (sorts.length !== op.order.length) throw new Error("reorder needs every workspace to have a sort");
      return { [`ws/${op.order[0]}`]: entry({ ...workspaceValue(op.order[0]), sort: between(null, Object.values(doc).filter(e => e.v && typeof e.v === "object" && "sort" in e.v).map(e => e.v.sort).sort()[0] ?? null) }) };
    }
    default:
      throw new Error(`unknown edit kind ${op.kind}`);
  }
};

try {
  if (command === "rpc") {
    const method = argv[1];
    const value = await call(method, parseJson(argv[2]), { first: argv.includes("--first") });
    console.log(JSON.stringify(value, null, 2));
  } else if (command === "get") {
    const value = await snapshot();
    if (canonical(materialize(value.document)) !== canonical(value.config)) fail("server config differs from materialize(document)");
    console.log(JSON.stringify(value, null, 2));
  } else if (command === "edit") {
    const op = parseJson(argv[1]);
    const current = await snapshot();
    const entries = await editOp(op, current.document, current.environmentId);
    const result = await call("meshLayout.apply", { entries });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "oldclient") {
    const beforeFile = opt("before");
    const afterFile = opt("after");
    const goFile = opt("go");
    if (!beforeFile || !afterFile || !goFile) fail("oldclient needs --before, --after and --go");
    const config = await call("server.getConfig", {});
    writeFileSync(beforeFile, JSON.stringify(config.settings.sidebarWorkspaces));
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(goFile)) {
      if (Date.now() > deadline) fail("oldclient: go file never appeared");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const after = JSON.parse(readFileSync(afterFile, "utf8"));
    const result = await call("server.updateSettings", { patch: { sidebarWorkspaces: after } });
    console.log(JSON.stringify({ ok: true, workspaces: result.sidebarWorkspaces?.workspaces?.length }));
  } else {
    fail("usage: ws.mjs {get|rpc <method> [payload]|edit <op>|oldclient ...}");
  }
} finally {
  clearTimeout(overallTimer);
  ws.close();
}
NODE

# ---------------------------------------------------------------------------
# Server discovery and tokens
# ---------------------------------------------------------------------------
descriptor_env() { # descriptor_env <origin>
  curl -fsS --max-time 5 "$1/.well-known/t3/environment" | jq -r '.environmentId'
}
descriptor_version() { # descriptor_version <origin>
  curl -fsS --max-time 5 "$1/.well-known/t3/environment" | jq -r '.serverVersion'
}

mint_token_once() { # mint_token_once gv|gor|vps
  case "$1" in
    gv) "$GV_RUNTIME_ROOT/$BUILD_VERSION/t3" auth session issue --base-dir "$GV_BASE_DIR" \
      --ttl 30m --label mesh-e2e-round1 --token-only 2>/dev/null ;;
    gor) gor_ssh "$GOR_BIN auth session issue --base-dir ~/.t3-sidebar-server --ttl 30m \
      --label mesh-e2e-round1 --token-only" 2>/dev/null ;;
    vps) vps_ssh "docker exec t3-mesh-e2e node $VPS_BIN auth session issue \
      --base-dir /home/t3/.t3 --ttl 30m --label mesh-e2e-round1 --token-only" 2>/dev/null ;;
  esac
}
mint_token() { # mint_token gv|gor|vps — a just-restarted server can answer empty once
  local i output
  for i in 1 2 3 4 5; do
    output="$(mint_token_once "$1" | head -1)"
    if [ -n "$output" ]; then printf '%s' "$output"; return 0; fi
    sleep 1
  done
  return 1
}

pair_code() { # pair_code gv|gor|vps
  local out
  case "$1" in
    gv) out="$("$GV_RUNTIME_ROOT/$BUILD_VERSION/t3" auth pairing create --base-dir "$GV_BASE_DIR" \
      --ttl 20m --label mesh-e2e-link --json 2>/dev/null)" ;;
    gor) out="$(gor_ssh "$GOR_BIN auth pairing create --base-dir ~/.t3-sidebar-server \
      --ttl 20m --label mesh-e2e-link --json" 2>/dev/null)" ;;
    vps) out="$(vps_ssh "docker exec t3-mesh-e2e node $VPS_BIN auth pairing create \
      --base-dir /home/t3/.t3 --ttl 20m --label mesh-e2e-link --json" 2>/dev/null)" ;;
  esac
  printf '%s\n' "$out" | sed -n '/^{/,$p' | jq -r '.credential // empty'
}

T_GV=""
T_GOR=""
T_VPS=""
token_of() {
  case "$1" in
    gv) [ -n "$T_GV" ] || T_GV="$(mint_token gv)"; printf '%s' "$T_GV" ;;
    gor) [ -n "$T_GOR" ] || T_GOR="$(mint_token gor)"; printf '%s' "$T_GOR" ;;
    vps) [ -n "$T_VPS" ] || T_VPS="$(mint_token vps)"; printf '%s' "$T_VPS" ;;
  esac
}
origin_of() {
  case "$1" in
    gv) printf '%s' "$GV_ORIGIN" ;;
    gor) printf '%s' "$GOR_ORIGIN" ;;
    vps) printf '%s' "$VPS_ORIGIN" ;;
  esac
}

ws_rpc() { # ws_rpc <machine> <method> [payload] [--first]
  local machine=$1 method=$2 payload=${3:-'{}'} first=${4:-}
  local token
  token="$(token_of "$machine")"
  [ -n "$token" ] || { echo '{"__error":true,"message":"no token"}'; return 1; }
  node "$WS" rpc "$method" "$payload" ${first:+"$first"} \
    --origin "$(origin_of "$machine")" --token "$token" --timeout 60000
}
ws_get() { # ws_get <machine> -> snapshot JSON
  local token
  token="$(token_of "$1")"
  node "$WS" get --origin "$(origin_of "$1")" --token "$token" --timeout 60000
}
ws_edit() { # ws_edit <machine> <op-json>
  local token
  token="$(token_of "$1")"
  node "$WS" edit "$2" --origin "$(origin_of "$1")" --token "$token" --timeout 60000
}

snapshot_all() { # snapshot_all -> writes $WORK/snap-<machine>.json, fails if any call failed
  local machine ok=0
  for machine in gv gor vps; do
    if ws_get "$machine" >"$WORK/snap-$machine.json" 2>"$WORK/snap-$machine.err"; then :; else ok=1; fi
  done
  return "$ok"
}

doc_hash() { jq -S -c '.document' "$1" | sha256sum | cut -d' ' -f1; }
config_hash() { jq -S -c '.config' "$1" | sha256sum | cut -d' ' -f1; }

wait_converged() { # wait_converged <label> [machines...] -> 0 when docs and configs agree
  local label=$1
  shift
  local machines=("$@")
  [ "${#machines[@]}" -gt 0 ] || machines=(gv gor vps)
  local start deadline first_doc="" first_cfg="" machine doc_hash_value cfg_hash_value converged=1
  start="$(now_ms)"
  deadline=$((start + TIMEOUT * 1000))
  local barrier="$WORK/convergence-barrier.json" snapshots=()
  if [ "${MESH_E2E_LIVE_REPORTS:-0}" = 1 ]; then
    for machine in "${machines[@]}"; do
      ws_get "$machine" > "$WORK/snap-$machine.json" || return 1
      snapshots+=("$WORK/snap-$machine.json")
    done
    node "$REPO_ROOT/scripts/mesh-e2e/convergence.mjs" capture "$barrier" "${snapshots[@]}" || return 1
  fi
  while :; do
    converged=1
    first_doc=""
    first_cfg=""
    for machine in "${machines[@]}"; do
      if ! ws_get "$machine" >"$WORK/snap-$machine.json" 2>"$WORK/snap-$machine.err"; then
        converged=0
        break
      fi
      doc_hash_value="$(doc_hash "$WORK/snap-$machine.json")"
      cfg_hash_value="$(config_hash "$WORK/snap-$machine.json")"
      if [ "${MESH_E2E_LIVE_REPORTS:-0}" = 1 ]; then continue; fi
      if [ -z "$first_doc" ]; then
        first_doc="$doc_hash_value"
        first_cfg="$cfg_hash_value"
      elif [ "$doc_hash_value" != "$first_doc" ] || [ "$cfg_hash_value" != "$first_cfg" ]; then
        converged=0
        break
      fi
    done
    if [ "$converged" = 1 ] && [ "${MESH_E2E_LIVE_REPORTS:-0}" = 1 ]; then
      node "$REPO_ROOT/scripts/mesh-e2e/convergence.mjs" check "$barrier" "${snapshots[@]}" || converged=0
      first_doc="captured all-entry HLC barrier"
    fi
    if [ "$converged" = 1 ]; then
      local took
      took="$(elapsed_ms "$start")"
      record_pass "$label" "converged in ${took}ms, doc $first_doc"
      return 0
    fi
    if [ "$(now_ms)" -ge "$deadline" ]; then
      record_fail "$label" "not converged after ${TIMEOUT}s"
      for machine in "${machines[@]}"; do
        printf '  %s doc %s config %s\n' "$machine" \
          "$(doc_hash "$WORK/snap-$machine.json" 2>/dev/null || echo '?')" \
          "$(config_hash "$WORK/snap-$machine.json" 2>/dev/null || echo '?')"
      done
      return 1
    fi
    sleep 0.5
  done
}

assert_all() { # assert_all <label> <jq filter> -> passes when filter is true on every snapshot
  local label=$1 filter=$2 machine ok=1
  for machine in gv gor vps; do
    if ! jq -e "$filter" "$WORK/snap-$machine.json" >/dev/null 2>&1; then
      ok=0
      printf '  %s: %s\n' "$machine" "$(jq -c "$filter" "$WORK/snap-$machine.json" 2>/dev/null || echo 'missing')"
    fi
  done
  if [ "$ok" = 1 ]; then record_pass "$label"; else record_fail "$label"; fi
}

wait_health() { # wait_health <origin> <tries>
  local i
  for ((i = 1; i <= ${2:-60}; i++)); do
    curl -fsS --max-time 2 -o /dev/null "$1/.well-known/t3/environment" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

if [ "${MESH_E2E_HELPERS_ONLY:-0}" = 1 ]; then return 0; fi

# ---------------------------------------------------------------------------
# Step 3 — settings and links
# ---------------------------------------------------------------------------
echo "== step 3: settings and links =="

check "build $BUILD_VERSION deployed on gv" \
  grep -q "$BUILD_VERSION/t3" ~/.config/systemd/user/"$GV_UNIT"
check "build $BUILD_VERSION deployed on gor" \
  gor_ssh "grep -q 'runtime/versions/$BUILD_VERSION/t3' ~/.config/systemd/user/$GOR_UNIT"
check "build $BUILD_VERSION image deployed on vps" \
  test "$(docker image inspect "$IMAGE" -f '{{.Id}}')" = "$(vps_ssh "docker image inspect '$IMAGE' -f '{{.Id}}'")"

T_GV="$(mint_token gv)"
T_GOR="$(mint_token gor)"
T_VPS="$(mint_token vps)"

GV_ENV="$(descriptor_env "$GV_ORIGIN")"
GOR_ENV="$(descriptor_env "$GOR_ORIGIN")"
VPS_ENV="$(descriptor_env "$VPS_ORIGIN")"
printf 'environments: gv=%s gor=%s vps=%s\n' "$GV_ENV" "$GOR_ENV" "$VPS_ENV"

for machine in gv gor vps; do
  ws_rpc "$machine" server.updateSettings \
    '{"patch":{"meshEnabled":true,"linkedEnvironmentsEnabled":true}}' >/dev/null 2>&1
done
for machine in gv gor vps; do
  enabled="$(ws_rpc "$machine" server.getConfig '{}' 2>/dev/null | jq -r '.settings.linkedEnvironmentsEnabled // false')"
  check "$machine has linkedEnvironmentsEnabled" test "$enabled" = true
done

link_exists() { # link_exists <machine> <peer-env>
  ws_rpc "$1" peerLinks.list '{}' 2>/dev/null |
    jq -e --arg id "$2" '.links[] | select(.environmentId == $id)' >/dev/null 2>&1
}

ensure_link() { # ensure_link <from> <to> <url> <to-env>
  local from=$1 to=$2 url=$3 to_env=$4 payload code
  if link_exists "$from" "$to_env"; then
    local access status
    access="$(ws_rpc "$from" peerLinks.list '{}' | jq -r --arg id "$to_env" '.links[] | select(.environmentId == $id) | .access')"
    status="$(ws_rpc "$from" peerLinks.list '{}' | jq -r --arg id "$to_env" '.links[] | select(.environmentId == $id) | .status')"
    if [ "$access" = full-access ] && [ "$status" != expired ]; then
      check "$from→$to link is full-access" true
      return 0
    fi
    ws_rpc "$from" peerLinks.unlink "{\"environmentId\":\"$to_env\"}" >/dev/null 2>&1
  fi
  code="$(pair_code "$to")"
  if [ -z "$code" ]; then
    record_fail "$from→$to link created" "no pairing code from $to"
    return 1
  fi
  payload="$(jq -nc --arg url "$url" --arg code "$code" --arg id "$to_env" \
    '{url:$url,pairingCode:$code,access:"full-access",expectedEnvironmentId:$id}')"
  if ws_rpc "$from" peerLinks.link "$payload" >"$WORK/link-$from-$to.json" 2>&1; then
    record_pass "$from→$to link created (full-access)"
  else
    record_fail "$from→$to link created" "$(head -c 300 "$WORK/link-$from-$to.json")"
  fi
}

ensure_link gv gor "$GOR_ORIGIN" "$GOR_ENV"
ensure_link gor vps "$VPS_ORIGIN" "$VPS_ENV"

# gv↔vps must stay unlinked so traffic has to go through gor.
gv_has_vps="$(link_exists gv "$VPS_ENV" && echo yes || echo no)"
vps_has_gv="$(link_exists vps "$GV_ENV" && echo yes || echo no)"
if [ "$gv_has_vps" = yes ]; then
  ws_rpc gv peerLinks.unlink "{\"environmentId\":\"$VPS_ENV\"}" >/dev/null 2>&1
  gv_has_vps=no
fi
if [ "$vps_has_gv" = yes ]; then
  ws_rpc vps peerLinks.unlink "{\"environmentId\":\"$GV_ENV\"}" >/dev/null 2>&1
  vps_has_gv=no
fi
check "no gv↔vps link" test "$gv_has_vps$vps_has_gv" = nono

# Wait until both links answer; the mesh exchange then starts on its own.
link_start="$(now_ms)"
links_ok=0
for _ in $(seq 1 "$TIMEOUT"); do
  gv_ok="$(ws_rpc gv peerLinks.list '{}' 2>/dev/null | jq -r --arg id "$GOR_ENV" '.links[] | select(.environmentId == $id) | .status' || true)"
  gor_ok="$(ws_rpc gor peerLinks.list '{}' 2>/dev/null | jq -r --arg id "$VPS_ENV" '.links[] | select(.environmentId == $id) | .status' || true)"
  if [ "$gv_ok" = reachable ] && [ "$gor_ok" = reachable ]; then links_ok=1; break; fi
  sleep 1
done
if [ "$links_ok" = 1 ]; then
  record_pass "links reachable" "gv→gor and gor→vps in $(elapsed_ms "$link_start")ms"
else
  record_fail "links reachable" "gv→gor=$gv_ok gor→vps=$gor_ok"
fi

# ---------------------------------------------------------------------------
# Step 4 — convergence and legacy adoption
# ---------------------------------------------------------------------------
echo "== step 4: convergence and legacy adoption =="
wait_converged "three documents and materialized configs converge"

main_count_ok=1
for machine in gv gor vps; do
  count="$(jq -r '[.config.workspaces[] | select((.name | ascii_downcase) == "main")] | length' "$WORK/snap-$machine.json")"
  [ "$count" = 1 ] || main_count_ok=0
done
check "exactly one \"main\" workspace on every server" test "$main_count_ok" = 1

main_ids="$(for machine in gv gor vps; do jq -r '[.config.workspaces[] | select((.name | ascii_downcase) == "main")][0].id' "$WORK/snap-$machine.json"; done | sort -u | wc -l)"
check "the same \"main\" workspace id everywhere" test "$main_ids" = 1

if [ -f "$LEGACY_DIR/gvidon.json" ] && [ -f "$LEGACY_DIR/operalia.json" ]; then
  project_keys() { # project_keys <config-json-file-or-stdin>
    jq -r '[(.placements | keys[]), (.assignments | keys[]), (.projectOrder[]),
            (.workspaceProjectOrder | to_entries[] | .value[]),
            (.workspaceFold | to_entries[] | .value | keys[])] | unique[]' "$@"
  }
  project_keys "$LEGACY_DIR/gvidon.json" "$LEGACY_DIR/operalia.json" | sort -u >"$WORK/source-keys.txt"
  jq -r '.config' "$WORK/snap-gv.json" >"$WORK/config-gv.json"
  project_keys "$WORK/config-gv.json" | sort -u >"$WORK/materialized-keys.txt"
  jq -r --rawfile keys "$WORK/source-keys.txt" '($keys | split("\n") | map(select(length > 0)))[] as $key | .config.projectAliases[$key] // $key' "$WORK/snap-gv.json" | sort -u > "$WORK/canonical-source-keys.txt"
  missing="$(comm -23 "$WORK/canonical-source-keys.txt" "$WORK/materialized-keys.txt")"
  if [ -z "$missing" ]; then
    record_pass "no project key from either legacy config was lost" "$(wc -l <"$WORK/source-keys.txt") keys"
  else
    record_fail "no project key from either legacy config was lost" "$(printf '%s\n' "$missing" | head -3 | tr '\n' ' ')"
  fi
else
  record_fail "legacy fixtures present" "run the seed step (README) first"
fi

legacy_matches=1
for machine in gv gor vps; do
  ws_rpc "$machine" server.getConfig '{}' 2>/dev/null | jq -S -c '.settings.sidebarWorkspaces' >"$WORK/legacy-$machine.json"
  jq -S -c '.config' "$WORK/snap-$machine.json" >"$WORK/materialized-$machine.json"
  cmp -s "$WORK/legacy-$machine.json" "$WORK/materialized-$machine.json" || legacy_matches=0
done
check "legacy settings.sidebarWorkspaces equals materialize(doc) on every server" test "$legacy_matches" = 1

# ---------------------------------------------------------------------------
# Step 5 — edits
# ---------------------------------------------------------------------------
echo "== step 5: edits =="

TEST_PROJECT="$(jq -r '.config.projectOrder[0] // (.config.placements | keys[0])' "$WORK/snap-gv.json")"
SECOND_PROJECT="$(jq -r '[(.config.placements | keys[]), (.config.projectOrder[])] | unique | map(select(. != "'"$TEST_PROJECT"'")) | .[0]' "$WORK/snap-gv.json")"
printf 'test projects: %s / %s\n' "$TEST_PROJECT" "$SECOND_PROJECT"

jq -nc --arg id "$SCRATCH" --arg name "$SCRATCH_NAME" \
  '{kind:"addWorkspace", id:$id, name:$name}' >"$WORK/op-add.json"
if ws_edit gv "$(cat "$WORK/op-add.json")" >/dev/null 2>"$WORK/edit-add.err"; then
  record_pass "gv created scratch workspace $SCRATCH"
else
  record_fail "gv created scratch workspace $SCRATCH" "$(head -c 300 "$WORK/edit-add.err")"
fi
wait_converged "scratch workspace replicated to all three"

# Three edits at once, one on each machine.
jq -nc --arg id "$SCRATCH" --arg name "$SCRATCH_NAME_A" \
  '{kind:"renameWorkspace", id:$id, name:$name}' >"$WORK/op-rename.json"
jq -nc --arg project "$TEST_PROJECT" --arg ws "$SCRATCH" \
  '{kind:"place", project:$project, workspace:$ws}' >"$WORK/op-place.json"
REORDER_ID="$(jq -r --arg id "$SCRATCH" '[.config.workspaces[].id | select(. != $id and . != "main")][-1]' "$WORK/snap-gor.json")"
ORDER="$(jq -nc --arg id "$REORDER_ID" '[$id]')"
jq -nc --argjson order "$ORDER" '{kind:"reorder", order:$order}' >"$WORK/op-reorder.json"

concurrent_start="$(now_ms)"
ws_edit gv "$(cat "$WORK/op-rename.json")" >"$WORK/cc-gv.json" 2>"$WORK/cc-gv.err" &
pid_gv=$!
ws_edit vps "$(cat "$WORK/op-place.json")" >"$WORK/cc-vps.json" 2>"$WORK/cc-vps.err" &
pid_vps=$!
ws_edit gor "$(cat "$WORK/op-reorder.json")" >"$WORK/cc-gor.json" 2>"$WORK/cc-gor.err" &
pid_gor=$!
cc_ok=1
wait "$pid_gv" || cc_ok=0
wait "$pid_vps" || cc_ok=0
wait "$pid_gor" || cc_ok=0
check "concurrent edits on gv, vps and gor applied" test "$cc_ok" = 1
wait_converged "concurrent edits converged"
assert_all "concurrent gv rename kept" \
  '(.config.workspaces[] | select(.id == "'"$SCRATCH"'") | .name) == "'"$SCRATCH_NAME_A"'"'
assert_all "concurrent vps placement kept" \
  '(.config.placements["'"$TEST_PROJECT"'"] // []) | index("'"$SCRATCH"'") != null'
assert_all "concurrent gor reorder kept (independent workspace first)" \
  '.config.workspaces[0].id == "'"$REORDER_ID"'"'

# gor offline: edit on gv and vps, then bring gor back.
gor_ssh 'systemctl --user stop t3code-sidebar.service'
GOR_STOPPED=1
took_start="$(now_ms)"
jq -nc --arg id "$SCRATCH" --arg name "$SCRATCH_NAME_B" \
  '{kind:"renameWorkspace", id:$id, name:$name}' >"$WORK/op-rename-b.json"
jq -nc --arg project "$SECOND_PROJECT" --arg ws "$SCRATCH" \
  '{kind:"place", project:$project, workspace:$ws}' >"$WORK/op-place-b.json"
offline_ok=1
ws_edit gv "$(cat "$WORK/op-rename-b.json")" >/dev/null 2>&1 || offline_ok=0
ws_edit vps "$(cat "$WORK/op-place-b.json")" >/dev/null 2>&1 || offline_ok=0

check "edits applied while gor was down" test "$offline_ok" = 1
gor_ssh 'systemctl --user start t3code-sidebar.service'
GOR_STOPPED=0
wait_health "$GOR_ORIGIN" "$TIMEOUT" || true
if wait_converged "gor rejoins and catches up" ; then
  printf '  gor catch-up: %sms\n' "$(elapsed_ms "$took_start")"
fi
assert_all "offline gv rename reached gor" \
  '(.config.workspaces[] | select(.id == "'"$SCRATCH"'") | .name) == "'"$SCRATCH_NAME_B"'"'
assert_all "offline vps placement reached gor" \
  '(.config.placements["'"$SECOND_PROJECT"'"] // []) | index("'"$SCRATCH"'") != null'

# Kill the VPS container in the middle of a sync.
jq -nc --arg id "$SCRATCH" --arg name "$SCRATCH_NAME_C" \
  '{kind:"renameWorkspace", id:$id, name:$name}' >"$WORK/op-rename-c.json"
ws_edit gv "$(cat "$WORK/op-rename-c.json")" >/dev/null 2>&1 &
kill_pid=$!
sleep 0.2
vps_ssh 'docker kill t3-mesh-e2e' >/dev/null 2>&1
VPS_KILLED=1
wait "$kill_pid" || true
vps_ssh 'docker start t3-mesh-e2e' >/dev/null 2>&1
sleep 1
VPS_KILLED=0
wait_health "$VPS_ORIGIN" "$TIMEOUT" || true
if wait_converged "vps restarts after a mid-sync kill and catches up"; then :; fi
assert_all "mid-sync rename reached the restarted vps" \
  '(.config.workspaces[] | select(.id == "'"$SCRATCH"'") | .name) == "'"$SCRATCH_NAME_C"'"'

# Cleanup: the scratch workspace and its placements.
jq -nc --arg id "$SCRATCH" '{kind:"removeWorkspace", id:$id}' >"$WORK/op-remove.json"
ws_edit gv "$(cat "$WORK/op-remove.json")" >/dev/null 2>&1
jq -nc --arg project "$TEST_PROJECT" --arg ws "$SCRATCH" \
  '{kind:"unplace", project:$project, workspace:$ws}' >"$WORK/op-unplace.json"
ws_edit vps "$(cat "$WORK/op-unplace.json")" >/dev/null 2>&1
jq -nc --arg project "$SECOND_PROJECT" --arg ws "$SCRATCH" \
  '{kind:"unplace", project:$project, workspace:$ws}' >"$WORK/op-unplace-b.json"
ws_edit vps "$(cat "$WORK/op-unplace-b.json")" >/dev/null 2>&1
wait_converged "scratch workspace removed everywhere"
assert_all "no scratch workspace left" '.config.workspaces | map(.id) | index("'"$SCRATCH"'") == null'

# ---------------------------------------------------------------------------
# Step 6 — layout RPC regression
# ---------------------------------------------------------------------------
echo "== step 6: RPC regression =="
layout_ok=1
for machine in gv gor vps; do
  if jq -e '(.document | type) == "object" and (.config.workspaces | type) == "array"' \
    "$WORK/snap-$machine.json" >/dev/null 2>&1; then :; else layout_ok=0; fi
done
check "every meshLayout.get returns the real document and config" test "$layout_ok" = 1

replicas_available=1
for machine in gv gor vps; do
  out="$(ws_rpc "$machine" replicas.status '{}' --first 2>&1)"
  printf '%s' "$out" | jq -e '.[0].replicas | type == "array"' >/dev/null || replicas_available=0
done
check "replicas.status returns the live replica stream on every server" test "$replicas_available" = 1

# ---------------------------------------------------------------------------
# Step 7 — files across the mesh
# ---------------------------------------------------------------------------
echo "== step 7: files =="
GOR_HOME="$(gor_ssh 'printf %s "$HOME"')"
GOR_README="$GOR_HOME/xdev-e2e/demo/README.md"
VPS_README="/home/t3/round1-e2e.txt"
gor_ssh "printf 'a\\000b\\n' > '$GOR_HOME/xdev-e2e/demo/binary.bin'; truncate -s 70M '$GOR_HOME/xdev-e2e/demo/large.bin'" >/dev/null 2>&1
vps_ssh "docker exec t3-mesh-e2e sh -c 'printf \"round1 file from vps\\n\" > $VPS_README'" >/dev/null 2>&1

read_file() { # read_file <environment-id> <path>
  ws_rpc gv files.read "{\"environmentId\":\"$1\",\"absolutePath\":\"$2\"}"
}
read_result="$(read_file "$GOR_ENV" "$GOR_README" 2>"$WORK/file-gor.err" || true)"
if printf '%s' "$read_result" | jq -e '.contents | contains("mesh e2e demo")' >/dev/null 2>&1; then
  record_pass "files.read on gor through gv"
else
  record_fail "files.read on gor through gv" "$(printf '%s' "$read_result" | head -c 300)"
fi
if printf '%s' "$read_result" | jq -e '.contents | contains("mesh e2e demo")' >/dev/null 2>&1; then :; fi

read_vps="$(read_file "$VPS_ENV" "$VPS_README" 2>"$WORK/file-vps.err" || true)"
if printf '%s' "$read_vps" | jq -e '.contents | contains("round1 file from vps")' >/dev/null 2>&1; then
  record_pass "files.read on vps through gv (relayed via gor)"
else
  record_fail "files.read on vps through gv (relayed via gor)" "$(printf '%s' "$read_vps" | head -c 400)"
fi

missing="$(read_file "$GOR_ENV" "$GOR_HOME/xdev-e2e/demo/definitely-missing-round1" 2>&1 || true)"
if printf '%s' "$missing" | jq -e '.message | fromjson | .[] | select(.error.reason == "not_found")' >/dev/null; then
  record_pass "files.read missing file is an error"
else
  record_fail "files.read missing file is an error" "$(printf '%s' "$missing" | head -c 300)"
fi

binary="$(read_file "$GOR_ENV" "$GOR_HOME/xdev-e2e/demo/binary.bin" 2>&1 || true)"
if printf '%s' "$binary" | jq -e '.message | fromjson | .[] | select(.error.reason == "binary")' >/dev/null; then
  record_pass "files.read binary file is an error"
else
  record_fail "files.read binary file is an error" "$(printf '%s' "$binary" | head -c 300)"
fi

large="$(read_file "$GOR_ENV" "$GOR_HOME/xdev-e2e/demo/large.bin" 2>&1 || true)"
if printf '%s' "$large" | jq -e '.message | fromjson | .[] | select(.error.reason == "too_large")' >/dev/null; then
  record_pass "files.read too-large file is an error"
else
  record_fail "files.read too-large file is an error" "$(printf '%s' "$large" | head -c 300)"
fi

list_gor="$(ws_rpc gv files.list "{\"environmentId\":\"$GOR_ENV\",\"partialPath\":\"$GOR_HOME/xdev-e2e/demo/\",\"limit\":100}" 2>&1 || true)"
if printf '%s' "$list_gor" | jq -e '.entries | map(.name) | index("README.md") != null' >/dev/null 2>&1; then
  record_pass "files.list completes on gor"
else
  record_fail "files.list completes on gor" "$(printf '%s' "$list_gor" | head -c 300)"
fi
list_vps="$(ws_rpc gv files.list "{\"environmentId\":\"$VPS_ENV\",\"partialPath\":\"/home/t3/\",\"limit\":200}" 2>&1 || true)"
if printf '%s' "$list_vps" | jq -e '.entries | map(.name) | index("round1-e2e.txt") != null' >/dev/null 2>&1; then
  record_pass "files.list completes on vps through gv"
else
  record_fail "files.list completes on vps through gv" "$(printf '%s' "$list_vps" | head -c 300)"
fi

gor_ssh "rm -f '$GOR_HOME/xdev-e2e/demo/binary.bin' '$GOR_HOME/xdev-e2e/demo/large.bin'" >/dev/null 2>&1
vps_ssh "docker exec t3-mesh-e2e rm -f $VPS_README" >/dev/null 2>&1

# ---------------------------------------------------------------------------
# Step 8 — old client whole-object settings write
# ---------------------------------------------------------------------------
echo "== step 8: old client compatibility =="
jq -nc --arg id "$OLD_A" --arg name "old-a-$RUN_TS" '{kind:"addWorkspace", id:$id, name:$name}' >"$WORK/op-old-a.json"
jq -nc --arg id "$OLD_B" --arg name "old-b-$RUN_TS" '{kind:"addWorkspace", id:$id, name:$name}' >"$WORK/op-old-b.json"
ws_edit gv "$(cat "$WORK/op-old-a.json")" >/dev/null 2>&1
ws_edit gv "$(cat "$WORK/op-old-b.json")" >/dev/null 2>&1
wait_converged "old-client scratch workspaces replicated"

BEFORE="$WORK/old-before.json"
AFTER="$WORK/old-after.json"
GO="$WORK/old-go"
rm -f "$BEFORE" "$AFTER" "$GO"
TOKEN_OLD="$(token_of gv)"
node "$WS" oldclient --origin "$GV_ORIGIN" --token "$TOKEN_OLD" \
  --before "$BEFORE" --after "$AFTER" --go "$GO" --timeout 60000 >"$WORK/old.out" 2>"$WORK/old.err" &
old_pid=$!
for _ in $(seq 1 200); do [ -s "$BEFORE" ] && break; sleep 0.05; done
if [ ! -s "$BEFORE" ]; then
  record_fail "old client captured its baseline" "$(head -c 300 "$WORK/old.err")"
else
  # A concurrent edit on gor renames A while the old client's snapshot still has the old name.
  jq -nc --arg id "$OLD_A" --arg name "old-a-renamed-$RUN_TS" \
    '{kind:"renameWorkspace", id:$id, name:$name}' >"$WORK/op-old-concurrent.json"
  ws_edit gor "$(cat "$WORK/op-old-concurrent.json")" >/dev/null 2>&1
  # The old client writes the whole object back, changing only B.
  jq --arg id "$OLD_B" --arg name "old-b-renamed-$RUN_TS" \
    '.workspaces = [.workspaces[] | if .id == $id then . + {name: $name} else . end]' \
    "$BEFORE" >"$AFTER"
  touch "$GO"
  check "old client whole-object write accepted" wait "$old_pid"
  wait_converged "old-client write merged"
  assert_all "concurrent gor edit survived the old client's whole-object write" \
    '(.config.workspaces[] | select(.id == "'"$OLD_A"'") | .name) == "old-a-renamed-'"$RUN_TS"'"'
  assert_all "old client's changed workspace propagated" \
    '(.config.workspaces[] | select(.id == "'"$OLD_B"'") | .name) == "old-b-renamed-'"$RUN_TS"'"'
fi

jq -nc --arg id "$OLD_A" '{kind:"removeWorkspace", id:$id}' >"$WORK/op-old-rm-a.json"
jq -nc --arg id "$OLD_B" '{kind:"removeWorkspace", id:$id}' >"$WORK/op-old-rm-b.json"
ws_edit gv "$(cat "$WORK/op-old-rm-a.json")" >/dev/null 2>&1
ws_edit gv "$(cat "$WORK/op-old-rm-b.json")" >/dev/null 2>&1
wait_converged "old-client scratch workspaces removed"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "== summary =="
printf 'PASS: %d  FAIL: %d\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed checks:\n'
  for name in "${FAILED[@]}"; do printf '  - %s\n' "$name"; done
  exit 1
fi
exit 0
