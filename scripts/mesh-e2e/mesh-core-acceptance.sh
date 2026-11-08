#!/usr/bin/env bash
# Mesh core acceptance on the three-machine bed.
#
# Re-runs, against the already seeded bed from `scripts/mesh-e2e/README.md`:
#   1. mesh settings on every server, nodeA↔nodeB and nodeB↔cloud links (not nodeA↔cloud)
#   2. convergence, one "main", no lost project keys, legacy settings = materialize(doc)
#   3. concurrent, offline and mid-sync edits
#   4. layout RPC regression and the replicas.status stream
#   5. files.read/files.list across the mesh
#   6. an old client's whole-object settings write next to a concurrent mesh edit
#
# Exit code 0 only when every check passed. The bed is left running and linked.
#
# Usage: scripts/mesh-e2e/mesh-core-acceptance.sh [--timeout SECONDS]
set -uo pipefail

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

set +e
load_build_env
require_bins
NODE_B_BASE_DIR=${MESH_E2E_NODE_B_BASE_DIR:-$NODE_B_BASE_DIR}

TIMEOUT="${MESH_E2E_CORE_TIMEOUT:-60}"
if [ "${1:-}" = "--timeout" ]; then
  TIMEOUT="${2:-60}"
fi

NODE_A_ORIGIN="http://127.0.0.1:$NODE_A_PORT"
NODE_B_ORIGIN="http://127.0.0.1:$NODE_B_LOCAL"
CLOUD_ORIGIN="http://127.0.0.1:$CLOUD_LOCAL"
LEGACY_DIR="$STATE_DIR/legacy"
WORK="${MESH_E2E_CORE_WORK:-/tmp/t3-mesh-e2e-core}"
WS="$WORK/ws.mjs"
NODE_B_BIN="$NODE_B_RUNTIME_ROOT/$BUILD_VERSION/t3"
CLOUD_BIN="/opt/t3/dist/bin.mjs"

RUN_TS="${MESH_E2E_FIXTURE_PREFIX:+$MESH_E2E_FIXTURE_PREFIX-}$(date -u +%Y%m%dT%H%M%SZ)"
ROUND1_NAME="${MESH_E2E_CORE_NAME:-core}"
ROUND1_SCRATCH="${MESH_E2E_CORE_SCRATCH:-r1}"
SCRATCH="$ROUND1_NAME-$RUN_TS"
SCRATCH_NAME="$ROUND1_SCRATCH-$RUN_TS"
SCRATCH_NAME_A="$ROUND1_SCRATCH-a-$RUN_TS"
SCRATCH_NAME_B="$ROUND1_SCRATCH-b-$RUN_TS"
SCRATCH_NAME_C="$ROUND1_SCRATCH-c-$RUN_TS"
OLD_A="$ROUND1_NAME-old-$RUN_TS"
OLD_B="$ROUND1_NAME-oldb-$RUN_TS"

PASS=0
FAIL=0
FAILED=()
NODE_B_STOPPED=0
CLOUD_KILLED=0

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
  if [ "$NODE_B_STOPPED" = 1 ]; then
    nodeB_ssh "systemctl --user start $NODE_B_UNIT" >/dev/null 2>&1 || true
    NODE_B_STOPPED=0
  fi
  if [ "$CLOUD_KILLED" = 1 ]; then
    cloud_ssh 'docker start t3-mesh-e2e' >/dev/null 2>&1 || true
    CLOUD_KILLED=0
  fi
}
trap cleanup_bed EXIT

mkdir -p "$WORK/node_modules/@t3tools"
ln -sfn "$REPO_ROOT/packages/shared" "$WORK/node_modules/@t3tools/shared"
cat >"$WS" <<'NODE'
#!/usr/bin/env node
// Minimal T3 WebSocket RPC client for the mesh E2E bed (mesh-core-acceptance.sh writes this at runtime).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { between, keys, materialize, canonical } from "@t3tools/shared/meshLayout";

