import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionSource,
  UnifiedSession,
} from '../types/index.js';
import { findFiles, listSubdirectories } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';

const ANTIGRAVITY_BASE_DIR = path.join(homeDir(), '.gemini', 'antigravity', 'code_tracker');

const SOURCE_NAME: SessionSource = 'antigravity';

// ⚠️  FORMAT NOTE: This parser handles JSONL conversation logs from Antigravity's
// code_tracker directory. Real Antigravity installations may also store raw file
// snapshots (binary/text diffs) in code_tracker/ — those are NOT parsed here.
// This parser only processes *.jsonl files containing {type, content, timestamp} entries.

/** Shape of a single line entry after stripping the binary prefix */
interface AntigravityEntry {
  type: string;
  timestamp: string;
  content: string;
}

// ── Line Parsing ────────────────────────────────────────────────────────────

/**
 * Strip binary/protobuf prefix bytes that precede the JSON on each JSONL line.
 * Returns the substring starting from the first `{`, or null if none found.
 */
function stripBinaryPrefix(line: string): string | null {
  const idx = line.indexOf('{');
  if (idx === -1) return null;
  return line.slice(idx);
}

/**
 * Parse a single JSONL line into an entry.
 * Returns null for empty lines, lines without JSON, or invalid payloads.
 */
function parseLine(line: string): AntigravityEntry | null {
  if (!line) return null;
  const json = stripBinaryPrefix(line);
  if (!json) return null;

  try {
    const obj = JSON.parse(json);
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.type === 'string' &&
      typeof obj.content === 'string'
    ) {
      return {
        type: obj.type,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
        content: obj.content,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── File I/O ────────────────────────────────────────────────────────────────

/** Read and parse all entries from an Antigravity JSONL file */
function parseJSONLFile(filePath: string): AntigravityEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries: AntigravityEntry[] = [];
    for (const line of raw.split('\n')) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch (err) {
    logger.debug('antigravity: failed to read JSONL file', filePath, err);
    return [];
  }
}

/** Parse an RFC 3339 / ISO 8601 timestamp, falling back to a default Date */
function parseTimestamp(ts: string, fallback: Date): Date {
  if (!ts) return fallback;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? fallback : d;
}

/** Find all *.jsonl session files under the code_tracker project dirs */
async function findSessionFiles(): Promise<string[]> {
  if (!fs.existsSync(ANTIGRAVITY_BASE_DIR)) return [];

  const results: string[] = [];
  for (const projectDir of listSubdirectories(ANTIGRAVITY_BASE_DIR)) {
    results.push(
      ...findFiles(projectDir, {
        match: (entry) => entry.name.endsWith('.jsonl'),
        recursive: false,
      }),
    );
  }
  return results;
}

/**
 * Derive project name from the JSONL file's parent directory.
 * "no_repo" falls back to "antigravity".
 */
function projectNameFromPath(filePath: string): string {
  const dirName = path.basename(path.dirname(filePath));
  return dirName === 'no_repo' ? 'antigravity' : dirName;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse all Antigravity sessions from ~/.gemini/antigravity/code_tracker/
 */
export async function parseAntigravitySessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const entries = parseJSONLFile(filePath);
      const relevant = entries.filter((e) => e.type === 'user' || e.type === 'assistant');
      if (relevant.length === 0) continue;

      const fileStats = fs.statSync(filePath);
      const mtime = fileStats.mtime;

      const sessionId = path.basename(filePath, '.jsonl');
      const projectName = projectNameFromPath(filePath);

      const firstUser = relevant.find((e) => e.type === 'user');
      const summary = firstUser ? cleanSummary(firstUser.content) : undefined;

      const createdAt = parseTimestamp(relevant[0].timestamp, mtime);
      const updatedAt = parseTimestamp(relevant[relevant.length - 1].timestamp, mtime);

      sessions.push({
        id: sessionId,
        source: SOURCE_NAME,
        cwd: '',
        repo: projectName,
        lines: relevant.length,
        bytes: fileStats.size,
        createdAt,
        updatedAt,
        originalPath: filePath,
        summary,
      });
    } catch (err) {
      logger.debug('antigravity: skipping unparseable session', filePath, err);
    }
  }

  return sessions
    .filter((s) => s.summary && s.summary.length > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from an Antigravity session for cross-tool continuation.
 * Antigravity sessions contain only user/assistant messages — no tool calls or token tracking.
 */
export async function extractAntigravityContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const entries = parseJSONLFile(session.originalPath);

  let fallbackDate = session.updatedAt;
  try {
    fallbackDate = fs.statSync(session.originalPath).mtime;
  } catch {
    // Use session.updatedAt if file is gone
  }

  const allMessages: ConversationMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    allMessages.push({
      role: entry.type as 'user' | 'assistant',
      content: entry.content,
      timestamp: parseTimestamp(entry.timestamp, fallbackDate),
    });
  }

  const recentMessages = allMessages.slice(-resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    recentMessages,
    [],  // filesModified — not tracked by Antigravity
    [],  // pendingTasks — not tracked by Antigravity
    [],  // toolSummaries — no tool calls in Antigravity
    undefined,  // sessionNotes — no tokens/reasoning
  );

  return {
    session,
    recentMessages,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    sessionNotes: undefined,
    markdown,
  };
}
