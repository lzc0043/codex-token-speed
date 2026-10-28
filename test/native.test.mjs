import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messageFor, textFor } from '../scripts/overlay.mjs';
import { Usage } from '../scripts/metrics.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const command = process.platform === 'win32' ? 'powershell.exe' : join(root, 'bin/token-speed-macos');
const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'native/overlay.ps1'), '-Headless'] : ['--headless'];
test('native helpers own a single display, hand over ownership and exit on stdin EOF', { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'token-speed-native-'));
  const children = [];
  const diagnostics = [];
  t.signal.addEventListener('abort', () => { for (const child of children) child.kill(); });
  try {
    const owners = [];
    for (let i = 0; i < 2; i++) {
      const child = spawn(command, args, { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      children.push(child);
      let errors = ''; child.stderr.on('data', b => { errors += b; });
      diagnostics.push(() => errors);
      const lines = createInterface({ input: child.stdout });
      owners.push(Promise.race([once(lines, 'line'), once(child, 'exit').then(([code]) => { throw new Error(`Native exited before ownership (${code}): ${errors}`); })]));
      child.stdin.write(messageFor({ tps: 42, cacheHit: 80, activity: 'complete', speedFresh: true }) + '\n');
      if (i === 0) assert.equal((await owners[0])[0], 'display-owner');
    }
    let secondOwns = false; owners[1].then(() => { secondOwns = true; });
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(secondOwns, false);
    const firstExit = once(children[0], 'exit'); children[0].stdin.end(); assert.equal((await firstExit)[0], 0, diagnostics[0]());
    assert.equal((await owners[1])[0], 'display-owner');
    const secondExit = once(children[1], 'exit'); children[1].stdin.end(); assert.equal((await secondExit)[0], 0, diagnostics[1]());
  } finally { for (const child of children) child.kill(); await rm(home, { recursive: true, force: true }); }
});
test('the native text control accepts and confirms successive metric updates', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'token-speed-text-'));
  const child = spawn(command, args, { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.signal.addEventListener('abort', () => child.kill());
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let layout, initial;
  lines.on('line', line => {
    if (line.startsWith('display-layout\t')) layout = JSON.parse(line.slice('display-layout\t'.length));
  });
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  async function displayed() {
    while (true) {
      const row = await iterator.next();
      assert.equal(row.done, false, errors);
      if (row.value.startsWith('display-text\t')) return row.value.slice('display-text\t'.length);
    }
  }
  try {
    for (const state of [
      { tps: 33, cacheHit: 98.4, activity: 'generating', speedFresh: false },
      { tps: 33, cacheHit: 98.4, activity: 'generating', speedFresh: true },
      { tps: 33, cacheHit: 98.4, activity: 'tool', speedFresh: false },
      { tps: 33, cacheHit: 98.4, activity: 'complete', speedFresh: false },
      { tps: 33, cacheHit: 98.4, activity: 'idle', speedFresh: false },
      ...[33, 146, 1079].map(tps => ({ tps, cacheHit: 98.4, activity: 'complete', speedFresh: true })),
      { activity: 'generating' }, { activity: 'idle' },
    ]) {
      child.stdin.write(messageFor(state) + '\n');
      assert.equal(await displayed(), textFor(state));
      assert.equal(layout.iconCount, 2);
      if (process.platform === 'darwin') assert.equal(layout.fullScreenSupport, true);
      assert.ok(Math.max(...layout.digitWidths) - Math.min(...layout.digitWidths) < 0.05, 'digits must be equally wide');
      assert.ok(Math.abs(layout.speedBaseline - layout.unitBaseline) <= 0.6, 'numbers and units must share a baseline');
      assert.ok(layout.fontSize >= (process.platform === 'win32' ? 9 : 11));
      assert.equal(layout.activity, state.activity);
      assert.equal(layout.speedFresh, state.speedFresh === true);
      assert.equal(layout.muted, state.activity === 'tool' || !state.speedFresh);
      if (state.activity !== 'generating') { assert.equal(layout.animating, false); assert.equal(layout.pulseAlpha, 1); }
      assert.ok(Math.abs(layout.unitX-layout.speedX-layout.speedWidth) < 1, 'unit must follow the measured number without a reserved gap');
      assert.ok(layout.speedX-layout.iconEnd <= 8, 'the number must sit next to the gauge');
      assert.ok(Math.abs(layout.iconCenter-layout.textCenter) <= 0.6, 'icons must align to the text visual centre');
      const columns = [layout.unitX, layout.speedGroupEnd, layout.cacheGroupX, layout.cacheX, layout.cacheWidth];
      if (!initial) initial = columns; else assert.deepEqual(columns, initial, 'unit, separator and cache columns must not move as the speed gains digits');
    }
    const metrics = new Usage();
    const model = (start, end, type = 'AgentMessage') => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type }, started_at_ms: start, completed_at_ms: end } });
    const usage = (n, cached = n*80, output = 20) => ({ type: 'token_usage_record', payload: {
      usage: { output_tokens: output, reasoning_output_tokens: 0 },
      thread_token_usage: { input_tokens: n*100, cached_input_tokens: cached, output_tokens: n*20, total_tokens: n*120 },
    } });
    metrics.ingest(model(0, 2000)); metrics.ingest(usage(1));
    child.stdin.write(messageFor(metrics.snapshot())+'\n');
    assert.equal(await displayed(), '10 t/s   ·   会话缓存 80.0%'); assert.equal(layout.muted, false);
    metrics.ingest(model(3000, 3832, 'Reasoning'));
    metrics.ingest({ type: 'response_item', payload: { type: 'function_call', call_id: 'a' } }); metrics.ingest(usage(2, 140));
    child.stdin.write(messageFor(metrics.snapshot())+'\n');
    assert.equal(await displayed(), '10 t/s   ·   会话缓存 70.0%'); assert.equal(layout.muted, true);
    metrics.ingest({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'a' } });
    metrics.ingest(model(5000, 7000)); metrics.ingest(usage(3, 240, 60));
    child.stdin.write(messageFor(metrics.snapshot())+'\n');
    assert.equal(await displayed(), '30 t/s   ·   会话缓存 80.0%'); assert.equal(layout.muted, false);
    const pulses = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 210));
      const state = { tps: 33+i%2, cacheHit: 98.4, activity: 'generating', speedFresh: false };
      child.stdin.write(messageFor(state) + '\n');
      assert.equal(await displayed(), textFor(state));
      if (layout.animating) pulses.push(layout.pulseAlpha);
    }
    if (pulses.length) assert.ok(Math.max(...pulses)-Math.min(...pulses) > 0.2, 'the rendered gauge must actually breathe while generation is active');
    child.stdin.write('33 t/s   ·   会话缓存 98.4%\tinvalid\t1\n');
    assert.equal(await displayed(), ''); assert.equal(layout.activity, 'idle'); assert.equal(layout.animating, false);
    const exited = once(child, 'exit'); child.stdin.end(); assert.equal((await exited)[0], 0, errors);
  } finally { child.kill(); lines.close(); await rm(home, { recursive: true, force: true }); }
});
