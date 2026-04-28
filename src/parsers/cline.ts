import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionNotes, UnifiedSession } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { truncate } from '../utils/tool-summarizer.js';

const require = createRequire(import.meta.url);

// ── Extension Configs ───────────────────────────────────────────────────────

/**
 * All Cline-family extensions share the same ui_messages.json format.
 * Each entry maps a VS Code extension ID to the source label used in UnifiedSession.
 */
const CLINE_EXTENSIONS = [
  { id: 'saoudrizwan.claude-dev', source: 'cline' },
  { id: 'rooveterinaryinc.roo-cline', source: 'roo-code' },
  { id: 'roo-code.roo-cline', source: 'roo-code' },
  { id: 'kilocode.kilo-code', source: 'kilo-code' },
] as const;

type ClineSource = (typeof CLINE_EXTENSIONS)[number]['source'];

// ── Raw Message Shape ───────────────────────────────────────────────────────

/** Single entry in ui_messages.json */
interface ClineRawMessage {
  ts?: number;
  type: string;
  say?: string;
  ask?: string;
  text?: string;
  reasoning?: string;
  images?: string[];
  partial?: boolean;
}

type ConversationRole = 'user' | 'assistant';

interface ConversationState {
  hasSeenApiRequest: boolean;
}

interface StreamState {
  index: number;
  role: ConversationRole;
  kind: string;
}

interface SqlitePreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

interface KiloDbSchema {
  session: Set<string>;
  message: Set<string>;
  part: Set<string>;
  project: Set<string>;
  supported: boolean;
  warnings: string[];
}

interface KiloDbMessageRead {
  messages: ConversationMessage[];
  notes: SessionNotes;
  rowCount: number;
  firstTimestamp?: Date;
  lastTimestamp?: Date;
}

// ── Path Discovery ──────────────────────────────────────────────────────────

/**
 * Build candidate globalStorage base directories for the current platform.
 * Covers VS Code, VS Code Insiders, and Cursor on macOS / Linux / Windows.
 */
function getGlobalStorageBases(): string[] {
  const home = homeDir();
  const bases: string[] = [];

  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    bases.push(
      path.join(appSupport, 'Code', 'User', 'globalStorage'),
      path.join(appSupport, 'Code - Insiders', 'User', 'globalStorage'),
      path.join(appSupport, 'Cursor', 'User', 'globalStorage'),
      path.join(appSupport, 'Windsurf', 'User', 'globalStorage'),
    );
  } else if (process.platform === 'linux') {
    bases.push(
      path.join(home, '.config', 'Code', 'User', 'globalStorage'),
      path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage'),
      path.join(home, '.config', 'Cursor', 'User', 'globalStorage'),
      path.join(home, '.config', 'Windsurf', 'User', 'globalStorage'),
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    bases.push(
      path.join(appData, 'Code', 'User', 'globalStorage'),
      path.join(appData, 'Code - Insiders', 'User', 'globalStorage'),
      path.join(appData, 'Cursor', 'User', 'globalStorage'),
      path.join(appData, 'Windsurf', 'User', 'globalStorage'),
    );
  }

  return bases;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover all task directories for a given extension across all IDE locations.
 * Returns tuples of (task-id directory path, extension source label).
 */
async function discoverTaskDirs(): Promise<Array<{ taskDir: string; taskId: string; source: ClineSource }>> {
  const bases = getGlobalStorageBases();
  const results: Array<{ taskDir: string; taskId: string; source: ClineSource }> = [];

  for (const base of bases) {
    if (!(await pathExists(base))) continue;

    for (const ext of CLINE_EXTENSIONS) {
      const tasksRoot = path.join(base, ext.id, 'tasks');
      if (!(await pathExists(tasksRoot))) continue;

      try {
        const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const taskDir = path.join(tasksRoot, entry.name);
          const uiFile = path.join(taskDir, 'ui_messages.json');
          if (await pathExists(uiFile)) {
            results.push({ taskDir, taskId: entry.name, source: ext.source });
          }
        }
      } catch (err) {
        logger.debug(`cline: cannot read tasks dir ${tasksRoot}`, err);
      }
    }
  }

  return results;
}

// ── Kilo Code SQLite Discovery ──────────────────────────────────────────────

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function cleanEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build the ordered list of candidate Kilo data roots. The default app
 * directory upstream is the literal "kilo" name appended to xdg-basedir's
 * data root (packages/opencode/src/global/index.ts: `const app = "kilo"`),
 * so on every platform Kilo first writes under `$XDG_DATA_HOME/kilo` or
 * `~/.local/share/kilo`. The macOS / Windows fallbacks below are defensive
 * paths for non-default installs (sandboxed environments, custom XDG layouts
 * that mirror native OS conventions). Upstream Kilo does NOT itself write to
 * `~/Library/Application Support/kilo` or `%APPDATA%\kilo`; we probe them
 * only so a non-canonical install does not silently disappear from discovery.
 */
function getKiloDataRoots(): string[] {
  const home = homeDir();
  const roots: string[] = [];
  const xdgDataHome = cleanEnvPath(process.env.XDG_DATA_HOME);

  if (xdgDataHome) roots.push(path.join(xdgDataHome, 'kilo'));

  // Kilo's canonical default on every platform via xdg-basedir fallback.
  roots.push(path.join(home, '.local', 'share', 'kilo'));

  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'kilo'));
  } else if (process.platform === 'win32') {
    const localAppData = cleanEnvPath(process.env.LOCALAPPDATA);
    const appData = cleanEnvPath(process.env.APPDATA);
    if (localAppData) roots.push(path.join(localAppData, 'kilo'));
    if (appData) roots.push(path.join(appData, 'kilo'));
  }

  return uniquePaths(roots);
}

