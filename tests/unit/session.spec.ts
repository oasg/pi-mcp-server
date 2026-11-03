import { describe, it, expect } from 'vitest';
import type { AgentSessionEvent, ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  PiSession,
  parseModelString,
  type PiInnerSession,
  type UsageSnapshot,
} from '../../src/sessions/session.js';

type Listener = (event: AgentSessionEvent) => void;

class FakeInnerSession implements PiInnerSession {
  private listener: Listener | null = null;
  /** Scripted tape emitted asynchronously when prompt() is called. */
  tape: AgentSessionEvent[] = [];
  /** Per-turn deltas applied to the cumulative usage snapshot when the tape ends. */
  nextDeltaCost = 0;
  nextDeltaInput = 0;
  nextDeltaOutput = 0;
  disposed = false;
  aborted = false;
  abortCalls = 0;
  promptCalls: string[] = [];
  private cumulative: UsageSnapshot = { cost: 0, inputTokens: 0, outputTokens: 0 };

  subscribe(listener: Listener): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    const tape = this.tape;
    this.tape = [];
    const dCost = this.nextDeltaCost;
    const dIn = this.nextDeltaInput;
    const dOut = this.nextDeltaOutput;
    this.nextDeltaCost = 0;
    this.nextDeltaInput = 0;
    this.nextDeltaOutput = 0;
    await Promise.resolve();
    // Apply the cumulative usage delta just before the terminal event, mirroring
    // pi's real behavior where stats reflect all completed LLM calls by turn_end.
    this.cumulative = {
      cost: this.cumulative.cost + dCost,
      inputTokens: this.cumulative.inputTokens + dIn,
      outputTokens: this.cumulative.outputTokens + dOut,
    };
    for (const ev of tape) this.listener?.(ev);
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.abortCalls += 1;
  }

  getUsageSnapshot(): UsageSnapshot {
    return this.cumulative;
  }

  dispose(): void {
    this.disposed = true;
  }
}

const baseOpts = {
  id: 't1',
  cwd: '/tmp/cwd',
  agentDir: '/tmp/agent',
  // unused: tests bypass create() and never touch modelRuntime
  modelRuntime: undefined as unknown as ModelRuntime,
  model: 'openrouter:amazon/nova-micro-v1',
};

function assistantMsg(input: number, output: number, cost: number) {
  return {
    role: 'assistant' as const,
    content: [],
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'fake',
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    stopReason: 'stop' as const,
    timestamp: 0,
  };
}

function scriptedTape(deltas: string[]): AgentSessionEvent[] {
  const empty = assistantMsg(0, 0, 0);
  const deltaEvents: AgentSessionEvent[] = deltas.map((delta) => ({
    type: 'message_update',
    message: empty,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: empty },
  }));
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: empty },
    ...deltaEvents,
    { type: 'message_end', message: empty },
    { type: 'turn_end', message: empty, toolResults: [] },
    { type: 'agent_end', messages: [] },
  ];
}

function scriptTurn(fake: FakeInnerSession, deltas: string[], cost: number, input: number, output: number): void {
  fake.tape = scriptedTape(deltas);
  fake.nextDeltaCost = cost;
  fake.nextDeltaInput = input;
  fake.nextDeltaOutput = output;
}

describe('parseModelString', () => {
  it('splits on first colon, preserving slashes in modelId', () => {
    expect(parseModelString('openrouter:amazon/nova-micro-v1')).toEqual({
      provider: 'openrouter',
      modelId: 'amazon/nova-micro-v1',
    });
  });

  it('throws on missing colon', () => {
    expect(() => parseModelString('nova-micro')).toThrow(/Invalid model string/);
  });

  it('throws on empty provider', () => {
    expect(() => parseModelString(':foo')).toThrow(/Invalid model string/);
  });

  it('throws on empty modelId', () => {
    expect(() => parseModelString('openrouter:')).toThrow(/Invalid model string/);
  });

  it('throws on whitespace-only provider', () => {
    expect(() => parseModelString('   :foo')).toThrow(/Invalid model string/);
  });

  it('throws on whitespace-only modelId', () => {
    expect(() => parseModelString('openrouter:   ')).toThrow(/Invalid model string/);
  });

  it('throws on control characters', () => {
    expect(() => parseModelString('openrouter:foobar')).toThrow(/Invalid model string/);
  });

  it('throws on multi-colon with empty after first', () => {
    // "::foo" splits into provider="" and modelId=":foo"; provider empty → reject.
    expect(() => parseModelString('::foo')).toThrow(/Invalid model string/);
  });

  it('trims whitespace around both halves on success', () => {
    expect(parseModelString('  openrouter : amazon/nova ')).toEqual({
      provider: 'openrouter',
      modelId: 'amazon/nova',
    });
  });
});

