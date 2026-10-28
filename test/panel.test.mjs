import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('../ui/panel.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));
function host() {
  const elements = Object.fromEntries(['speed', 'tps', 'cache', 'phase'].map(id => [id, { textContent: '', dataset: {} }]));
  const messages = [], listeners = {}, timers = new Map(); let sequence = 0;
  const parent = { postMessage: message => messages.push(message) };
  const window = { parent, addEventListener: (event, handler) => { listeners[event] = handler; } };
  const document = { visibilityState: 'visible', documentElement: { style: {} }, getElementById: id => elements[id],
    addEventListener: (event, handler) => { listeners[event] = handler; } };
  runInNewContext(script, { window, document, setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  const deliver = (data, source = parent, origin = 'https://host.example') => listeners.message({ source, origin, data: { jsonrpc: '2.0', ...data } });
  return { elements, messages, listeners, timers, document, parent, deliver };
}
async function initialize(h) {
  const init = h.messages[0]; assert.equal(init.method, 'ui/initialize');
  h.deliver({ id: init.id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark' } } }); await flush();
  assert.equal(h.document.documentElement.style.colorScheme, 'dark');
  assert.ok(h.messages.some(m => m.method === 'ui/notifications/initialized'));
}
test('panel handshakes before polling and accepts updates only from its parent and bound origin', async () => {
  const h = host(); h.listeners.visibilitychange(); assert.equal(h.messages.length, 1);
  h.deliver({ id: h.messages[0].id, result: {} }, {}); await flush(); assert.equal(h.messages.length, 1);
  await initialize(h);
  const request = h.messages.at(-1); assert.equal(request.method, 'tools/call'); assert.equal(request.params.name, 'token_speed_status');
  h.deliver({ id: request.id, result: { structuredContent: { tps: 99 } } }, h.parent, 'https://other.example'); await flush();
  assert.equal(h.elements.tps.textContent, '');
  h.deliver({ id: request.id, result: { structuredContent: { tps: 24, cacheHit: 97.9, activity: 'tool', speedFresh: false, status: 'connected' } } }); await flush();
  assert.equal(h.elements.tps.textContent, '24'); assert.equal(h.elements.cache.textContent, '97.9');
  assert.equal(h.elements.speed.dataset.stale, 'true'); assert.match(h.elements.phase.textContent, /上次有效速度/);
  h.deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { tps: 31.1, cacheHit: 98, activity: 'complete', speedFresh: true } } });
  assert.equal(h.elements.tps.textContent, '31'); assert.equal(h.elements.speed.dataset.stale, 'false');
});
test('hidden and destroyed panels stop requests; errors weaken retained data and never fabricate speed', async () => {
  const h = host(); await initialize(h);
  const request = h.messages.at(-1);
  h.deliver({ id: request.id, result: { structuredContent: { tps: 24, cacheHit: 80, speedFresh: true } } }); await flush();
  const pollTimer = [...h.timers.values()].find(t => t.ms === 1000); assert.ok(pollTimer);
  h.document.visibilityState = 'hidden'; h.listeners.visibilitychange(); pollTimer.fn();
  const count = h.messages.length; await flush(); assert.equal(h.messages.length, count);
  h.document.visibilityState = 'visible'; h.listeners.visibilitychange();
  const next = h.messages.at(-1); h.deliver({ id: next.id, error: { code: -1 } }); await flush();
  assert.equal(h.elements.tps.textContent, '24'); assert.equal(h.elements.speed.dataset.stale, 'true'); assert.match(h.elements.phase.textContent, /连接暂时中断/);
  h.deliver({ id: 999, method: 'ui/resource-teardown' });
  assert.equal(h.timers.size, 0); assert.ok(h.messages.at(-1).result);
  h.listeners.visibilitychange(); await flush(); assert.equal(h.messages.at(-1).id, 999);
});
test('invalid metrics render as unknown and connection timeout explains failure', async () => {
  const h = host(); await initialize(h);
  h.deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { tps: -1, cacheHit: 101, status: 'waiting-session' } } });
  assert.equal(h.elements.tps.textContent, '--'); assert.equal(h.elements.cache.textContent, '--'); assert.match(h.elements.phase.textContent, /等待当前聊天/);
  const unopened = host(); [...unopened.timers.values()][0].fn(); await flush();
  assert.match(unopened.elements.phase.textContent, /客户端未能加载/);
  assert.equal(unopened.messages.length, 1);
});

test('historical speed explains rejected samples and exposes only the real sampling time', async () => {
  const h = host(); await initialize(h);
  h.deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { tps: 20, cacheHit: 80,
    activity: 'generating', speedFresh: false, speedReason: 'ambiguous-window', speedUpdatedAt: '2026-10-28T02:00:01.000Z', model: 'test-model', effort: 'high' } } });
  assert.match(h.elements.phase.textContent, /无法可靠配对/); assert.match(h.elements.phase.textContent, /上次有效速度/);
  assert.match(h.elements.speed.title, /最近有效采样/); assert.match(h.elements.speed.title, /test-model \/ high/);
  h.deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { tps: null, speedFresh: false, speedReason: 'context-changed' } } });
  assert.equal(h.elements.tps.textContent, '--'); assert.match(h.elements.phase.textContent, /档位已变化/);
  assert.equal(h.elements.speed.title, '尚无有效采样时间');
});
