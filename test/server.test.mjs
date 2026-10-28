import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.ok(initialized.result.capabilities.resources);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tool = (await rpc(3, 'tools/list')).result.tools[0]; assert.equal(tool.name, 'token_speed_status');
    const status = await rpc(4, 'tools/call', { name: tool.name, arguments: {} });
    assert.equal(JSON.parse(status.result.content[0].text).overlay, 'headless');
    assert.equal(status.result.structuredContent.overlay, 'headless');
    assert.equal(status.result.structuredContent.speedUpdatedAt, null);
    assert.equal(status.result.structuredContent.speedReason, 'no-sample');
    assert.equal(status.result.structuredContent.model, null);
    assert.equal((await rpc(5, 'tools/call', { name: tool.name, arguments: { command: 'bad' } })).error.code, -32602);
    child.stdin.write('{bad json}\n'); assert.equal(JSON.parse((await iterator.next()).value).error.code, -32700);
    assert.equal((await rpc(6, 'unknown')).error.code, -32601);
    const tools = (await rpc(7, 'tools/list')).result.tools;
    const panel = tools.find(t => t.name === 'token_speed_panel');
    assert.deepEqual(panel._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
    assert.equal(tool._meta?.ui?.resourceUri, undefined);
    const resources = (await rpc(8, 'resources/list')).result.resources;
    assert.equal(resources[0].uri, panel._meta.ui.resourceUri);
    const resource = (await rpc(9, 'resources/read', { uri: resources[0].uri })).result.contents[0];
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.text, /ui\/initialize/); assert.match(resource.text, /token_speed_status/);
    assert.deepEqual(resource._meta.ui.csp.connectDomains, []);
    assert.equal((await rpc(10, 'resources/read', { uri: 'file:///auth.json' })).error.code, -32602);
    assert.equal((await rpc(11, 'tools/call', { name: panel.name, arguments: {} })).result.structuredContent.overlay, 'headless');
    const exited = once(child, 'exit'); child.stdin.end();
    assert.equal((await exited)[0], 0); assert.equal(stderr, '');
  } finally { child.kill(); lines.close(); }
});

test('panel mode serves data without launching a native display process', { timeout: 8000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-speed-panel-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/server.mjs', import.meta.url)), '--panel'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout }); const iterator = lines[Symbol.asyncIterator]();
  child.stderr.resume();
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'panel-test', version: '1' } } })+'\n');
    assert.ok(JSON.parse((await iterator.next()).value).result);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'token_speed_status', arguments: {} } })+'\n');
    const state = JSON.parse((await iterator.next()).value).result.structuredContent;
    assert.equal(state.displayMode, 'panel'); assert.equal(state.overlay, 'disabled'); assert.equal(state.overlayOwner, undefined);
    assert.equal(state.speedUpdatedAt, null); assert.equal(state.speedReason, 'no-sample'); assert.equal(state.model, null);
    const exited = once(child, 'exit'); child.stdin.end(); assert.equal((await exited)[0], 0);
  } finally { child.kill(); lines.close(); await rm(home, { recursive: true, force: true }); }
});
