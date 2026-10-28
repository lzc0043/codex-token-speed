import test from 'node:test';
import assert from 'node:assert/strict';
import { Router, Frames, frameJSON } from '../scripts/ipc.mjs';
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
test('UI shows only approximate speed and cache hit; zero cache is not missing', () => {
  assert.equal(textFor({ tps: 42, cacheHit: 0 }), '≈ 42 t/s   ·   缓存命中 0.0%');
  assert.equal(textFor({ tps: null, cacheHit: null }), '≈ -- t/s   ·   缓存命中 --');
});
