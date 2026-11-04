#!/usr/bin/env bash
# Sourced by round3-features.sh; only this run's N folders and project are changed.
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH
catalog_root="$N_ROOT-catalog"
catalog_title="N-unplaced catalog $RUN_TS"
rexec gor mkdir -p "$catalog_root"
ctl gor tool t3_project_create "$(jq -nc --arg title "$catalog_title" --arg root "$catalog_root" '{title:$title,workspaceRoot:$root}')" > "$WORK/N-catalog-project.json"
ctl vps tool t3_project_machines "$(jq -nc --arg title "$catalog_title" '{project:$title}')" > "$WORK/N-catalog-lookup.json"
catalog_key=$(jq -r '.logicalKey' "$WORK/N-catalog-lookup.json")
warning_root="$N_ROOT-live"
warning_title="N-scan warnings $RUN_TS"
rexec gor mkdir -p "$warning_root"
rexec gor git init -q "$warning_root"
rexec gor sh -c 'printf N-readable > "$1/good"; printf N-private > "$1/private"; chmod 000 "$1/private"; ln -s "$1-outside" "$1/absolute-link"; ln -s "../$(basename "$1")-outside" "$1/relative-outside"' sh "$warning_root"
ctl gor tool t3_project_create "$(jq -nc --arg title "$warning_title" --arg root "$warning_root" '{title:$title,workspaceRoot:$root}')" > "$WORK/N-live-source-project.json"
ctl vps tool t3_project_machines "$(jq -nc --arg title "$warning_title" '{project:$title}')" > "$WORK/N-live-remote-lookup.json"
warning_key=$(jq -r '.logicalKey' "$WORK/N-live-remote-lookup.json")
jq -e --arg title "$warning_title" --arg source "$GOR_ENV" --arg root "$warning_root" '.title==$title and any(.representations[]; .environmentId==$source and .path==$root and .role=="primary")' "$WORK/N-live-remote-lookup.json" >/dev/null
ws_get vps > "$WORK/N-live-before-placement.json"
jq -e --arg k "$warning_key" '(.config.projectMounts[$k] // [])|length==0' "$WORK/N-live-before-placement.json" >/dev/null
ctl vps place "$warning_title" --on "$GV_ENV" --path "$warning_root-copy" --wait 120 --json > "$WORK/N-live-place.json"
jq -e --arg k "$warning_key" --arg source "$GOR_ENV" '.logicalKey==$k and .ready and .representation.source==$source and .representation.projectId!=null' "$WORK/N-live-place.json" >/dev/null
wait_converged 'N remote project lookup and non-fatal scan warnings'
ctl vps tool t3_project_machines "$(jq -nc --arg title "$warning_title" '{project:$title}')" > "$WORK/N-live-skipped.json"
jq -e --arg env "$GV_ENV" '.representations[] | select(.environmentId==$env) | .projectId!=null and .status.state=="watching" and .status.skipped>=3 and (.status.message|contains("files skipped")) and any(.status.skippedPaths[]; .path=="private")' "$WORK/N-live-skipped.json" >/dev/null
ctl gv tool t3_project_machines "$(jq -nc --arg key "$warning_key" '{project:$key}')" > "$WORK/N-live-driver.json"
jq -e --arg env "$GV_ENV" '.representations[] | select(.environmentId==$env) | .live.state=="watching" and .live.skipped>=3' "$WORK/N-live-driver.json" >/dev/null
test "$(rexec gv cat "$warning_root-copy/good")" = N-readable
rexec gv test ! -e "$warning_root-copy/private"
warning_hash=$(node --input-type=module -e 'import {createHash} from "node:crypto"; console.log(createHash("sha256").update(process.argv[1]).digest("hex").slice(0,8))' "$warning_key")
mut gv sync list --label-selector "t3-logical=$warning_hash" --template '{{json .}}' > "$WORK/N-live-before-ignores.json"
rexec gor chmod 600 "$warning_root/private"
ctl vps place "$warning_title" --on "$GV_ENV" --ignore absolute-link --ignore relative-outside --ignore private --wait 120 --json > "$WORK/N-live-ignore-place.json"
previous_session=$(jq -r '.[0].identifier' "$WORK/N-live-before-ignores.json")
ignore_deadline=$((SECONDS+TIMEOUT))
while :; do
  mut gv sync list --label-selector "t3-logical=$warning_hash" --template '{{json .}}' > "$WORK/N-live-after-ignores.json"
  if jq -e --arg previous "$previous_session" 'length==1 and .[0].identifier!=$previous and (.[0].ignore.paths | index("absolute-link")!=null and index("relative-outside")!=null and index("private")!=null)' "$WORK/N-live-after-ignores.json" >/dev/null; then break; fi
  if [ "$SECONDS" -ge "$ignore_deadline" ]; then
    cat "$WORK/N-live-after-ignores.json" >&2
    die 'Ignore update did not replace the sync session within the deadline'
  fi
  sleep 1
