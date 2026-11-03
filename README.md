# pi-mcp-server

MCP server that bridges Claude Code and the pi coding agent.

## Why this exists

Claude Code's built-in shell tools run inside a sandbox without outbound DNS,
so anything that needs to reach OpenRouter, Anthropic, Google or another LLM
provider has to live outside that sandbox. The pi coding agent
([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent))
is one such tool: it does real work, but only if it can call an API.

`pi-mcp-server` runs *outside* the sandbox as a normal user-process and
exposes pi sessions as MCP tools. Claude Code attaches as an MCP client over
local HTTP and can spawn pi agents, send them prompts, inspect their cost,
and dispose of them without ever leaving the sandbox itself.

## Quickstart

```sh
npm install -g @a-fig/pi-mcp-server
export OPENROUTER_API_KEY=sk-or-...        # or set in your shell config
pi-mcp-server &                            # listens on http://127.0.0.1:3700/mcp
claude mcp add pi-mcp --transport http --url http://127.0.0.1:3700/mcp
```

You also need a working pi setup at `~/.pi/agent/`. The server defers to pi
for authentication: if `~/.pi/agent/auth.json` contains a valid OAuth token,
pi will use that; otherwise it falls back to provider env vars like
`OPENROUTER_API_KEY`. See pi's own docs for first-time setup.

## How Claude uses this

Once attached, Claude has four tools.

| Tool | Inputs | Output |
| --- | --- | --- |
| `pi_new_session` | `cwd`, `model`, optional `max_cost_usd`, `thinking_level`, `system_prompt` | `{ sessionId }` |
| `pi_prompt` | `sessionId`, `text` | `{ text, costUsd, cumulativeCostUsd, inputTokens, outputTokens, finishReason, errorMessage? }` |
| `pi_list_sessions` | (none) | `{ sessions: SessionInfo[] }` |
| `pi_close_session` | `sessionId` | `{ closed: true }` |

A typical Claude flow: create a session in your repo with a cheap model and
a `max_cost_usd` of, say, `0.50`; send pi a prompt like "rewrite this module
to use async iterators, then run the tests"; pi works, edits files, and
returns when done; check the cumulative cost; close the session.

## Tool reference

### `pi_new_session`