const argv = process.argv.slice(2);
const command = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const origin = opt("origin", process.env.MESH_E2E_WS_ORIGIN || "").replace(/\/$/, "");
const token = opt("token", process.env.MESH_E2E_WS_TOKEN || "");
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
ws.addEventListener("close", () => {
  connected = false;
  for (const [id, request] of pending) {
    if (request.matches) {
      pending.delete(id);
      request.resolve({ ok: false, error: "replica stream closed before the requested transition" });
    }
  }
});
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
      if (request.matches) {
        request.chunks = message.values;
        if (!request.ready) {
          request.ready = true;
          writeFileSync(request.readyFile, "ready");
          ws.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
          continue;
        }
        if (!message.values.some(request.matches)) {
          ws.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
          continue;
        }
      } else {
        request.chunks.push(...message.values);
      }
      if (request.firstChunk) {
        pending.delete(message.requestId);
        ws.send(JSON.stringify({ _tag: "Interrupt", requestId: message.requestId }));
        request.resolve({ ok: true, value: request.chunks });
      } else {
        ws.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
      }
    } else if (message._tag === "Exit") {
      pending.delete(message.requestId);
      if (request.matches) {
        request.resolve({ ok: false, error: "replica stream ended before the requested transition" });
      } else if (request.firstChunk && message.exit._tag === "Success" && request.chunks.length > 0) {
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
const rpc = (method, payload = {}, { first = false, matches, readyFile } = {}) =>
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
      matches,
      readyFile,
      ready: false,
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
    case "addWorkspace": {
      const last = Object.entries(doc).flatMap(([key, e]) =>
        key.startsWith("ws/") && e.v && typeof e.v === "object" && typeof e.v.sort === "string"
          ? [e.v.sort] : []).sort().at(-1) ?? null;
      return { [`ws/${op.id}`]: entry({ name: op.name, ...(op.color ? { color: op.color } : {}), sort: op.sort ?? between(last, null) }) };
    }
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
  } else if (command === "wait-replica") {
    const [logicalKey, environmentId, state, readyFile] = argv.slice(1);
    if (!logicalKey || !environmentId || !state || !readyFile) fail("wait-replica needs logical key, environment id, state and ready file");
    const value = await call("replicas.status", {}, {
      first: true,
      readyFile,
      matches: (snapshot) => snapshot.replicas.some((row) => row.logicalKey === logicalKey && row.environmentId === environmentId && row.state === state),
    });
    console.log(JSON.stringify(value, null, 2));
  } else if (command === "get") {
    const value = await snapshot();
    if (canonical(materialize(value.document)) !== canonical(value.config)) fail("server config differs from materialize(document)");
    console.log(JSON.stringify(value, null, 2));
  } else if (command === "mirror") {
    for (;;) {
      const before = await snapshot();
      const legacy = (await call("server.getConfig", {})).settings.sidebarWorkspaces;
      const after = await snapshot();
      if (canonical(before.config) === canonical(after.config) &&
          canonical(legacy) === canonical(after.config)) {
        if (canonical(materialize(after.document)) !== canonical(after.config)) fail("server config differs from materialize(document)");
        console.log(JSON.stringify({ legacy, snapshot: after }, null, 2));
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
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
    fail("usage: ws.mjs {get|mirror|rpc <method> [payload]|edit <op>|oldclient ...}");
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

mint_token_once() { # mint_token_once nodeA|nodeB|cloud
  local ttl=${MESH_E2E_SESSION_TTL:-30m} quoted_ttl quoted_base
  printf -v quoted_ttl '%q' "$ttl"
  printf -v quoted_base '%q' "$NODE_B_BASE_DIR"
  case "$1" in
    nodeA) "$NODE_A_RUNTIME_ROOT/$BUILD_VERSION/t3" auth session issue --base-dir "$NODE_A_BASE_DIR" \
      --ttl "$ttl" --label mesh-e2e-core --token-only 2>/dev/null ;;
    nodeB) nodeB_ssh "$NODE_B_BIN auth session issue --base-dir $quoted_base --ttl $quoted_ttl \
      --label mesh-e2e-core --token-only" 2>/dev/null ;;
    cloud) cloud_ssh "docker exec t3-mesh-e2e node $CLOUD_BIN auth session issue \
      --base-dir /home/t3/.t3 --ttl $quoted_ttl --label mesh-e2e-core --token-only" 2>/dev/null ;;
  esac
}
mint_token() { # mint_token nodeA|nodeB|cloud — a just-restarted server can answer empty once
  local i output
  for i in 1 2 3 4 5; do
    output="$(mint_token_once "$1" | head -1)"
    if [ -n "$output" ]; then printf '%s' "$output"; return 0; fi
    sleep 1
  done
  return 1
}

pair_code() { # pair_code nodeA|nodeB|cloud
  local out quoted_base
  printf -v quoted_base '%q' "$NODE_B_BASE_DIR"
  case "$1" in
    nodeA) out="$("$NODE_A_RUNTIME_ROOT/$BUILD_VERSION/t3" auth pairing create --base-dir "$NODE_A_BASE_DIR" \
      --ttl 20m --label mesh-e2e-link --json 2>/dev/null)" ;;
    nodeB) out="$(nodeB_ssh "$NODE_B_BIN auth pairing create --base-dir $quoted_base \
      --ttl 20m --label mesh-e2e-link --json" 2>/dev/null)" ;;
    cloud) out="$(cloud_ssh "docker exec t3-mesh-e2e node $CLOUD_BIN auth pairing create \
      --base-dir /home/t3/.t3 --ttl 20m --label mesh-e2e-link --json" 2>/dev/null)" ;;
  esac
  printf '%s\n' "$out" | sed -n '/^{/,$p' | jq -r '.credential // empty'
}