done
test "$(jq -r '.[0].identifier' "$WORK/N-live-before-ignores.json")" != "$(jq -r '.[0].identifier' "$WORK/N-live-after-ignores.json")"
jq -e 'length==1 and (.[0].ignore.paths | index("absolute-link")!=null and index("relative-outside")!=null and index("private")!=null)' "$WORK/N-live-after-ignores.json" >/dev/null
wait_converged 'N per-replica ignore update'
ctl vps tool t3_project_machines "$(jq -nc --arg title "$warning_title" '{project:$title}')" > "$WORK/N-live-ignored.json"
jq -e --arg env "$GV_ENV" '.representations[] | select(.environmentId==$env) | .status.state=="watching" and (.status.skipped // 0)==0' "$WORK/N-live-ignored.json" >/dev/null
rexec gor ln -s "../$(basename "$warning_root")-outside" "$warning_root/fresh-outside"
mut gv sync flush "$(jq -r '.[0].name' "$WORK/N-live-after-ignores.json")"
assert_live_regression_recovery() {
  ctl vps tool t3_project_machines "$(jq -nc --arg title "$catalog_title" '{project:$title}')" > "$WORK/N-catalog-current.json"
  jq -e --arg key "$catalog_key" --arg root "$catalog_root" --arg source "$GOR_ENV" '.logicalKey==$key and any(.representations[]; .environmentId==$source and .path==$root)' "$WORK/N-catalog-current.json" >/dev/null
  ws_get vps > "$WORK/N-catalog-layout.json"
  jq -e --arg key "$catalog_key" '(.config.projectMounts[$key] // [])|length==0' "$WORK/N-catalog-layout.json" >/dev/null
  local end=$((SECONDS+TIMEOUT))
  while :; do
    ctl vps tool t3_project_machines "$(jq -nc --arg title "$warning_title" '{project:$title}')" > "$WORK/N-live-current.json"
    if jq -e --arg env "$GV_ENV" '.representations[] | select(.environmentId==$env) | .projectId!=null and .status.state=="watching" and .status.skipped==1 and any(.status.skippedPaths[]; .path=="fresh-outside")' "$WORK/N-live-current.json" >/dev/null; then break; fi
    [ "$SECONDS" -lt "$end" ] || die 'Scan warnings did not remain non-fatal after recovery'
    sleep 1
  done
  ctl gv tool t3_project_machines "$(jq -nc --arg key "$warning_key" '{project:$key}')" > "$WORK/N-live-driver-current.json"
  jq -e --arg env "$GV_ENV" '.representations[] | select(.environmentId==$env) | .live.state=="watching" and .live.skipped==1' "$WORK/N-live-driver-current.json" >/dev/null
  test "$(rexec gv cat "$warning_root-copy/good")" = N-readable
}
assert_live_regression_recovery
printf 'PASS N live regressions 8–9: remote name lookup/place, skipped paths registered and visible, session recreated for ignores\n'
