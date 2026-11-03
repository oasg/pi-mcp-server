import fs from 'node:fs';
import path from 'node:path';

/**
 * Read-only inspection of the pi session files that pi-mcp-server leaves on
 * disk under `<sessionDir>/sessions/<mcpSessionId>/<ts>_<piSessionId>.jsonl`.
 *
 * Nothing here talks to a running server: everything is inferred from the
 * append-only JSONL transcript. That keeps the CLI usable when the server is
 * stopped, at the cost of the status being a heuristic rather than the
 * process's authoritative view (see `staleMs`).
 */

/** A turn that has produced no new entry for this long is assumed to be dead. */
export const DEFAULT_STALE_MS = 120_000;

/** Refuse to slurp absurdly large transcripts; they are almost certainly a bug. */
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

export type SessionStatus = 'running' | 'idle' | 'interrupted' | 'empty' | 'unreadable';

export interface RawUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cost?: { readonly total?: number };
}

export interface RawMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly usage?: RawUsage;
  readonly stopReason?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly durationMs?: number;
}

export interface RawEntry {
  readonly type: string;
  readonly id?: string;
  readonly parentId?: string | null;
  readonly timestamp?: string;
  readonly message?: RawMessage;
  readonly provider?: string;
  readonly modelId?: string;
  readonly name?: string;
}

export interface ParsedSessionFile {
  readonly file: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly entries: readonly RawEntry[];
  readonly parseErrors: number;
  /** Trailing fragment that is not valid JSON yet (a half-written line). */
  readonly partialLine: string;
  /** Set when the file could not be read at all (missing, unreadable, too big). */
  readonly readError: string | null;
}

export interface SessionSummary {
  readonly mcpSessionId: string;
  readonly piSessionId: string | null;
  readonly file: string;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly createdAt: number;
  readonly lastEventAt: number;
  readonly messageCount: number;
  readonly userTurns: number;
  readonly toolCalls: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly preview: string;
  readonly lastStopReason: string | null;
  readonly status: SessionStatus;
  readonly parseErrors: number;
  readonly sizeBytes: number;
}

export interface SummarizeOptions {
  /** Injectable clock, for tests. */
  readonly now?: number;
  /** How long a `running` turn may stay silent before it becomes `interrupted`. */
  readonly staleMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRawEntry(value: unknown): RawEntry | null {
  if (!isRecord(value)) return null;
  const type = value['type'];
  if (typeof type !== 'string') return null;
  return value as unknown as RawEntry;
}

function timestampOf(entry: RawEntry): number | null {
  if (typeof entry.timestamp !== 'string') return null;
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Parse a JSONL transcript. A final line without a trailing newline may be
 * mid-write, so a JSON error there is surfaced as `partialLine` instead of a
 * parse error; the caller can retry once the writer finishes.
 */
export function parseSessionContent(content: string): {
  readonly entries: RawEntry[];
  readonly parseErrors: number;
  readonly partialLine: string;
} {
  const entries: RawEntry[] = [];
  let parseErrors = 0;
  let partialLine = '';
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    try {
      const entry = toRawEntry(JSON.parse(line) as unknown);
      if (entry === null) parseErrors += 1;
      else entries.push(entry);
    } catch {
      if (i === lines.length - 1) partialLine = line;
      else parseErrors += 1;
    }
  }
  return { entries, parseErrors, partialLine };
}

/** Read and parse one transcript file. Never throws. */
export function readSessionFile(file: string): ParsedSessionFile {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat === undefined) {
    return {
      file,
      sizeBytes: 0,
      mtimeMs: 0,
      entries: [],
      parseErrors: 0,
      partialLine: '',
      readError: 'file not found',
    };
  }
  if (stat.size > MAX_SESSION_FILE_BYTES) {
    return {
      file,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      entries: [],
      parseErrors: 0,
      partialLine: '',
      readError: `file too large (${stat.size} bytes, limit ${MAX_SESSION_FILE_BYTES})`,
    };
  }
  try {
    const content = fs.readFileSync(file, 'utf8');
    const parsed = parseSessionContent(content);
    return {
      file,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      entries: parsed.entries,
      parseErrors: parsed.parseErrors,
      partialLine: parsed.partialLine,
      readError: null,
    };
  } catch (err) {
    return {
      file,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      entries: [],
      parseErrors: 0,
      partialLine: '',
      readError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Text blocks of a message, joined. Handles plain-string content too. */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
    }
  }
  return parts.join('\n');
}

export interface ToolCall {
  readonly name: string;
  readonly args: unknown;
}

export function toolCallsOf(message: RawMessage | undefined): ToolCall[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'toolCall') continue;
    calls.push({
      name: typeof block['name'] === 'string' ? block['name'] : 'unknown',
      args: block['arguments'],
    });
  }
  return calls;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function shorten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Turn a parsed transcript into the row we display. Everything is derived from
 * the entries themselves; `mtimeMs` is only a fallback for empty/legacy files.
 */
