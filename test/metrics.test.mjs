import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Usage, SessionReader } from '../scripts/metrics.mjs';

const id = '00000000-0000-4000-8000-000000000001';
test('a chat switched during an asynchronous read cannot receive the old chat metrics', async () => {
  let resolveRead;
  const reader = new SessionReader('unused');
  reader.read = () => new Promise(resolve => { resolveRead = resolve; });
  const original = { threadId: id, status: 'connected' };
  let current = original;
  const stale = reader.readSelected(original, () => current);
  current = { threadId: id.slice(0, -1) + '2', status: 'connected' };
  resolveRead({ tps: 42, cacheHit: 98 });
  assert.equal(await stale, null);
  const fresh = reader.readSelected(current, () => current);
  resolveRead({ tps: 73, cacheHit: 60 });
  assert.deepEqual(await fresh, { tps: 73, cacheHit: 60 });
  assert.deepEqual(await reader.readSelected({ threadId: null, status: 'waiting-session' }, () => ({ threadId: null, status: 'waiting-session' })), { tps: null, cacheHit: null });
});
const begin = (turn = 'one') => ({ type: 'event_msg', timestamp: '2026-10-28T02:00:00.000Z', payload: { type: 'task_started', turn_id: turn, started_at: 1793152800 } });
const usage = (n = 1, turn = 'one') => ({ type: 'token_usage_record', payload: {
  turn_id: turn, usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 10 },
  thread_token_usage: { input_tokens: n * 100, cached_input_tokens: n * 80, output_tokens: n * 20, total_tokens: n * 120 },
} });
const legacy = record => ({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: record.payload.usage, total_token_usage: record.payload.thread_token_usage } } });
const done = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one', duration_ms: 2000 } };
const model = (start = 0, end = 2000, turn = 'one', type = 'Reasoning') => ({ type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item: { type }, started_at_ms: start, completed_at_ms: end } });

test('generation, parallel tools, fresh usage and completion change feedback without inventing speed', () => {
  const m = new Usage();
  const tool = (type, call_id) => ({ type: 'response_item', payload: { type, call_id } });
  assert.equal(m.snapshot().activity, 'idle');
  m.ingest(begin()); assert.equal(m.snapshot().activity, 'generating');
  assert.equal(m.snapshot().speedFresh, false); assert.equal(m.snapshot().tps, null);
  m.ingest(model()); m.ingest(usage()); assert.equal(m.snapshot().speedFresh, true);
  m.ingest(tool('function_call', 'a')); m.ingest(tool('custom_tool_call', 'b'));
  assert.equal(m.snapshot().activity, 'tool'); assert.equal(m.snapshot().tps, 10);
  m.ingest(tool('function_call_output', 'a')); assert.equal(m.snapshot().activity, 'tool');
  m.ingest(tool('custom_tool_call_output', 'b')); assert.equal(m.snapshot().activity, 'generating');
  assert.equal(m.snapshot().speedFresh, false); assert.equal(m.snapshot().tps, 10);
  m.ingest(model(3000, 4000)); m.ingest(usage(2)); assert.equal(m.snapshot().speedFresh, true);
  m.ingest(done); assert.equal(m.snapshot().activity, 'complete');
  m.ingest(tool('function_call', 'late')); assert.equal(m.snapshot().activity, 'complete');
  m.ingest(begin('two'));
  m.ingest({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'one' } });
  assert.equal(m.snapshot().activity, 'generating');
  m.ingest({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'two' } });
  assert.equal(m.snapshot().activity, 'idle');
});

