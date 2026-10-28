import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
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
  assert.deepEqual(await reader.readSelected({ threadId: null, status: 'waiting-session' }, () => ({ threadId: null, status: 'waiting-session' })), new Usage().snapshot());
});
const begin = (turn = 'one') => ({ type: 'event_msg', timestamp: '2026-10-28T02:00:00.000Z', payload: { type: 'task_started', turn_id: turn, started_at: 1793152800 } });
const usage = (n = 1, turn = 'one') => ({ type: 'token_usage_record', payload: {
  turn_id: turn, usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 0 },
  thread_token_usage: { input_tokens: n * 100, cached_input_tokens: n * 80, output_tokens: n * 20, total_tokens: n * 120 },
} });
const legacy = record => ({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: record.payload.usage, total_token_usage: record.payload.thread_token_usage } } });
const done = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one', duration_ms: 2000 } };
const model = (start = 0, end = 2000, turn = 'one', type = 'AgentMessage') => ({ type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item: { type }, started_at_ms: start, completed_at_ms: end } });

const identified = (response, n = 1, turn = 'one') => {
  const row = usage(n, turn); row.payload.response_id = response;
  row.timestamp = `2026-10-28T02:00:${String(n).padStart(2, '0')}.000Z`; return row;
};
const context = (name, effort = 'high', turn = 'one') => ({ type: 'turn_context', payload: { turn_id: turn, model: name, effort } });

test('response identity protects the next window even when cumulative counts are corrected', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 1000)); m.ingest(identified('r1'));
  const measuredAt = m.snapshot().speedUpdatedAt;
  m.ingest(model(2000, 4000)); const duplicate = identified('r1', 2);
  duplicate.payload.thread_token_usage.cached_input_tokens = 100; m.ingest(duplicate);
  assert.equal(m.snapshot().tps, 20); assert.equal(m.snapshot().cacheHit, 50);
  assert.equal(m.snapshot().speedFresh, false); assert.equal(m.snapshot().speedUpdatedAt, measuredAt);
  const next = identified('r2', 3); next.payload.usage.output_tokens = 60; m.ingest(next);
  assert.equal(m.snapshot().tps, 30); assert.equal(m.snapshot().speedFresh, true);
  assert.equal(m.snapshot().speedUpdatedAt, next.timestamp); assert.equal(m.snapshot().speedReason, 'valid');
});

test('a late old response cannot overwrite newer cache or consume the next window', () => {
  for (const corrupt of [false, true]) {
    const m = new Usage(); const old = identified('r1');
    m.ingest(begin()); m.ingest(model(0, 1000)); m.ingest(old);
    m.ingest(model(2000, 3000)); const current = identified('r2', 2);
    current.payload.thread_token_usage.cached_input_tokens = 100; m.ingest(current);
    assert.equal(m.snapshot().cacheHit, 50);
    m.ingest(model(4000, 6000)); const before = m.snapshot();
    const stale = structuredClone(old);
    if (corrupt) stale.payload.thread_token_usage.input_tokens = null;
    m.ingest(stale); assert.deepEqual(m.snapshot(), before);
    const correction = structuredClone(current); correction.payload.thread_token_usage.cached_input_tokens = 120;
    m.ingest(correction); assert.equal(m.snapshot().cacheHit, 60);
    assert.equal(m.snapshot().speedUpdatedAt, before.speedUpdatedAt); assert.equal(m.snapshot().speedFresh, false);
    const next = identified('r3', 3); next.payload.usage.output_tokens = 60; m.ingest(next);
    assert.equal(m.snapshot().tps, 30); assert.equal(m.snapshot().speedFresh, true);
  }
});

test('an id-less newer record also prevents an older identified correction overwriting cache', () => {
  const m = new Usage(); const old = identified('r1'); m.ingest(old);
  const current = usage(2); current.payload.thread_token_usage.cached_input_tokens = 100; m.ingest(current);
  m.ingest(old); assert.equal(m.snapshot().cacheHit, 50);
});

test('ignored duplicate counts preserve correction ownership but a newer invalid response replaces it', () => {
  const m = new Usage(); const old = identified('r1'); m.ingest(old); m.ingest(usage());
  const correction = structuredClone(old); correction.payload.thread_token_usage.cached_input_tokens = 50;
  m.ingest(correction); assert.equal(m.snapshot().cacheHit, 50);
  const bad = identified('r2', 2); bad.payload.thread_token_usage.input_tokens = null;
  m.ingest(bad); m.ingest(old); assert.equal(m.snapshot().cacheHit, null);
  const repaired = identified('r2', 2); repaired.payload.thread_token_usage.cached_input_tokens = 120;
  m.ingest(repaired); assert.equal(m.snapshot().cacheHit, 60);
});

