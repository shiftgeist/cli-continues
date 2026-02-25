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
import { truncate } from '../utils/tool-summarizer.js';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';

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
  ts: number;
  type: string;
  say?: string;
  ask?: string;
  text?: string;
  images?: string[];
  partial?: boolean;
}

/** Token metadata parsed from api_req_started text field */
interface ApiReqMeta {
  tokensIn?: number;
  tokensOut?: number;
  cacheWrites?: number;
  cacheReads?: number;
  cost?: number;
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
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    bases.push(
      path.join(appData, 'Code', 'User', 'globalStorage'),
      path.join(appData, 'Code - Insiders', 'User', 'globalStorage'),
      path.join(appData, 'Cursor', 'User', 'globalStorage'),
    );
  }

  return bases;
}

/**
 * Discover all task directories for a given extension across all IDE locations.
 * Returns tuples of (task-id directory path, extension source label).
 */
function discoverTaskDirs(): Array<{ taskDir: string; taskId: string; source: ClineSource }> {
  const bases = getGlobalStorageBases();
  const results: Array<{ taskDir: string; taskId: string; source: ClineSource }> = [];

  for (const base of bases) {
    if (!fs.existsSync(base)) continue;

    for (const ext of CLINE_EXTENSIONS) {
      const tasksRoot = path.join(base, ext.id, 'tasks');
      if (!fs.existsSync(tasksRoot)) continue;

      try {
        const entries = fs.readdirSync(tasksRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const taskDir = path.join(tasksRoot, entry.name);
          const uiFile = path.join(taskDir, 'ui_messages.json');
          if (fs.existsSync(uiFile)) {
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

// ── Message Parsing ─────────────────────────────────────────────────────────

/** Read and parse ui_messages.json, returning an empty array on failure */
function readUiMessages(filePath: string): ClineRawMessage[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed as ClineRawMessage[];
  } catch (err) {
    logger.debug('cline: failed to parse ui_messages.json', filePath, err);
    return [];
  }
}

/**
 * Determine conversation role from a raw Cline message.
 * Returns null for messages that aren't conversation turns (metadata, api events).
 */
function classifyRole(msg: ClineRawMessage): 'user' | 'assistant' | null {
  if (msg.type !== 'say') return null;

  switch (msg.say) {
    case 'user_feedback':
      return 'user';

    case 'text':
      // Streaming assistant chunks have partial: true
      // Non-partial text without images is user input
      return msg.partial === true ? 'assistant' : 'user';

    case 'completion_result':
      return 'assistant';

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
  for (const msg of messages) {
    const role = classifyRole(msg);
    if (role === 'user' && msg.text && msg.text.length > 0) {
      return msg.text;
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

  for (const msg of messages) {
    const role = classifyRole(msg);
    if (!role || !msg.text) continue;

    const text = msg.text.trim();
    if (!text) continue;

    const ts = msg.ts ? new Date(msg.ts) : undefined;

    // Deduplicate: if the previous message is the same role (assistant streaming),
    // replace it with this one (which has more complete text)
    if (
      role === 'assistant' &&
      msg.say === 'text' &&
      msg.partial === true &&
      result.length > 0 &&
      result[result.length - 1].role === 'assistant'
    ) {
      result[result.length - 1] = { role, content: text, timestamp: ts };
    } else {
      result.push({ role, content: text, timestamp: ts });
    }
  }

  return result;
}

// ── Token / Cost Extraction ─────────────────────────────────────────────────

/**
 * Aggregate token usage and cost from api_req_started events.
 * Each event's text field contains a JSON object with token counts.
 */
function extractTokenUsage(messages: ClineRawMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheWrites = 0;
  let totalCacheReads = 0;
  let totalCost = 0;
  let found = false;

  for (const msg of messages) {
    if (msg.type !== 'say' || msg.say !== 'api_req_started') continue;
    if (!msg.text) continue;

    try {
      const meta: ApiReqMeta = JSON.parse(msg.text);
      if (meta.tokensIn) { totalIn += meta.tokensIn; found = true; }
      if (meta.tokensOut) { totalOut += meta.tokensOut; found = true; }
      if (meta.cacheWrites) { totalCacheWrites += meta.cacheWrites; found = true; }
      if (meta.cacheReads) { totalCacheReads += meta.cacheReads; found = true; }
      if (meta.cost) totalCost += meta.cost;
    } catch {
      // Malformed JSON in api_req_started — skip silently
    }
  }

  if (found) {
    notes.tokenUsage = { input: totalIn, output: totalOut };
  }
  if (totalCacheWrites > 0 || totalCacheReads > 0) {
    notes.cacheTokens = { creation: totalCacheWrites, read: totalCacheReads };
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
    if (!msg.text || msg.text.length < 10) continue;
    highlights.push(truncate(msg.text.trim(), 200));
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
    if (msg.type !== 'say') continue;
    if (msg.say !== 'completion_result' && msg.say !== 'text') continue;
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
  const taskEntries = discoverTaskDirs();
  const sessions: UnifiedSession[] = [];

  for (const { taskDir, taskId, source } of taskEntries) {
    if (filterSource && source !== filterSource) continue;

    try {
      const uiFile = path.join(taskDir, 'ui_messages.json');
      const messages = readUiMessages(uiFile);
      if (messages.length === 0) continue;

      const firstUserMsg = extractFirstUserMessage(messages);
      const summary = cleanSummary(firstUserMsg);
      if (!summary) continue; // Skip sessions with no real user message

      const fileStats = fs.statSync(uiFile);

      // Derive timestamps: prefer message timestamps, fall back to file stats
      const firstTs = messages[0]?.ts;
      const lastTs = messages[messages.length - 1]?.ts;
      const createdAt = firstTs ? new Date(firstTs) : fileStats.birthtime;
      const updatedAt = lastTs ? new Date(lastTs) : fileStats.mtime;

      sessions.push({
        id: taskId,
        source: source as SessionSource,
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

// ── Context Extraction (shared) ─────────────────────────────────────────────

/**
 * Extract full session context for cross-tool handoff.
 * Shared implementation for all three Cline-family variants.
 */
async function extractContextShared(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const messages = readUiMessages(session.originalPath);

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

// ── Public API: Cline ───────────────────────────────────────────────────────

/** Discover sessions for Cline only */
export async function parseClineSessions(): Promise<UnifiedSession[]> {
  return parseSessionsForSource('cline');
}

/** Extract context from a Cline session */
export async function extractClineContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
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
  return parseSessionsForSource('kilo-code');
}

/** Extract context from a Kilo Code session (delegates to shared implementation) */
export async function extractKiloCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  return extractContextShared(session, config);
}
