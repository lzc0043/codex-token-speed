import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export function textFor(state) {
  if (!Number.isFinite(state.tps) && !Number.isFinite(state.cacheHit)) return '';
  const speed = Number.isFinite(state.tps) ? state.tps.toFixed(0) : '--';
  const cache = Number.isFinite(state.cacheHit) ? `${state.cacheHit.toFixed(1)}%` : '--';
  return `${speed} t/s   ·   会话缓存 ${cache}`;
}

export function startDisplay(report, onState = () => {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let command, args;
  if (process.platform === 'darwin') { command = join(root, 'bin/token-speed-macos'); args = []; }
  else if (process.platform === 'win32') {
    command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(root, 'native/overlay.ps1')];
  } else throw new Error('Only macOS and Windows are supported');
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (line === 'display-owner') onState({ overlay: 'running', overlayOwner: true });
    else if (line === 'display-visible') onState({ overlayVisible: true });
    else if (line === 'display-hidden') onState({ overlayVisible: false });
    else if (line.startsWith('display-text\t')) onState({ displayedText: line.slice('display-text\t'.length) });
    else if (line.startsWith('display-layout\t')) {
      try { onState({ displayLayout: JSON.parse(line.slice('display-layout\t'.length)) }); } catch { report('Invalid native layout report'); }
    }
  });
  child.stdin.on('error', () => {});
  child.stderr.on('data', bytes => report(bytes.toString().slice(0, 1000)));
  child.on('error', error => report(error.message));
  return child;
}
