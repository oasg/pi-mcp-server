#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PACKAGE_VERSION } from '../pkg.js';
import {
  DEFAULT_STALE_MS,
  readSessionFile,
  resolveSession,
  scanSessions,
  sessionsRoot,
  type SessionSummary,
} from '../sessions/inspect.js';
import {
  createPalette,
  formatCompact,
  formatDateTime,
  formatRelativeTime,
  formatUsd,
  prettyCwd,
  renderTable,
  truncate,
  type Palette,
} from './format.js';
import { renderEntry, styleStatus } from './render.js';
import { watchSession } from './watch.js';

const USAGE = `pi-sessions ${PACKAGE_VERSION} — inspect pi sessions created by pi-mcp-server

Usage:
  pi-sessions [list] [options]
  pi-sessions show <sessionId|id-prefix|path.jsonl> [options]
  pi-sessions watch [sessionId|id-prefix] [options]

Sessions are read from <SESSION_DIR>/sessions/<mcpSessionId>/*.jsonl.
SESSION_DIR defaults to ~/.pi-mcp, matching pi-mcp-server.

Options:
  --dir <path>        Session root directory (overrides SESSION_DIR)
  --json              Machine-readable output (NDJSON for watch)
  --no-color          Disable ANSI colour
  --stale <dur>       Silence after which "running" becomes "interrupted" (default 120s)
  -h, --help          Show this help
  -v, --version       Print the version

list:
  --cwd <path>        Only sessions started in this directory (or below it)
  --status <status>   running | idle | interrupted | empty | unreadable
  --since <dur>       Only sessions active within this window (e.g. 24h, 90m)
  --sort <key>        recent (default) | cost | created | status
  --limit <n>         Maximum number of rows

show:
  --tail <n>          Show the last n messages (default 20, 0 = all)
  --full              Do not truncate message text or tool output
  --thinking          Include model thinking blocks

watch:
  --from-start        Replay the whole transcript before following
  --tail <n>          Messages to print before following (default 10)
  --interval <dur>    Polling fallback interval (default 500ms)
  --full, --thinking  Same meaning as for show
`;

class UsageError extends Error {}

const KNOWN_COMMANDS = new Set(['list', 'show', 'watch', 'help']);
const STATUSES = new Set(['running', 'idle', 'interrupted', 'empty', 'unreadable']);

type Command = 'list' | 'show' | 'watch' | 'help';

interface GlobalOptions {
  readonly sessionDir: string;
  readonly now: number;
  readonly staleMs: number;
  readonly palette: Palette;
}

function expandHome(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  return input;
}

