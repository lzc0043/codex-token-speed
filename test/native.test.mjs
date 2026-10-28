import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      child.stdin.write('42 t/s   ·   会话缓存 80.0%\n');
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
    for (const text of ['41 t/s   ·   会话缓存 97.0%', '146 t/s   ·   会话缓存 97.0%', '1079 t/s   ·   会话缓存 99.8%', '']) {
      child.stdin.write(text + '\n');
      assert.equal(await displayed(), text);
      assert.equal(layout.iconCount, 2);
      assert.ok(Math.max(...layout.digitWidths) - Math.min(...layout.digitWidths) < 0.05, 'digits must be equally wide');
      assert.ok(Math.abs(layout.speedBaseline - layout.unitBaseline) <= 0.6, 'numbers and units must share a baseline');
      assert.ok(layout.fontSize >= (process.platform === 'win32' ? 9 : 11));
      const columns = [layout.speedX, layout.speedWidth, layout.cacheGroupX, layout.cacheX, layout.cacheWidth];
      if (!initial) initial = columns; else assert.deepEqual(columns, initial, 'cache columns must not move as the speed gains digits');
    }
    const exited = once(child, 'exit'); child.stdin.end(); assert.equal((await exited)[0], 0, errors);
  } finally { child.kill(); lines.close(); await rm(home, { recursive: true, force: true }); }
});
