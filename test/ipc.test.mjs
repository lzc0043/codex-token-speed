import test from 'node:test';
import assert from 'node:assert/strict';
import { Router, Frames, frameJSON, ActiveSession } from '../scripts/ipc.mjs';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textFor } from '../scripts/overlay.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const event = (conversationId = id, following = true, sourceClientId = 'window-one', hostId = 'local') => ({
  type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId, params: { conversationId, following, hostId },
});
test('selection follows one window; stale un-follow never clears a newer selection', () => {
  const router = new Router(); router.ingest(event());
  assert.equal(router.snapshot().threadId, id);
  const next = id.slice(0, -1) + '2'; router.ingest(event(next)); router.ingest(event(id, false));
  assert.equal(router.snapshot().threadId, next);
  router.ingest(event(next, false)); assert.equal(router.snapshot().threadId, null);
});
test('multiple windows and remote sessions never guess a local log', () => {
  const router = new Router(); router.ingest(event()); router.ingest(event(id, true, 'window-two'));
  assert.deepEqual(router.snapshot(), { threadId: null, status: 'multiple-windows' });
  router.ingest({ type: 'broadcast', method: 'client-status-changed', params: { clientId: 'window-two', status: 'disconnected' } });
  assert.equal(router.snapshot().threadId, id);
  router.ingest(event(id, true, 'window-one', 'remote')); router.ingest(event(id, false));
  assert.equal(router.snapshot().status, 'remote-session');
});
test('IPC length-prefix parser handles split/concatenated UTF-8, malformed and oversized data', () => {
  const frames = new Frames(), seen = [];
  const bytes = Buffer.concat([frameJSON({ value: '缓存' }), frameJSON(event())]);
  frames.push(bytes.subarray(0, 6), v => seen.push(v)); assert.equal(seen.length, 0);
  frames.push(bytes.subarray(6), v => seen.push(v)); assert.equal(seen.length, 2);
  assert.equal(seen[0].value, '缓存');
  const bad = Buffer.alloc(4); bad.writeUInt32LE(4 * 1024 * 1024 + 1);
  assert.throws(() => frames.push(bad, () => {}), /limit/);
});
test('UI shows speed and cache without an approximation symbol; missing data stays hidden', () => {
  assert.equal(textFor({ tps: 42, cacheHit: 0 }), '42 t/s   ·   会话缓存 0.0%');
  assert.equal(textFor({ tps: null, cacheHit: null }), '');
  assert.equal(textFor({ tps: null, cacheHit: 80 }), '-- t/s   ·   会话缓存 80.0%');
});
test('refreshes missed selection notifications without dropping the current route', { timeout: 12000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-speed-ipc-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\token-speed-test-${process.pid}` : join(home, 'ipc.sock');
  const previous = process.env.CODEX_IPC_SOCKET;
  const connections = new Set(); let selected = id, monitor, mainSocket, onProbe;
  const server = createServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    const parser = new Frames();
    socket.on('data', bytes => parser.push(bytes, request => {
      if (request.method !== 'initialize') return;
      socket.write(frameJSON({ type: 'response', method: 'initialize', result: { clientId: 'test-monitor' } }));
      socket.write(frameJSON(event(selected)));
      if (!mainSocket) mainSocket = socket;
      else if (onProbe) { const run = onProbe; onProbe = null; run(); }
    }));
  });
  const waitFor = async predicate => {
    const until = Date.now() + 7000;
    while (!predicate() && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    assert.equal(predicate(), true, 'the current thread must recover after a missed notification');
  };
  try {
    await new Promise(resolve => server.listen(path, resolve));
    process.env.CODEX_IPC_SOCKET = path; monitor = new ActiveSession(home);
    await waitFor(() => monitor.snapshot().threadId === id);
    selected = id.slice(0, -1) + '2';
    await waitFor(() => monitor.snapshot().threadId === selected);
    assert.equal(monitor.snapshot().status, 'connected');
    await waitFor(() => !monitor.refreshSocket);
    const newer = id.slice(0, -1) + '3';
    onProbe = () => { selected = newer; mainSocket.write(frameJSON(event(newer))); };
    await monitor.refresh();
    await waitFor(() => monitor.snapshot().threadId === newer);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(monitor.snapshot().threadId, newer, 'a stale refresh must not overwrite a live switch');
  } finally {
    monitor?.close(); for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.CODEX_IPC_SOCKET; else process.env.CODEX_IPC_SOCKET = previous;
    await rm(home, { recursive: true, force: true });
  }
});