function resolveSessionDir(raw: string | undefined): string {
  const envValue = process.env['SESSION_DIR'];
  const chosen = raw ?? (envValue === undefined || envValue === '' ? undefined : envValue);
  if (chosen === undefined) return path.join(os.homedir(), '.pi-mcp');
  return path.resolve(expandHome(chosen, os.homedir()));
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;

function parseDuration(raw: string, flag: string): number {
  const match = DURATION_RE.exec(raw.trim());
  if (match === null) {
    throw new UsageError(`${flag} expects a duration such as 500ms, 30s, 5m, 2h or 1d`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1_000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
  return value * factor;
}

function parseCount(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new UsageError(`${flag} expects a non-negative integer`);
  return Number.parseInt(raw, 10);
}

function shortId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 8)}…`;
}

function listRows(
  sessions: readonly SessionSummary[],
  opts: GlobalOptions,
): string {
  const home = os.homedir();
  const rows = sessions.map((s) => [
    styleStatus(s.status, opts.palette).text,
    shortId(s.mcpSessionId),
    truncate(s.model ?? '-', 28),
    truncate(prettyCwd(s.cwd, home), 36),
    formatRelativeTime(s.lastEventAt, opts.now),
    String(s.messageCount),
    formatUsd(s.costUsd),
  ]);
  return renderTable(
    ['STATUS', 'SESSION', 'MODEL', 'CWD', 'LAST', 'MSGS', 'COST'],
    rows,
    ['left', 'left', 'left', 'left', 'left', 'right', 'right'],
  );
}

function sortSessions(
  sessions: SessionSummary[],
  key: string,
): SessionSummary[] {
  switch (key) {
    case 'recent':
      return sessions.sort((a, b) => b.lastEventAt - a.lastEventAt);
    case 'created':
      return sessions.sort((a, b) => b.createdAt - a.createdAt);
    case 'cost':
      return sessions.sort((a, b) => b.costUsd - a.costUsd);
    case 'status':
      return sessions.sort((a, b) => a.status.localeCompare(b.status) || b.lastEventAt - a.lastEventAt);
    default:
      throw new UsageError(`--sort expects one of recent, created, cost, status (got ${JSON.stringify(key)})`);
  }
}

function filterSessions(
  sessions: SessionSummary[],
  values: Record<string, unknown>,
): SessionSummary[] {
  let out = sessions;

  if (typeof values['cwd'] === 'string') {
    const target = path.resolve(expandHome(values['cwd'], os.homedir()));
    out = out.filter(
      (s) => s.cwd !== null && (s.cwd === target || s.cwd.startsWith(`${target}${path.sep}`)),
    );
  }

  if (typeof values['status'] === 'string') {
    const status = values['status'];
    if (!STATUSES.has(status)) {
      throw new UsageError(`--status expects one of ${[...STATUSES].join(', ')}`);
    }
    out = out.filter((s) => s.status === status);
  }

  if (typeof values['since'] === 'string') {
    const windowMs = parseDuration(values['since'], '--since');
    const cutoff = Date.now() - windowMs;
    out = out.filter((s) => s.lastEventAt >= cutoff);
  }

  return out;
}

function reportNoMatch(
  target: string,
  candidates: readonly SessionSummary[],
  sessionDir: string,
  palette: Palette,
): void {
  if (candidates.length > 1) {
    process.stderr.write(`multiple sessions match ${JSON.stringify(target)}:\n`);
    for (const s of candidates) {
      process.stderr.write(
        `  - ${s.mcpSessionId}  ${styleStatus(s.status, palette).text}  ` +
          `${s.model ?? '-'}  ${formatRelativeTime(s.lastEventAt)}\n`,
      );
    }
    return;
  }
  process.stderr.write(
    `no session matched ${JSON.stringify(target)} under ${sessionsRoot(sessionDir)}\n` +
      'run `pi-sessions list` to see the available sessions\n',
  );
}

function commandList(
  values: Record<string, unknown>,
  opts: GlobalOptions,
): number {
  let sessions = scanSessions({
    sessionDir: opts.sessionDir,
    now: opts.now,
    staleMs: opts.staleMs,
  });
  sessions = filterSessions(sessions, values);
  sessions = sortSessions(sessions, typeof values['sort'] === 'string' ? values['sort'] : 'recent');
  const limit = parseCount(
    typeof values['limit'] === 'string' ? values['limit'] : undefined,
    '--limit',
    0,
  );
  if (limit > 0) sessions = sessions.slice(0, limit);

  if (values['json'] === true) {
    process.stdout.write(`${JSON.stringify({ sessions }, null, 2)}\n`);
    return 0;
  }

  if (sessions.length === 0) {
    process.stdout.write(`no sessions under ${sessionsRoot(opts.sessionDir)}\n`);
    return 0;
  }

  const root = truncate(sessionsRoot(opts.sessionDir), 80);
  process.stdout.write(
    `${opts.palette.dim(`${sessions.length} session(s) · ${root}`)}\n` +
      `${listRows(sessions, opts)}\n`,
  );
  return 0;
}

function commandShow(
  target: string | undefined,
  values: Record<string, unknown>,
  opts: GlobalOptions,
): number {
  if (target === undefined) {
    throw new UsageError('show requires a session id, id prefix or .jsonl path');
  }

  const resolved = resolveSession(target, {
    sessionDir: opts.sessionDir,
    now: opts.now,
    staleMs: opts.staleMs,
  });
  if (resolved.session === null) {
    reportNoMatch(target, resolved.candidates, opts.sessionDir, opts.palette);
    return 1;
  }

  const session = resolved.session;
  const parsed = readSessionFile(session.file);

  if (values['json'] === true) {
    process.stdout.write(
      `${JSON.stringify({ session, entries: parsed.entries, readError: parsed.readError }, null, 2)}\n`,
    );
    return 0;
  }

  const p = opts.palette;
  const home = os.homedir();
  const status = styleStatus(session.status, p);
  const lines: string[] = [];
  lines.push(`${p.bold('session')}   ${session.mcpSessionId}`);
  if (session.piSessionId !== null) lines.push(`pi id     ${session.piSessionId}`);
  lines.push(`model     ${session.model ?? '-'}`);
  lines.push(`cwd       ${prettyCwd(session.cwd, home)}`);
  lines.push(
    `created   ${formatDateTime(session.createdAt)} (${formatRelativeTime(session.createdAt, opts.now)})`,
  );
  lines.push(
    `status    ${status.colored} (last event ${formatRelativeTime(session.lastEventAt, opts.now)})`,
  );
  lines.push(
    `usage     ${session.messageCount} entries (${session.userTurns} user, ${session.toolCalls} tool call${session.toolCalls === 1 ? '' : 's'})`,
  );
  lines.push(
    `          in ${formatCompact(session.inputTokens)} / out ${formatCompact(session.outputTokens)} tokens · ${formatUsd(session.costUsd)}`,
  );
  lines.push(`file      ${session.file}`);
  if (session.parseErrors > 0) {
    lines.push(`warn      ${session.parseErrors} unparseable line(s) skipped`);
  }
  if (parsed.readError !== null) lines.push(p.red(`error     ${parsed.readError}`));
  lines.push(p.dim('---'));

  const tail = parseCount(
    typeof values['tail'] === 'string' ? values['tail'] : undefined,
    '--tail',
    20,
  );
  const messages = parsed.entries.filter(
    (entry) => entry.type === 'message' && entry.message?.role !== 'system',
  );
  const shown = tail === 0 ? messages : messages.slice(-tail);
  for (const entry of shown) {
    const rendered = renderEntry(entry, {
      palette: p,
      full: values['full'] === true,
      thinking: values['thinking'] === true,
    });
    if (rendered !== null) lines.push(rendered);
  }
  if (tail !== 0 && messages.length > shown.length) {
    lines.push(p.dim(`… ${messages.length - shown.length} older message(s) hidden (--tail 0 for all)`));
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function commandWatch(
  target: string | undefined,
  values: Record<string, unknown>,
  opts: GlobalOptions,
): number {
  const scanOpts = {
    sessionDir: opts.sessionDir,
    now: opts.now,
    staleMs: opts.staleMs,
  };

  let session: SessionSummary | null = null;
  if (target === undefined) {
    const sessions = scanSessions(scanOpts);
    session = sessions.find((s) => s.status === 'running') ?? sessions[0] ?? null;
    if (session === null) {
      process.stderr.write(`no sessions under ${sessionsRoot(opts.sessionDir)}\n`);
      return 0;
    }
  } else {
    const resolved = resolveSession(target, scanOpts);
    if (resolved.session === null) {
      reportNoMatch(target, resolved.candidates, opts.sessionDir, opts.palette);
      return 1;
    }
    session = resolved.session;
  }

  const tail = parseCount(
    typeof values['tail'] === 'string' ? values['tail'] : undefined,
    '--tail',
    10,
  );
  const intervalMs = parseDuration(
    typeof values['interval'] === 'string' ? values['interval'] : '500ms',
    '--interval',
  );

  watchSession({
    file: session.file,
    mcpSessionId: session.mcpSessionId,
    fromStart: values['from-start'] === true,
    tail,
    json: values['json'] === true,
    palette: opts.palette,
    full: values['full'] === true,
    thinking: values['thinking'] === true,
    intervalMs,
  });
  return 0;
}

function main(argv: readonly string[]): number {
  let parsedArgs;
  try {
    parsedArgs = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        dir: { type: 'string' },
        json: { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        stale: { type: 'string' },
        limit: { type: 'string' },
        cwd: { type: 'string' },
        status: { type: 'string' },
        since: { type: 'string' },
        sort: { type: 'string' },
        tail: { type: 'string' },
        full: { type: 'boolean', default: false },
        thinking: { type: 'boolean', default: false },
        'from-start': { type: 'boolean', default: false },
        interval: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 1;
  }

  const { values, positionals } = parsedArgs;
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version === true) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }

  const first = positionals[0];
  let command: Command = 'list';
  let target: string | undefined;
  if (first !== undefined) {
    if (KNOWN_COMMANDS.has(first)) {
      command = first as Command;
      target = positionals[1];
    } else {
      command = 'show';
      target = first;
    }
  }
  if (command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const sessionDir = resolveSessionDir(typeof values.dir === 'string' ? values.dir : undefined);
  const useColor =
    values['no-color'] !== true &&
    process.stdout.isTTY === true &&
    process.env['NO_COLOR'] === undefined &&
    process.env['TERM'] !== 'dumb';
  const opts: GlobalOptions = {
    sessionDir,
    now: Date.now(),
    staleMs:
      typeof values.stale === 'string'
        ? parseDuration(values.stale, '--stale')
        : DEFAULT_STALE_MS,
    palette: createPalette(useColor),
  };

  try {
    if (command === 'list') return commandList(values, opts);
    if (command === 'show') return commandShow(target, values, opts);
    return commandWatch(target, values, opts);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`pi-sessions: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
