import { describe, expect, it } from 'vitest';
import {
  createPalette,
  formatCompact,
  formatDateTime,
  formatRelativeTime,
  formatUsd,
  prettyCwd,
  renderTable,
  truncate,
} from '../../src/cli/format.js';

describe('truncate', () => {
  it('collapses whitespace and leaves short text alone', () => {
    expect(truncate('  hello\n   world  ', 40)).toBe('hello world');
  });

  it('cuts long text and appends an ellipsis within the limit', () => {
    const out = truncate('abcdefghij', 5);
    expect(out).toBe('abcd…');
    expect(out.length).toBe(5);
  });

  it('handles a zero limit', () => {
    expect(truncate('anything', 0)).toBe('');
  });
});

describe('formatUsd', () => {
  it('formats zero and sub-cent values', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.000012)).toBe('$0.000012');
    expect(formatUsd(0.187319304)).toBe('$0.1873');
    expect(formatUsd(Number.NaN)).toBe('$0');
    expect(formatUsd(-1)).toBe('$0');
  });
});

describe('formatCompact', () => {
  it('compacts thousands and millions', () => {
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(1_234)).toBe('1.2K');
    expect(formatCompact(321_300)).toBe('321.3K');
    expect(formatCompact(1_500_000)).toBe('1.5M');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-11-03T10:00:00.000Z');

  it('describes recent timestamps', () => {
    expect(formatRelativeTime(now, now)).toBe('just now');
    expect(formatRelativeTime(now - 1_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 12_000, now)).toBe('12s ago');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d ago');
  });

  it('falls back to a date for old timestamps and handles invalid input', () => {
    expect(formatRelativeTime(now - 30 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatRelativeTime(0, now)).toBe('unknown');
  });
});

describe('formatDateTime', () => {
  it('renders a local YYYY-MM-DD HH:MM:SS string', () => {
    expect(formatDateTime(Date.parse('2026-11-03T10:00:00.000Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    expect(formatDateTime(0)).toBe('unknown');
  });
});

describe('renderTable', () => {
  it('pads columns and honours right alignment', () => {
    const out = renderTable(['A', 'N'], [['x', '1'], ['long', '22']], ['left', 'right']);
    const lines = out.split('\n');
    expect(lines[0]).toBe('A      N');
    expect(lines[1]).toBe('x      1');
    expect(lines[2]).toBe('long  22');
  });
});

describe('prettyCwd', () => {
  it('shortens the home directory and passes other paths through', () => {
    expect(prettyCwd('/home/me', '/home/me')).toBe('~');
    expect(prettyCwd('/home/me/code/app', '/home/me')).toBe('~/code/app');
    expect(prettyCwd('/srv/app', '/home/me')).toBe('/srv/app');
    expect(prettyCwd(null, '/home/me')).toBe('-');
  });
});

describe('createPalette', () => {
  it('is a no-op when colour is disabled', () => {
    const p = createPalette(false);
    expect(p.green('ok')).toBe('ok');
    expect(p.enabled).toBe(false);
  });

  it('wraps and resets when colour is enabled', () => {
    const p = createPalette(true);
    expect(p.green('ok')).toContain('\u001b[');
    expect(p.green('ok')).toContain('ok');
    expect(p.green('ok')).toContain('\u001b[0m');
  });
});
