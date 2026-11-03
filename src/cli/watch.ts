import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parseSessionContent, type RawEntry } from '../sessions/inspect.js';
import { formatClock, formatUsd, type Palette } from './format.js';
import { renderEntry } from './render.js';

export interface WatchOptions {
  readonly file: string;
  readonly mcpSessionId: string;
  /** Replay the whole transcript instead of just the last `tail` messages. */
  readonly fromStart: boolean;
  /** How many messages to print before following. Defaults to 10. */
  readonly tail: number;
  /** Emit raw JSONL entries instead of rendered text. */
  readonly json: boolean;
  readonly palette: Palette;
  readonly full?: boolean;
  readonly thinking?: boolean;
  /** Fallback polling interval; `fs.watch` events are still used. */
  readonly intervalMs: number;
  readonly write?: (line: string) => void;
}

function isTerminalAssistant(entry: RawEntry): boolean {
  if (entry.type !== 'message' || entry.message?.role !== 'assistant') return false;
  const stopReason = entry.message.stopReason;
  return typeof stopReason === 'string' && stopReason !== 'toolUse';
}

function costOf(entry: RawEntry): number {
  const total = entry.message?.usage?.cost?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

/**
 * Follow a transcript file and print new entries as pi appends them.
 *
 * Returns a `stop()` function. The caller keeps the process alive implicitly
 * because the polling interval is not unref'd.
 */
export function watchSession(opts: WatchOptions): () => void {
  const write = opts.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const renderOpts = {
    palette: opts.palette,
    ...(opts.full !== undefined ? { full: opts.full } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    textLimit: 200,
    resultLimit: 160,
  };

  const fd = fs.openSync(opts.file, 'r');
  const initialStat = fs.fstatSync(fd);
  const initialBuf = Buffer.allocUnsafe(initialStat.size);
  if (initialStat.size > 0) fs.readSync(fd, initialBuf, 0, initialStat.size, 0);
  const parsed = parseSessionContent(initialBuf.toString('utf8'));

  let turnCost = 0;
  let cumulativeCost = 0;
  let replaying = true;

  const emitDone = (): void => {
    const p = opts.palette;
    if (opts.json || replaying) return;
    write(
      `${p.dim(`[${formatClock(Date.now())}]`)} ${p.green('✓ done')} · turn ${formatUsd(turnCost)} · cumulative ${formatUsd(cumulativeCost)}`,
    );
  };

  const consume = (entry: RawEntry): void => {
    if (entry.type === 'message') {
      const role = entry.message?.role;
      if (role === 'user') turnCost = 0;
      if (role === 'assistant') {
        const cost = costOf(entry);
        turnCost += cost;
        if (!replaying) cumulativeCost += cost;
      }
    }

    if (opts.json) {
      write(JSON.stringify(entry));
      return;
    }

    if (entry.type === 'model_change') {
      const provider = entry.provider ?? '?';
      const modelId = entry.modelId ?? '?';
      write(`${opts.palette.dim(`[${formatClock(Date.now())}]`)} model → ${provider}:${modelId}`);
      return;
    }

    const rendered = renderEntry(entry, renderOpts);
    if (rendered !== null) write(rendered);
    if (isTerminalAssistant(entry)) emitDone();
  };

  for (const entry of parsed.entries) {
    const role = entry.message?.role;
    if (role === 'user') turnCost = 0;
    if (role === 'assistant') cumulativeCost += costOf(entry);
  }

  const visible = parsed.entries.filter(
    (entry) => entry.type === 'message' && entry.message?.role !== 'system',
  );
  const initial = opts.fromStart ? visible : visible.slice(-Math.max(0, opts.tail));
  if (!opts.json) {
    const p = opts.palette;
    write(
      `${p.bold(`watching ${opts.mcpSessionId}`)} ${p.dim(`(${opts.file})`)} ${p.dim('· Ctrl-C to stop')}`,
    );
  } else {
    process.stderr.write(`watching ${opts.mcpSessionId} (${opts.file})\n`);
  }
  for (const entry of initial) consume(entry);
  replaying = false;

  let offset = initialStat.size;
  let pending = parsed.partialLine;
  let decoder = new StringDecoder('utf8');
  let stopped = false;

  const handleLine = (line: string): void => {
    if (line.trim() === '') return;
    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      return;
    }
    if (typeof entry.type !== 'string') return;
    consume(entry);
  };

  const check = (): void => {
    if (stopped) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(opts.file);
    } catch {
      return;
    }
    if (stat.size < offset) {
      // Truncated or replaced: start over from the new beginning.
      offset = 0;
      pending = '';
      decoder = new StringDecoder('utf8');
    }
    if (stat.size === offset) return;
    const length = stat.size - offset;
    const buf = Buffer.allocUnsafe(length);
    try {
      fs.readSync(fd, buf, 0, length, offset);
    } catch {
      return;
    }
    offset += length;
    pending += decoder.write(buf);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(opts.file, () => check());
    watcher.on('error', () => {});
  } catch {
    watcher = null;
  }
  const interval = setInterval(check, Math.max(50, opts.intervalMs));

  return (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    if (watcher !== null) watcher.close();
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
  };
}
