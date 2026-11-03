import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager, NewSessionOpts } from '../sessions/manager.js';
import type { ThinkingLevel } from '../sessions/types.js';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const inputSchema = {
  cwd: z
    .string()
    .describe('Absolute path to the working directory for the pi agent.'),
  model: z
    .string()
    .describe(
      'Model identifier in "provider:modelId" form, e.g. "openrouter:anthropic/claude-3.5-haiku".',
    ),
  max_cost_usd: z
    .number()
    .positive()
    .optional()
    .describe(
      'Optional per-session cost cap in USD. Future versions will abort prompts once this is reached; not enforced in this layer.',
    ),
  thinking_level: z.enum(THINKING_LEVELS).optional(),
  system_prompt: z.string().optional(),
};

export function registerNewSessionTool(server: McpServer, sessionManager: SessionManager): void {
  server.registerTool(
    'pi_new_session',
    {
      description:
        'Spawn a new pi agent session. Returns a sessionId usable with pi_prompt, pi_list_sessions, and pi_close_session.',
      inputSchema,
    },
    async (args) => {
      try {
        const opts: NewSessionOpts = {
          cwd: args.cwd,
          model: args.model,
          // Spread-with-condition avoids assigning `undefined` to optional fields
          // under exactOptionalPropertyTypes.
          ...(args.max_cost_usd !== undefined ? { maxCostUsd: args.max_cost_usd } : {}),
          ...(args.thinking_level !== undefined
            ? { thinkingLevel: args.thinking_level as ThinkingLevel }
            : {}),
          ...(args.system_prompt !== undefined ? { systemPrompt: args.system_prompt } : {}),
        };
        const { sessionId } = await sessionManager.create(opts);
        return {
          content: [
            {
              type: 'text',
              text: `session ${sessionId} created (model=${args.model}, cwd=${args.cwd})`,
            },
          ],
          structuredContent: { sessionId },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: message }],
          structuredContent: { errorMessage: message },
        };
      }
    },
  );
}
