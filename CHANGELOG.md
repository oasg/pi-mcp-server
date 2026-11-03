# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `pi-sessions` CLI (`list`, `show`, `watch`) for inspecting the pi sessions
  created by the server. It reads the JSONL transcripts under
  `SESSION_DIR` directly, so it works without a running server. `list`
  reports model, cwd, message count, cumulative cost and an inferred
  status (`running`, `idle`, `interrupted`, `empty`, `unreadable`); `show`
  renders a transcript; `watch` follows a live session. All commands
  support `--json`.

## [0.1.0] - 2026-05-22

Initial public release.

### Added

- MCP server that bridges Claude Code (or any MCP client) and the
  [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
  Node SDK, so a sandboxed client without outbound network access can drive
  pi sessions over a local HTTP endpoint.
- Streamable HTTP transport on `127.0.0.1:3700/mcp` by default (`PORT`
  configurable). One MCP session per client connection; pi sessions are
  process-wide and outlive any individual MCP connection.
- Four tools:
  - `pi_new_session({ cwd, model, max_cost_usd?, thinking_level?, system_prompt? })`
    spawns an isolated pi agent (its own `agentDir` under `SESSION_DIR`) and
    returns a `sessionId`.
  - `pi_prompt({ sessionId, text })` sends a message, streams pi's reply, and
    returns the full text plus per-turn and cumulative cost/token usage.
  - `pi_list_sessions()` returns every known session with its model, cwd,
    cumulative spend, optional cap, and timestamps.
  - `pi_close_session({ sessionId })` disposes a session; idempotent.
- Per-session `max_cost_usd` cap. Pre-flight check short-circuits prompts
  once cumulative spend has reached the cap; mid-turn check aborts the
  in-flight pi run on the first assistant `message_end` that crosses the
  cap, preserving any text already streamed. Cost-capped turns return
  `finishReason: 'cost_cap'` and surface as `isError: true`.
- Progress heartbeat. `notifications/progress` fires every 10 seconds
  during an active prompt so MCP clients don't time the call out.
  Fire-and-forget delivery means a stalled client doesn't serialise ticks.
- DNS-rebinding defence. The HTTP layer rejects requests whose `Host`
  header doesn't match the configured bind address.
- Cross-platform graceful shutdown. SIGINT/SIGTERM closes pi sessions
  first, then the HTTP server, then exits 0. A 5-second force-exit timer
  is the hard upper bound; a second signal during shutdown exits
  immediately with code 130.
- Real-OpenRouter smoke scripts (`scripts/smoke-pi.ts`,
  `scripts/smoke-l4.ts`, `scripts/smoke-l5.ts`) demonstrate the full
  surface against `amazon/nova-micro-v1` for under $0.001 per run.
- 55 unit tests across config, paths, session state machine,
  SessionManager, prompt heartbeat, and shutdown plumbing. No tests
  touch the network.

[0.1.0]: https://github.com/a-fig/pi-mcp-server/releases/tag/v0.1.0
