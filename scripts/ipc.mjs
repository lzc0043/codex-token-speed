import { connect } from 'node:net';
import { lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { threadPattern } from './metrics.mjs';

// Protocol reference: soleillevant0125/codex-token-overlay (MIT); see THIRD_PARTY.md.
export class Router {
  windows = new Map();
  ingest(frame) {
    if (frame?.type !== 'broadcast' || typeof frame.params !== 'object' || !frame.params) return;
    const p = frame.params;
    if (frame.method === 'client-status-changed' && p.status === 'disconnected') {
      for (const key of this.windows.keys()) if (key.startsWith(`${p.clientId}\0`)) this.windows.delete(key);
    }
    if (frame.method !== 'thread-stream-following-changed' || typeof frame.sourceClientId !== 'string' ||
        typeof p.hostId !== 'string' || !threadPattern.test(p.conversationId ?? '') || typeof p.following !== 'boolean') return;
    const key = `${frame.sourceClientId}\0${p.hostId}`;
    if (p.following) this.windows.set(key, { threadId: p.conversationId, local: p.hostId === 'local' });
    else if (this.windows.get(key)?.threadId === p.conversationId) this.windows.delete(key);
  }
  snapshot() {
    if (this.windows.size > 1) return { threadId: null, status: 'multiple-windows' };
    const active = [...this.windows.values()][0];
    return active?.local ? { threadId: active.threadId, status: 'connected' } :
      { threadId: null, status: active ? 'remote-session' : 'waiting-session' };
  }
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
  constructor(home) {
    this.router = new Router(); this.state = 'disconnected'; this.stopped = false; this.index = 0;
    this.candidates = process.platform === 'win32' ? ['\\\\.\\pipe\\codex-ipc'] : [...new Set([
      process.env.CODEX_IPC_SOCKET, join(home, 'ipc/ipc.sock'),
      join(tmpdir(), `codex-ipc/ipc-${process.getuid()}.sock`), join(tmpdir(), 'codex-ipc/ipc.sock'),
      `/tmp/codex-ipc/ipc-${process.getuid()}.sock`, '/tmp/codex-ipc/ipc.sock',
    ].filter(Boolean))];
    this.open();
  }
  async open() {
    if (this.stopped) return;
    const path = this.candidates[this.index++ % this.candidates.length];
    try {
      if (process.platform !== 'win32') {
        const [s, d] = await Promise.all([lstat(path), lstat(dirname(path))]);
        if (!s.isSocket() || s.uid !== process.getuid() || !d.isDirectory() || d.uid !== process.getuid() || (d.mode & 0o022)) throw new Error('Unsafe IPC owner or directory');
      }
      if (this.stopped) return;
      const parser = new Frames();
      const socket = this.socket = connect(path);
      socket.setTimeout(3000, () => { if (this.state !== 'connected') socket.destroy(); });
      socket.on('connect', () => {
        this.state = 'connected'; socket.setTimeout(0);
        socket.write(frameJSON({ type: 'request', requestId: randomUUID(), sourceClientId: 'initializing-client', version: 0,
          method: 'initialize', params: { clientType: 'codex-token-speed' } }));
      });
      socket.on('data', bytes => { try { parser.push(bytes, frame => this.router.ingest(frame)); } catch { socket.destroy(); } });
      socket.on('error', () => {});
      socket.on('close', () => { this.router = new Router(); this.state = 'disconnected'; this.retry(); });
    } catch { this.retry(); }
  }
  retry() { if (!this.stopped) this.timer = setTimeout(() => this.open(), 1000); }
  snapshot() { return this.state === 'connected' ? this.router.snapshot() : { threadId: null, status: 'disconnected' }; }
  close() { this.stopped = true; clearTimeout(this.timer); this.socket?.destroy(); }
}
