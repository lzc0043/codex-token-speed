import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const LIMIT = 2 * 1024 * 1024;
export const threadPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const modelItems = new Set(['Reasoning', 'AgentMessage']);
const toolItems = new Set(['CommandExecution', 'McpToolCall', 'DynamicToolCall', 'FileChange', 'WebSearch', 'ImageGeneration', 'ToolCall']);

export class Usage {
  constructor() { this.reset(null); }
  reset(turnId) {
    Object.assign(this, { turnId, completed: false, activity: turnId ? 'generating' : 'idle', speedFresh: false,
      tools: new Set(), runningTools: new Set(), tps: this.tps ?? null, cache: this.cache ?? null, previousEnd: null, seen: this.seen ?? new Set() });
    this.clearWindow();
  }
  clearWindow() { this.first = null; this.last = null; this.toolStart = null; }
  ingest(record) {
    const p = record?.payload;
    if (!p || typeof p !== 'object') return;
    if (record.type === 'turn_context' || (record.type === 'event_msg' && p.type === 'task_started')) {
      if (typeof p.turn_id !== 'string') return;
      if (this.turnId !== p.turn_id) this.reset(p.turn_id);
      return;
    }
    if (this.turnId && p.turn_id && p.turn_id !== this.turnId) return;
    if (record.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(p.type)) {
      if (p.turn_id === this.turnId) {
        this.completed = true;
        this.activity = p.type === 'task_complete' ? 'complete' : 'idle';
        this.tools.clear();
        this.runningTools.clear();
      }
      return;
    }
    if (record.type === 'response_item' && !this.completed && typeof p.call_id === 'string' && p.call_id.length <= 512) {
      if (['function_call', 'custom_tool_call'].includes(p.type)) {
        if (this.tools.size < 256) this.tools.add(p.call_id);
        this.activity = 'tool'; this.speedFresh = false;
      } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type) && this.tools.delete(p.call_id)) {
        this.activity = this.tools.size || this.runningTools.size ? 'tool' : 'generating'; this.speedFresh = false;
      }
      return;
    }
    if (record.type === 'event_msg' && ['item_started', 'item_completed'].includes(p.type)) {
      if (this.turnId && p.turn_id && p.turn_id !== this.turnId) return;
      if (!this.turnId && p.turn_id) this.turnId = p.turn_id;
      const start = number(p.started_at_ms), end = number(p.completed_at_ms), type = p.item?.type;
      if (!this.completed && toolItems.has(type) && typeof p.item?.id === 'string') {
        if (p.type === 'item_started' && this.runningTools.size < 256) { this.runningTools.add(p.item.id); this.speedFresh = false; }
        else if (p.type === 'item_completed') this.runningTools.delete(p.item.id);
        this.activity = this.tools.size || this.runningTools.size ? 'tool' : 'generating';
      }
      if (start === null || (this.previousEnd !== null && start < this.previousEnd)) return;
      if (modelItems.has(type)) {
        if (!this.completed && !this.tools.size && !this.runningTools.size) this.activity = 'generating';
        if (!this.completed && this.first === null) this.speedFresh = false;
        this.first = this.first === null ? start : Math.min(this.first, start);
        if (end !== null && end >= start) this.last = Math.max(this.last ?? end, end);
      } else if (toolItems.has(type) && this.first !== null && start >= this.first) {
        this.toolStart = this.toolStart === null ? start : Math.min(this.toolStart, start);
      }
      return;
    }
    let usage, cumulative, upgrade = false;
    if (record.type === 'token_usage_record') {
      if (this.turnId && p.turn_id && p.turn_id !== this.turnId) return;
      usage = p.usage;
      cumulative = p.thread_token_usage;
      upgrade = !this.modernSeen && this.lastCarrier === 'legacy' && this.first === null;
      this.modernSeen = true;
    } else if (record.type === 'event_msg' && p.type === 'token_count') {
      // These carriers may have different cumulative scope after forks/resumes.
      if (this.modernSeen) return;
      usage = p.info?.last_token_usage;
      cumulative = p.info?.total_token_usage;
    } else return;
    if (!usage || !cumulative) return;
    const counts = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens'].map(k => number(cumulative[k]));
    if (counts.some(n => n === null)) { this.tps = null; this.cache = null; this.speedFresh = false; this.clearWindow(); return; }
    const key = counts.join(':');
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
    const [input, cached] = counts;
    const output = number(usage.output_tokens);
    this.cache = input > 0 && cached !== null && cached <= input ? cached / input * 100 : null;
    const request = JSON.stringify(['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'].map(k => usage[k] ?? null));
    const sameLegacyRequest = upgrade && request === this.lastRequest;
    this.lastCarrier = record.type === 'token_usage_record' ? 'modern' : 'legacy';
    this.lastRequest = request;
    if (sameLegacyRequest) return;
    const end = this.last === null && this.toolStart === null ? null : Math.max(this.last ?? 0, this.toolStart ?? 0);
    const elapsed = end === null || this.first === null ? null : end - this.first;
    this.tps = elapsed > 0 && output > 0 ? output * 1000 / elapsed : null;
    if (!Number.isFinite(this.tps)) this.tps = null;
    this.speedFresh = this.tps !== null;
    if (end !== null) this.previousEnd = end;
    this.clearWindow();
  }
  snapshot() { return { tps: this.tps, cacheHit: this.cache, completed: this.completed, activity: this.activity, speedFresh: this.speedFresh }; }
}

