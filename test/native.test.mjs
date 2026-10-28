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
test('native helpers own a single display, hand over ownership and exit on stdin EOF', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-speed-native-'));
  const command = process.platform === 'win32' ? 'powershell.exe' : join(root, 'bin/token-speed-macos');
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'native/overlay.ps1')] : [];
  const children = [];
  try {
    const owners = [];
    for (let i = 0; i < 2; i++) {
      const child = spawn(command, args, { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      children.push(child);
      let errors = ''; child.stderr.on('data', b => { errors += b; });
      child.on('exit', code => assert.equal(code, 0, errors));
      const lines = createInterface({ input: child.stdout });
      owners.push(once(lines, 'line'));
      child.stdin.write('≈ 42 t/s   ·   缓存命中 80.0%\n');
      if (i === 0) assert.equal((await owners[0])[0], 'display-owner');
    }
    let secondOwns = false; owners[1].then(() => { secondOwns = true; });
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(secondOwns, false);
    const firstExit = once(children[0], 'exit'); children[0].stdin.end(); await firstExit;
    assert.equal((await owners[1])[0], 'display-owner');
    const secondExit = once(children[1], 'exit'); children[1].stdin.end(); await secondExit;
  } finally { for (const child of children) child.kill(); await rm(home, { recursive: true, force: true }); }
});