T_NODE_A=""
T_NODE_B=""
T_CLOUD=""
token_of() {
  case "$1" in
    nodeA) [ -n "$T_NODE_A" ] || T_NODE_A="$(mint_token nodeA)"; printf '%s' "$T_NODE_A" ;;
    nodeB) [ -n "$T_NODE_B" ] || T_NODE_B="$(mint_token nodeB)"; printf '%s' "$T_NODE_B" ;;
    cloud) [ -n "$T_CLOUD" ] || T_CLOUD="$(mint_token cloud)"; printf '%s' "$T_CLOUD" ;;
  esac
}
origin_of() {
  case "$1" in
    nodeA) printf '%s' "$NODE_A_ORIGIN" ;;
    nodeB) printf '%s' "$NODE_B_ORIGIN" ;;
    cloud) printf '%s' "$CLOUD_ORIGIN" ;;
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
  for machine in nodeA nodeB cloud; do
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
  [ "${#machines[@]}" -gt 0 ] || machines=(nodeA nodeB cloud)
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
        continue
      fi
      doc_hash_value="$(doc_hash "$WORK/snap-$machine.json")"
      cfg_hash_value="$(config_hash "$WORK/snap-$machine.json")"
      if [ "${MESH_E2E_LIVE_REPORTS:-0}" = 1 ]; then continue; fi
      if [ -z "$first_doc" ]; then
        first_doc="$doc_hash_value"
        first_cfg="$cfg_hash_value"
      elif [ "$doc_hash_value" != "$first_doc" ] || [ "$cfg_hash_value" != "$first_cfg" ]; then
        converged=0
        continue
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
  for machine in nodeA nodeB cloud; do
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

check "build $BUILD_VERSION deployed on nodeA" \
  grep -q "$BUILD_VERSION/t3" ~/.config/systemd/user/"$NODE_A_UNIT"
check "build $BUILD_VERSION deployed on nodeB" \
  nodeB_ssh "grep -Fq '$NODE_B_BIN' ~/.config/systemd/user/$NODE_B_UNIT"
check "build $BUILD_VERSION image deployed on cloud" \
  test "$(docker image inspect "$IMAGE" -f '{{.Id}}')" = "$(cloud_ssh "docker image inspect '$IMAGE' -f '{{.Id}}'")"

T_NODE_A="$(mint_token nodeA)"
T_NODE_B="$(mint_token nodeB)"
T_CLOUD="$(mint_token cloud)"

NODE_A_ENV="$(descriptor_env "$NODE_A_ORIGIN")"
NODE_B_ENV="$(descriptor_env "$NODE_B_ORIGIN")"
CLOUD_ENV="$(descriptor_env "$CLOUD_ORIGIN")"
printf 'environments: nodeA=%s nodeB=%s cloud=%s\n' "$NODE_A_ENV" "$NODE_B_ENV" "$CLOUD_ENV"

