import { WORKER_PLATFORM_SOURCE } from "./RunPlatform.ts";
export const RUN_WORKER_SOURCE = String.raw`
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const readline = require('node:readline');
const nativeSpawn = require('node:child_process').spawn;
const resolveInvocation = typeof __T3_RUN_RESOLVE === 'function' ? __T3_RUN_RESOLVE : (command,args) => ({command,args,shell:false,ptyCommand:command,ptyArgs:args,ptyEof:'\x04'});
const spawn = (command,args,options) => { const resolved = resolveInvocation(command,args); return nativeSpawn(resolved.command,resolved.args,{...options,shell:resolved.shell}); };
const c = JSON.parse(Buffer.from(typeof __T3_RUN_PAYLOAD === 'string' ? __T3_RUN_PAYLOAD : process.argv[1], 'base64').toString());
if (c.tty && process.stdin.isTTY) process.stdin.setRawMode(true);
${WORKER_PLATFORM_SOURCE}
const record = id => path.join(root, id + '.json');
const journal = id => path.join(root, id + '.ndjson');
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const frame = value => process.stdout.write(String.fromCharCode(30) + 'T3RUN ' + JSON.stringify(value) + '\n');
async function completion(code, paths, emit = frame) {
  async function send(value) { if (emit(value) === false) await require('node:events').once(process.stdout, 'drain'); }
  if (Buffer.byteLength(JSON.stringify(paths)) <= 32768) { await send({type:'done',code,ignored:paths}); return; }
  let chunk = [], size = 0;
  for (const file of paths) {
    const bytes = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (chunk.length && size + bytes > 32768) { await send({type:'ignored',paths:chunk}); chunk = []; size = 0; }
    chunk.push(file); size += bytes;
  }
  if (chunk.length) await send({type:'ignored',paths:chunk});
  await send({type:'done',code,ignored:[]});
}
const atomic = async (file, value) => { const temp = file + '.' + crypto.randomUUID(); await fsp.writeFile(temp, JSON.stringify(value), {mode: 0o600}); await fsp.rename(temp, file); };
const state = async id => JSON.parse(await fsp.readFile(record(id), 'utf8'));
async function prepareRoot() {
  await fsp.mkdir(root, {recursive: true, mode: 0o700});
  const s = await fsp.lstat(root);
  if (!privateStat(s)) throw Error('Run state directory is not private');
}
function ignored(relative) {
  const segments = relative.split('/');
  if (segments.includes('.git')) return true;
  let result = false;
  for (const raw of c.ignores || []) {
    const negate = raw.startsWith('!');
    const pattern = (negate ? raw.slice(1) : raw).replace(/\/$/, '');
    const anchored = pattern.startsWith('/');
    const glob = anchored ? pattern.slice(1) : pattern;
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      if ((anchored || glob.includes('/')) ? path.matchesGlob(prefix, glob) : path.matchesGlob(segments[i - 1], glob)) result = !negate;
    }
  }
  return result;
}
async function manifest() {
  const entries = new Map();
  async function walk(directory, relative) {
    let children;
    try { children = await fsp.readdir(directory, {withFileTypes: true}); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const child of children) {
      const rel = relative ? relative + '/' + child.name : child.name;
      const full = path.join(directory, child.name);
      if (child.isDirectory()) await walk(full, rel);
      else if (ignored(rel)) {
        const stat = await fsp.lstat(full, {bigint: true});
        entries.set(rel, String(stat.mtimeNs) + ':' + String(stat.size));
      }
    }
  }
  await walk(c.root, '');
  return entries;
}
async function changed(before) {
  const after = await manifest();
  return [...after].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => file);
}
async function control(id, signal) {
  await new Promise((resolve, reject) => {
    const socket = net.connect(address(id));
    socket.setTimeout(3000, () => socket.destroy(Error('Background process did not answer')));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(JSON.stringify({signal}) + '\n'));
    socket.on('data', () => resolve());
    socket.on('end', resolve);
  });
}
async function observe(id, logs, follow) {
  let offset = 0;
  let buffer = '';
  const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
  let watcher;
  let draining = false;
  let again = false;
  let completed = false;
  const close = () => { if (watcher) watcher.close(); process.stdin.destroy(); };
  async function drain() {
    if (draining) { again = true; return; }
    draining = true;
    try {
      do {
        again = false;
        if (logs) {
          const handle = await fsp.open(journal(id), 'r');
          try {
            const size = (await handle.stat()).size;
            while (size > offset) {
              const data = Buffer.alloc(Math.min(65536, size - offset));
              const read = await handle.read(data, 0, data.length, offset);
              offset += read.bytesRead;
              buffer += decoder.write(data.subarray(0, read.bytesRead));
              let end;
              while ((end = buffer.indexOf('\n')) >= 0) {
                const item = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
                if (item.type === 'done') completed = true;
                if (!frame(item)) await new Promise(resolve => process.stdout.once('drain', resolve));
              }
            }
          } finally { await handle.close(); }
        }
        const current = await state(id);
        if (!logs && current.status !== 'running') { await completion(current.code, current.ignored || []); completed = true; }
        if (completed || !follow) { close(); if (!completed) frame({type: 'done', code: 0, ignored: []}); }
      } while (again && !completed && follow);
    } finally { draining = false; }
  }
  if (follow) {
    watcher = fs.watch(root, (_, name) => {
      if (name === id + '.json' || name === id + '.ndjson') drain().catch(fail);
    });
    process.stdin.on('end', close); process.stdin.resume();
  }
  function fail(error) { close(); frame({type: 'error', message: error.message}); process.exitCode = 255; }
  if (!logs) frame({type: 'ready', id});
  await drain();
}
async function execute(job) {
  const before = await manifest();
  const id = c.id;
  let child;
  let terminalSignal;
  let killTimer;
  let commandTimer;
  let watchdog;
  let server;
  let stopping = false;
  let finished = false;
  let lastBeat = Date.now();
  const emit = job ? value => fs.appendFileSync(journal(id), JSON.stringify(value) + '\n', {mode: 0o600}) : frame;
  const metadata = {id, name: c.args[0], cwd: c.cwd, ports: c.ports || [], startedAt: new Date().toISOString(), status: 'running'};
  function signal(sig) {
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 || finished) return;
    signalGroup(child.pid,sig,emit);
  }
  function stop(sig) {
    if (stopping || finished) return;
    stopping = true; terminalSignal = sig;
    signal(sig);
    killTimer = setTimeout(() => signal('SIGKILL'), 1000);
  }
  if (job) await fsp.writeFile(journal(id), '', {mode: 0o600});
  if (c.tty) {
    if (!c.ptyModule) throw Error('The primary terminal runtime was not discovered');
    const {EventEmitter} = require('node:events');
    const {PassThrough, Writable} = require('node:stream');
    const resolved = resolveInvocation(c.args[0],c.args.slice(1));
    const pty = require(c.ptyModule).spawn(resolved.ptyCommand, resolved.ptyArgs, {cwd:c.cwd, env:process.env, name:process.env.TERM || 'xterm-256color', cols:c.cols || 80, rows:c.rows || 24, encoding:null});
    child = new EventEmitter(); child.pid = pty.pid;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({write(data, _, next) { try { pty.write(data.toString()); next(); } catch(error) { next(error); } }, final(next) { pty.write(resolved.ptyEof); next(); }});
    pty.onData(data => { if (!child.stdout.write(Buffer.from(data))) pty.pause(); });
    child.stdout.on('drain', () => pty.resume());
    pty.onExit(event => { const code = event.signal ? 128 + event.signal : event.exitCode; child.emit('exit', code, null); child.stdout.end(); child.stderr.end(); child.emit('close', code, null); });
  } else child = spawn(c.args[0], c.args.slice(1), {cwd: c.cwd, env: process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
  child.once('exit', () => { if (!stopping) { signal('SIGTERM'); killTimer = setTimeout(() => signal('SIGKILL'), 1000); } });
  for (const [stream, type] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', data => {
    if (emit({type, data: data.toString('base64')}) === false) { child.stdout.pause(); child.stderr.pause(); }
  });
  if (!job) process.stdout.on('drain', () => { child.stdout.resume(); child.stderr.resume(); });
  const complete = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, sig) => resolve(code === null ? 128 + (os.constants.signals[sig || terminalSignal] || 1) : code));
  });
  if (job) {
    server = net.createServer(socket => {
      let input = '';
      socket.setTimeout(3000, () => socket.destroy());
      socket.on('error', e => emit({type: 'error', message: e.message}));
      socket.on('data', data => {
        input += data;
        if (input.length > 1024) { socket.destroy(); return; }
        if (input.includes('\n')) { const request = JSON.parse(input.trim()); if (['SIGINT', 'SIGTERM'].includes(request.signal)) stop(request.signal); socket.end('ok\n'); }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address(id), resolve); });
    await protectSocket(address(id));
    await atomic(record(id), metadata);
    if (process.send) { process.send({ready: true}); process.disconnect(); }
    child.stdin.end();
  } else {
    const input = readline.createInterface({input: process.stdin});
    input.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.type === 'beat') lastBeat = Date.now();
        else if (message.type === 'data') child.stdin.write(Buffer.from(message.data, 'base64'));
        else if (message.type === 'end') child.stdin.end();
        else if (message.type === 'signal' && ['SIGINT','SIGTERM'].includes(message.signal)) stop(message.signal);
      } catch (e) { emit({type: 'error', message: e.message}); stop('SIGTERM'); }
    });
    input.on('close', () => stop('SIGTERM'));
    frame({type:'ready',id:''});
    watchdog = setInterval(() => { if (Date.now() - lastBeat > 5000) stop('SIGTERM'); }, 1000);
    process.stdout.on('error', () => stop('SIGTERM'));
  }
  child.stdin.on('error', e => { if (e.code !== 'EPIPE' && e.code !== 'ERR_STREAM_DESTROYED') { emit({type: 'error', message: e.message}); stop('SIGTERM'); } });
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGTERM'));
  if (c.timeoutMs) commandTimer = setTimeout(() => stop('SIGTERM'), c.timeoutMs);
  let code;
  try { code = await complete; }
  catch (e) { emit({type: 'err', data: Buffer.from(e.message + '\n').toString('base64')}); code = e.code === 'ENOENT' ? 127 : 126; }
  // A successful shell can leave descendants behind; the supervisor owns the group through cleanup.
  signal('SIGKILL');
  finished = true;
  clearTimeout(killTimer); clearTimeout(commandTimer); clearInterval(watchdog);
  const outputs = await changed(before);
  if (job) await atomic(record(id), {...metadata, status: 'exited', code, ignored: outputs});
  await completion(code, outputs, emit);
  if (server) await new Promise(resolve => server.close(resolve));
  process.stdin.destroy();
}
async function main() {
  if (!c.namespace || !/^[a-f0-9]{16}$/.test(c.namespace)) throw Error('Invalid run namespace');
  await prepareRoot();
  if (c.action === 'probe') { frame({type: 'done', code: 0, ignored: []}); return; }
  if (c.action === 'exec') { await execute(false); return; }
  if (c.action === 'job') { if (!validId(c.id)) throw Error('Invalid background id'); await execute(true); return; }
  if (c.action === 'start') {
    const id = crypto.randomUUID();
    const payload = Buffer.from(JSON.stringify({...c, action: 'job', id})).toString('base64');
    const source = process.execArgv[process.execArgv.indexOf('-e') + 1];
    const launcher = c.runtimeInvocation;
    const daemon = spawn(launcher ? launcher.command : process.execPath, launcher ? [...(launcher.entrypoint ? [launcher.entrypoint] : []), '__run-worker', payload] : ['-e', source, '--', payload], {detached: true, stdio: ['ignore','ignore','ignore','ipc']});
    await new Promise((resolve, reject) => {
      daemon.once('error', reject); daemon.once('exit', code => reject(Error('Background process failed to start (' + code + ')')));
      daemon.once('message', message => { if (message.ready) resolve(); else reject(Error('Invalid background handshake')); });
    });
    daemon.unref(); frame({type:'ready', id}); frame({type:'done',code:0,ignored:[]}); return;
  }
  if (c.action === 'list') {
    const rows = [];
    for (const name of await fsp.readdir(root)) if (/^[a-f0-9-]{36}\.json$/.test(name)) rows.push(await state(name.slice(0, -5)));
    frame({type:'out', data:Buffer.from(rows.map(row => row.id + '\t' + row.status + '\t' + row.name + '\t' + row.cwd + '\t' + (row.code === undefined ? '' : row.code) + '\t' + (row.ports || []).join(',')).join('\n') + (rows.length ? '\n' : '')).toString('base64')});
    frame({type:'done',code:0,ignored:[]}); return;
  }
  if (!validId(c.id)) throw Error('Invalid background id');
  const current = await state(c.id);
  if (c.action === 'stop') {
    if (current.status === 'running') await control(c.id, 'SIGTERM');
    await observe(c.id, false, true); return;
  }
  if (c.action === 'logs' || c.action === 'wait') { await observe(c.id, c.action === 'logs', c.follow || c.action === 'wait'); return; }
  throw Error('Unknown remote run action');
}
main().catch(error => { frame({type:'error',message:error.message}); process.exitCode = 255; });
`;
