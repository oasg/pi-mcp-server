/** Small, dependency-free formatting helpers for the `pi-sessions` CLI. */

const ANSI = {
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  reset: '\u001b[0m',
} as const;

export interface Palette {
  readonly enabled: boolean;
  dim(text: string): string;
  bold(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
}

export function createPalette(enabled: boolean): Palette {
  const paint = (code: string, text: string): string =>
    enabled ? `${code}${text}${ANSI.reset}` : text;
  return {
    enabled,
    dim: (text) => paint(ANSI.dim, text),
    bold: (text) => paint(ANSI.bold, text),
    green: (text) => paint(ANSI.green, text),
    yellow: (text) => paint(ANSI.yellow, text),
    red: (text) => paint(ANSI.red, text),
    cyan: (text) => paint(ANSI.cyan, text),
  };
}

/** Collapse whitespace and cut to `max` characters (including the ellipsis). */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (max <= 0) return '';
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '$0';
  if (value === 0) return '$0';
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

/** 1234 -> "1.2K", 1500000 -> "1.5M". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const delta = now - timestamp;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown';
  if (delta < 0) return 'just now';
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return formatDate(timestamp);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local wall-clock "YYYY-MM-DD HH:MM:SS". */
export function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown';
  const d = new Date(timestamp);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local "HH:MM:SS", used for the live event prefix. */
export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export type Align = 'left' | 'right';

/**
 * Render a plain ASCII table with two-space gutters. Cell contents are expected
 * to be single-line already; widths are derived from the data, so callers
 * should truncate long values themselves.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  aligns?: readonly Align[],
): string {
  const columns = headers.length;
  const widths: number[] = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < columns; i += 1) {
      const cell = row[i] ?? '';
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    }
  }

  const pad = (text: string, width: number, align: Align): string =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => pad(cell, widths[i] ?? 0, aligns?.[i] ?? 'left'))
      .join('  ')
      .replace(/\s+$/, '');

  const out = [line(headers.map((h) => h))];
  for (const row of rows) {
    out.push(line(headers.map((_, i) => row[i] ?? '')));
  }
  return out.join('\n');
}

/** Shorten the user's home directory to `~` for display. */
export function prettyCwd(cwd: string | null, home: string): string {
  if (cwd === null || cwd === '') return '-';
  if (cwd === home) return '~';
  if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}
