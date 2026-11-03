import { join } from 'node:path';
import { ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent';

/**
 * Build the process-wide pi model/auth runtime.
 *
 * There MUST be exactly one of these across all sessions: pi uses file locking
 * on OAuth refresh, and multiple in-process runtimes would see stale auth data.
 *
 * The runtime always points at the user's real pi agent dir (`~/.pi/agent`, or
 * `PI_CODING_AGENT_DIR` when set) so credentials and custom models are shared,
 * while each session still gets its own agentDir on disk.
 */
export async function createSharedModelRuntime(): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  return ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    // Static catalogs are enough: avoids a network round-trip on startup.
    allowModelNetwork: false,
  });
}