for machine in nodeA nodeB cloud; do
  ws_rpc "$machine" server.updateSettings \
    '{"patch":{"meshEnabled":true,"linkedEnvironmentsEnabled":true}}' >/dev/null 2>&1
done
for machine in nodeA nodeB cloud; do
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

ensure_link nodeA nodeB "$NODE_B_ORIGIN" "$NODE_B_ENV"
ensure_link nodeB cloud "$CLOUD_ORIGIN" "$CLOUD_ENV"

# nodeA↔cloud must stay unlinked so traffic has to go through nodeB.
nodeA_has_cloud="$(link_exists nodeA "$CLOUD_ENV" && echo yes || echo no)"
cloud_has_nodeA="$(link_exists cloud "$NODE_A_ENV" && echo yes || echo no)"
if [ "$nodeA_has_cloud" = yes ]; then
  ws_rpc nodeA peerLinks.unlink "{\"environmentId\":\"$CLOUD_ENV\"}" >/dev/null 2>&1
  nodeA_has_cloud=no
fi
if [ "$cloud_has_nodeA" = yes ]; then
  ws_rpc cloud peerLinks.unlink "{\"environmentId\":\"$NODE_A_ENV\"}" >/dev/null 2>&1
  cloud_has_nodeA=no
fi
check "no nodeA↔cloud link" test "$nodeA_has_cloud$cloud_has_nodeA" = nono

# Wait until both links answer; the mesh exchange then starts on its own.
link_start="$(now_ms)"
links_ok=0
for _ in $(seq 1 "$TIMEOUT"); do
  nodeA_ok="$(ws_rpc nodeA peerLinks.list '{}' 2>/dev/null | jq -r --arg id "$NODE_B_ENV" '.links[] | select(.environmentId == $id) | .status' || true)"
  nodeB_ok="$(ws_rpc nodeB peerLinks.list '{}' 2>/dev/null | jq -r --arg id "$CLOUD_ENV" '.links[] | select(.environmentId == $id) | .status' || true)"
  if [ "$nodeA_ok" = reachable ] && [ "$nodeB_ok" = reachable ]; then links_ok=1; break; fi
  sleep 1
done
if [ "$links_ok" = 1 ]; then
  record_pass "links reachable" "nodeA→nodeB and nodeB→cloud in $(elapsed_ms "$link_start")ms"
else
  record_fail "links reachable" "nodeA→nodeB=$nodeA_ok nodeB→cloud=$nodeB_ok"
fi

# ---------------------------------------------------------------------------
# Step 4 — convergence and legacy adoption
# ---------------------------------------------------------------------------
echo "== step 4: convergence and legacy adoption =="
wait_converged "three documents and materialized configs converge"

main_count_ok=1
for machine in nodeA nodeB cloud; do
  count="$(jq -r '[.config.workspaces[] | select((.name | ascii_downcase) == "main")] | length' "$WORK/snap-$machine.json")"
  [ "$count" = 1 ] || main_count_ok=0
done
check "exactly one \"main\" workspace on every server" test "$main_count_ok" = 1

main_ids="$(for machine in nodeA nodeB cloud; do jq -r '[.config.workspaces[] | select((.name | ascii_downcase) == "main")][0].id' "$WORK/snap-$machine.json"; done | sort -u | wc -l)"
check "the same \"main\" workspace id everywhere" test "$main_ids" = 1

if [ -f "$LEGACY_DIR/studio.json" ] && [ -f "$LEGACY_DIR/cloudbox.json" ]; then
  project_keys() { # project_keys <config-json-file-or-stdin>
    jq -r '[(.placements | keys[]), (.assignments | keys[]), (.projectOrder[]),
            (.workspaceProjectOrder | to_entries[] | .value[]),
            (.workspaceFold | to_entries[] | .value | keys[])] | unique[]' "$@"
  }
  project_keys "$LEGACY_DIR/studio.json" "$LEGACY_DIR/cloudbox.json" | sort -u >"$WORK/source-keys.txt"
  jq -r '.config' "$WORK/snap-nodeA.json" >"$WORK/config-nodeA.json"
  project_keys "$WORK/config-nodeA.json" | sort -u >"$WORK/materialized-keys.txt"
  jq -r --rawfile keys "$WORK/source-keys.txt" '($keys | split("\n") | map(select(length > 0)))[] as $key | .config.projectAliases[$key] // $key' "$WORK/snap-nodeA.json" | sort -u > "$WORK/canonical-source-keys.txt"
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
for machine in nodeA nodeB cloud; do
  node "$WS" mirror --origin "$(origin_of "$machine")" --token "$(token_of "$machine")" \
    >"$WORK/mirror-$machine.json" 2>"$WORK/mirror-$machine.err" || legacy_matches=0