export class SessionReader {
  constructor(home) { this.home = home; this.paths = new Map(); this.files = new Map(); this.scanned = 0; }
  async readSelected(route, snapshot) {
    const metrics = route.threadId ? await this.read(route.threadId) : { tps: null, cacheHit: null };
    const latest = snapshot();
    return route.threadId === latest.threadId && route.status === latest.status ? metrics : null;
  }
  async locate(threadId) {
    if (!threadPattern.test(threadId)) return null;
    if (this.paths.has(threadId)) return this.paths.get(threadId);
    if (Date.now() - this.scanned < 500) return null;
    this.scanned = Date.now();
    for (const dir of ['sessions', 'archived_sessions']) {
      let names;
      try { names = await readdir(join(this.home, dir), { recursive: true }); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      for (const name of names) {
        const id = name.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1];
        if (id && threadPattern.test(id)) this.paths.set(id, join(this.home, dir, name));
      }
    }
    return this.paths.get(threadId) ?? null;
  }
  async read(threadId) {
    const path = await this.locate(threadId);
    if (!path) return { tps: null, cacheHit: null, completed: false };
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      let entry = this.files.get(path);
      if (!entry || entry.ino !== stat.ino || stat.size < entry.offset || stat.size - entry.offset > LIMIT || (stat.size === entry.offset && entry.mtime !== stat.mtimeMs)) {
        const offset = Math.max(0, stat.size - LIMIT);
        entry = { ino: stat.ino, offset, mtime: stat.mtimeMs, pending: Buffer.alloc(0), drop: offset > 0, usage: new Usage() };
        this.files.set(path, entry);
        if (this.files.size > 8) this.files.delete(this.files.keys().next().value);
      }
      const bytes = Buffer.alloc(Math.min(LIMIT, stat.size - entry.offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, entry.offset);
      entry.offset += bytesRead;
      entry.mtime = stat.mtimeMs;
      const buffer = Buffer.concat([entry.pending, bytes.subarray(0, bytesRead)]);
      const end = buffer.lastIndexOf(10);
      if (end >= 0) {
        const lines = buffer.subarray(0, end).toString('utf8').split('\n');
        if (entry.drop) { lines.shift(); entry.drop = false; }
        for (const line of lines) {
          try { entry.usage.ingest(JSON.parse(line)); } catch { /* JSONL can end mid-write or contain an older malformed line. */ }
        }
      }
      entry.pending = buffer.subarray(end + 1);
      if (entry.pending.length > LIMIT) { entry.pending = Buffer.alloc(0); entry.drop = true; }
      return entry.usage.snapshot();
    } finally { await handle.close(); }
  }
}
