import { connect } from 'node:net';
import { lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { threadPattern } from './metrics.mjs';

// Protocol reference: soleillevant0125/codex-token-overlay (MIT); see THIRD_PARTY.md.
export class Router {
  windows = new Map();
  revision = 0;
  ingest(frame) {
    if (frame?.type !== 'broadcast' || typeof frame.params !== 'object' || !frame.params) return;
    const p = frame.params;
    if (frame.method === 'client-status-changed' && p.status === 'disconnected') {
      for (const key of this.windows.keys()) if (key.startsWith(`${p.clientId}\0`)) { this.windows.delete(key); this.revision++; }
    }
    if (frame.method !== 'thread-stream-following-changed' || typeof frame.sourceClientId !== 'string' ||
        typeof p.hostId !== 'string' || !threadPattern.test(p.conversationId ?? '') || typeof p.following !== 'boolean') return;
    const key = `${frame.sourceClientId}\0${p.hostId}`;
    if (p.following && this.windows.get(key)?.threadId !== p.conversationId) {
      this.windows.set(key, { threadId: p.conversationId, local: p.hostId === 'local' }); this.revision++;
    } else if (!p.following && this.windows.get(key)?.threadId === p.conversationId) {
      this.windows.delete(key); this.revision++;
    }
  }
  snapshot() {
    if (this.windows.size > 1) return { threadId: null, status: 'multiple-windows' };
    const active = [...this.windows.values()][0];
    return active?.local ? { threadId: active.threadId, status: 'connected' } :
      { threadId: null, status: active ? 'remote-session' : 'waiting-session' };
  }
}

async function validateSocket(path) {
  if (process.platform === 'win32') return;
  const [s, d] = await Promise.all([lstat(path), lstat(dirname(path))]);
  if (!s.isSocket() || s.uid !== process.getuid() || !d.isDirectory() || d.uid !== process.getuid() || (d.mode & 0o022)) throw new Error('Unsafe IPC owner or directory');
}

export function frameJSON(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class Frames {
  pending = Buffer.alloc(0);
  push(bytes, receive) {
    this.pending = Buffer.concat([this.pending, bytes]);
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (!length || length > 4 * 1024 * 1024) throw new Error('IPC frame exceeds safe limit');
      if (this.pending.length < length + 4) return;
      const body = this.pending.subarray(4, length + 4); this.pending = this.pending.subarray(length + 4);
      try { receive(JSON.parse(body.toString('utf8'))); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
}

export class ActiveSession {
  constructor(home, onChange = () => {}) {
    this.onChange = onChange;
    this.router = new Router(); this.state = 'disconnected'; this.stopped = false; this.index = 0;
    this.candidates = process.platform === 'win32' ? [process.env.CODEX_IPC_SOCKET || '\\\\.\\pipe\\codex-ipc'] : [...new Set([
      process.env.CODEX_IPC_SOCKET, join(home, 'ipc/ipc.sock'),
      join(tmpdir(), `codex-ipc/ipc-${process.getuid()}.sock`), join(tmpdir(), 'codex-ipc/ipc.sock'),
      `/tmp/codex-ipc/ipc-${process.getuid()}.sock`, '/tmp/codex-ipc/ipc.sock',
    ].filter(Boolean))];
    this.open();
    this.refreshTimer = setInterval(() => this.refresh(), 500);
  }
  notify() {
    const route = this.snapshot(), key = `${route.status}:${route.threadId ?? ''}`;
    if (key !== this.reportedRoute) { this.reportedRoute = key; this.onChange(); }
  }
  async open() {
    if (this.stopped) return;
    const path = this.candidates[this.index++ % this.candidates.length];
    try {
      await validateSocket(path);
      if (this.stopped) return;
      const parser = new Frames();
      const socket = this.socket = connect(path);
      socket.setTimeout(3000, () => { if (this.state !== 'connected') socket.destroy(); });
      socket.on('connect', () => {
        this.state = 'connected'; this.path = path; socket.setTimeout(0);
        socket.write(frameJSON({ type: 'request', requestId: randomUUID(), sourceClientId: 'initializing-client', version: 0,
          method: 'initialize', params: { clientType: 'codex-token-speed' } }));
      });
      socket.on('data', bytes => { try { parser.push(bytes, frame => this.router.ingest(frame)); this.notify(); } catch { socket.destroy(); } });
      socket.on('error', () => {});
      socket.on('close', () => { this.router = new Router(); this.state = 'disconnected'; if (!this.stopped) this.notify(); this.retry(); });
    } catch { this.retry(); }
  }
  async refresh() {
    if (this.stopped || this.state !== 'connected' || this.refreshSocket || this.refreshPending) return;
    this.refreshPending = true;
    try {
      await validateSocket(this.path);
      if (this.stopped) return;
      const original = this.router, main = this.socket, revision = original.revision, latest = new Router(), frames = new Frames();
      const socket = this.refreshSocket = connect(this.path);
      let settle, initialized = false;
      const deadline = setTimeout(() => socket.destroy(), 1500);
      socket.on('connect', () => socket.write(frameJSON({ type: 'request', requestId: randomUUID(), sourceClientId: 'initializing-client', version: 0,
        method: 'initialize', params: { clientType: 'codex-token-speed' } })));
      socket.on('data', bytes => {
        try {
          frames.push(bytes, frame => {
            if (frame.type === 'response' && frame.method === 'initialize' && typeof frame.result?.clientId === 'string') initialized = true;
            latest.ingest(frame);
          });
          if (!initialized) return;
          clearTimeout(settle);
          settle = setTimeout(() => {
            // A live selection event is newer than a snapshot being fetched.
            if (!this.stopped && this.state === 'connected' && this.socket === main && this.router === original && original.revision === revision) { this.router = latest; this.notify(); }
            socket.destroy();
          }, 50);
        } catch { socket.destroy(); }
      });
      socket.on('error', () => {});
      socket.on('close', () => { clearTimeout(settle); clearTimeout(deadline); if (this.refreshSocket === socket) this.refreshSocket = null; });
    } catch { /* The persistent connection continues serving until its own close event. */ }
    finally { this.refreshPending = false; }
  }
  retry() { if (!this.stopped) this.timer = setTimeout(() => this.open(), 1000); }
  snapshot() { return this.state === 'connected' ? this.router.snapshot() : { threadId: null, status: 'disconnected' }; }
  close() { this.stopped = true; clearTimeout(this.timer); clearInterval(this.refreshTimer); this.socket?.destroy(); this.refreshSocket?.destroy(); }
}