done
check "legacy settings.sidebarWorkspaces equals materialize(doc) on every server" test "$legacy_matches" = 1

# ---------------------------------------------------------------------------
# Step 5 — edits
# ---------------------------------------------------------------------------
echo "== step 5: edits =="

TEST_PROJECT="$(jq -r '.config.projectOrder[0] // (.config.placements | keys[0])' "$WORK/snap-nodeA.json")"
SECOND_PROJECT="$(jq -r '[(.config.placements | keys[]), (.config.projectOrder[])] | unique | map(select(. != "'"$TEST_PROJECT"'")) | .[0]' "$WORK/snap-nodeA.json")"
printf 'test projects: %s / %s\n' "$TEST_PROJECT" "$SECOND_PROJECT"

jq -nc --arg id "$SCRATCH" --arg name "$SCRATCH_NAME" \
  '{kind:"addWorkspace", id:$id, name:$name}' >"$WORK/op-add.json"
if ws_edit nodeA "$(cat "$WORK/op-add.json")" >/dev/null 2>"$WORK/edit-add.err"; then
  record_pass "nodeA created scratch workspace $SCRATCH"
else
  record_fail "nodeA created scratch workspace $SCRATCH" "$(head -c 300 "$WORK/edit-add.err")"
fi
wait_converged "scratch workspace replicated to all three"

# Three edits at once, one on each machine.
jq -nc --arg id "$SCRATCH" --arg name "$SCRATCH_NAME_A" \
  '{kind:"renameWorkspace", id:$id, name:$name}' >"$WORK/op-rename.json"
jq -nc --arg project "$TEST_PROJECT" --arg ws "$SCRATCH" \
  '{kind:"place", project:$project, workspace:$ws}' >"$WORK/op-place.json"
REORDER_ID="$(jq -r --arg id "$SCRATCH" '[.config.workspaces[].id | select(. != $id and . != "main")][-1]' "$WORK/snap-nodeB.json")"
ORDER="$(jq -nc --arg id "$REORDER_ID" '[$id]')"
jq -nc --argjson order "$ORDER" '{kind:"reorder", order:$order}' >"$WORK/op-reorder.json"

concurrent_start="$(now_ms)"
ws_edit nodeA "$(cat "$WORK/op-rename.json")" >"$WORK/cc-nodeA.json" 2>"$WORK/cc-nodeA.err" &
pid_nodeA=$!
ws_edit cloud "$(cat "$WORK/op-place.json")" >"$WORK/cc-cloud.json" 2>"$WORK/cc-cloud.err" &
pid_cloud=$!
ws_edit nodeB "$(cat "$WORK/op-reorder.json")" >"$WORK/cc-nodeB.json" 2>"$WORK/cc-nodeB.err" &
pid_nodeB=$!
cc_ok=1
wait "$pid_nodeA" || cc_ok=0
wait "$pid_cloud" || cc_ok=0
wait "$pid_nodeB" || cc_ok=0
check "concurrent edits on nodeA, cloud and nodeB applied" test "$cc_ok" = 1
wait_converged "concurrent edits converged"
assert_all "concurrent nodeA rename kept" \
  '(.config.workspaces[] | select(.id == "'"$SCRATCH"'") | .name) == "'"$SCRATCH_NAME_A"'"'
assert_all "concurrent cloud placement kept" \
  '(.config.placements["'"$TEST_PROJECT"'"] // []) | index("'"$SCRATCH"'") != null'
assert_all "concurrent nodeB reorder kept (independent workspace first)" \
  '.config.workspaces[0].id == "'"$REORDER_ID"'"'

