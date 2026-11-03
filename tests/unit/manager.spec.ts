import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '../../src/sessions/manager.js';
import type { PiSession } from '../../src/sessions/session.js';
import type { PiSessionOptions, PromptOptions, PromptResult } from '../../src/sessions/types.js';
import type { Logger } from '../../src/log.js';

/** Minimal stub mirroring the surface SessionManager touches on PiSession. */
class FakePiSession {
  readonly id: string;
  readonly model: string;
  readonly cwd: string;
  cumulativeCostUsd = 0;
  closed = false;
  closeError: Error | null = null;
  promptResults: PromptResult[] = [];
  promptCalls: string[] = [];
  constructor(opts: PiSessionOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.cwd = opts.cwd;
  }
  async prompt(text: string, _opts?: PromptOptions): Promise<PromptResult> {
    this.promptCalls.push(text);
    const next = this.promptResults.shift();
    if (next === undefined) throw new Error('FakePiSession: no scripted prompt result');
    this.cumulativeCostUsd = next.cumulativeCostUsd;
    return next;
  }
  async close(): Promise<void> {
    if (this.closeError !== null) throw this.closeError;
    this.closed = true;
  }
}

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const ABS_CWD = path.resolve('/tmp/work');

function buildHarness(tickStart = 1_000): { mgr: SessionManager; fakes: FakePiSession[]; tick: () => number } {
  const fakes: FakePiSession[] = [];
  let clock = tickStart;
  const tick = (): number => clock++;
  const mgr = new SessionManager({
    sessionDir: path.resolve('/tmp/pi-mcp-test'),
    // Fake never touches modelRuntime; the manager just forwards it.
    modelRuntime: undefined as unknown as ModelRuntime,
    logger: silentLogger,
    createSession: async (opts) => {
      const fake = new FakePiSession(opts);
      fakes.push(fake);
      // Manager touches only PiSession's public shape; cast bridges the structural fake.
      return fake as unknown as PiSession;
    },
    now: tick,
  });
  return { mgr, fakes, tick };
}

function completedResult(cumulative: number): PromptResult {
  return { text: 'ok', costUsd: cumulative, cumulativeCostUsd: cumulative, inputTokens: 1, outputTokens: 1, finishReason: 'completed' };
}

describe('SessionManager.create', () => {
  it('returns a non-empty sessionId and lists the new session with correct fields', async () => {
    const { mgr, fakes } = buildHarness(100);
    const { sessionId } = await mgr.create({
      cwd: ABS_CWD,
      model: 'openrouter:foo/bar',
      maxCostUsd: 5,
    });
    expect(sessionId).toMatch(/[0-9a-f-]{36}/i);
    const listed = mgr.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      sessionId,
      cwd: ABS_CWD,
      model: 'openrouter:foo/bar',
      cumulativeCostUsd: 0,
      maxCostUsd: 5,
      createdAt: 100,
      lastActiveAt: 100,
    });
    expect(fakes[0]?.id).toBe(sessionId);
  });

  it('defaults maxCostUsd to null when omitted', async () => {
    const { mgr } = buildHarness();
    await mgr.create({ cwd: ABS_CWD, model: 'openrouter:m/n' });
    expect(mgr.list()[0]?.maxCostUsd).toBeNull();
  });

  it('throws on relative cwd', async () => {
    const { mgr } = buildHarness();
    await expect(mgr.create({ cwd: 'relative/path', model: 'openrouter:m/n' })).rejects.toThrow(
      /absolute path/,
    );
  });

  it('throws on maxCostUsd <= 0 (zero and negative)', async () => {
    const { mgr } = buildHarness();
    await expect(
      mgr.create({ cwd: ABS_CWD, model: 'openrouter:m/n', maxCostUsd: 0 }),
    ).rejects.toThrow(/maxCostUsd/);
    await expect(
      mgr.create({ cwd: ABS_CWD, model: 'openrouter:m/n', maxCostUsd: -1 }),
    ).rejects.toThrow(/maxCostUsd/);
  });

  it('throws on maxCostUsd: NaN', async () => {
    const { mgr } = buildHarness();
    await expect(
      mgr.create({ cwd: ABS_CWD, model: 'openrouter:m/n', maxCostUsd: Number.NaN }),
    ).rejects.toThrow(/maxCostUsd/);
  });

  it('passes maxCostUsd through to PiSessionOptions when provided', async () => {
    const fakes: FakePiSession[] = [];
    const captured: PiSessionOptions[] = [];
    const mgr = new SessionManager({
      sessionDir: path.resolve('/tmp/pi-mcp-test'),
      modelRuntime: undefined as unknown as ModelRuntime,
      logger: silentLogger,
      createSession: async (opts) => {
        captured.push(opts);
        const fake = new FakePiSession(opts);
        fakes.push(fake);
        return fake as unknown as PiSession;
      },
    });
    await mgr.create({ cwd: ABS_CWD, model: 'openrouter:m/n', maxCostUsd: 0.5 });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.maxCostUsd).toBe(0.5);

    // And when omitted, the option is absent (not undefined-assigned).
    await mgr.create({ cwd: ABS_CWD, model: 'openrouter:m/n' });
    expect(captured[1]).toBeDefined();
    expect('maxCostUsd' in (captured[1] as PiSessionOptions)).toBe(false);
  });
});

