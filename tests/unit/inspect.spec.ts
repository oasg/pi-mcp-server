import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STALE_MS,
  discoverSessionFiles,
  parseSessionContent,
  readSessionFile,
  resolveSession,
  scanSessions,
  summarizeSession,
  type RawEntry,
} from '../../src/sessions/inspect.js';

const NOW = Date.parse('2026-11-03T10:00:00.000Z');
const SESSION_ID = 'aaaa1111-2222-3333-4444-555566667777';

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session',
    version: 3,
    id: 'pi-session-1',
    timestamp: at(-60_000),
    cwd: '/tmp/project',
    ...overrides,
  };
}

function modelChange(): Record<string, unknown> {
  return {
    type: 'model_change',
    id: 'm1',
    parentId: null,
    timestamp: at(-59_000),
    provider: 'openrouter',
    modelId: 'amazon/nova-micro-v1',
  };
}

function user(text: string, timestamp = at(-58_000)): Record<string, unknown> {
  return {
    type: 'message',
    id: 'u1',
    parentId: 'm1',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistant(
  content: readonly Record<string, unknown>[],
  opts: { stopReason?: string; cost?: number; input?: number; output?: number; timestamp?: string } = {},
): Record<string, unknown> {
  return {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    timestamp: opts.timestamp ?? at(-57_000),
    message: {
      role: 'assistant',
      content,
      usage: {
        input: opts.input ?? 100,
        output: opts.output ?? 20,
        cost: { total: opts.cost ?? 0.001 },
      },
      ...(opts.stopReason !== undefined ? { stopReason: opts.stopReason } : {}),
    },
  };
}

function toolResult(timestamp = at(-56_000)): Record<string, unknown> {
  return {
    type: 'message',
    id: 't1',
    parentId: 'a1',
    timestamp,
    message: {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      durationMs: 12,
    },
  };
}

const tmpDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-'));
  tmpDirs.push(root);
  return root;
}

function writeSession(
  root: string,
  entries: readonly Record<string, unknown>[],
  id = SESSION_ID,
): string {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026-11-03T10-00-00-000Z_pi-session-1.jsonl');
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  return file;
}

function makeSessionDir(entries: readonly Record<string, unknown>[], id = SESSION_ID): string {
  const root = makeRoot();
  writeSession(root, entries, id);
  return root;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseSessionContent', () => {
  it('parses JSONL entries and skips blank lines', () => {
    const content = `${JSON.stringify(header())}\n\n${JSON.stringify(modelChange())}\n`;
    const parsed = parseSessionContent(content);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.parseErrors).toBe(0);
    expect(parsed.partialLine).toBe('');
  });

  it('counts corrupt middle lines but keeps parsing', () => {
    const content = `${JSON.stringify(header())}\nnot json\n${JSON.stringify(modelChange())}\n`;
    const parsed = parseSessionContent(content);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.parseErrors).toBe(1);
  });

  it('treats a half-written final line as partial rather than an error', () => {
    const content = `${JSON.stringify(header())}\n{"type":"message","id":`;
    const parsed = parseSessionContent(content);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.parseErrors).toBe(0);
    expect(parsed.partialLine).toBe('{"type":"message","id":');
  });

  it('ignores JSON values that are not session entries', () => {
    const content = `${JSON.stringify(header())}\n[1,2,3]\n"nope"\n`;
    const parsed = parseSessionContent(content);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.parseErrors).toBe(2);
  });
});

