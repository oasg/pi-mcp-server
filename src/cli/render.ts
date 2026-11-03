import { type RawEntry, textOfContent, toolCallsOf } from '../sessions/inspect.js';
import { formatClock, truncate, type Palette } from './format.js';

export interface RenderOptions {
  readonly palette: Palette;
  /** Print full text/tool output instead of truncating. */
  readonly full?: boolean;
  /** Include `thinking` blocks (hidden by default). */
  readonly thinking?: boolean;
  /** Max characters for message text. Defaults to 400, or 200 while watching. */
  readonly textLimit?: number;
  /** Max characters for tool output. Defaults to 200. */
  readonly resultLimit?: number;
}

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
      blocks.push(block as Record<string, unknown>);
    }
  }
  return blocks;
}

function timestampOf(entry: RawEntry): number | null {
  if (typeof entry.timestamp !== 'string') return null;
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

function argsPreview(args: unknown, limit: number): string {
  if (args === undefined) return '';
  if (typeof args === 'string') return truncate(args, limit);
  try {
    return truncate(JSON.stringify(args), limit);
  } catch {
    return '…';
  }
}

/**
 * Render one JSONL entry as human-readable lines. Returns `null` for entries
 * that are not worth showing (session header, model changes, system prompts).
 */
export function renderEntry(entry: RawEntry, opts: RenderOptions): string | null {
  if (entry.type !== 'message') return null;
  const message = entry.message;
  if (message === undefined) return null;
  const role = message.role;
  if (role === 'system' || role === undefined) return null;

  const p = opts.palette;
  const textLimit = opts.full === true ? Number.MAX_SAFE_INTEGER : (opts.textLimit ?? 400);
  const resultLimit = opts.full === true ? Number.MAX_SAFE_INTEGER : (opts.resultLimit ?? 200);
  const ts = timestampOf(entry);
  const prefix = ts === null ? '[--:--:--]' : `[${formatClock(ts)}]`;

  if (role === 'user') {
    const text = textOfContent(message.content);
    return `${prefix} ${p.bold('user:')} ${truncate(text, textLimit)}`;
  }

  if (role === 'assistant') {
    const lines: string[] = [];
    for (const block of blocksOf(message.content)) {
      const type = block['type'];
      if (type === 'text' && typeof block['text'] === 'string' && block['text'].trim() !== '') {
        lines.push(`${prefix} ${p.bold('assistant:')} ${truncate(block['text'], textLimit)}`);
      } else if (type === 'thinking' && opts.thinking === true) {
        const thinking = typeof block['thinking'] === 'string' ? block['thinking'] : '';
        if (thinking.trim() !== '') {
          lines.push(`${prefix} ${p.dim(`thinking: ${truncate(thinking, textLimit)}`)}`);
        }
      }
    }
    for (const call of toolCallsOf(message)) {
      lines.push(`${prefix}   ${p.dim('└')} ${p.cyan(call.name)}(${argsPreview(call.args, resultLimit)})`);
    }
    if (lines.length === 0) {
      lines.push(`${prefix} ${p.bold('assistant:')} ${p.dim('(empty)')}`);
    }
    return lines.join('\n');
  }

  if (role === 'toolResult') {
    const name = typeof message.toolName === 'string' ? message.toolName : 'tool';
    const ok = message.isError === true ? p.red('✗') : p.green('✓');
    const duration = typeof message.durationMs === 'number' ? ` ${message.durationMs}ms` : '';
    const text = textOfContent(message.content);
    const body = truncate(text, resultLimit);
    return `${prefix} ${p.dim('tool:')} ${ok} ${name}${duration}${body === '' ? '' : ` · ${body}`}`;
  }

  return null;
}

export interface StatusStyle {
  readonly text: string;
  readonly colored: string;
}

export function styleStatus(status: string, palette: Palette): StatusStyle {
  switch (status) {
    case 'running':
      return { text: status, colored: palette.green(status) };
    case 'interrupted':
      return { text: status, colored: palette.yellow(status) };
    case 'unreadable':
      return { text: status, colored: palette.red(status) };
    case 'empty':
    case 'idle':
      return { text: status, colored: palette.dim(status) };
    default:
      return { text: status, colored: status };
  }
}