test('different response identities are not dropped solely because cumulative counts match', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 1000)); m.ingest(identified('r1'));
  m.ingest(model(2000, 4000)); m.ingest(identified('r2'));
  assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedFresh, true);
});

test('missing usage cannot join successive closed windows and the next response recovers', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 1000)); m.ingest(identified('r0'));
  m.ingest(model(2000, 3000)); m.ingest(model(4000, 5000));
  const row = identified('r2', 2); row.payload.usage.output_tokens = 60; m.ingest(row);
  assert.equal(m.snapshot().tps, 20); assert.equal(m.snapshot().speedFresh, false);
  assert.equal(m.snapshot().speedReason, 'ambiguous-window');
  m.ingest(model(6000, 7000)); const next = identified('r3', 3); next.payload.usage.output_tokens = 60; m.ingest(next);
  assert.equal(m.snapshot().tps, 60); assert.equal(m.snapshot().speedFresh, true);
});

test('duplicate model lifecycle events do not create an ambiguous window', () => {
  const m = new Usage(); m.ingest(begin()); const row = model(0, 1000); row.payload.item.id = 'answer';
  m.ingest(row); m.ingest(row); m.ingest(identified('r1'));
  assert.equal(m.snapshot().tps, 20); assert.equal(m.snapshot().speedFresh, true);
});

test('model and effort changes clear historical speed but preserve session cache', () => {
  for (const next of [context('new-model'), context('old-model', 'low'), context('old-model', 'low', 'two')]) {
    const m = new Usage(); m.ingest(context('old-model')); m.ingest(model(0, 1000)); m.ingest(identified('r1'));
    m.ingest(begin(next.payload.turn_id)); m.ingest(next);
    assert.equal(m.snapshot().tps, null); assert.equal(m.snapshot().speedUpdatedAt, null);
    assert.equal(m.snapshot().speedFresh, false); assert.equal(m.snapshot().speedReason, 'context-changed');
    assert.equal(m.snapshot().cacheHit, 80); assert.equal(m.snapshot().model, next.payload.model);
    m.ingest(model(2000, 4000, next.payload.turn_id)); m.ingest(identified('r2', 2, next.payload.turn_id));
    assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedFresh, true);
  }
});

test('same-context history keeps its real log timestamp through invalid samples and turns', () => {
  const m = new Usage(); m.ingest(context('same')); m.ingest(model(0, 1000)); const first = identified('r1'); m.ingest(first);
  assert.equal(m.snapshot().speedUpdatedAt, first.timestamp);
  m.ingest(begin('two')); m.ingest(context('same', 'high', 'two'));
  assert.equal(m.snapshot().tps, 20); assert.equal(m.snapshot().speedFresh, false);
  m.ingest(identified('r2', 2, 'two'));
  assert.equal(m.snapshot().speedUpdatedAt, first.timestamp); assert.equal(m.snapshot().speedReason, 'incomplete-window');
  const empty = new Usage(); assert.equal(empty.snapshot().speedUpdatedAt, null);
  assert.equal(empty.snapshot().speedReason, 'no-sample');
});

test('a malformed duplicate cannot clear the next window or refresh historical time', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 1000)); const first = identified('r1'); m.ingest(first);
  m.ingest(model(2000, 4000)); const bad = identified('r1', 2); bad.payload.thread_token_usage.input_tokens = null;
  m.ingest(bad); assert.equal(m.snapshot().speedUpdatedAt, first.timestamp); assert.equal(m.snapshot().cacheHit, null);
  m.ingest(identified('r2', 3)); assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedFresh, true);
});

test('a configuration change drops pending timing and missing timestamps are never invented', () => {
  const m = new Usage(); m.ingest(context('old')); m.ingest(model(0, 1000)); m.ingest(context('new'));
  m.ingest(identified('old-request')); assert.equal(m.snapshot().tps, null); assert.equal(m.snapshot().speedFresh, false);
  m.ingest(model(2000, 4000)); const row = identified('new-request', 2); row.timestamp = 'invalid'; m.ingest(row);
  assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedUpdatedAt, null);
});

