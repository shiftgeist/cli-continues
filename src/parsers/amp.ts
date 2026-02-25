import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';
import { findFiles } from '../utils/fs-helpers.js';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { truncate } from '../utils/tool-summarizer.js';

// ── Amp Thread JSON shape ───────────────────────────────────────────────────
// Minimal interfaces matching ~/.local/share/amp/threads/{id}.json

interface AmpContentBlock {
  type: string;
  text?: string;
  provider?: string;
}

interface AmpMessage {
  role: 'user' | 'assistant';
  messageId: number;
  content: AmpContentBlock[];
}

interface AmpUsageEvent {
  model?: string;
  credits?: number;
  tokens?: { input?: number; output?: number };
  operationType?: string;
  fromMessageId?: number;
  toMessageId?: number;
}

interface AmpThread {
  id: string;
  title?: string;
  created: number; // milliseconds since epoch
  messages: AmpMessage[];
  usageLedger?: {
    events?: AmpUsageEvent[];
  };
  env?: {
    initial?: {
      tags?: string[];
    };
  };
}

const AMP_BASE_DIR = path.join(homeDir(), '.local', 'share', 'amp', 'threads');

/**
 * Find all Amp thread JSON files
 */
function findSessionFiles(): string[] {
  return findFiles(AMP_BASE_DIR, {
    match: (entry) => entry.name.endsWith('.json'),
    recursive: false,
  });
}

/**
 * Parse a single Amp thread file. Returns null on any parse error.
 */
function parseThreadFile(filePath: string): AmpThread | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);

    // Minimal validation: must have id, created timestamp, and messages array
    if (typeof data.id !== 'string' || typeof data.created !== 'number' || !Array.isArray(data.messages)) {
      logger.debug('amp: thread validation failed — missing id, created, or messages', filePath);
      return null;
    }

    return data as AmpThread;
  } catch (err) {
    logger.debug('amp: failed to parse thread file', filePath, err);
    return null;
  }
}

/**
 * Concatenate text from an Amp message's content blocks
 */
function extractMessageText(message: AmpMessage): string {
  if (!message.content || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('\n')
    .trim();
}

/**
 * Extract the first real user message for use as a session summary
 */
function extractFirstUserMessage(thread: AmpThread): string {
  for (const msg of thread.messages) {
    if (msg.role === 'user') {
      const text = extractMessageText(msg);
      if (text) return text;
    }
  }
  return '';
}

/**
 * Extract model identifier from env.initial.tags (e.g. "model:claude-opus-4-5-20251101" → "claude-opus-4-5-20251101")
 */
function extractModel(thread: AmpThread): string | undefined {
  const tags = thread.env?.initial?.tags;
  if (!Array.isArray(tags)) return undefined;

  for (const tag of tags) {
    if (typeof tag === 'string' && tag.startsWith('model:')) {
      return tag.slice('model:'.length);
    }
  }
  return undefined;
}

/**
 * Extract session notes: model info and token usage from usageLedger
 */
function extractSessionNotes(thread: AmpThread): SessionNotes {
  const notes: SessionNotes = {};

  const model = extractModel(thread);
  if (model) notes.model = model;

  // Accumulate token usage from ledger events, skipping title-generation
  const events = thread.usageLedger?.events;
  if (Array.isArray(events)) {
    let inputTokens = 0;
    let outputTokens = 0;

    for (const event of events) {
      if (event.operationType === 'title-generation') continue;

      if (event.tokens) {
        inputTokens += event.tokens.input ?? 0;
        outputTokens += event.tokens.output ?? 0;
      }

      // Use the first non-title-generation model as fallback if env tags didn't provide one
      if (!notes.model && event.model) {
        notes.model = event.model;
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      notes.tokenUsage = { input: inputTokens, output: outputTokens };
    }
  }

  return notes;
}

/**
 * Parse all Amp sessions
 */
export async function parseAmpSessions(): Promise<UnifiedSession[]> {
  const files = findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const thread = parseThreadFile(filePath);
      if (!thread || !thread.id) continue;

      const firstUserMessage = extractFirstUserMessage(thread);
      const summary = cleanSummary(thread.title || firstUserMessage);

      const fileStats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').length;

      sessions.push({
        id: thread.id,
        source: 'amp',
        cwd: '',
        repo: '',
        lines,
        bytes: fileStats.size,
        createdAt: new Date(thread.created),
        updatedAt: new Date(fileStats.mtimeMs),
        originalPath: filePath,
        summary: summary || undefined,
        model: extractModel(thread),
      });
    } catch (err) {
      logger.debug('amp: skipping unparseable thread', filePath, err);
    }
  }

  return sessions
    .filter((s) => s.summary && s.summary.length > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from an Amp session for cross-tool continuation
 */
export async function extractAmpContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const thread = parseThreadFile(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  const filesModified: string[] = [];
  const pendingTasks: string[] = [];
  const toolSummaries: ToolUsageSummary[] = [];
  let sessionNotes: SessionNotes | undefined;

  if (thread) {
    sessionNotes = extractSessionNotes(thread);

    // Convert Amp messages to unified ConversationMessage format.
    // Slice to recent window (×2 to account for user+assistant pairs, matching gemini pattern).
    for (const msg of thread.messages.slice(-cfg.recentMessages * 2)) {
      const text = extractMessageText(msg);
      if (!text) continue;

      if (msg.role === 'user' || msg.role === 'assistant') {
        recentMessages.push({
          role: msg.role,
          content: text,
          // Amp threads don't carry per-message timestamps; use thread creation as fallback
          timestamp: new Date(thread.created),
        });
      }
    }

    // Scan last few assistant messages for pending-task signals
    const assistantMessages = thread.messages.filter((m) => m.role === 'assistant');
    for (const msg of assistantMessages.slice(-3)) {
      if (pendingTasks.length >= 5) break;
      const text = extractMessageText(msg).toLowerCase();
      if (
        text.includes('todo') ||
        text.includes('next step') ||
        text.includes('remaining') ||
        text.includes('need to')
      ) {
        // Extract the first sentence containing the keyword as the task hint
        const sentences = extractMessageText(msg).split(/[.!\n]/).filter(Boolean);
        for (const sentence of sentences) {
          if (pendingTasks.length >= 5) break;
          const lower = sentence.toLowerCase();
          if (
            lower.includes('todo') ||
            lower.includes('next step') ||
            lower.includes('remaining') ||
            lower.includes('need to')
          ) {
            pendingTasks.push(truncate(sentence.trim(), 120));
          }
        }
      }
    }
  }

  const trimmed = recentMessages.slice(-cfg.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
  );

  return {
    session: sessionNotes?.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}