Spawns a fresh pi agent backed by its own isolated `agentDir` under
`SESSION_DIR`. Returns a `sessionId` to use with the other three tools.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `cwd` | string | yes | Absolute path. Pi runs as if it were launched here. |
| `model` | string | yes | `provider:modelId`, e.g. `openrouter:anthropic/claude-3.5-haiku`. |
| `max_cost_usd` | number > 0 | no | Per-session USD cap. See [Cost caps](#cost-caps). |
| `thinking_level` | enum | no | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `system_prompt` | string | no | Custom system prompt for this session. |

Output (`structuredContent`):

```json
{ "sessionId": "0a2c..." }
```

`isError: true` when `cwd` is not absolute, when `max_cost_usd <= 0` or NaN,
when pi rejects the model string, or when the underlying agent fails to start.

### `pi_prompt`

Sends `text` to the named session and waits for pi to finish the turn.
Emits `notifications/progress` every 10 seconds while pi is running so MCP
clients don't time the call out.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | yes | Returned by `pi_new_session`. |
| `text` | string (non-empty) | yes | User message to send. |

Output (`structuredContent`):

```json
{
  "text": "...",
  "costUsd": 0.000123,
  "cumulativeCostUsd": 0.000456,
  "inputTokens": 512,
  "outputTokens": 88,
  "finishReason": "completed",
  "errorMessage": "..."
}
```

`finishReason` is one of `completed`, `error`, or `cost_cap`. The tool
returns `isError: true` for anything other than `completed`. `errorMessage`
is only present when `finishReason !== 'completed'`. For `cost_cap`, `text`
may still contain the partial response that streamed before pi was aborted.

### `pi_list_sessions`

No inputs. Returns every session known to this server process, sorted by
creation time.

Output (`structuredContent`):

```json
{
  "sessions": [
    {
      "sessionId": "0a2c...",
      "cwd": "/abs/path",
      "model": "openrouter:amazon/nova-micro-v1",
      "cumulativeCostUsd": 0.000456,
      "maxCostUsd": 0.5,
      "createdAt": 1747958400000,
      "lastActiveAt": 1747958412000
    }
  ]
}
```

`maxCostUsd` is `null` when no cap was set.

### `pi_close_session`

Disposes a session and frees its resources. Idempotent: closing an unknown
`sessionId` succeeds.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | yes | Session to close. |

Output (`structuredContent`):

```json
{ "closed": true }
```

`isError: true` only on unexpected disposal failure from pi itself.

## Inspecting sessions (`pi-sessions`)

The package also ships a read-only CLI that reads the JSONL transcripts pi
writes under `SESSION_DIR`. It works whether or not `pi-mcp-server` is
running, and never mutates a transcript.

```sh
pi-sessions                      # same as `pi-sessions list`
pi-sessions show bd6d6dc8        # unique id prefix, full id, or a .jsonl path
pi-sessions watch bd6d6dc8       # follow new messages as pi writes them
```

`list` prints one row per session with its inferred status, model, working
directory, last activity, message count and cumulative cost:

```
STATUS       SESSION    MODEL                         CWD                  LAST      MSGS     COST
running      bd6d6dc8…  opencode-go:deepseek-v4.1-f…  ~/code/app           12s ago    317  $0.1873
interrupted  df492fb9…  openrouter:qwen/qwen3.6-plus  ~/code/app            2h ago       9  $0.0041
```

Status values are inferred from the transcript, not reported by a live
process:

| Status | Meaning |
| --- | --- |
| `running` | Last entry is a user message, tool call or tool result, and it is newer than `--stale` (default `120s`). |
| `idle` | Last entry is an assistant message whose `stopReason` is not `toolUse` (the turn finished). |
| `interrupted` | Same shape as `running`, but no new entry for longer than `--stale`; usually an aborted turn or a session left behind by a stopped server. |
| `empty` | No messages yet. |
| `unreadable` | The file is missing, unreadable, or larger than 64 MiB. |

Useful flags:

| Flag | Command | Description |
| --- | --- | --- |
| `--cwd <path>` | list | Only sessions started in this directory or below it. |
| `--status <status>` | list | Filter by inferred status. |
| `--since <duration>` | list | Only sessions active within the window, e.g. `90m`, `24h`. |
| `--sort recent\|created\|cost\|status` | list | Sort order (default `recent`). |
| `--tail <n>` | show, watch | Messages to print (`show` default 20, `watch` default 10; 0 shows all). |
| `--full` | show, watch | Do not truncate message text or tool output. |
| `--thinking` | show, watch | Include `thinking` blocks, hidden by default. |
| `--from-start` | watch | Replay the whole transcript before following. |
| `--json` | all | Stable machine-readable output (NDJSON for `watch`). |
| `--dir <path>` | all | Override `SESSION_DIR` for this invocation. |

Caveats:

- Status is inferred at message granularity. While the model is generating a
  long reply pi has not written anything yet, so the CLI can only report that
  the previous entry is recent; expect a delay of up to one assistant message.
- Only sessions under `SESSION_DIR` are visible. Sessions created by the pi
  CLI itself (under `~/.pi/agent/sessions`) are out of scope.
- Directories left behind by a stopped server still show up. They look
  `idle` or `interrupted`; delete `SESSION_DIR/sessions/<id>` when you no
  longer need them.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3700` | HTTP port. Must be 1-65535. |
| `SESSION_DIR` | `~/.pi-mcp` | Root directory for per-session pi agent dirs. |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. JSON-line logs to stderr. |
| `OPENROUTER_API_KEY` | none | Passed through to pi sessions. Required if `~/.pi/agent/auth.json` doesn't carry an OAuth token. |
| `ANTHROPIC_API_KEY` | none | Same fallback chain. Other provider env vars pi knows about also work. |

The HTTP server binds `127.0.0.1` only and has no authentication. It
checks the `Host` header on every request and rejects mismatches with
`421 Misdirected Request` to defend against DNS rebinding from
attacker-controlled pages. If you need multi-machine access or auth, put a
reverse proxy in front; first-class auth and remote-binding support are
out of scope for this version. PRs welcome.

## Cost caps

`max_cost_usd` is enforced per session by two checks:

1. **Pre-flight.** Before every prompt, if cumulative spend is already
   at-or-past the cap, the prompt short-circuits without calling pi. It
   returns `finishReason: 'cost_cap'` and `costUsd: 0`.
2. **Mid-turn.** On every assistant `message_end`, the cumulative usage
   reported by pi is compared against the cap. If at-or-past, pi is
   aborted (best-effort) and the turn completes with `finishReason:
   'cost_cap'`. Any text that already streamed is preserved in the result.

The cap is not a hard guarantee. Pi may have an in-flight LLM call at the
moment the check fires; that call is allowed to complete its current
assistant message, which can push spend a small amount past the cap.
Subsequent prompts on the same session will then short-circuit pre-flight.
Set caps with some headroom.

## Models

Models are addressed by `provider:modelId`. Examples:

- `openrouter:anthropic/claude-3.5-haiku`
- `openrouter:amazon/nova-micro-v1`
- `openrouter:google/gemini-2.0-flash-exp:free`

Pi resolves the identifier through its own `ModelRegistry`. Anything pi
recognises, this server can use. For development and tests we lean on
`openrouter:amazon/nova-micro-v1` because a smoke run costs well under one
tenth of a cent.

## Limitations and known issues

- **No persistence across server restarts.** Sessions live in the server
  process. Pi writes its own JSONL session files under
  `~/.pi-mcp/sessions/<uuid>/`, but this server does not currently
  re-attach to them on startup. Restart the server, lose the session map.
- **Disk usage grows.** Each session leaves its `agentDir` behind. Clean
  up periodically with `rm -rf ~/.pi-mcp/sessions/` (or the Windows
  equivalent) when no live server is using it.
- **Windows signal handling is best-effort.** SIGINT works under most
  shells; if shutdown gets stuck, use `taskkill /PID <pid>`.
- **No authentication.** Bind is `127.0.0.1`. Don't expose the port on a
  public interface without putting auth in front.
- **One pi session per `sessionId`.** Concurrent sessions are isolated
  via per-session `agentDir`, so a busy server can run many sessions in
  parallel; a single session can only handle one prompt at a time.

## Development

```sh
npm install
npm run build           # tsc → dist/
npm run dev             # tsx watch src/index.ts
npm test                # vitest, 80 unit tests, no network
npm run typecheck       # tsc --noEmit
npm run sessions        # run the pi-sessions CLI from dist/
```

Live smokes hit real OpenRouter and need `OPENROUTER_API_KEY` set. Each
run costs less than $0.001 against `amazon/nova-micro-v1`.

```sh
npx tsx scripts/smoke-pi.ts    # PiSession against real OpenRouter
npx tsx scripts/smoke-l4.ts    # Full 4-tool MCP client end-to-end
npx tsx scripts/smoke-l5.ts    # Cost-cap behaviour, pre-flight + mid-turn
```

`npm run test:live` is a placeholder; the live coverage today is the smoke
scripts above.

## Architecture

```
Claude Code (MCP client, Streamable HTTP)
    |
    v
pi-mcp-server (Node, 127.0.0.1:3700/mcp)
    |  - one McpServer per HTTP MCP-Session-Id
    |  - one process-wide SessionManager
    |  - 10s notifications/progress heartbeat per prompt
    |  - DNS-rebinding Host-header check
    |
    +--> PiSession A (createAgentSession, isolated agentDir)
    +--> PiSession B (createAgentSession, isolated agentDir)
    +--> ...
```

Pi is consumed in-process via the `createAgentSession` SDK rather than as
a child process. This avoids JSONL framing fragility, gives us typed
events, and lets the server intercept usage updates on every
`message_end` for cost-cap enforcement.

## Contributing

Issues and PRs welcome at <https://github.com/a-fig/pi-mcp-server>. The
test suite is `npm test`; please keep it green and add a unit test for
any new behaviour. For changes that touch live pi, run the relevant smoke
script before opening the PR.

## License

MIT. See [LICENSE](./LICENSE).

## Acknowledgments

- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
  for the underlying agent SDK.
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
  for the MCP server and Streamable HTTP transport.