describe('summarizeSession', () => {
  it('derives metadata, usage, tool calls and an idle status from a finished turn', () => {
    const root = makeSessionDir([
      header(),
      modelChange(),
      user('refactor the module'),
      assistant([
        { type: 'text', text: 'on it' },
        { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
        { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } },
      ], { stopReason: 'toolUse', cost: 0.001, input: 100, output: 20 }),
      toolResult(),
      assistant([{ type: 'text', text: 'done' }], { stopReason: 'stop', cost: 0.002, input: 50, output: 10 }),
    ]);
    const [session] = scanSessions({ sessionDir: root, now: NOW, staleMs: DEFAULT_STALE_MS });
    expect(session).toBeDefined();
    const s = session as NonNullable<typeof session>;

    expect(s.mcpSessionId).toBe(SESSION_ID);
    expect(s.piSessionId).toBe('pi-session-1');
    expect(s.cwd).toBe('/tmp/project');
    expect(s.model).toBe('openrouter:amazon/nova-micro-v1');
    expect(s.createdAt).toBe(NOW - 60_000);
    expect(s.lastEventAt).toBe(NOW - 56_000);
    expect(s.messageCount).toBe(4);
    expect(s.userTurns).toBe(1);
    expect(s.toolCalls).toBe(2);
    expect(s.costUsd).toBeCloseTo(0.003);
    expect(s.inputTokens).toBe(150);
    expect(s.outputTokens).toBe(30);
    expect(s.preview).toBe('refactor the module');
    expect(s.lastStopReason).toBe('stop');
    expect(s.status).toBe('idle');
    expect(s.parseErrors).toBe(0);
  });

  it('reports running when the last entry is a fresh tool result', () => {
    const root = makeSessionDir([
      header(),
      modelChange(),
      user('go', at(-10_000)),
      assistant([{ type: 'toolCall', name: 'bash', arguments: {} }], {
        stopReason: 'toolUse',
        timestamp: at(-9_000),
      }),
      toolResult(at(-1_000)),
    ]);
    const [session] = scanSessions({ sessionDir: root, now: NOW, staleMs: 120_000 });
    expect(session?.status).toBe('running');
  });

  it('reports interrupted when the last entry is stale', () => {
    const root = makeSessionDir([
      header(),
      modelChange(),
      user('go', at(-30_000)),
      assistant([{ type: 'toolCall', name: 'bash', arguments: {} }], {
        stopReason: 'toolUse',
        timestamp: at(-25_000),
      }),
      toolResult(at(-20_000)),
    ]);
    const [session] = scanSessions({ sessionDir: root, now: NOW, staleMs: 10_000 });
    expect(session?.status).toBe('interrupted');
  });

  it('reports empty for a header-only transcript', () => {
    const root = makeSessionDir([header(), modelChange()]);
    const [session] = scanSessions({ sessionDir: root, now: NOW });
    expect(session?.status).toBe('empty');
    expect(session?.messageCount).toBe(0);
    expect(session?.preview).toBe('');
    expect(session?.costUsd).toBe(0);
  });

  it('reports unreadable when the file cannot be read', () => {
    const parsed = readSessionFile('/definitely/missing/session.jsonl');
    const session = summarizeSession(parsed, 'missing', { now: NOW });
    expect(parsed.readError).not.toBeNull();
    expect(session.status).toBe('unreadable');
  });

  it('falls back to the file mtime when entries have no timestamps', () => {
    const parsed = {
      file: '/tmp/x.jsonl',
      sizeBytes: 10,
      mtimeMs: NOW - 5_000,
      entries: [{ type: 'session' }] as RawEntry[],
      parseErrors: 0,
      partialLine: '',
      readError: null,
    };
    const session = summarizeSession(parsed, 'x', { now: NOW });
    expect(session.lastEventAt).toBe(NOW - 5_000);
    expect(session.status).toBe('empty');
  });
});

describe('discoverSessionFiles and resolveSession', () => {
  it('finds transcripts and resolves exact ids, prefixes and paths', () => {
    const root = makeRoot();
    writeSession(root, [header()]);
    const other = 'bbbb9999-2222-3333-4444-555566667777';
    writeSession(root, [header({ id: 'pi-session-2' })], other);

    const discovered = discoverSessionFiles(root);
    expect(discovered).toHaveLength(2);
    expect(discovered.map((d) => d.mcpSessionId).sort()).toEqual([SESSION_ID, other].sort());

    const exact = resolveSession(SESSION_ID, { sessionDir: root, now: NOW });
    expect(exact.session?.mcpSessionId).toBe(SESSION_ID);

    const prefix = resolveSession('aaaa', { sessionDir: root, now: NOW });
    expect(prefix.session?.mcpSessionId).toBe(SESSION_ID);

    const byPath = resolveSession(discovered[0]?.file ?? '', { sessionDir: root, now: NOW });
    expect(byPath.session).not.toBeNull();
    expect(byPath.session?.file).toBe(discovered[0]?.file);
  });

  it('returns candidates when a prefix is ambiguous', () => {
    const root = makeRoot();
    writeSession(root, [header()], 'aaaa1111');
    writeSession(root, [header()], 'aaaa2222');

    const result = resolveSession('aaaa', { sessionDir: root, now: NOW });
    expect(result.session).toBeNull();
    expect(result.candidates).toHaveLength(2);
  });

  it('returns nothing when the session root does not exist', () => {
    expect(discoverSessionFiles('/definitely/missing/root')).toEqual([]);
    const result = resolveSession('nope', { sessionDir: '/definitely/missing/root', now: NOW });
    expect(result.session).toBeNull();
    expect(result.candidates).toEqual([]);
  });
});