describe('SessionManager.prompt', () => {
  it('routes through and reflects cumulativeCostUsd + lastActiveAt in list()', async () => {
    const { mgr, fakes, tick } = buildHarness(500);
    const { sessionId } = await mgr.create({ cwd: ABS_CWD, model: 'openrouter:m/n' });
    const fake = fakes[0];
    if (fake === undefined) throw new Error('no fake');
    fake.promptResults.push(completedResult(0.0123));
    const result = await mgr.prompt(sessionId, 'hello');
    expect(result.text).toBe('ok');
    expect(result.cumulativeCostUsd).toBeCloseTo(0.0123, 10);
    expect(fake.promptCalls).toEqual(['hello']);
    const info = mgr.list()[0];
    expect(info?.cumulativeCostUsd).toBeCloseTo(0.0123, 10);
    expect(info?.createdAt).toBe(500);
    expect(info?.lastActiveAt).toBe(501);
    expect(tick()).toBe(502);
  });

  it('updates lastActiveAt across multiple prompts using injected now()', async () => {
    const { mgr, fakes } = buildHarness(10);
    const { sessionId } = await mgr.create({ cwd: ABS_CWD, model: 'openrouter:m/n' });
    const fake = fakes[0];
    if (fake === undefined) throw new Error('no fake');
    fake.promptResults.push(completedResult(0.01));
    fake.promptResults.push(completedResult(0.05));
    await mgr.prompt(sessionId, 'one');
    await mgr.prompt(sessionId, 'two');
    const info = mgr.list()[0];
    expect(info?.createdAt).toBe(10);
    expect(info?.lastActiveAt).toBe(12);
    expect(info?.cumulativeCostUsd).toBeCloseTo(0.05, 10);
  });

  it('throws on unknown sessionId', async () => {
    const { mgr } = buildHarness();
    await expect(mgr.prompt('nope-not-real', 'hi')).rejects.toThrow(/unknown session/);
  });
});

describe('SessionManager.list', () => {
  it('returns sessions sorted by createdAt as fresh copies (no leak)', async () => {
    const { mgr } = buildHarness(1);
    const a = await mgr.create({ cwd: ABS_CWD, model: 'openrouter:a/a' });
    const b = await mgr.create({ cwd: ABS_CWD, model: 'openrouter:b/b' });
    const c = await mgr.create({ cwd: ABS_CWD, model: 'openrouter:c/c' });
    const listed = mgr.list();
    expect(listed.map((s) => s.sessionId)).toEqual([a.sessionId, b.sessionId, c.sessionId]);
    // SessionInfo is readonly at the type level; cast through unknown to verify
    // runtime isolation — mutating the returned object must not leak back.
    (listed[0] as unknown as { cumulativeCostUsd: number }).cumulativeCostUsd = 999;
    expect(mgr.list()[0]?.cumulativeCostUsd).toBe(0);
  });
});

describe('SessionManager.close / closeAll', () => {
  it('close(id) removes from list()', async () => {
    const { mgr, fakes } = buildHarness();
    const { sessionId } = await mgr.create({ cwd: ABS_CWD, model: 'openrouter:m/n' });
    await mgr.close(sessionId);
    expect(mgr.list()).toEqual([]);
    expect(fakes[0]?.closed).toBe(true);
  });

  it('close(unknownId) is a no-op', async () => {
    const { mgr } = buildHarness();
    await expect(mgr.close('nope')).resolves.toBeUndefined();
  });

  it('closeAll() closes everything even if one close() rejects, and is idempotent', async () => {
    const { mgr, fakes } = buildHarness();
    await mgr.create({ cwd: ABS_CWD, model: 'openrouter:a/a' });
    await mgr.create({ cwd: ABS_CWD, model: 'openrouter:b/b' });
    await mgr.create({ cwd: ABS_CWD, model: 'openrouter:c/c' });
    const middle = fakes[1];
    if (middle === undefined) throw new Error('expected second fake');
    middle.closeError = new Error('boom');
    await mgr.closeAll();
    expect(mgr.list()).toEqual([]);
    expect(fakes[0]?.closed).toBe(true);
    expect(fakes[2]?.closed).toBe(true);
    await expect(mgr.closeAll()).resolves.toBeUndefined();
  });
});