# nodeB offline: edit on nodeA and cloud, then bring nodeB back.
nodeB_ssh "systemctl --user stop $NODE_B_UNIT"
NODE_B_STOPPED=1
took_start="$(now_ms)"
jq -nc --arg id "$SCRATCH" --arg name "$SCRATCH_NAME_B" \
  '{kind:"renameWorkspace", id:$id, name:$name}' >"$WORK/op-rename-b.json"
jq -nc --arg project "$SECOND_PROJECT" --arg ws "$SCRATCH" \
  '{kind:"place", project:$project, workspace:$ws}' >"$WORK/op-place-b.json"
offline_ok=1
ws_edit nodeA "$(cat "$WORK/op-rename-b.json")" >/dev/null 2>&1 || offline_ok=0
ws_edit cloud "$(cat "$WORK/op-place-b.json")" >/dev/null 2>&1 || offline_ok=0

check "edits applied while nodeB was down" test "$offline_ok" = 1
nodeB_ssh "systemctl --user start $NODE_B_UNIT"
NODE_B_STOPPED=0
wait_health "$NODE_B_ORIGIN" "$TIMEOUT" || true
if wait_converged "nodeB rejoins and catches up" ; then
  printf '  nodeB catch-up: %sms\n' "$(elapsed_ms "$took_start")"
fi
assert_all "offline nodeA rename reached nodeB" \
  '(.config.workspaces[] | select(.id == "'"$SCRATCH"'") | .name) == "'"$SCRATCH_NAME_B"'"'
assert_all "offline cloud placement reached nodeB" \
  '(.config.placements["'"$SECOND_PROJECT"'"] // []) | index("'"$SCRATCH"'") != null'

# Kill the CLOUD container in the middle of a sync.
jq -nc --arg id "$SCRATCH" --arg name "$SCRATCH_NAME_C" \
  '{kind:"renameWorkspace", id:$id, name:$name}' >"$WORK/op-rename-c.json"
ws_edit nodeA "$(cat "$WORK/op-rename-c.json")" >/dev/null 2>&1 &
kill_pid=$!
sleep 0.2
cloud_ssh 'docker kill t3-mesh-e2e' >/dev/null 2>&1
CLOUD_KILLED=1
wait "$kill_pid" || true
cloud_ssh 'docker start t3-mesh-e2e' >/dev/null 2>&1
sleep 1
CLOUD_KILLED=0
wait_health "$CLOUD_ORIGIN" "$TIMEOUT" || true
if wait_converged "cloud restarts after a mid-sync kill and catches up"; then :; fi
assert_all "mid-sync rename reached the restarted cloud" \
  '(.config.workspaces[] | select(.id == "'"$SCRATCH"'") | .name) == "'"$SCRATCH_NAME_C"'"'

# Cleanup: the scratch workspace and its placements.
jq -nc --arg id "$SCRATCH" '{kind:"removeWorkspace", id:$id}' >"$WORK/op-remove.json"
ws_edit nodeA "$(cat "$WORK/op-remove.json")" >/dev/null 2>&1
jq -nc --arg project "$TEST_PROJECT" --arg ws "$SCRATCH" \
  '{kind:"unplace", project:$project, workspace:$ws}' >"$WORK/op-unplace.json"
ws_edit cloud "$(cat "$WORK/op-unplace.json")" >/dev/null 2>&1
jq -nc --arg project "$SECOND_PROJECT" --arg ws "$SCRATCH" \
  '{kind:"unplace", project:$project, workspace:$ws}' >"$WORK/op-unplace-b.json"
ws_edit cloud "$(cat "$WORK/op-unplace-b.json")" >/dev/null 2>&1
wait_converged "scratch workspace removed everywhere"
assert_all "no scratch workspace left" '.config.workspaces | map(.id) | index("'"$SCRATCH"'") == null'

# ---------------------------------------------------------------------------
# Step 6 — layout RPC regression
# ---------------------------------------------------------------------------
echo "== step 6: RPC regression =="
layout_ok=1
for machine in nodeA nodeB cloud; do
  if jq -e '(.document | type) == "object" and (.config.workspaces | type) == "array"' \
    "$WORK/snap-$machine.json" >/dev/null 2>&1; then :; else layout_ok=0; fi
done
check "every meshLayout.get returns the real document and config" test "$layout_ok" = 1

