import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  UnifiedSession,
} from '../types/index.js';
import { extractTextFromBlocks } from '../utils/content.js';
import { findFiles, listSubdirectories } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';

// ── Kiro Session Shape ──────────────────────────────────────────────────────

/** A single entry in the Kiro history array */
interface KiroHistoryEntry {
  message: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    id?: string;
  };
}

/** Raw Kiro session JSON structure */
interface KiroSession {
  sessionId: string;
  title?: string;
  workspacePath?: string;
  selectedModel?: string;
  history: KiroHistoryEntry[];
}

// ── Base Path ───────────────────────────────────────────────────────────────
// macOS: ~/Library/Application Support/Kiro/workspace-sessions/
const KIRO_BASE_DIR = path.join(
  homeDir(),
  'Library',
  'Application Support',
  'Kiro',
  'workspace-sessions',
);

/**
 * Find all Kiro session JSON files.
 * Walks workspace subdirectories, skips the `sessions.json` index file.
 */
async function findSessionFiles(): Promise<string[]> {
  if (!fs.existsSync(KIRO_BASE_DIR)) return [];

  const results: string[] = [];
  for (const workspaceDir of listSubdirectories(KIRO_BASE_DIR)) {
    results.push(
      ...findFiles(workspaceDir, {
        match: (entry) => entry.name.endsWith('.json') && entry.name !== 'sessions.json',
        recursive: false,
      }),
    );
  }
  return results;
}

/**
 * Parse and validate a single Kiro session JSON file.
 * Returns null for files that don't match the expected shape.
 */
function parseSessionFile(filePath: string): KiroSession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    if (typeof data.sessionId !== 'string' || !Array.isArray(data.history)) {
      logger.debug('kiro: missing sessionId or history', filePath);
      return null;
    }
    return data as KiroSession;
  } catch (err) {
    logger.debug('kiro: failed to parse session file', filePath, err);
    return null;
  }
}

/**
 * Extract text content from a Kiro message.
 * Handles both plain string and `[{type: "text", text: "..."}]` formats.
 */
function extractContent(content: string | Array<{ type: string; text?: string }>): string {
  return extractTextFromBlocks(content);
}

/**
 * Extract the first real user message for use as a session summary.
 */
function extractFirstUserMessage(session: KiroSession): string {
  for (const entry of session.history) {
    if (entry.message.role === 'user' && entry.message.content) {
      return extractContent(entry.message.content);
    }
  }
  return '';
}

/**
 * Derive a project name from session data.
 * Priority: title → basename(workspacePath) → "kiro"
 */
function deriveProjectName(session: KiroSession): string {
  if (session.title) return session.title;
  if (session.workspacePath) return path.basename(session.workspacePath);
  return 'kiro';
}

/**
 * Parse all Kiro sessions into the unified format.
 */
export async function parseKiroSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const session = parseSessionFile(filePath);
      if (!session) continue;

      const fileStats = fs.statSync(filePath);
      const firstUserMessage = extractFirstUserMessage(session);
      const summary = cleanSummary(firstUserMessage) || deriveProjectName(session);

      sessions.push({
        id: session.sessionId,
        // Type assertion: 'kiro' will be added to TOOL_NAMES separately
        source: 'kiro',
        cwd: session.workspacePath || '',
        lines: session.history.length,
        bytes: fileStats.size,
        // Kiro has no per-message timestamps — file mtime is the best proxy
        createdAt: fileStats.mtime,
        updatedAt: fileStats.mtime,
        originalPath: filePath,
        summary,
        model: session.selectedModel,
      });
    } catch (err) {
      logger.debug('kiro: skipping unparseable session', filePath, err);
    }
  }

  return sessions
    .filter((s) => s.summary && s.summary.length > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a Kiro session for cross-tool continuation.
 */
export async function extractKiroContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const sessionData = parseSessionFile(session.originalPath);
  const recentMessages: ConversationMessage[] = [];

  if (sessionData) {
    for (const entry of sessionData.history) {
      const role: 'user' | 'assistant' = entry.message.role === 'user' ? 'user' : 'assistant';
      const content = extractContent(entry.message.content);
      if (content) {
        recentMessages.push({ role, content });
      }
    }
  }

  const trimmed = recentMessages.slice(-cfg.recentMessages);

  // Kiro sessions have no tool call data
  const filesModified: string[] = [];
  const pendingTasks: string[] = [];

  const enrichedSession = sessionData?.selectedModel
    ? { ...session, model: sessionData.selectedModel }
    : session;

  const markdown = generateHandoffMarkdown(
    enrichedSession,
    trimmed,
    filesModified,
    pendingTasks,
    [], // toolSummaries — Kiro stores no tool call data
  );

  return {
    session: enrichedSession,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries: [],
    markdown,
  };
}