test('tool arguments cannot be divided by a reasoning-only window, including calls without ids', () => {
  for (const type of ['function_call', 'custom_tool_call']) for (const withId of [true, false]) for (const withText of [false, true]) {
    const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 832, 'one', 'Reasoning'));
    if (withText) m.ingest(model(832, 1000));
    m.ingest({ type: 'response_item', payload: { type, ...(withId ? { call_id: 'a' } : {}) } });
    const record = usage(); record.payload.usage.output_tokens = 196; record.payload.usage.reasoning_output_tokens = 26;
    m.ingest(record);
    assert.equal(m.snapshot().tps, null); assert.equal(m.snapshot().speedFresh, false); assert.equal(m.snapshot().cacheHit, 80);
  }
});

test('only completed text with corresponding reasoning can supply a speed window', () => {
  const reasoningOnly = new Usage(); reasoningOnly.ingest(begin()); reasoningOnly.ingest(model(0, 2000, 'one', 'Reasoning')); reasoningOnly.ingest(usage());
  assert.equal(reasoningOnly.snapshot().tps, null);
  const missingReasoning = new Usage(); missingReasoning.ingest(begin()); missingReasoning.ingest(model(0, 1000));
  const withReasoning = usage(); withReasoning.payload.usage.reasoning_output_tokens = 10; missingReasoning.ingest(withReasoning);
  assert.equal(missingReasoning.snapshot().tps, null);
  const incompleteAnswer = new Usage(); incompleteAnswer.ingest(begin()); incompleteAnswer.ingest(model(0, 2000, 'one', 'Reasoning'));
  incompleteAnswer.ingest({ type: 'event_msg', payload: { type: 'item_started', turn_id: 'one', item: { type: 'AgentMessage' }, started_at_ms: 2000 } });
  incompleteAnswer.ingest(usage()); assert.equal(incompleteAnswer.snapshot().tps, null);
});

test('a tool response retains historical speed and the following complete text response updates it', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 500, 'one', 'Reasoning')); m.ingest(model(500, 2000)); m.ingest(usage());
  assert.equal(m.snapshot().tps, 10);
  m.ingest(model(3000, 3832, 'one', 'Reasoning'));
  m.ingest({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'a' } }); m.ingest(usage(2));
  assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedFresh, false);
  m.ingest(model(4000, 54000, 'one', 'McpToolCall'));
  m.ingest({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a' } });
  assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedFresh, false);
  m.ingest(model(55000, 56000, 'one', 'Reasoning')); m.ingest(model(56000, 57000));
  const next = usage(3); next.payload.usage.output_tokens = 40;
  m.ingest(next);
  assert.equal(m.snapshot().tps, 20); assert.equal(m.snapshot().speedFresh, true); assert.equal(m.snapshot().cacheHit, 80);
});

test('unfinished or malformed later model items cannot replace the last valid speed', () => {
  for (const type of ['Reasoning', 'AgentMessage']) for (const started of [true, false]) for (const withId of [true, false]) {
    const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 1000)); m.ingest(usage());
    m.ingest(model(2000, 3000));
    const pending = model(3100, undefined, 'one', type);
    pending.payload.completed_at_ms = undefined;
    pending.payload.item.id = withId ? 'pending' : undefined;
    if (started) pending.payload.type = 'item_started';
    m.ingest(pending);
    const next = usage(2); next.payload.usage.output_tokens = 100; m.ingest(next);
    assert.equal(m.snapshot().tps, 20); assert.equal(m.snapshot().speedFresh, false);
  }
});

test('parallel started model items must all finish before a new measurement is accepted', () => {
  const m = new Usage(); m.ingest(begin());
  const reasoning = model(0, 500, 'one', 'Reasoning'); reasoning.payload.item.id = 'reason';
  const text = model(0, 1000); text.payload.item.id = 'text';
  for (const item of [reasoning, text]) m.ingest({ ...item, payload: { ...item.payload, type: 'item_started', completed_at_ms: undefined } });
  m.ingest(reasoning); m.ingest(text); m.ingest(usage());
  assert.equal(m.snapshot().tps, 20); assert.equal(m.snapshot().speedFresh, true);
});

