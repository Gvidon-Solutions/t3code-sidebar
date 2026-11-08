#!/usr/bin/env bash
# Runs only in a disposable N-prefixed directory on the root CLOUD bed host.
set -euo pipefail
ROOT=${1:?N-prefixed fixture directory required}
case "$ROOT" in /tmp/N-*) ;; *) exit 2;; esac
export PATH="$ROOT/bin:$PATH"
export T3CODE_HOME="$ROOT/home"
export T3CTL_UNIT="N-runtime-$(basename "$ROOT").service"
unit="/etc/systemd/system/$T3CTL_UNIT"
cleanup() {
  systemctl stop "$T3CTL_UNIT"
  rm -f "$unit"
  systemctl daemon-reload
}
trap cleanup EXIT
mkdir -p "$ROOT/bin" "$T3CODE_HOME/userdata"
docker cp t3-mesh-e2e:/usr/local/bin/node "$ROOT/bin/node"
for version in 0.0.1-N 0.0.2-N; do
  dir="$T3CODE_HOME/runtime/versions/$version"
  mkdir -p "$dir"
  cat > "$dir/t3" <<'JS'
#!/usr/bin/env node
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const server = http.createServer((_req, res) => res.end('N-system-unit'));
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(process.env.T3CODE_HOME, 'userdata/server-runtime.json'), JSON.stringify({pid:process.pid,origin:`http://127.0.0.1:${server.address().port}`,startedAt:'N-test'}));
  console.log('N system runtime started', process.argv[1]);
});
JS
  chmod 700 "$dir/t3"
done
cat > "$unit" <<UNIT
[Unit]
Description=N disposable system-unit acceptance
[Service]
Environment=PATH=$ROOT/bin:/usr/bin:/bin
Environment=T3CODE_HOME=$T3CODE_HOME
ExecStart=$T3CODE_HOME/runtime/versions/0.0.1-N/t3
UNIT
systemctl daemon-reload
rm -f "$T3CODE_HOME/userdata/server-runtime.json"
systemctl start "$T3CTL_UNIT"
for _ in $(seq 1 30); do [ -s "$T3CODE_HOME/userdata/server-runtime.json" ] && break; sleep 1; done
ctl() { node "$ROOT/scripts/t3ctl.mjs" server "$@"; }
ctl status > "$ROOT/status.log"
node -e 'if(!require("node:fs").readFileSync(process.argv[1],"utf8").includes("active (running)"))process.exit(1)' "$ROOT/status.log"
ctl logs > "$ROOT/journal.log"
node -e 'if(!require("node:fs").readFileSync(process.argv[1],"utf8").includes("N system runtime started"))process.exit(1)' "$ROOT/journal.log"
ctl versions --json > "$ROOT/versions.json"
node -e 'const rows=require(process.argv[1]);if(!rows.some(x=>x.version==="0.0.1-N"&&x.current))process.exit(1)' "$ROOT/versions.json"
ctl use 0.0.2-N --yes > "$ROOT/use.log"
ctl versions --json > "$ROOT/versions2.json"
node -e 'const rows=require(process.argv[1]);if(!rows.some(x=>x.version==="0.0.2-N"&&x.current))process.exit(1)' "$ROOT/versions2.json"
ctl restart --yes > "$ROOT/restart.log"
# Real public HTTP download without gh or an Authorization header.
mkdir -p "$ROOT/public/t3-0.0.3-N"
cp "$T3CODE_HOME/runtime/versions/0.0.1-N/t3" "$ROOT/public/t3-0.0.3-N/t3"
tar -czf "$ROOT/public/runtime.tar.gz" -C "$ROOT/public" t3-0.0.3-N
node --input-type=module - "$ROOT" <<'JS'
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const root=process.argv[2];
const { installPublicRuntime }=await import(pathToFileURL(root+'/scripts/server-runtime.mjs'));
const server=http.createServer((req,res)=>{
  if(req.headers.authorization) { res.writeHead(403); res.end(); return; }
  if(req.url==='/archive') res.end(fs.readFileSync(root+'/public/runtime.tar.gz'));
  else res.end(JSON.stringify({tag_name:'0.0.3-N',assets:[{name:'t3-0.0.3-N-linux-x64.tar.gz',browser_download_url:`http://127.0.0.1:${server.address().port}/archive`}]}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  const installed=await installPublicRuntime({home:root+'/download',repository:'N/public',want:'latest',api:`http://127.0.0.1:${server.address().port}`});
  if(!fs.existsSync(installed.path+'/t3')) throw Error('Public install missing');
} finally { server.close(); }
console.log('PASS N public release HTTP fallback without gh');
JS
node --input-type=module - "$ROOT" <<'JS'
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const root=process.argv[2];
const { installSshRuntime }=await import(pathToFileURL(root+'/scripts/server-runtime.mjs'));
const route=JSON.parse(fs.readFileSync(root+'/ssh-copy.json','utf8'));
const run=(command,args,options)=>execFileSync(command,command==='ssh' ? ['-F','/dev/null','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+route.knownHostsFile,...args] : args,options);
const result=installSshRuntime({home:root+'/ssh-copy',want:'0.0.4-N',destination:route.destination,identityFile:route.identityFile,remoteHome:root+'-source',run});
if(!fs.existsSync(result.path+'/t3')) throw Error('SSH runtime missing');
console.log('PASS N runtime copied from linked nodeB over SSH without gh');
JS
printf 'PASS N system unit status/logs/versions/use/restart; evidence %s\n' "$ROOT"