replicas_available=1
for machine in nodeA nodeB cloud; do
  out="$(ws_rpc "$machine" replicas.status '{}' --first 2>&1)"
  printf '%s' "$out" | jq -e '.[0].replicas | type == "array"' >/dev/null || replicas_available=0
done
check "replicas.status returns the live replica stream on every server" test "$replicas_available" = 1

# ---------------------------------------------------------------------------
# Step 7 — files across the mesh
# ---------------------------------------------------------------------------
echo "== step 7: files =="
NODE_B_HOME="$(nodeB_ssh 'printf %s "$HOME"')"
NODE_B_README="$NODE_B_DEMO_DIR/README.md"
CLOUD_README="/home/t3/$ROUND1_NAME-e2e.txt"
nodeB_ssh "printf 'a\\000b\\n' > '$NODE_B_DEMO_DIR/binary.bin'; truncate -s 70M '$NODE_B_DEMO_DIR/large.bin'" >/dev/null 2>&1
cloud_ssh "docker exec t3-mesh-e2e sh -c 'printf \"mesh core file from cloud\\n\" > $CLOUD_README'" >/dev/null 2>&1

read_file() { # read_file <environment-id> <path>
  ws_rpc nodeA files.read "{\"environmentId\":\"$1\",\"absolutePath\":\"$2\"}"
}
read_result="$(read_file "$NODE_B_ENV" "$NODE_B_README" 2>"$WORK/file-nodeB.err" || true)"
if printf '%s' "$read_result" | jq -e '.contents | contains("mesh e2e demo")' >/dev/null 2>&1; then
  record_pass "files.read on nodeB through nodeA"
else
  record_fail "files.read on nodeB through nodeA" "$(printf '%s' "$read_result" | head -c 300)"
fi
if printf '%s' "$read_result" | jq -e '.contents | contains("mesh e2e demo")' >/dev/null 2>&1; then :; fi

read_cloud="$(read_file "$CLOUD_ENV" "$CLOUD_README" 2>"$WORK/file-cloud.err" || true)"
if printf '%s' "$read_cloud" | jq -e '.contents | contains("mesh core file from cloud")' >/dev/null 2>&1; then
  record_pass "files.read on cloud through nodeA (relayed via nodeB)"
else
  record_fail "files.read on cloud through nodeA (relayed via nodeB)" "$(printf '%s' "$read_cloud" | head -c 400)"
fi

missing="$(read_file "$NODE_B_ENV" "$NODE_B_DEMO_DIR/definitely-missing-core" 2>&1 || true)"
if printf '%s' "$missing" | jq -e '.message | fromjson | .[] | select(.error.reason == "not_found")' >/dev/null; then
  record_pass "files.read missing file is an error"
else
  record_fail "files.read missing file is an error" "$(printf '%s' "$missing" | head -c 300)"
fi

binary="$(read_file "$NODE_B_ENV" "$NODE_B_DEMO_DIR/binary.bin" 2>&1 || true)"
if printf '%s' "$binary" | jq -e '.message | fromjson | .[] | select(.error.reason == "binary")' >/dev/null; then
  record_pass "files.read binary file is an error"
else
  record_fail "files.read binary file is an error" "$(printf '%s' "$binary" | head -c 300)"
fi

large="$(read_file "$NODE_B_ENV" "$NODE_B_DEMO_DIR/large.bin" 2>&1 || true)"
if printf '%s' "$large" | jq -e '.message | fromjson | .[] | select(.error.reason == "too_large")' >/dev/null; then
  record_pass "files.read too-large file is an error"
else
  record_fail "files.read too-large file is an error" "$(printf '%s' "$large" | head -c 300)"
fi

list_nodeB="$(ws_rpc nodeA files.list "{\"environmentId\":\"$NODE_B_ENV\",\"partialPath\":\"$NODE_B_DEMO_DIR/\",\"limit\":100}" 2>&1 || true)"
if printf '%s' "$list_nodeB" | jq -e '.entries | map(.name) | index("README.md") != null' >/dev/null 2>&1; then
  record_pass "files.list completes on nodeB"
else
  record_fail "files.list completes on nodeB" "$(printf '%s' "$list_nodeB" | head -c 300)"