test('a late modern duplicate updates cache without consuming the next request window', () => {
  const m = new Usage(); const old = usage(); const modern = usage();
  old.payload.thread_token_usage = { input_tokens: 200, cached_input_tokens: 100, output_tokens: 40, total_tokens: 240 };
  m.ingest(begin()); m.ingest(model(0, 1000)); m.ingest(legacy(old));
  m.ingest(model(2000, 4000)); m.ingest(modern);
  assert.equal(m.snapshot().tps, 20); assert.equal(m.snapshot().speedFresh, false); assert.equal(m.snapshot().cacheHit, 80);
  const next = usage(2); next.payload.usage.output_tokens = 60; m.ingest(next);
  assert.equal(m.snapshot().tps, 30); assert.equal(m.snapshot().speedFresh, true);
});

test('ambiguous identical usage at the carrier transition cannot combine two model windows', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 1000)); m.ingest(legacy(usage()));
  m.ingest(model(2000, 4000)); m.ingest(usage(2));
  m.ingest(model(5000, 6000)); const next = usage(3); next.payload.usage.output_tokens = 60; m.ingest(next);
  assert.equal(m.snapshot().tps, 60); assert.equal(m.snapshot().speedFresh, true);
});

test('invalid input and missing windows retain history without marking it fresh', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model()); m.ingest(usage());
  const invalid = usage(2); invalid.payload.thread_token_usage.input_tokens = NaN; m.ingest(invalid);
  assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedFresh, false); assert.equal(m.snapshot().cacheHit, null);
  m.ingest(usage(3)); assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedFresh, false);
  m.ingest(done); assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedFresh, false);
});

test('a tool lifecycle inside a text window makes it unmeasurable without a persisted call', () => {
  for (const start of [3100, undefined]) {
    const m = new Usage(); m.ingest(begin()); m.ingest(model()); m.ingest(model(2000, 3000));
    const tool = model(3100, 50000, 'one', 'CommandExecution'); tool.payload.started_at_ms = start;
    m.ingest(tool); m.ingest(usage()); assert.equal(m.snapshot().tps, null);
  }
});

