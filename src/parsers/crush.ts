import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  UnifiedSession,
} from '../types/index.js';
import type { SessionSource } from '../types/tool-names.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';

// 'crush' is not yet in TOOL_NAMES — use a type assertion until registration is added.
const CRUSH_SOURCE: SessionSource = 'crush';

const CRUSH_DB_PATH = path.join(homeDir(), '.crush', 'crush.db');

// ── SQLite CLI Helper ───────────────────────────────────────────────────────

/** Row shape returned by the session-listing query */
interface CrushSessionRow {
  id: string;
  title: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: number | null;
  first_msg_at: number | null;
  last_msg_at: number | null;
  msg_count: number;
}

/** Row shape returned by the message query */
interface CrushMessageRow {
  role: string;
  parts: string;
  created_at: number;
  model: string | null;
  provider: string | null;
}

/**
 * Execute a read-only SQLite query via the `sqlite3` CLI and return parsed JSON rows.
 * Uses execFileSync (no shell) to avoid injection risks with paths.
 */
function querySqlite<T = Record<string, unknown>>(dbPath: string, query: string): T[] {
  try {
    const raw = execFileSync('sqlite3', [dbPath, '-json', query], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!raw.trim()) return [];
    return JSON.parse(raw) as T[];
  } catch (err) {
    logger.debug('crush: sqlite3 query failed', dbPath, err);
    return [];
  }
}

/**
 * Check if the Crush database exists and the sqlite3 binary is available.
 */
function isCrushAvailable(): boolean {
  if (!fs.existsSync(CRUSH_DB_PATH)) return false;
  try {
    execFileSync('sqlite3', ['--version'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Parts Parsing ───────────────────────────────────────────────────────────

interface CrushPart {
  type: string;
  data?: { text?: string };
}

/**
 * Extract plain text from a Crush message's `parts` JSON column.
 * Format: [{"type": "text", "data": {"text": "..."}}]
 */
function extractTextFromParts(partsJson: string): string {
  try {
    const parts: CrushPart[] = JSON.parse(partsJson);
    if (!Array.isArray(parts)) return '';
    return parts
      .filter((p) => p.type === 'text' && p.data?.text)
      .map((p) => p.data!.text!)
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Escape a string for safe embedding in a SQL single-quoted literal.
 */
function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

// ── Session Listing ─────────────────────────────────────────────────────────

/**
 * Get the text of the first user message in a session (for summary fallback).
 */
function getFirstUserMessage(sessionId: string): string {
  const rows = querySqlite<CrushMessageRow>(
    CRUSH_DB_PATH,
    `SELECT role, parts, created_at, model, provider FROM messages WHERE session_id = '${sqlEscape(sessionId)}' AND role = 'user' ORDER BY created_at ASC LIMIT 1`,
  );
  if (rows.length === 0) return '';
  return extractTextFromParts(rows[0].parts);
}

/**
 * Parse all Crush sessions from the SQLite database.
 */
export async function parseCrushSessions(): Promise<UnifiedSession[]> {
  if (!isCrushAvailable()) return [];

  const rows = querySqlite<CrushSessionRow>(
    CRUSH_DB_PATH,
    `SELECT s.id, s.title, s.prompt_tokens, s.completion_tokens, s.cost, MIN(m.created_at) AS first_msg_at, MAX(m.created_at) AS last_msg_at, COUNT(m.rowid) AS msg_count FROM sessions s LEFT JOIN messages m ON m.session_id = s.id GROUP BY s.id ORDER BY last_msg_at DESC`,
  );

  const sessions: UnifiedSession[] = [];

  for (const row of rows) {
    if (!row.msg_count || row.msg_count === 0) continue;

    let summary = row.title || '';
    if (!summary) {
      summary = getFirstUserMessage(row.id);
    }
    summary = cleanSummary(summary);
    if (!summary) continue;

    const createdAt = row.first_msg_at ? new Date(row.first_msg_at) : new Date();
    const updatedAt = row.last_msg_at ? new Date(row.last_msg_at) : createdAt;

    sessions.push({
      id: row.id,
      source: CRUSH_SOURCE,
      cwd: '',
      lines: row.msg_count,
      bytes: 0, // SQLite — no per-session file size
      createdAt,
      updatedAt,
      originalPath: CRUSH_DB_PATH,
      summary,
    });
  }

  return sessions;
}

// ── Context Extraction ──────────────────────────────────────────────────────

/**
 * Extract context from a Crush session for cross-tool continuation.
 */
export async function extractCrushContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');

  const msgRows = querySqlite<CrushMessageRow>(
    CRUSH_DB_PATH,
    `SELECT role, parts, created_at, model, provider FROM messages WHERE session_id = '${sqlEscape(session.id)}' ORDER BY created_at ASC`,
  );

  const allMessages: ConversationMessage[] = [];
  let model: string | undefined;

  for (const row of msgRows) {
    const content = extractTextFromParts(row.parts);
    if (!content) continue;

    const role: 'user' | 'assistant' = row.role === 'user' ? 'user' : 'assistant';
    // Crush stores created_at as millisecond epoch
    const timestamp = new Date(row.created_at);

    allMessages.push({ role, content, timestamp });

    if (!model && row.model && role === 'assistant') {
      model = row.model;
    }
  }

  // Get token usage from the session row
  const sessionRows = querySqlite<{ prompt_tokens: number | null; completion_tokens: number | null }>(
    CRUSH_DB_PATH,
    `SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = '${sqlEscape(session.id)}'`,
  );

  let tokenInput = 0;
  let tokenOutput = 0;
  if (sessionRows.length > 0) {
    tokenInput = sessionRows[0].prompt_tokens ?? 0;
    tokenOutput = sessionRows[0].completion_tokens ?? 0;
  }

  const hasNotes = model || tokenInput || tokenOutput;
  const sessionNotes: SessionNotes | undefined = hasNotes
    ? {
        ...(model ? { model } : {}),
        ...(tokenInput || tokenOutput ? { tokenUsage: { input: tokenInput, output: tokenOutput } } : {}),
      }
    : undefined;

  const trimmed = allMessages.slice(-resolvedConfig.recentMessages);
  const enrichedSession = model ? { ...session, model } : session;

  const markdown = generateHandoffMarkdown(
    enrichedSession,
    trimmed,
    [], // filesModified — not tracked in Crush's schema
    [], // pendingTasks — not tracked in Crush's schema
    [], // toolSummaries — not tracked in Crush's schema
    sessionNotes,
  );

  return {
    session: enrichedSession,
    recentMessages: trimmed,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    sessionNotes,
    markdown,
  };
}