fi
list_cloud="$(ws_rpc nodeA files.list "{\"environmentId\":\"$CLOUD_ENV\",\"partialPath\":\"/home/t3/\",\"limit\":200}" 2>&1 || true)"
if printf '%s' "$list_cloud" | jq -e --arg name "$ROUND1_NAME-e2e.txt" '.entries | map(.name) | index($name) != null' >/dev/null 2>&1; then
  record_pass "files.list completes on cloud through nodeA"
else
  record_fail "files.list completes on cloud through nodeA" "$(printf '%s' "$list_cloud" | head -c 300)"
fi

nodeB_ssh "rm -f '$NODE_B_DEMO_DIR/binary.bin' '$NODE_B_DEMO_DIR/large.bin'" >/dev/null 2>&1
cloud_ssh "docker exec t3-mesh-e2e rm -f $CLOUD_README" >/dev/null 2>&1

# ---------------------------------------------------------------------------
# Step 8 — old client whole-object settings write
# ---------------------------------------------------------------------------
echo "== step 8: old client compatibility =="
jq -nc --arg id "$OLD_A" --arg name "old-a-$RUN_TS" '{kind:"addWorkspace", id:$id, name:$name}' >"$WORK/op-old-a.json"
jq -nc --arg id "$OLD_B" --arg name "old-b-$RUN_TS" '{kind:"addWorkspace", id:$id, name:$name}' >"$WORK/op-old-b.json"
ws_edit nodeA "$(cat "$WORK/op-old-a.json")" >/dev/null 2>&1
ws_edit nodeA "$(cat "$WORK/op-old-b.json")" >/dev/null 2>&1
wait_converged "old-client scratch workspaces replicated"

BEFORE="$WORK/old-before.json"
AFTER="$WORK/old-after.json"
GO="$WORK/old-go"
rm -f "$BEFORE" "$AFTER" "$GO"
TOKEN_OLD="$(token_of nodeA)"
node "$WS" oldclient --origin "$NODE_A_ORIGIN" --token "$TOKEN_OLD" \
  --before "$BEFORE" --after "$AFTER" --go "$GO" --timeout 60000 >"$WORK/old.out" 2>"$WORK/old.err" &
old_pid=$!
for _ in $(seq 1 200); do [ -s "$BEFORE" ] && break; sleep 0.05; done
if [ ! -s "$BEFORE" ]; then
  record_fail "old client captured its baseline" "$(head -c 300 "$WORK/old.err")"
else
  # A concurrent edit on nodeB renames A while the old client's snapshot still has the old name.
  jq -nc --arg id "$OLD_A" --arg name "old-a-renamed-$RUN_TS" \
    '{kind:"renameWorkspace", id:$id, name:$name}' >"$WORK/op-old-concurrent.json"
  ws_edit nodeB "$(cat "$WORK/op-old-concurrent.json")" >/dev/null 2>&1
  # The old client writes the whole object back, changing only B.
  jq --arg id "$OLD_B" --arg name "old-b-renamed-$RUN_TS" \
    '.workspaces = [.workspaces[] | if .id == $id then . + {name: $name} else . end]' \
    "$BEFORE" >"$AFTER"
  touch "$GO"
  check "old client whole-object write accepted" wait "$old_pid"
  wait_converged "old-client write merged"
  assert_all "concurrent nodeB edit survived the old client's whole-object write" \
    '(.config.workspaces[] | select(.id == "'"$OLD_A"'") | .name) == "old-a-renamed-'"$RUN_TS"'"'
  assert_all "old client's changed workspace propagated" \
    '(.config.workspaces[] | select(.id == "'"$OLD_B"'") | .name) == "old-b-renamed-'"$RUN_TS"'"'
fi

jq -nc --arg id "$OLD_A" '{kind:"removeWorkspace", id:$id}' >"$WORK/op-old-rm-a.json"
jq -nc --arg id "$OLD_B" '{kind:"removeWorkspace", id:$id}' >"$WORK/op-old-rm-b.json"
ws_edit nodeA "$(cat "$WORK/op-old-rm-a.json")" >/dev/null 2>&1
ws_edit nodeA "$(cat "$WORK/op-old-rm-b.json")" >/dev/null 2>&1
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