test('generation, parallel tools, fresh usage and completion change feedback without inventing speed', () => {
  const m = new Usage();
  const tool = (type, call_id) => ({ type: 'response_item', payload: { type, call_id } });
  assert.equal(m.snapshot().activity, 'idle');
  m.ingest(begin()); assert.equal(m.snapshot().activity, 'generating');
  assert.equal(m.snapshot().speedFresh, false); assert.equal(m.snapshot().tps, null);
  m.ingest(model()); m.ingest(usage()); assert.equal(m.snapshot().speedFresh, true);
  m.ingest(model(3000, 3832, 'one', 'Reasoning'));
  m.ingest(tool('function_call', 'a')); m.ingest(tool('custom_tool_call', 'b'));
  assert.equal(m.snapshot().activity, 'tool'); assert.equal(m.snapshot().tps, 10);
  m.ingest(usage(2)); assert.equal(m.snapshot().tps, 10); assert.equal(m.snapshot().speedFresh, false);
  m.ingest(tool('function_call_output', 'a')); assert.equal(m.snapshot().activity, 'tool');
  m.ingest(tool('custom_tool_call_output', 'b')); assert.equal(m.snapshot().activity, 'generating');
  assert.equal(m.snapshot().speedFresh, false); assert.equal(m.snapshot().tps, 10);
  m.ingest(model(5000, 6000)); m.ingest(usage(3)); assert.equal(m.snapshot().speedFresh, true);
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
  const m = new Usage(); const record = usage(); record.payload.usage.reasoning_output_tokens = 10;
  m.ingest(begin()); m.ingest(model(0, 1000, 'one', 'Reasoning')); m.ingest(model(1000, 2000));
  m.ingest(record); m.ingest(legacy(record)); m.ingest(done);
  assert.deepEqual(m.snapshot(), { ...new Usage().snapshot(), tps: 10, cacheHit: 80, completed: true, activity: 'complete', speedFresh: true, speedReason: 'valid' });
});
test('legacy-first order is deduplicated and a tool window remains unknown', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model());
  m.ingest(model(2500, 52500, 'one', 'CommandExecution'));
  m.ingest(legacy(usage())); m.ingest(usage());
  assert.equal(m.snapshot().tps, null); assert.equal(m.snapshot().cacheHit, 80);
  m.ingest({ ...done, payload: { ...done.payload, duration_ms: 1000000 } });
  assert.equal(m.snapshot().tps, null);
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
  assert.deepEqual(m.snapshot(), { ...new Usage().snapshot(), tps: 10, cacheHit: 80, completed: false, activity: 'generating', speedFresh: false, speedReason: 'awaiting-usage' });
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
  m.ingest(usage(3)); assert.equal(m.snapshot().tps, 20); assert.equal(m.snapshot().speedFresh, false);
});
test('reasoning and message timestamps bound one response, late old items are ignored', () => {
  const m = new Usage(); m.ingest(begin()); m.ingest(model(0, 1000, 'one', 'Reasoning')); m.ingest(model(1100, 2000)); m.ingest(usage());
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
    assert.deepEqual(await reader.read(id), { ...new Usage().snapshot(), tps: 10, cacheHit: 80, completed: true, activity: 'complete', speedFresh: true, speedReason: 'valid' });
    const id2 = id.slice(0, -1) + 'b';
    assert.deepEqual(await reader.read(id2), new Usage().snapshot());
    await writeFile(file, JSON.stringify(usage()) + '\n');
    const snapshot = await reader.read(id);
    assert.equal(snapshot.cacheHit, 80); assert.equal(snapshot.tps, null);
    assert.equal((await reader.read('../../auth.json')).cacheHit, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('archive and unarchive retain incremental history even when it is outside the replay tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-speed-archive-'));
  try {
    await mkdir(join(root, 'sessions')); await mkdir(join(root, 'archived_sessions'));
    const file = join(root, 'sessions', `rollout-${id}.jsonl`), archived = join(root, 'archived_sessions', `rollout-${id}.jsonl`);
    await writeFile(file, [context('same'), model(0, 1000), identified('r1')].map(JSON.stringify).join('\n')+'\n');
    const reader = new SessionReader(root), before = await reader.read(id);
    const padding = JSON.stringify({ type: 'padding', payload: { text: 'x'.repeat(1100000) } })+'\n';
    for (let i = 0; i < 2; i++) { await appendFile(file, padding); await reader.read(id); }
    await rename(file, archived); assert.deepEqual(await reader.read(id), before);
    await rename(archived, file); assert.deepEqual(await reader.read(id), before);
    const next = identified('r2', 2); next.payload.thread_token_usage.cached_input_tokens = 100;
    await appendFile(file, [model(2000, 4000), next].map(JSON.stringify).join('\n')+'\n');
    const after = await reader.read(id); assert.equal(after.tps, 10); assert.equal(after.cacheHit, 50);
    assert.equal(after.model, 'same'); assert.equal(after.speedUpdatedAt, next.timestamp);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a different file at a relocated path cannot inherit old timing or model context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-speed-replaced-'));
  try {
    await mkdir(join(root, 'sessions')); await mkdir(join(root, 'archived_sessions'));
    const file = join(root, 'sessions', `rollout-${id}.jsonl`), archived = join(root, 'archived_sessions', `rollout-${id}.jsonl`);
    await writeFile(file, [context('old'), model(0, 1000), identified('r1')].map(JSON.stringify).join('\n')+'\n');
    const reader = new SessionReader(root); assert.equal((await reader.read(id)).tps, 20);
    const next = identified('r2', 2); next.payload.thread_token_usage.cached_input_tokens = 100;
    await writeFile(archived, JSON.stringify(next)+'\n'); await rm(file);
    const after = await reader.read(id); assert.equal(after.cacheHit, 50);
    assert.equal(after.tps, null); assert.equal(after.speedUpdatedAt, null); assert.equal(after.model, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a temporarily missing log returns empty diagnostics and recovers when restored', { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-speed-missing-'));
  try {
    await mkdir(join(root, 'sessions'));
    const file = join(root, 'sessions', `rollout-${id}.jsonl`), parked = join(root, 'parked.jsonl');
    await writeFile(file, [context('same'), model(0, 1000), identified('r1')].map(JSON.stringify).join('\n')+'\n');
    const reader = new SessionReader(root); await reader.read(id); await rename(file, parked);
    assert.deepEqual(await reader.read(id), new Usage().snapshot());
    await rename(parked, file); const until = Date.now()+1500; let state;
    do { await new Promise(resolve => setTimeout(resolve, 30)); state = await reader.read(id); } while (state.tps === null && Date.now()<until);
    assert.equal(state.tps, 20); assert.equal(state.model, 'same');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repeated disappearance during relocation is bounded to two open attempts', async () => {
  const reader = new SessionReader('unused'); let attempts = 0;
  reader.locate = async () => { attempts++; return join(tmpdir(), `missing-token-speed-${process.pid}-${attempts}`, 'rollout.jsonl'); };
  assert.deepEqual(await reader.read(id), new Usage().snapshot()); assert.equal(attempts, 2);
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