function getKiloDbCandidatePaths(): string[] {
  const kiloDb = cleanEnvPath(process.env.KILO_DB);
  if (kiloDb) {
    if (kiloDb === ':memory:') return [];
    if (path.isAbsolute(kiloDb)) return [kiloDb];
    return uniquePaths(getKiloDataRoots().map((root) => path.join(root, kiloDb)));
  }

  return uniquePaths(getKiloDataRoots().map((root) => path.join(root, 'kilo.db')));
}

async function discoverKiloDbPaths(): Promise<string[]> {
  const dbPaths: string[] = [];
  for (const dbPath of getKiloDbCandidatePaths()) {
    if (await pathExists(dbPath)) dbPaths.push(dbPath);
  }
  return dbPaths;
}

/**
 * Open Kilo's SQLite session store strictly read-only. Read-only is enforced
 * via `node:sqlite`'s `readOnly: true` flag (Node.js v22+; verified at
 * runtime by our integration test, which asserts that any write through this
 * handle throws). Read-only is non-negotiable: this parser must never mutate
 * a user's `kilo.db`.
 */
function openKiloDb(dbPath: string): { db: SqliteDatabase; close: () => void } | null {
  try {
    const sqliteModule = require('node:sqlite') as {
      DatabaseSync: new (database: string, options?: { open?: boolean; readOnly?: boolean }) => SqliteDatabase;
    };
    const db = new sqliteModule.DatabaseSync(dbPath, { open: true, readOnly: true });
    return { db, close: () => db.close() };
  } catch (err) {
    logger.debug('kilo-code: failed to open SQLite database', dbPath, err);
    return null;
  }
}

function tableColumns(db: SqliteDatabase, tableName: 'session' | 'message' | 'part' | 'project'): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const columns = new Set<string>();
    for (const row of rows) {
      if (isRecord(row) && typeof row.name === 'string') columns.add(row.name);
    }
    return columns;
  } catch (err) {
    logger.debug('kilo-code: failed to inspect SQLite table', tableName, err);
    return new Set();
  }
}

function missingColumns(columns: Set<string>, required: readonly string[]): string[] {
  return required.filter((column) => !columns.has(column));
}

function inspectKiloDbSchema(db: SqliteDatabase): KiloDbSchema {
  const schema: KiloDbSchema = {
    session: tableColumns(db, 'session'),
    message: tableColumns(db, 'message'),
    part: tableColumns(db, 'part'),
    project: tableColumns(db, 'project'),
    supported: true,
    warnings: [],
  };

  const required: Array<[keyof Pick<KiloDbSchema, 'session' | 'message' | 'part'>, readonly string[]]> = [
    ['session', ['id']],
    ['message', ['id', 'session_id', 'data']],
    ['part', ['message_id', 'data']],
  ];

  for (const [tableName, requiredColumns] of required) {
    const columns = schema[tableName];
    if (columns.size === 0) {
      schema.warnings.push(`Kilo SQLite schema unsupported: missing "${tableName}" table.`);
      continue;
    }

    const missing = missingColumns(columns, requiredColumns);
    if (missing.length > 0) {
      schema.warnings.push(
        `Kilo SQLite schema unsupported: "${tableName}" table is missing column(s): ${missing.join(', ')}.`,
      );
    }
  }

  schema.supported = schema.warnings.length === 0;
  return schema;
}

function warnKiloDbFidelity(dbPath: string, warnings: string[]): void {
  if (warnings.length === 0) return;
  logger.warn('kilo-code: skipping SQLite database with unsupported schema', dbPath, warnings.join(' '));
}

// ── Message Parsing ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
}

function normalizeRawMessage(value: unknown): ClineRawMessage | null {
  if (!isRecord(value)) return null;

  const type = readString(value, 'type');
  if (!type) return null;

  return {
    type,
    ts: readNumber(value, 'ts'),
    say: readString(value, 'say'),
    ask: readString(value, 'ask'),
    text: readString(value, 'text'),
    reasoning: readString(value, 'reasoning'),
    images: readStringArray(value, 'images'),
    partial: readBoolean(value, 'partial'),
  };
}

/** Read and parse ui_messages.json, returning an empty array on failure */
async function readUiMessages(filePath: string): Promise<ClineRawMessage[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRawMessage).filter((msg): msg is ClineRawMessage => msg !== null);
  } catch (err) {
    logger.debug('cline: failed to parse ui_messages.json', filePath, err);
    return [];
  }
}

function messageText(msg: ClineRawMessage): string | undefined {
  return msg.say === 'reasoning' ? (msg.reasoning ?? msg.text) : msg.text;
}

function isApiRequestMetadata(msg: ClineRawMessage): boolean {
  return msg.type === 'say' && (msg.say === 'api_req_started' || msg.say === 'api_req_finished');
}

function parseJsonRecord(value: unknown, context: string): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch (err) {
    logger.debug('kilo-code: failed to parse SQLite JSON', context, err);
    return null;
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value?.trim()) return value;
  }
  return undefined;
}

function previewValue(value: unknown, maxLength = 160): string {
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' ').trim(), maxLength);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  try {
    return truncate(JSON.stringify(value).replace(/\s+/g, ' ').trim(), maxLength);
  } catch (err) {
    logger.debug('kilo-code: failed to stringify SQLite part preview', err);
    return '';
  }
}

