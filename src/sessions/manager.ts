import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Logger } from '../log.js';
import { PiSession } from './session.js';
import { agentDirFor } from './paths.js';
import type { PiSessionOptions, PromptOptions, PromptResult, ThinkingLevel } from './types.js';

export interface NewSessionOpts {
  readonly cwd: string;
  readonly model: string;
  readonly maxCostUsd?: number;
  readonly thinkingLevel?: ThinkingLevel;
  readonly systemPrompt?: string;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly cumulativeCostUsd: number;
  readonly maxCostUsd: number | null;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

export interface SessionManagerDeps {
  readonly sessionDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly logger: Logger;
  /**
   * Override for tests. Production: omit (defaults to PiSession.create).
   * Receives a fully-built PiSessionOptions; must return a working PiSession.
   */
  readonly createSession?: (opts: PiSessionOptions) => Promise<PiSession>;
  /** Override for tests. Production: omit (defaults to Date.now). */
  readonly now?: () => number;
}

interface Entry {
  session: PiSession;
  info: SessionInfo;
}

export class SessionManager {
  private readonly sessionDir: string;
  private readonly modelRuntime: ModelRuntime;
  private readonly logger: Logger;
  private readonly createSession: (opts: PiSessionOptions) => Promise<PiSession>;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Entry>();

  constructor(deps: SessionManagerDeps) {
    this.sessionDir = deps.sessionDir;
    this.modelRuntime = deps.modelRuntime;
    this.logger = deps.logger;
    this.createSession = deps.createSession ?? PiSession.create;
    this.now = deps.now ?? Date.now;
  }

  async create(opts: NewSessionOpts): Promise<{ sessionId: string }> {
    if (!path.isAbsolute(opts.cwd)) {
      throw new Error(`cwd must be an absolute path: ${JSON.stringify(opts.cwd)}`);
    }
    // Redundant with PiSession's constructor-time validation, but kept here so
    // callers get a fast failure before we spin up an agent dir on disk.
    if (opts.maxCostUsd !== undefined) {
      if (Number.isNaN(opts.maxCostUsd) || opts.maxCostUsd <= 0) {
        throw new Error(`maxCostUsd must be > 0: ${String(opts.maxCostUsd)}`);
      }
    }

    const sessionId = randomUUID();
    const agentDir = agentDirFor(sessionId, this.sessionDir);
    const piOpts: PiSessionOptions = {
      id: sessionId,
      cwd: opts.cwd,
      agentDir,
      modelRuntime: this.modelRuntime,
      model: opts.model,
      // Spread-with-condition keeps exactOptionalPropertyTypes happy: we never
      // assign `undefined` to an optional field, we just omit it.
      ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
    };

    const session = await this.createSession(piOpts);
    const ts = this.now();
    const info: SessionInfo = {
      sessionId,
      cwd: session.cwd,
      model: session.model,
      cumulativeCostUsd: session.cumulativeCostUsd,
      maxCostUsd: opts.maxCostUsd ?? null,
      createdAt: ts,
      lastActiveAt: ts,
    };
    this.sessions.set(sessionId, { session, info });
    this.logger.info('session created', { sessionId, model: opts.model, cwd: opts.cwd });
    return { sessionId };
  }

  async prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<PromptResult> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) throw new Error(`unknown session: ${sessionId}`);

    let result: PromptResult;
    try {
      result = await entry.session.prompt(text, opts);
    } catch (err) {
      // PiSession.prompt is contractually non-rejecting. If that ever changes,
      // surface it loudly rather than silently dropping the in-flight turn.
      this.logger.warn('session prompt threw (unexpected)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    entry.info = {
      ...entry.info,
      cumulativeCostUsd: result.cumulativeCostUsd,
      lastActiveAt: this.now(),
    };
    return result;
  }

  list(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const entry of this.sessions.values()) {
      // Spread to produce a fresh object so callers can't mutate internal state.
      out.push({ ...entry.info });
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      this.logger.debug('close called for unknown session (no-op)', { sessionId });
      return;
    }
    this.sessions.delete(sessionId);
    await entry.session.close();
    this.logger.info('session closed', { sessionId });
  }

  async closeAll(): Promise<void> {
    const snapshot = Array.from(this.sessions.values());
    this.sessions.clear();
    if (snapshot.length === 0) return;
    await Promise.allSettled(snapshot.map((e) => e.session.close()));
    this.logger.info('all sessions closed', { count: snapshot.length });
  }
}