test('tool item lifecycle and persisted call records must both settle before generation resumes', () => {
  const m = new Usage(); m.ingest(begin());
  const item = type => ({ type: 'event_msg', payload: { type, turn_id: 'one', item: { type: 'McpToolCall', id: 'item-a' }, started_at_ms: 2000, completed_at_ms: 3000 } });
  m.ingest({ type: 'response_item', payload: { type: 'function_call', call_id: 'call-a' } });
  m.ingest(item('item_started')); assert.equal(m.snapshot().activity, 'tool');
  m.ingest({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-a' } });
  assert.equal(m.snapshot().activity, 'tool');
  m.ingest(item('item_completed')); assert.equal(m.snapshot().activity, 'generating');
});

test('modern and legacy duplicate counts are included once, reasoning is a subset', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model()); m.ingest(usage()); m.ingest(legacy(usage())); m.ingest(done);
  assert.deepEqual(m.snapshot(), { tps: 10, cacheHit: 80, completed: true, activity: 'complete', speedFresh: true });
});
test('legacy-first order is deduplicated and tool execution time never enters the speed window', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model());
  m.ingest(model(2500, 52500, 'one', 'CommandExecution'));
  m.ingest(legacy(usage())); m.ingest(usage());
  assert.equal(m.snapshot().tps, 8);
  m.ingest({ ...done, payload: { ...done.payload, duration_ms: 1000000 } });
  assert.equal(m.snapshot().tps, 8);
});
test('real-world carriers can have different cumulative scope; legacy cannot clear modern speed/cache', () => {
  const modern = usage();
  const old = legacy(modern);
  old.payload.info.total_token_usage = { input_tokens: 200, cached_input_tokens: 100, output_tokens: 40, total_tokens: 240 };
  for (const rows of [[modern, old], [old, modern]]) {
    const m = new Usage(); m.ingest(begin()); m.ingest(model());
    for (const row of rows) m.ingest(row);
    assert.equal(m.snapshot().tps, 10);
    assert.equal(m.snapshot().cacheHit, 80);
  }
});
test('a new turn retains the last speed and ignores late previous-turn records and duplicates', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model()); m.ingest(usage()); m.ingest(begin('two'));
  m.ingest(usage()); m.ingest(legacy(usage()));
  assert.deepEqual(m.snapshot(), { tps: 10, cacheHit: 80, completed: false, activity: 'generating', speedFresh: false });
  m.ingest(model(3000, 4000, 'two'));
  m.ingest(usage(2, 'two'));
  assert.equal(m.snapshot().tps, 20);
});
test('missing output window keeps speed unknown; zero/invalid cumulative input is unknown', () => {
  const m = new Usage(); const row = usage(); row.payload.thread_token_usage.input_tokens = 0;
  m.ingest(row); assert.equal(m.snapshot().tps, null); assert.equal(m.snapshot().cacheHit, null);
  const next = usage(2); next.payload.thread_token_usage.cached_input_tokens = 201; m.ingest(next);
  assert.equal(m.snapshot().cacheHit, null);
});
test('zero cached tokens with positive input is a real zero cache hit', () => {
  const m = new Usage(); const row = usage(); row.payload.thread_token_usage.cached_input_tokens = 0;
  m.ingest(row); assert.equal(m.snapshot().cacheHit, 0);
});
test('zero output-window duration and non-finite values cannot produce infinity', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 0)); m.ingest(usage());
  assert.equal(m.snapshot().tps, null);
  const bad = usage(2); bad.payload.usage.output_tokens = Infinity; m.ingest(model(1000, 2000)); m.ingest(bad);
  assert.equal(m.snapshot().tps, null);
});
test('cache hit is session-wide weighted input, not latest-request percentage', () => {
  const m = new Usage(); m.ingest(usage());
  const second = usage(2);
  second.payload.usage = { input_tokens: 200, cached_input_tokens: 30, output_tokens: 20 };
  second.payload.thread_token_usage = { input_tokens: 300, cached_input_tokens: 110, output_tokens: 40, total_tokens: 340 };
  m.ingest(second);
  assert.equal(m.snapshot().cacheHit, 110 / 300 * 100);
});
test('each response owns its window; a duplicate cannot consume the next window', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model()); m.ingest(usage());
  m.ingest(model(3000, 4000)); m.ingest(legacy(usage())); m.ingest(usage(2));
  assert.equal(m.snapshot().tps, 20);
  m.ingest(usage(3)); assert.equal(m.snapshot().tps, null);
});
test('reasoning and message timestamps bound one response, late old items are ignored', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 1000)); m.ingest(model(1100, 2000, 'one', 'AgentMessage')); m.ingest(usage());
  assert.equal(m.snapshot().tps, 10);
  m.ingest(model(0, 2000)); m.ingest(model(3000, 4000)); m.ingest(usage(2));
  assert.equal(m.snapshot().tps, 20);
});
test('reader waits for a complete JSONL line, resets truncated files, and isolates sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inline-metrics-test-'));
  try {
    const dir = join(root, 'sessions/2026/10/28'); await mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-${id}.jsonl`);
    const full = JSON.stringify(usage());
    await writeFile(file, [begin(), model()].map(JSON.stringify).join('\n') + '\n' + full.slice(0, 100));
    const reader = new SessionReader(root);
    assert.equal((await reader.read(id)).cacheHit, null);
    await appendFile(file, full.slice(100) + '\n' + JSON.stringify(done) + '\n');
    assert.deepEqual(await reader.read(id), { tps: 10, cacheHit: 80, completed: true, activity: 'complete', speedFresh: true });
    const id2 = id.slice(0, -1) + 'b';
    assert.equal((await reader.read(id2)).cacheHit, null);
    await writeFile(file, JSON.stringify(usage()) + '\n');
    const snapshot = await reader.read(id);
    assert.equal(snapshot.cacheHit, 80); assert.equal(snapshot.tps, null);
    assert.equal((await reader.read('../../auth.json')).cacheHit, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a newly created selected chat becomes readable within the selection recovery budget', { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-speed-new-chat-'));
  try {
    const reader = new SessionReader(root);
    assert.equal((await reader.read(id)).cacheHit, null);
    await mkdir(join(root, 'sessions'), { recursive: true });
    await writeFile(join(root, 'sessions', `rollout-${id}.jsonl`), [begin(), model(), usage()].map(JSON.stringify).join('\n')+'\n');
    const until = Date.now()+1500;
    let state;
    do { await new Promise(resolve => setTimeout(resolve, 30)); state = await reader.read(id); } while (state.cacheHit === null && Date.now()<until);
    assert.equal(state.cacheHit, 80); assert.equal(state.activity, 'generating');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('tail truncation never invents a missing model output window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inline-metrics-tail-'));
  try {
    const dir = join(root, 'sessions'); await mkdir(dir);
    const padding = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(2 * 1024 * 1024) } });
    await writeFile(join(dir, `rollout-${id}.jsonl`), [begin(), JSON.parse(padding), usage()].map(JSON.stringify).join('\n') + '\n');
    const result = await new SessionReader(root).read(id);
    assert.equal(result.cacheHit, 80); assert.equal(result.tps, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('self-contained model timing from a tail works without the turn start', () => {
  const m = new Usage(); m.ingest(model()); m.ingest(usage());
  assert.equal(m.snapshot().tps, 10);
});
