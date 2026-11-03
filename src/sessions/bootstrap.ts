import fs from 'node:fs/promises';
import {
  type AgentSession,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { parseModelString } from './parseModel.js';
import type { PiInnerSession, PiSessionOptions } from './types.js';

/** Wrap a real pi AgentSession in the minimal PiInnerSession shape PiSession consumes. */
export function adaptAgentSession(s: AgentSession): PiInnerSession {
  return {
    subscribe: (l) => s.subscribe(l),
    prompt: (t) => s.prompt(t),
    abort: () => s.abort(),
    getUsageSnapshot: () => {
      const stats = s.getSessionStats();
      return { cost: stats.cost, inputTokens: stats.tokens.input, outputTokens: stats.tokens.output };
    },
    dispose: () => s.dispose(),
  };
}

/**
 * Resolve the model, ensure the agentDir exists, build a fresh pi AgentSession,
 * and return the PiInnerSession adapter ready to hand to PiSession's constructor.
 *
 * Model resolution happens BEFORE mkdir so a bad model string doesn't leak an
 * empty agent dir on disk.
 */
export async function buildInnerSession(opts: PiSessionOptions): Promise<PiInnerSession> {
  const { provider, modelId } = parseModelString(opts.model);
  const model = opts.modelRuntime.getModel(provider, modelId);
  if (!model) {
    const available = opts.modelRuntime
      .getModels(provider)
      .map((m) => m.id)
      .slice(0, 20);
    throw new Error(
      `Model not found: provider=${JSON.stringify(provider)} id=${JSON.stringify(modelId)}` +
        (available.length > 0 ? `. Available for ${provider}: ${available.join(', ')}` : ''),
    );
  }
  if (!opts.modelRuntime.hasConfiguredAuth(provider)) {
    throw new Error(
      `No credentials configured for provider ${JSON.stringify(provider)}. ` +
        'Log in with `pi` (or set the provider API key) and retry.',
    );
  }
  await fs.mkdir(opts.agentDir, { recursive: true });
  const created = await createAgentSession({
    cwd: opts.cwd,
    // Per-session isolated agent dir: never mutates ~/.pi/agent.
    agentDir: opts.agentDir,
    // Shared runtime so the isolated agent dir still sees the user's auth.
    modelRuntime: opts.modelRuntime,
    model,
    ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
    // In-memory settings so we never mutate the user's global pi settings.
    settingsManager: SettingsManager.inMemory(),
    // pi 1.5.0: SessionManager.create(cwd, sessionDir)
    sessionManager: SessionManager.create(opts.cwd, opts.agentDir),
  });
  return adaptAgentSession(created.session);
}