export function summarizeSession(
  parsed: ParsedSessionFile,
  mcpSessionId: string,
  opts: SummarizeOptions = {},
): SessionSummary {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;

  let piSessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let createdAt: number | null = null;
  let lastEntryAt: number | null = null;
  let messageCount = 0;
  let userTurns = 0;
  let toolCalls = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let firstUserText = '';
  let lastAssistantText = '';
  let lastStopReason: string | null = null;
  let lastRole: string | null = null;

  for (const entry of parsed.entries) {
    const ts = timestampOf(entry);
    if (ts !== null) {
      lastEntryAt = lastEntryAt === null ? ts : Math.max(lastEntryAt, ts);
      createdAt ??= ts;
    }
    if (entry.type === 'session') {
      if (typeof entry.id === 'string') piSessionId = entry.id;
      if (typeof entry.timestamp === 'string') {
        const headerTs = Date.parse(entry.timestamp);
        if (!Number.isNaN(headerTs)) createdAt = headerTs;
      }
      const headerCwd = (entry as { readonly cwd?: unknown }).cwd;
      if (typeof headerCwd === 'string' && headerCwd !== '') cwd = headerCwd;
      continue;
    }
    if (entry.type === 'model_change') {
      if (typeof entry.provider === 'string' && typeof entry.modelId === 'string') {
        model = `${entry.provider}:${entry.modelId}`;
      }
      continue;
    }
    if (entry.type !== 'message') continue;

    messageCount += 1;
    const message = entry.message;
    const role = typeof message?.role === 'string' ? message.role : 'unknown';
    lastRole = role;
    if (role === 'system') continue;

    if (role === 'user') {
      userTurns += 1;
      if (firstUserText === '') firstUserText = textOfContent(message?.content);
      continue;
    }
    if (role === 'assistant') {
      costUsd += numberOr(message?.usage?.cost?.total, 0);
      inputTokens += numberOr(message?.usage?.input, 0);
      outputTokens += numberOr(message?.usage?.output, 0);
      toolCalls += toolCallsOf(message).length;
      const text = textOfContent(message?.content);
      if (text !== '') lastAssistantText = text;
      if (typeof message?.stopReason === 'string') lastStopReason = message.stopReason;
    }
  }

  const lastEventAt = lastEntryAt ?? parsed.mtimeMs;

  const previewSource = firstUserText !== '' ? firstUserText : lastAssistantText;
  const preview = shorten(previewSource, 100);

  let status: SessionStatus;
  if (parsed.readError !== null) status = 'unreadable';
  else if (messageCount === 0) status = 'empty';
  else if (lastRole === 'assistant' && lastStopReason !== 'toolUse') status = 'idle';
  else status = now - lastEventAt <= staleMs ? 'running' : 'interrupted';

  return {
    mcpSessionId,
    piSessionId,
    file: parsed.file,
    cwd,
    model,
    createdAt: createdAt ?? parsed.mtimeMs,
    lastEventAt,
    messageCount,
    userTurns,
    toolCalls,
    costUsd,
    inputTokens,
    outputTokens,
    preview,
    lastStopReason,
    status,
    parseErrors: parsed.parseErrors,
    sizeBytes: parsed.sizeBytes,
  };
}

export interface DiscoveredSession {
  readonly mcpSessionId: string;
  readonly file: string;
}

/** Resolve `<sessionDir>/sessions`; defaults are applied by the caller. */
export function sessionsRoot(sessionDir: string): string {
  return path.join(sessionDir, 'sessions');
}

/**
 * Find the transcript to use per session directory. A directory currently holds
 * exactly one JSONL file, but pi can create more when a session branches, so we
 * pick the most recently modified one.
 */
export function discoverSessionFiles(sessionDir: string): DiscoveredSession[] {
  const root = sessionsRoot(sessionDir);
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered: DiscoveredSession[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = path.join(root, dir.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    let newest: { file: string; mtimeMs: number } | null = null;
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const filePath = path.join(full, file.name);
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (newest === null || stat.mtimeMs > newest.mtimeMs) {
        newest = { file: filePath, mtimeMs: stat.mtimeMs };
      }
    }
    if (newest !== null) {
      discovered.push({ mcpSessionId: dir.name, file: newest.file });
    }
  }
  return discovered;
}

export interface ScanOptions extends SummarizeOptions {
  readonly sessionDir: string;
}

/** Summarize every session under `<sessionDir>/sessions`, newest activity first. */
export function scanSessions(opts: ScanOptions): SessionSummary[] {
  const summaries = discoverSessionFiles(opts.sessionDir).map((found) =>
    summarizeSession(readSessionFile(found.file), found.mcpSessionId, opts),
  );
  summaries.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return summaries;
}

export interface ResolveResult {
  /** Unique match, if there is one. */
  readonly session: SessionSummary | null;
  /** Prefix/equality candidates when the target was ambiguous or missing. */
  readonly candidates: readonly SessionSummary[];
}

/**
 * Resolve a user-supplied target: a full JSONL path, a complete session id, or
 * a unique id prefix.
 */
export function resolveSession(
  target: string,
  opts: ScanOptions,
): ResolveResult {
  if (target.endsWith('.jsonl') || target.includes(path.sep)) {
    const file = path.resolve(target);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) return { session: null, candidates: [] };
    const mcpSessionId = path.basename(path.dirname(file));
    const session = summarizeSession(readSessionFile(file), mcpSessionId, opts);
    return { session, candidates: [session] };
  }

  const sessions = scanSessions(opts);
  const exact = sessions.find((s) => s.mcpSessionId === target);
  if (exact !== undefined) return { session: exact, candidates: sessions };

  const matches = sessions.filter((s) => s.mcpSessionId.startsWith(target));
  if (matches.length === 1) {
    const only = matches[0];
    return { session: only ?? null, candidates: sessions };
  }
  return { session: null, candidates: matches };
}