function timestampFromValue(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function roleFromMessageData(data: Record<string, unknown>): ConversationMessage['role'] | null {
  const role = readString(data, 'role');
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  return null;
}

/**
 * Convert a Kilo part record into a single-line preview string for the
 * cross-tool handoff conversation.
 *
 * Design decision (per PR open question on tool-part fidelity):
 *   We summarize tool / patch / snapshot / agent / compaction / file / subtask
 *   parts as `[type] preview` text rather than projecting them as structured
 *   ConversationMessage.toolCall records. The rest of the Cline-family pipeline
 *   feeds a markdown handoff (see `generateHandoffMarkdown`) — preview text
 *   keeps the next-tool prompt compact, faithful to source ordering, and
 *   consistent with how the legacy `ui_messages.json` path already flattens
 *   tool activity into prose. Promoting these to structured tool calls would
 *   require a parallel toolSummaries pipeline that the handoff renderer does
 *   not currently consume.
 *
 * Part types covered (Kilo MessageV2 schema, packages/opencode/src/session/message-v2.ts):
 *   text, reasoning, tool, file, snapshot, patch, agent, compaction, subtask, retry
 *
 * Part types intentionally elided (internal markers without user-meaningful prose):
 *   step-start, step-finish — token totals are read at the message level via
 *   `addKiloTokenUsage`; carrying them in conversation would dilute signal.
 */
function extractKiloPartContent(partData: Record<string, unknown>): string {
  const type = readString(partData, 'type');

  if (type === 'text') {
    return firstString(partData, ['text', 'content', 'message']) ?? '';
  }

  if (type === 'reasoning') {
    const text = firstString(partData, ['text', 'summary', 'content']);
    return text ? `[reasoning] ${text}` : '';
  }

  if (type === 'tool') {
    const toolName = readString(partData, 'tool') ?? readString(partData, 'name') ?? 'tool';
    const state = readRecord(partData, 'state');
    const status = state ? readString(state, 'status') : undefined;
    const input = state ? previewValue(state.input, 90) : previewValue(partData.input, 90);
    const output = state
      ? previewValue(state.output ?? state.error, 120)
      : previewValue(partData.output ?? partData.error, 120);
    const label = status && status !== 'completed' ? `[tool:${toolName}:${status}]` : `[tool:${toolName}]`;
    return [label, input, output].filter(Boolean).join(' ');
  }

  if (type === 'file') {
    const filename = readString(partData, 'filename') ?? readString(partData, 'name') ?? '';
    const mime = readString(partData, 'mime') ?? readString(partData, 'mediaType');
    const url = readString(partData, 'url');
    const descriptor = filename || url || mime || 'attachment';
    return mime && filename ? `[file] ${descriptor} (${mime})` : `[file] ${descriptor}`;
  }

  if (type === 'subtask') {
    const agent = readString(partData, 'agent') ?? 'subtask';
    const description = firstString(partData, ['description', 'prompt', 'command']) ?? '';
    return description ? `[subtask:${agent}] ${description}` : `[subtask:${agent}]`;
  }

  if (type === 'retry') {
    const attempt = readNumber(partData, 'attempt');
    const error = readRecord(partData, 'error');
    const errorMessage =
      (error && firstString(error, ['message', 'name', 'code'])) ?? readString(partData, 'error') ?? '';
    const prefix = attempt !== undefined ? `[retry:${attempt}]` : '[retry]';
    return errorMessage ? `${prefix} ${errorMessage}` : prefix;
  }

  if (type === 'patch' || type === 'snapshot' || type === 'agent' || type === 'compaction') {
    const preview = firstString(partData, ['text', 'summary', 'content', 'diff', 'message']) ?? previewValue(partData);
    return preview ? `[${type}] ${preview}` : '';
  }

  // step-start, step-finish: deliberately empty — tracked at message level only.
  return '';
}

function addKiloTokenUsage(notes: SessionNotes, messageData: Record<string, unknown>): void {
  const tokens = readRecord(messageData, 'tokens');
  const usage = readRecord(messageData, 'usage');
  if (!tokens && !usage) return;

  const input =
    (tokens && (readNumber(tokens, 'input') ?? readNumber(tokens, 'inputTokens'))) ??
    (usage && (readNumber(usage, 'input_tokens') ?? readNumber(usage, 'inputTokens'))) ??
    0;
  const output =
    (tokens && (readNumber(tokens, 'output') ?? readNumber(tokens, 'outputTokens'))) ??
    (usage && (readNumber(usage, 'output_tokens') ?? readNumber(usage, 'outputTokens'))) ??
    0;

  if (input > 0 || output > 0) {
    notes.tokenUsage = {
      input: (notes.tokenUsage?.input ?? 0) + input,
      output: (notes.tokenUsage?.output ?? 0) + output,
    };
  }

  const reasoning =
    (tokens && readNumber(tokens, 'reasoning')) ?? (usage && readNumber(usage, 'reasoning_tokens')) ?? 0;
  if (reasoning > 0) notes.thinkingTokens = (notes.thinkingTokens ?? 0) + reasoning;

  const cache = tokens && readRecord(tokens, 'cache');
  const cacheRead =
    (cache && readNumber(cache, 'read')) ??
    (tokens && readNumber(tokens, 'cacheRead')) ??
    (usage && readNumber(usage, 'cache_read_input_tokens')) ??
    0;
  const cacheCreation =
    (cache && (readNumber(cache, 'write') ?? readNumber(cache, 'creation'))) ??
    (tokens && readNumber(tokens, 'cacheWrite')) ??
    (usage && readNumber(usage, 'cache_creation_input_tokens')) ??
    0;

  if (cacheRead > 0 || cacheCreation > 0) {
    notes.cacheTokens = {
      read: (notes.cacheTokens?.read ?? 0) + cacheRead,
      creation: (notes.cacheTokens?.creation ?? 0) + cacheCreation,
    };
  }
}

function addKiloReasoning(partData: Record<string, unknown>, reasoning: string[], maxHighlights: number): void {
  if (reasoning.length >= maxHighlights || readString(partData, 'type') !== 'reasoning') return;
  const text = firstString(partData, ['text', 'summary', 'content']);
  if (!text || text.length < 10) return;
  reasoning.push(truncate(text.trim(), 200));
}

function selectColumns(columns: Set<string>, preferred: readonly string[]): string {
  return preferred.filter((column) => columns.has(column)).join(', ');
}

function orderBy(columns: Set<string>, preferred: string, fallback: string): string {
  if (columns.has(preferred) && columns.has(fallback)) return `${preferred} ASC, ${fallback} ASC`;
  if (columns.has(preferred)) return `${preferred} ASC`;
  if (columns.has(fallback)) return `${fallback} ASC`;
  return 'rowid ASC';
}

interface KiloDbDiscoverySummary {
  rowCount: number;
  firstUserMessage: string;
  model?: string;
  firstTimestamp?: Date;
  lastTimestamp?: Date;
}

/**
 * Lightweight summary used during session discovery.
 *
 * Issues a single message query (no parts) to determine row count and
 * timestamps, then makes at most two follow-up part queries to recover
 * the first-user content (for summary fallback) and model (for the
 * unified session card). Avoids the N+1 message/part scan that the
 * full extraction path requires, so listing remains fast on large DBs.
 */
function readKiloDbDiscoverySummary(
  db: SqliteDatabase,
  schema: KiloDbSchema,
  sessionId: string,
): KiloDbDiscoverySummary {
  const messageColumns = selectColumns(schema.message, ['id', 'time_created', 'data']);
  let msgRows: unknown[];
  try {
    msgRows = db
      .prepare(
        `SELECT ${messageColumns} FROM message WHERE session_id = ? ORDER BY ${orderBy(schema.message, 'time_created', 'id')}`,
      )
      .all(sessionId);
  } catch (err) {
    logger.debug('kilo-code: failed to read message metadata for discovery', sessionId, err);
    return { rowCount: 0, firstUserMessage: '' };
  }

  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;
  let firstUserMessageId: string | undefined;
  let firstAssistantMessageId: string | undefined;
  let model: string | undefined;

  for (const msgRow of msgRows) {
    if (!isRecord(msgRow)) continue;
    const messageId = readString(msgRow, 'id');
    if (!messageId) continue;

    const messageData = parseJsonRecord(msgRow.data, `message:${messageId}`);
    if (!messageData) continue;

    const role = roleFromMessageData(messageData);
    if (!role) continue;

    const timestamp = timestampFromValue(msgRow.time_created);
    if (timestamp) {
      if (!firstTimestamp || timestamp.getTime() < firstTimestamp.getTime()) firstTimestamp = timestamp;
      if (!lastTimestamp || timestamp.getTime() > lastTimestamp.getTime()) lastTimestamp = timestamp;
    }

    if (role === 'user' && !firstUserMessageId) firstUserMessageId = messageId;
    if (role === 'assistant' && !firstAssistantMessageId) {
      firstAssistantMessageId = messageId;
      if (!model) {
        model = firstString(messageData, ['modelID', 'modelId', 'model', 'providerID', 'providerId']);
      }
    }

    if (firstUserMessageId && firstAssistantMessageId && model) break;
  }

  const firstUserMessage = firstUserMessageId ? readKiloDbPartsContent(db, schema, firstUserMessageId) : '';

  return {
    rowCount: msgRows.length,
    firstUserMessage,
    model,
    firstTimestamp,
    lastTimestamp,
  };
}

/** Read and concatenate the text content of all parts for a single message. */
function readKiloDbPartsContent(db: SqliteDatabase, schema: KiloDbSchema, messageId: string): string {
  const partColumns = selectColumns(schema.part, ['id', 'message_id', 'time_created', 'data']);
  let partRows: unknown[];
  try {
    partRows = db
      .prepare(
        `SELECT ${partColumns} FROM part WHERE message_id = ? ORDER BY ${orderBy(schema.part, 'time_created', 'id')}`,
      )
      .all(messageId);
  } catch (err) {
    logger.debug('kilo-code: failed to read part rows', messageId, err);
    return '';
  }

  const contentParts: string[] = [];
  for (const partRow of partRows) {
    if (!isRecord(partRow)) continue;
    const partData = parseJsonRecord(partRow.data, `part:${messageId}`);
    if (!partData) continue;
    const content = extractKiloPartContent(partData).trim();
    if (content) contentParts.push(content);
  }
  return contentParts.join('\n').trim();
}

function readKiloDbMessagesFromHandle(
  db: SqliteDatabase,
  schema: KiloDbSchema,
  sessionId: string,
  maxReasoningHighlights = 10,
): KiloDbMessageRead {
  const messageColumns = selectColumns(schema.message, ['id', 'session_id', 'time_created', 'data']);
  const partColumns = selectColumns(schema.part, ['id', 'message_id', 'time_created', 'data']);
  const msgRows = db
    .prepare(
      `SELECT ${messageColumns} FROM message WHERE session_id = ? ORDER BY ${orderBy(schema.message, 'time_created', 'id')}`,
    )
    .all(sessionId);

  const messages: ConversationMessage[] = [];
  const notes: SessionNotes = {};
  const reasoning: string[] = [];
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  for (const msgRow of msgRows) {
    if (!isRecord(msgRow)) continue;
    const messageId = readString(msgRow, 'id');
    if (!messageId) continue;

    const messageData = parseJsonRecord(msgRow.data, `message:${messageId}`);
    if (!messageData) continue;

    const role = roleFromMessageData(messageData);
    if (!role) continue;

    const timestamp = timestampFromValue(msgRow.time_created);
    if (timestamp) {
      if (!firstTimestamp || timestamp.getTime() < firstTimestamp.getTime()) firstTimestamp = timestamp;
      if (!lastTimestamp || timestamp.getTime() > lastTimestamp.getTime()) lastTimestamp = timestamp;
    }

    if (role === 'assistant' && !notes.model) {
      notes.model = firstString(messageData, ['modelID', 'modelId', 'model', 'providerID', 'providerId']) ?? undefined;
    }
    addKiloTokenUsage(notes, messageData);

    const partRows = db
      .prepare(
        `SELECT ${partColumns} FROM part WHERE message_id = ? ORDER BY ${orderBy(schema.part, 'time_created', 'id')}`,
      )
      .all(messageId);

    const contentParts: string[] = [];
    for (const partRow of partRows) {
      if (!isRecord(partRow)) continue;
      const partData = parseJsonRecord(partRow.data, `part:${messageId}`);
      if (!partData) continue;

      const content = extractKiloPartContent(partData).trim();
      if (content) contentParts.push(content);
      addKiloReasoning(partData, reasoning, maxReasoningHighlights);
    }

    const content = contentParts.join('\n').trim();
    if (content) messages.push({ role, content, timestamp, sourceId: messageId });
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  if (firstTimestamp && lastTimestamp && lastTimestamp.getTime() >= firstTimestamp.getTime()) {
    notes.activeTimeMs = lastTimestamp.getTime() - firstTimestamp.getTime();
  }

  return { messages, notes, rowCount: msgRows.length, firstTimestamp, lastTimestamp };
}

function getProjectWorktree(db: SqliteDatabase, schema: KiloDbSchema, projectId: string | undefined): string {
  if (!projectId || !schema.project.has('id') || !schema.project.has('worktree')) return '';
  try {
    const row = db.prepare('SELECT worktree FROM project WHERE id = ?').get(projectId);
    return isRecord(row) ? (readString(row, 'worktree') ?? '') : '';
  } catch (err) {
    logger.debug('kilo-code: failed to read SQLite project row', projectId, err);
    return '';
  }
}

function sessionSourceMetadata(row: Record<string, unknown>, dbPath: string): Record<string, unknown> {
  return {
    storage: 'sqlite',
    dbPath,
    ...(readString(row, 'slug') ? { slug: readString(row, 'slug') } : {}),
    ...(readString(row, 'version') ? { version: readString(row, 'version') } : {}),
    ...(readString(row, 'project_id') ? { projectId: readString(row, 'project_id') } : {}),
  };
}

function isUnhelpfulDbTitle(title: string): boolean {
  return title.trim().length === 0 || /^new session\b/iu.test(title.trim());
}

/**
 * Determine conversation role from a raw Cline message.
 * Returns null for messages that aren't conversation turns (metadata, api events).
 */
function classifyRole(msg: ClineRawMessage, state: ConversationState): ConversationRole | null {
  if (msg.type === 'ask') {
    switch (msg.ask) {
      case 'followup':
      case 'plan_mode_respond':
      case 'act_mode_respond':
      case 'completion_result':
      case 'resume_task':
      case 'resume_completed_task':
      case 'mistake_limit_reached':
      case 'api_req_failed':
      case 'new_task':
      case 'condense':
      case 'summarize_task':
      case 'report_bug':
        return 'assistant';

      default:
        return null;
    }
  }

  if (msg.type !== 'say') return null;

  switch (msg.say) {
    case 'task':
    case 'user_feedback':
    case 'user_feedback_diff':
      return 'user';

    case 'text':
      // Roo Code stores the initial user task as the first text message.
      // Once an API request exists, text messages are assistant output, including
      // partial:false finalizations of prior streaming assistant chunks.
      return state.hasSeenApiRequest || msg.partial !== undefined ? 'assistant' : 'user';

    case 'completion_result':
    case 'reasoning':
      return 'assistant';

    default:
      // api_req_started, api_req_finished, and other event types → not conversation
      return null;
  }
}

/**
 * Extract the first real user message from a set of raw messages.
 * Used for session summary.
 */
function extractFirstUserMessage(messages: ClineRawMessage[]): string {
  for (const msg of buildConversation(messages)) {
    if (msg.role === 'user' && msg.content.length > 0) {
      return msg.content;
    }
  }
  return '';
}

/**
 * Build conversation messages from raw Cline events.
 * Deduplicates consecutive assistant streaming chunks (keeps last = most complete).
 */
function buildConversation(messages: ClineRawMessage[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  const state: ConversationState = { hasSeenApiRequest: false };
  let streamState: StreamState | undefined;

  for (const msg of messages) {
    const role = classifyRole(msg, state);
    if (isApiRequestMetadata(msg)) state.hasSeenApiRequest = true;
    if (!role) continue;

    const content = messageText(msg);
    if (!content) continue;

    const text = content.trim();
    if (!text) continue;

    const ts = msg.ts ? new Date(msg.ts) : undefined;
    const kind = `${msg.type}:${msg.type === 'ask' ? msg.ask : msg.say}`;
    const canReplaceStream =
      role === 'assistant' &&
      streamState?.index === result.length - 1 &&
      streamState.role === role &&
      streamState.kind === kind;

    // Consecutive partial updates represent the same assistant message evolving
    // over time. Keep only the latest visible state, including partial:false
    // finalizations of the same message.
    if (canReplaceStream && (msg.partial === true || msg.partial === false)) {
      result[result.length - 1] = { role, content: text, timestamp: ts };
    } else {
      result.push({ role, content: text, timestamp: ts });
    }

    streamState =
      role === 'assistant' && msg.partial === true
        ? { index: result.length - 1, role, kind }
        : msg.partial === false
          ? undefined
          : streamState;
  }

  return result;
}

// ── Token / Cost Extraction ─────────────────────────────────────────────────

interface TokenAccumulator {
  tokensIn: number;
  tokensOut: number;
  cacheWrites: number;
  cacheReads: number;
  found: boolean;
}

/**
 * Sum per-call token counts from `api_req_started` events.
 * Each event's `text` payload describes a single API call.
 */
function sumStartedTokens(messages: ClineRawMessage[]): TokenAccumulator {
  const acc: TokenAccumulator = {
    tokensIn: 0,
    tokensOut: 0,
    cacheWrites: 0,
    cacheReads: 0,
    found: false,
  };

  for (const msg of messages) {
    if (msg.type !== 'say' || msg.say !== 'api_req_started' || !msg.text) continue;
    try {
      const parsed: unknown = JSON.parse(msg.text);
      if (!isRecord(parsed)) continue;
      const tokensIn = readNumber(parsed, 'tokensIn');
      if (tokensIn !== undefined) {
        acc.tokensIn += tokensIn;
        acc.found = true;
      }
      const tokensOut = readNumber(parsed, 'tokensOut');
      if (tokensOut !== undefined) {
        acc.tokensOut += tokensOut;
        acc.found = true;
      }
      const cacheWrites = readNumber(parsed, 'cacheWrites');
      if (cacheWrites !== undefined) {
        acc.cacheWrites += cacheWrites;
        acc.found = true;
      }
      const cacheReads = readNumber(parsed, 'cacheReads');
      if (cacheReads !== undefined) {
        acc.cacheReads += cacheReads;
        acc.found = true;
      }
    } catch (err) {
      logger.debug('cline: skipping malformed api_req_started metadata', err);
    }
  }

  return acc;
}

/**
 * Read cumulative session totals from the last `api_req_finished` event.
 * `api_req_finished.total*` fields already include all per-call counts, so
 * this is used only as a fallback when no `api_req_started` data is present.
 */
function readLastFinishedTotals(messages: ClineRawMessage[]): TokenAccumulator {
  const acc: TokenAccumulator = {
    tokensIn: 0,
    tokensOut: 0,
    cacheWrites: 0,
    cacheReads: 0,
    found: false,
  };

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type !== 'say' || msg.say !== 'api_req_finished' || !msg.text) continue;
    try {
      const parsed: unknown = JSON.parse(msg.text);
      if (!isRecord(parsed)) continue;
      const tokensIn = readNumber(parsed, 'totalTokensIn') ?? readNumber(parsed, 'tokensIn');
      const tokensOut = readNumber(parsed, 'totalTokensOut') ?? readNumber(parsed, 'tokensOut');
      const cacheWrites = readNumber(parsed, 'totalCacheWrites') ?? readNumber(parsed, 'cacheWrites');
      const cacheReads = readNumber(parsed, 'totalCacheReads') ?? readNumber(parsed, 'cacheReads');
      if (tokensIn !== undefined) {
        acc.tokensIn = tokensIn;
        acc.found = true;
      }
      if (tokensOut !== undefined) {
        acc.tokensOut = tokensOut;
        acc.found = true;
      }
      if (cacheWrites !== undefined) {
        acc.cacheWrites = cacheWrites;
        acc.found = true;
      }
      if (cacheReads !== undefined) {
        acc.cacheReads = cacheReads;
        acc.found = true;
      }
      if (acc.found) return acc;
    } catch (err) {
      logger.debug('cline: skipping malformed api_req_finished metadata', err);
    }
  }

  return acc;
}

/**
 * Aggregate token usage from API request events.
 *
 * Cline emits two flavors of API event:
 *  - `api_req_started`: per-call counts (`tokensIn`, `tokensOut`, ...)
 *  - `api_req_finished`: cumulative session totals (`totalTokensIn`, ...)
 *
 * Summing both double-counts every call. We prefer the per-call data when
 * present and only fall back to the last `api_req_finished` totals when no
 * `api_req_started` events were found.
 */
function extractTokenUsage(messages: ClineRawMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  const started = sumStartedTokens(messages);
  const totals = started.found ? started : readLastFinishedTotals(messages);

  if (totals.found) {
    notes.tokenUsage = { input: totals.tokensIn, output: totals.tokensOut };
  }
  if (totals.cacheWrites > 0 || totals.cacheReads > 0) {
    notes.cacheTokens = { creation: totals.cacheWrites, read: totals.cacheReads };
  }

  return notes;
}

/**
 * Extract reasoning highlights from "reasoning" say events (max N).
 */
function extractReasoning(messages: ClineRawMessage[], max: number): string[] {
  const highlights: string[] = [];
  for (const msg of messages) {
    if (highlights.length >= max) break;
    if (msg.type !== 'say' || msg.say !== 'reasoning') continue;
    const content = messageText(msg);
    if (!content || content.length < 10) continue;
    highlights.push(truncate(content.trim(), 200));
  }
  return highlights;
}

/**
 * Extract pending tasks from the last assistant message.
 * Looks for TODO, NEXT, REMAINING patterns in completion results.
 */
function extractPendingTasks(messages: ClineRawMessage[], max: number): string[] {
  const tasks: string[] = [];

  // Walk backwards to find the last completion_result or assistant text
  for (let i = messages.length - 1; i >= 0 && tasks.length < max; i--) {
    const msg = messages[i];
    const isCompletion =
      (msg.type === 'say' && (msg.say === 'completion_result' || msg.say === 'text')) ||
      (msg.type === 'ask' && msg.ask === 'completion_result');
    if (!isCompletion) continue;
    if (!msg.text) continue;

    const lines = msg.text.split('\n');
    for (const line of lines) {
      if (tasks.length >= max) break;
      const trimmed = line.trim();
      const lower = trimmed.toLowerCase();
      if (
        (lower.startsWith('- [ ]') || lower.startsWith('todo:') || lower.includes('next step')) &&
        trimmed.length > 5
      ) {
        tasks.push(truncate(trimmed, 200));
      }
    }

    // Only check the last relevant message
    if (tasks.length > 0) break;
  }

  return tasks;
}

// ── Session Parsing (shared) ────────────────────────────────────────────────

/**
 * Discover and parse sessions for all Cline-family extensions, optionally
 * filtering to a single source variant.
 */
async function parseSessionsForSource(filterSource?: ClineSource): Promise<UnifiedSession[]> {
  const taskEntries = await discoverTaskDirs();
  const sessions: UnifiedSession[] = [];

  for (const { taskDir, taskId, source } of taskEntries) {
    if (filterSource && source !== filterSource) continue;

    try {
      const uiFile = path.join(taskDir, 'ui_messages.json');
      const messages = await readUiMessages(uiFile);
      if (messages.length === 0) continue;

      const firstUserMsg = extractFirstUserMessage(messages);
      const summary = cleanSummary(firstUserMsg);
      if (!summary) continue; // Skip sessions with no real user message

      const fileStats = await fs.stat(uiFile);

      // Derive timestamps: prefer message timestamps, fall back to file stats
      const firstTs = messages[0]?.ts;
      const lastTs = messages[messages.length - 1]?.ts;
      const createdAt = firstTs ? new Date(firstTs) : fileStats.birthtime;
      const updatedAt = lastTs ? new Date(lastTs) : fileStats.mtime;

      sessions.push({
        id: taskId,
        source,
        cwd: '',
        lines: messages.length,
        bytes: fileStats.size,
        createdAt,
        updatedAt,
        originalPath: uiFile,
        summary,
      });
    } catch (err) {
      logger.debug(`cline: skipping unparseable task ${taskId}`, err);
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

async function parseKiloDbSessions(): Promise<UnifiedSession[]> {
  const sessionsById = new Map<string, UnifiedSession>();

  for (const dbPath of await discoverKiloDbPaths()) {
    const handle = openKiloDb(dbPath);
    if (!handle) continue;

    const { db, close } = handle;
    try {
      const schema = inspectKiloDbSchema(db);
      if (!schema.supported) {
        warnKiloDbFidelity(dbPath, schema.warnings);
        continue;
      }

      const dbStats = await fs.stat(dbPath);
      const sessionColumns = selectColumns(schema.session, [
        'id',
        'project_id',
        'slug',
        'directory',
        'title',
        'version',
        'time_created',
        'time_updated',
      ]);
      const sortColumn = schema.session.has('time_updated') ? 'time_updated' : 'id';
      const rows = db.prepare(`SELECT ${sessionColumns} FROM session ORDER BY ${sortColumn} DESC`).all();

      for (const row of rows) {
        if (!isRecord(row)) continue;
        const id = readString(row, 'id');
        if (!id) continue;

        // Discovery uses a lightweight summary (one message-table query + at
        // most one part query for the first user message) instead of walking
        // every message and part for every session.
        const summaryRead = readKiloDbDiscoverySummary(db, schema, id);
        if (summaryRead.rowCount === 0) continue;

        const title = readString(row, 'title') ?? '';
        const slug = readString(row, 'slug') ?? '';
        const summarySource = isUnhelpfulDbTitle(title) ? summaryRead.firstUserMessage || slug : title;
        const summary = cleanSummary(summarySource || slug || summaryRead.firstUserMessage);
        if (!summary) continue;

        const projectId = readString(row, 'project_id');
        const cwd = readString(row, 'directory') || getProjectWorktree(db, schema, projectId);
        const createdAt = timestampFromValue(row.time_created) ?? summaryRead.firstTimestamp ?? dbStats.birthtime;
        const updatedAt = timestampFromValue(row.time_updated) ?? summaryRead.lastTimestamp ?? dbStats.mtime;

        const session: UnifiedSession = {
          id,
          source: 'kilo-code',
          cwd,
          repo: extractRepoFromCwd(cwd),
          lines: summaryRead.rowCount,
          bytes: dbStats.size,
          createdAt,
          updatedAt,
          originalPath: dbPath,
          summary,
          model: summaryRead.model,
        };

        const existing = sessionsById.get(id);
        if (!existing || existing.updatedAt.getTime() < session.updatedAt.getTime()) {
          sessionsById.set(id, session);
        }
      }
    } catch (err) {
      logger.debug('kilo-code: failed to parse SQLite sessions', dbPath, err);
    } finally {
      close();
    }
  }

  return Array.from(sessionsById.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

async function parseKiloSessionsAll(): Promise<UnifiedSession[]> {
  const sessionsById = new Map<string, UnifiedSession>();
  for (const session of await parseKiloDbSessions()) {
    sessionsById.set(session.id, session);
  }
  for (const session of await parseSessionsForSource('kilo-code')) {
    const existing = sessionsById.get(session.id);
    if (!existing || existing.updatedAt.getTime() < session.updatedAt.getTime()) {
      sessionsById.set(session.id, session);
    }
  }
  return Array.from(sessionsById.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// ── Context Extraction (shared) ─────────────────────────────────────────────

/**
 * Extract full session context for cross-tool handoff.
 * Shared implementation for all three Cline-family variants.
 */
async function extractContextShared(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const messages = await readUiMessages(session.originalPath);

  // Build conversation messages
  const allConversation = buildConversation(messages);
  const recentMessages = allConversation.slice(-cfg.recentMessages);

  // Extract token usage and session notes
  const sessionNotes: SessionNotes = extractTokenUsage(messages);

  // Extract reasoning highlights
  const reasoning = extractReasoning(messages, cfg.thinking?.maxHighlights ?? 5);
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;

  // Extract pending tasks
  const pendingTasks = extractPendingTasks(messages, cfg.pendingTasks?.maxTasks ?? 5);

  // Cline's ui_messages.json doesn't track file-level tool calls,
  // so filesModified and toolSummaries remain empty
  const filesModified: string[] = [];

  const markdown = generateHandoffMarkdown(
    session,
    recentMessages,
    filesModified,
    pendingTasks,
    [], // toolSummaries — not available from ui_messages.json
    sessionNotes,
    cfg,
  );

  return {
    session: sessionNotes.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages,
    filesModified,
    pendingTasks,
    toolSummaries: [],
    sessionNotes,
    markdown,
  };
}

function isKiloDbSession(session: UnifiedSession): boolean {
  return session.source === 'kilo-code' && path.basename(session.originalPath) !== 'ui_messages.json';
}

function emptyKiloDbContext(session: UnifiedSession, cfg: VerbosityConfig, fidelityWarnings: string[]): SessionContext {
  const sessionNotes: SessionNotes = {
    rawAccess: { kind: 'sqlite', path: session.originalPath },
    sourceMetadata: { storage: 'sqlite', dbPath: session.originalPath },
    fidelityWarnings,
  };
  const markdown = generateHandoffMarkdown(session, [], [], [], [], sessionNotes, cfg);

  return {
    session,
    recentMessages: [],
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    sessionNotes,
    markdown,
  };
}

function readKiloSessionRow(
  db: SqliteDatabase,
  schema: KiloDbSchema,
  sessionId: string,
): Record<string, unknown> | null {
  const sessionColumns = selectColumns(schema.session, ['id', 'project_id', 'slug', 'directory', 'title', 'version']);
  try {
    const row = db.prepare(`SELECT ${sessionColumns} FROM session WHERE id = ?`).get(sessionId);
    return isRecord(row) ? row : null;
  } catch (err) {
    logger.debug('kilo-code: failed to read SQLite session metadata', sessionId, err);
    return null;
  }
}

async function extractKiloDbContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const handle = openKiloDb(session.originalPath);
  if (!handle) {
    return emptyKiloDbContext(session, cfg, [`Kilo SQLite database could not be opened: ${session.originalPath}`]);
  }

  const { db, close } = handle;
  try {
    const schema = inspectKiloDbSchema(db);
    if (!schema.supported) {
      warnKiloDbFidelity(session.originalPath, schema.warnings);
      return emptyKiloDbContext(session, cfg, schema.warnings);
    }

    const messageRead = readKiloDbMessagesFromHandle(db, schema, session.id, cfg.thinking?.maxHighlights ?? 5);
    const sessionRow = readKiloSessionRow(db, schema, session.id);
    const warnings =
      messageRead.rowCount === 0 ? [`Kilo SQLite session "${session.id}" has no readable message rows.`] : [];

    const sessionNotes: SessionNotes = {
      ...messageRead.notes,
      rawAccess: { kind: 'sqlite', path: session.originalPath },
      sourceMetadata: {
        ...(messageRead.notes.sourceMetadata ?? {}),
        ...(sessionRow ? sessionSourceMetadata(sessionRow, session.originalPath) : {}),
        storage: 'sqlite',
        dbPath: session.originalPath,
      },
      ...(warnings.length > 0 ? { fidelityWarnings: warnings } : {}),
    };

    const recentMessages = messageRead.messages.slice(-cfg.recentMessages);
    const enrichedSession = sessionNotes.model ? { ...session, model: sessionNotes.model } : session;
    const markdown = generateHandoffMarkdown(enrichedSession, recentMessages, [], [], [], sessionNotes, cfg);

    return {
      session: enrichedSession,
      recentMessages,
      filesModified: [],
      pendingTasks: [],
      toolSummaries: [],
      sessionNotes,
      markdown,
    };
  } catch (err) {
    logger.debug('kilo-code: failed to extract SQLite context', session.originalPath, session.id, err);
    return emptyKiloDbContext(session, cfg, [
      `Kilo SQLite session "${session.id}" could not be extracted without losing fidelity.`,
    ]);
  } finally {
    close();
  }
}

// ── Public API: Cline ───────────────────────────────────────────────────────

/** Discover sessions for Cline only */
export async function parseClineSessions(): Promise<UnifiedSession[]> {
  return parseSessionsForSource('cline');
}

/** Extract context from a Cline session */
export async function extractClineContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  return extractContextShared(session, config);
}

// ── Public API: Roo Code ────────────────────────────────────────────────────

/** Discover sessions for Roo Code only */
export async function parseRooCodeSessions(): Promise<UnifiedSession[]> {
  return parseSessionsForSource('roo-code');
}

/** Extract context from a Roo Code session (delegates to shared implementation) */
export async function extractRooCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  return extractContextShared(session, config);
}

// ── Public API: Kilo Code ───────────────────────────────────────────────────

/** Discover sessions for Kilo Code only */
export async function parseKiloCodeSessions(): Promise<UnifiedSession[]> {
  return parseKiloSessionsAll();
}

/** Extract context from a Kilo Code session (delegates to shared implementation) */
export async function extractKiloCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  if (isKiloDbSession(session)) return extractKiloDbContext(session, config);
  return extractContextShared(session, config);
}
