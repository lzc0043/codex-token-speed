import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
test('standard stdio initialize, status query, invalid requests and EOF cleanup', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/server.mjs', import.meta.url)), '--headless'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout }); const iterator = lines[Symbol.asyncIterator]();
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  async function rpc(id, method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const row = await iterator.next(); assert.equal(row.done, false);
    const response = JSON.parse(row.value); assert.equal(response.id, id); return response;
  }
  try {
    assert.equal((await rpc(1, 'tools/list')).error.code, -32000);
    const initialized = await rpc(2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(initialized.result.protocolVersion, '2025-06-18');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tool = (await rpc(3, 'tools/list')).result.tools[0]; assert.equal(tool.name, 'token_speed_status');
    const status = await rpc(4, 'tools/call', { name: tool.name, arguments: {} });
    assert.equal(JSON.parse(status.result.content[0].text).overlay, 'headless');
    assert.equal((await rpc(5, 'tools/call', { name: tool.name, arguments: { command: 'bad' } })).error.code, -32602);
    child.stdin.write('{bad json}\n'); assert.equal(JSON.parse((await iterator.next()).value).error.code, -32700);
    assert.equal((await rpc(6, 'unknown')).error.code, -32601);
    const exited = once(child, 'exit'); child.stdin.end();
    assert.equal((await exited)[0], 0); assert.equal(stderr, '');
  } finally { child.kill(); lines.close(); }
});