describe('PiSession.prompt (fake inner session)', () => {
  it('aggregates text deltas, cost, and tokens on a successful turn', async () => {
    const fake = new FakeInnerSession();
    const session = new PiSession(baseOpts, fake);
    scriptTurn(fake, ['hello ', 'world'], 0.0001, 5, 2);
    const streamed: string[] = [];
    const result = await session.prompt('say hi', { onText: (d) => streamed.push(d) });
    expect(result.text).toBe('hello world');
    expect(result.costUsd).toBeCloseTo(0.0001, 10);
    expect(result.cumulativeCostUsd).toBeCloseTo(0.0001, 10);
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(2);
    expect(result.finishReason).toBe('completed');
    expect(streamed).toEqual(['hello ', 'world']);
    expect(fake.promptCalls).toEqual(['say hi']);
    await session.close();
    expect(fake.disposed).toBe(true);
  });

  it('accumulates cumulativeCostUsd from getSessionStats across multiple prompts', async () => {
    const fake = new FakeInnerSession();
    const session = new PiSession(baseOpts, fake);
    scriptTurn(fake, ['a'], 0.0001, 3, 1);
    const r1 = await session.prompt('1');
    expect(r1.cumulativeCostUsd).toBeCloseTo(0.0001, 10);
    scriptTurn(fake, ['b'], 0.0001, 4, 2);
    const r2 = await session.prompt('2');
    expect(r2.costUsd).toBeCloseTo(0.0001, 10);
    expect(r2.cumulativeCostUsd).toBeCloseTo(0.0002, 10);
    expect(session.cumulativeCostUsd).toBeCloseTo(0.0002, 10);
    await session.close();
  });

  it('returns error result when inner.prompt rejects', async () => {
    const fake = new FakeInnerSession();
    fake.prompt = async () => {
      throw new Error('boom');
    };
    const session = new PiSession(baseOpts, fake);
    const result = await session.prompt('x');
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/boom/);
    await session.close();
  });

  it('close() is idempotent', async () => {
    const fake = new FakeInnerSession();
    const session = new PiSession(baseOpts, fake);
    await session.close();
    await session.close();
    expect(fake.disposed).toBe(true);
  });

  it('accumulates text across multiple turn_end events (multi-step tool use) and resolves on agent_end', async () => {
    // Real pi emits one turn_end per round when the model uses tools:
    //   turn 1 = assistant tool_call + tool result (no text)
    //   turn 2 = assistant final text
    //   agent_end terminates the whole agent run
    // PiSession must resolve on agent_end with the accumulated text, not on
    // the first turn_end.
    const fake = new FakeInnerSession();
    const session = new PiSession(baseOpts, fake);
    const empty = assistantMsg(0, 0, 0);
    const finalMsg = assistantMsg(10, 5, 0.0001);
    fake.tape = [
      { type: 'agent_start' },
      // Turn 1: model emits a tool call, no text.
      { type: 'turn_start' },
      { type: 'message_start', message: empty },
      { type: 'message_end', message: empty },
      { type: 'turn_end', message: empty, toolResults: [] },
      // Turn 2: model emits the final text answer.
      { type: 'turn_start' },
      { type: 'message_start', message: empty },
      {
        type: 'message_update',
        message: empty,
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '0.1.0', partial: empty },
      },
      { type: 'message_end', message: finalMsg },
      { type: 'turn_end', message: finalMsg, toolResults: [] },
      { type: 'agent_end', messages: [] },
    ];
    const result = await session.prompt('what version?');
    expect(result.finishReason).toBe('completed');
    expect(result.text).toBe('0.1.0');
    await session.close();
  });

  it('rejects a second prompt() while the first is in progress', async () => {
    // Use a fake whose prompt never resolves on its own so the first turn stays open.
    const fake = new FakeInnerSession();
    let release: () => void = () => {};
    fake.prompt = (text: string) => {
      fake.promptCalls.push(text);
      return new Promise<void>((res) => {
        release = res;
      });
    };
    const session = new PiSession(baseOpts, fake);
    const first = session.prompt('one');
    // Yield so the first prompt() registers `this.active` before the second call.
    await Promise.resolve();
    const second = await session.prompt('two');
    expect(second.finishReason).toBe('error');
    expect(second.errorMessage).toMatch(/already in progress/);
    // close() resolves the in-flight turn with an error so `first` settles.
    release();
    await session.close();
    const firstResult = await first;
    expect(firstResult.finishReason).toBe('error');
    expect(firstResult.errorMessage).toMatch(/closed/);
  });

  it('honors AbortSignal during prompt(): aborts inner and returns error result', async () => {
    // Model pi's contract: prompt() stays pending until abort() (or natural completion)
    // settles it. The fake's abort() resolves the pending prompt the same way.
    const fake = new FakeInnerSession();
    let release: () => void = () => {};
    fake.prompt = (text: string) => {
      fake.promptCalls.push(text);
      return new Promise<void>((res) => {
        release = res;
      });
    };
    fake.abort = async () => {
      fake.abortCalls += 1;
      release();
    };
    const session = new PiSession(baseOpts, fake);
    const ac = new AbortController();
    const pending = session.prompt('go', { signal: ac.signal });
    await Promise.resolve();
    ac.abort();
    const result = await pending;
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/aborted/);
    expect(fake.abortCalls).toBe(1);
    await session.close();
  });

  it('short-circuits the second prompt with cost_cap once cumulative cost has reached the cap', async () => {
    const fake = new FakeInnerSession();
    const session = new PiSession({ ...baseOpts, maxCostUsd: 0.001 }, fake);
    // First turn drives cumulative cost to 0.002 (above cap). The turn itself
    // does not trip the cap mid-turn because the contract only triggers the
    // pre-flight check on the NEXT prompt for this scenario; we want the second
    // prompt to short-circuit without ever calling inner.prompt.
    scriptTurn(fake, ['hi'], 0.002, 1, 1);
    const r1 = await session.prompt('one');
    // First turn does fire the mid-turn cap because cost >= cap at message_end.
    // That's fine for this test — we only care that the SECOND call is the
    // pre-flight short-circuit. Drain the fake's promptCalls so we can assert
    // length precisely below.
    expect(r1.cumulativeCostUsd).toBeCloseTo(0.002, 10);
    const callsBefore = fake.promptCalls.length;
    const r2 = await session.prompt('two');
    expect(r2.finishReason).toBe('cost_cap');
    expect(r2.errorMessage).toMatch(/cap/);
    // Pre-flight: inner.prompt must NOT have been called for the second call.
    expect(fake.promptCalls.length).toBe(callsBefore);
    await session.close();
  });

  it('aborts mid-turn and resolves with cost_cap when message_end pushes cost past the cap', async () => {
    const fake = new FakeInnerSession();
    const session = new PiSession({ ...baseOpts, maxCostUsd: 0.0005 }, fake);
    // Tape: streams "par" + "tial" deltas, then message_end reports cumulative
    // cost of 0.001 (above the 0.0005 cap). turn_end would normally follow but
    // PiSession should already have finalized the turn as cost_cap.
    scriptTurn(fake, ['par', 'tial'], 0.001, 3, 2);
    const result = await session.prompt('hi');
    expect(result.finishReason).toBe('cost_cap');
    expect(result.errorMessage).toMatch(/cap/);
    expect(result.text).toBe('partial');
    expect(fake.abortCalls).toBe(1);
    expect(fake.aborted).toBe(true);
    await session.close();
  });

  it('returns error immediately when signal is already aborted', async () => {
    const fake = new FakeInnerSession();
    const session = new PiSession(baseOpts, fake);
    const ac = new AbortController();
    ac.abort();
    const result = await session.prompt('go', { signal: ac.signal });
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toMatch(/aborted before send/);
    // inner.prompt should not have been called.
    expect(fake.promptCalls).toEqual([]);
    expect(fake.abortCalls).toBe(0);
    await session.close();
  });
});
