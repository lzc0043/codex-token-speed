import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionReader } from './metrics.mjs';
import { ActiveSession } from './ipc.mjs';
import { startDisplay, messageFor } from './overlay.mjs';

const version = '0.3.5';
const home = process.env.CODEX_HOME || join(homedir(), '.codex');
const headless = process.argv.includes('--headless');
const reader = new SessionReader(home);
let active, display, timer, currentThread, busy = false, pendingTick = false, stopping = false, initialized = false;
let state = { version, tps: null, cacheHit: null, status: 'starting', overlay: 'starting' };
const report = message => { state.overlayError = message.trim(); process.stderr.write(`token-speed: ${message.trim()}\n`); };

async function start() {
  if (initialized || stopping) return;
  initialized = true;
  if (headless) { state.status = 'headless'; state.overlay = 'headless'; return; }
  active = new ActiveSession(home, () => tick());
  await tick();
  timer = setInterval(tick, 750);
}
async function tick() {
  if (headless || stopping) return;
  if (busy) { pendingTick = true; return; }
  busy = true;
  try {
    const route = active.snapshot();
    if (route.threadId !== currentThread) {
      currentThread = route.threadId;
      Object.assign(state, { tps: null, cacheHit: null, activity: 'idle', speedFresh: false, status: route.status });
      if (display?.stdin.writable) display.stdin.write(messageFor(state) + '\n');
    }
    const metrics = await reader.readSelected(route, () => active.snapshot());
    if (!metrics) {
      const latest = active.snapshot();
      Object.assign(state, { tps: null, cacheHit: null, activity: 'idle', speedFresh: false, status: latest.status });
      pendingTick = true; return;
    }
    state = { ...state, ...metrics, status: route.status };
    if (!display) {
      Object.assign(state, { overlay: 'standby', overlayOwner: false, overlayVisible: false });
      display = startDisplay(report, update => Object.assign(state, update));
      display.on('exit', code => { state.overlay = 'stopped'; state.overlayVisible = false; if (code) report(`Display exited (${code})`); });
    }
  } catch (error) { state.status = 'error'; state.tps = null; state.cacheHit = null; state.activity = 'idle'; state.speedFresh = false; report(error.message); }
  finally {
    if (display?.stdin.writable && display.stdin.writableLength < 4096) display.stdin.write(messageFor(state) + '\n');
    busy = false;
    if (pendingTick) { pendingTick = false; queueMicrotask(tick); }
  }
}
function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer); active?.close(); process.stdin.destroy();
  display?.stdin.end(); display?.kill();
  setTimeout(() => process.exit(0), 100).unref();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
process.stdin.on('end', stop);
process.stdout.on('error', stop);
process.stdin.on('error', stop);
process.on('uncaughtException', error => { report(error.message); stop(); });
process.on('unhandledRejection', error => { report(String(error)); stop(); });

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const error = (code, message) => ({ error: { code, message } });
async function handle(request) {
  if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(-32600, 'Invalid request');
  const { method, params: p = {} } = request;
  if (method === 'initialize') {
    if (typeof p?.protocolVersion !== 'string' || !p.clientInfo || !p.capabilities) return error(-32602, 'Invalid initialize parameters');
    await start();
    return { result: { protocolVersion: versions.includes(p.protocolVersion) ? p.protocolVersion : versions[0],
      capabilities: { tools: {} }, serverInfo: { name: 'codex-token-speed', version } } };
  }
  if (method === 'ping') return { result: {} };
  if (method.startsWith('notifications/')) return null;
  if (!initialized) return error(-32000, 'Initialize first');
  if (method === 'tools/list') return { result: { tools: [{ name: 'token_speed_status', description: 'Read current local token/s, cache hit rate and display status. No chat text is returned.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] } };
  if (method === 'tools/call') {
    if (p?.name !== 'token_speed_status' || (p.arguments !== undefined && (!p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments) || Object.keys(p.arguments).length))) return error(-32602, 'Unknown tool or invalid arguments');
    await tick();
    return { result: { content: [{ type: 'text', text: JSON.stringify(state) }] } };
  }
  return error(-32601, 'Method not found');
}
function send(id, response) {
  if (response && !stopping) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...response }) + '\n');
}
let pending = Buffer.alloc(0), queue = Promise.resolve();
process.stdin.on('data', bytes => {
  pending = Buffer.concat([pending, bytes]);
  let end;
  while ((end = pending.indexOf(10)) >= 0) {
    const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
    if (line.length > 1024 * 1024) { stop(); return; }
    queue = queue.then(async () => {
      let request;
      try { request = JSON.parse(line); } catch { send(null, error(-32700, 'Parse error')); return; }
      const response = await handle(request).catch(() => error(-32603, 'Internal error'));
      const id = request?.id;
      if (id !== undefined && (typeof id === 'string' || (Number.isInteger(id) && Number.isFinite(id)))) send(id, response);
      else if (response?.error && !request?.method) send(null, response);
    });
  }
  if (pending.length > 1024 * 1024) stop();
});
