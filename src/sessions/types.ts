import type { AgentSessionEvent, ModelRuntime } from '@earendil-works/pi-coding-agent';

/** Mirrors pi-agent-core's ThinkingLevel union (not re-exported by pi-coding-agent). */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PiSessionOptions {
  readonly id: string;
  readonly cwd: string;
  readonly agentDir: string;
  /**
   * Process-wide model/auth runtime. Built once from the user's real
   * `~/.pi/agent` so per-session agentDirs stay isolated without losing auth.
   */
  readonly modelRuntime: ModelRuntime;
  readonly model: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly systemPrompt?: string;
  /**
   * Optional per-session cost cap in USD. When cumulative spend reaches this
   * value PiSession aborts the in-flight turn and short-circuits subsequent
   * prompts with `finishReason: 'cost_cap'`. Must be > 0 and not NaN.
   */
  readonly maxCostUsd?: number;
}

/**
 * Result of a single prompt turn.
 *
 * `finishReason === 'cost_cap'` means the per-session cost cap was reached;
 * `text` may contain a partial streamed response captured before pi was aborted.
 */
export interface PromptResult {
  readonly text: string;
  readonly costUsd: number;
  readonly cumulativeCostUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly finishReason: 'completed' | 'error' | 'cost_cap';
  readonly errorMessage?: string;
}

export interface PromptOptions {
  readonly onText?: (delta: string) => void;
  readonly signal?: AbortSignal;
}

/** Snapshot of cumulative usage for delta calculation across a turn. */
export interface UsageSnapshot {
  readonly cost: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Minimal adapter over the pi AgentSession. Only the surface PiSession actually
 * uses, so tests can drive a fake without depending on pi internals.
 */
export interface PiInnerSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  /**
   * Intentionally narrowed to `(text)` only. Pi's real `prompt` accepts a
   * second `PromptOptions` arg for streaming-behavior / images / templates;
   * expand this signature when steering or follow-ups are wired in.
   */
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  getUsageSnapshot(): UsageSnapshot;
  dispose(): void;
}
