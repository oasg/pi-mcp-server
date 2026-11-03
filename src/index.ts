#!/usr/bin/env node
import { createSharedModelRuntime } from './runtime.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { buildMcpServer } from './server.js';
import { startHttpServer } from './http.js';
import { SessionManager } from './sessions/manager.js';
import { installShutdownHandlers } from './shutdown.js';
import { PACKAGE_VERSION } from './pkg.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const modelRuntime = await createSharedModelRuntime();
  // SessionManager is process-wide: a single instance owns all pi sessions so
  // they outlive any individual HTTP-level MCP session id.
  const sessionManager = new SessionManager({
    sessionDir: config.sessionDir,
    modelRuntime,
    logger,
  });
  const handle = await startHttpServer(
    config,
    () => buildMcpServer({ logger, sessionManager }),
    logger,
  );
  const url = `http://${config.host}:${config.port}/mcp`;
  logger.info('pi-mcp-server listening', { url, version: PACKAGE_VERSION });

  installShutdownHandlers({
    logger,
    target: {
      // Close pi sessions BEFORE the HTTP server. Otherwise in-flight prompts
      // could still try to emit progress notifications onto closed transports.
      closeSessions: () => sessionManager.closeAll(),
      closeHttp: () => handle.close(),
    },
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: 'fatal', fields: { err: String(err) } })}\n`,
  );
  process.exit(1);
});
