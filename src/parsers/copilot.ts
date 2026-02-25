import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, ToolUsageSummary, UnifiedSession } from '../types/index.js';
import { classifyToolName } from '../types/tool-names.js';
import type { CopilotEvent, CopilotWorkspace } from '../types/schemas.js';
import { listSubdirectories } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { homeDir } from '../utils/parser-helpers.js';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';

const COPILOT_SESSIONS_DIR = path.join(homeDir(), '.copilot', 'session-state');

/**
 * Find all Copilot session directories
 */
async function findSessionDirs(): Promise<string[]> {
  return listSubdirectories(COPILOT_SESSIONS_DIR).filter((dir) => fs.existsSync(path.join(dir, 'workspace.yaml')));
}

/**
 * Parse workspace.yaml file
 */
function parseWorkspace(workspacePath: string): CopilotWorkspace | null {
  try {
    const content = fs.readFileSync(workspacePath, 'utf8');
    return YAML.parse(content) as CopilotWorkspace;
  } catch (err) {
    logger.debug('copilot: failed to parse workspace YAML', workspacePath, err);
    return null;
  }
}

/**
 * Extract model from events.jsonl
 */
async function extractModel(eventsPath: string): Promise<string | undefined> {
  let model: string | undefined;

  await scanJsonlHead(eventsPath, 50, (parsed) => {
    const event = parsed as CopilotEvent;
    if (event.type === 'session.start' && event.data?.selectedModel) {
      model = event.data.selectedModel;
      return 'stop';
    }
    return 'continue';
  });

  return model;
}

/**
 * Parse all Copilot sessions
 */
export async function parseCopilotSessions(): Promise<UnifiedSession[]> {
  const dirs = await findSessionDirs();
  const sessions: UnifiedSession[] = [];

  for (const sessionDir of dirs) {
    try {
      const workspacePath = path.join(sessionDir, 'workspace.yaml');
      const eventsPath = path.join(sessionDir, 'events.jsonl');

      const workspace = parseWorkspace(workspacePath);
      if (!workspace) continue;

      const stats = fs.existsSync(eventsPath) ? await getFileStats(eventsPath) : { lines: 0, bytes: 0 };
      const model = await extractModel(eventsPath);

      let summary = workspace.summary || '';
      if (summary.startsWith('|')) {
        summary = summary.replace(/^\|\n?/, '').split('\n')[0];
      }

      sessions.push({
        id: workspace.id,
        source: 'copilot',
        cwd: workspace.cwd,
        repo: workspace.repository,
        branch: workspace.branch,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: new Date(workspace.created_at),
        updatedAt: new Date(workspace.updated_at),
        originalPath: sessionDir,
        summary: summary.slice(0, 60),
        model,
      });
    } catch (err) {
      logger.debug('copilot: skipping unparseable session', sessionDir, err);
      // Skip sessions we can't parse
    }
  }

  return sessions.filter((s) => s.bytes > 0).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a Copilot session for cross-tool continuation
 */
export async function extractCopilotContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const eventsPath = path.join(session.originalPath, 'events.jsonl');
  const events = await readJsonlFile<CopilotEvent>(eventsPath);

  const recentMessages: ConversationMessage[] = [];
  const pendingTasks: string[] = [];

  // Process events to extract conversation
  for (const event of events.slice(-resolvedConfig.recentMessages * 2)) {
    if (event.type === 'user.message') {
      const content = event.data?.content || event.data?.transformedContent || '';
      if (content) {
        recentMessages.push({
          role: 'user',
          content,
          timestamp: new Date(event.timestamp),
        });
      }
    } else if (event.type === 'assistant.message') {
      const content = event.data?.content || '';
      const toolRequests = event.data?.toolRequests || [];

      if (content) {
        recentMessages.push({
          role: 'assistant',
          content: typeof content === 'string' ? content : JSON.stringify(content),
          timestamp: new Date(event.timestamp),
          toolCalls:
            toolRequests.length > 0 ? toolRequests.map((t) => ({ name: t.name, arguments: t.arguments })) : undefined,
        });
      } else if (toolRequests.length > 0) {
        // Assistant message with only tool calls (no text content)
        const toolNames = toolRequests.map((t) => t.name).join(', ');
        recentMessages.push({
          role: 'assistant',
          content: `[Used tools: ${toolNames}]`,
          timestamp: new Date(event.timestamp),
          toolCalls: toolRequests.map((t) => ({ name: t.name, arguments: t.arguments })),
        });
      }
    }
  }

  // If no conversation messages were found, synthesize from workspace summary
  if (recentMessages.length === 0 && session.summary) {
    recentMessages.push({
      role: 'user',
      content: session.summary,
      timestamp: session.createdAt,
    });
    recentMessages.push({
      role: 'assistant',
      content: `[Session worked on: ${session.summary}]`,
      timestamp: session.updatedAt,
    });
  }

  // Extract tool summaries and file modifications from toolRequests across all events
  const { summaries: toolSummaries, filesModified } = extractCopilotToolSummaries(events, resolvedConfig);

  const trimmed = recentMessages.slice(-resolvedConfig.recentMessages);

  // Generate markdown for injection
  const markdown = generateHandoffMarkdown(session, trimmed, filesModified, pendingTasks, toolSummaries);

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    markdown,
  };
}

/**
 * Extract tool usage summaries from Copilot events' toolRequests arrays.
 * Copilot doesn't provide tool results, so we capture names and arguments only.
 */
function extractCopilotToolSummaries(events: CopilotEvent[], config: VerbosityConfig): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const toolCounts = new Map<string, { count: number; samples: Array<{ summary: string; data?: import('../types/index.js').StructuredToolSample }> }>();
  const files = new Set<string>();
  const defaultSampleLimit = config.mcp.maxSamplesPerNamespace;

  for (const event of events) {
    if (event.type !== 'assistant.message') continue;
    const toolRequests = event.data?.toolRequests || [];
    for (const tr of toolRequests) {
      const name = tr.name || 'unknown';
      const category = classifyToolName(name);
      if (!category) continue; // skip internal tools

      if (!toolCounts.has(name)) {
        toolCounts.set(name, { count: 0, samples: [] });
      }
      const entry = toolCounts.get(name)!;
      entry.count++;

      const args = tr.arguments || {};
      const fp = (args.path as string) || (args.file_path as string) || '';

      // Track files from write/edit tool requests
      if ((category === 'write' || category === 'edit') && fp) {
        files.add(fp);
      }

      if (entry.samples.length < defaultSampleLimit) {
        const data = buildCopilotSampleData(category, name, args);
        const argsStr = Object.keys(args).length > 0 ? JSON.stringify(args).slice(0, 100) : '';
        entry.samples.push({
          summary: argsStr ? `${name}(${argsStr})` : name,
          data,
        });
      }
    }
  }

  const summaries = Array.from(toolCounts.entries()).map(([name, { count, samples }]) => ({
    name,
    count,
    samples,
  }));

  return { summaries, filesModified: Array.from(files) };
}

/** Build the correct StructuredToolSample for a Copilot tool request based on its classified category */
function buildCopilotSampleData(
  category: import('../types/tool-names.js').ToolSampleCategory,
  name: string,
  args: Record<string, unknown>,
): import('../types/index.js').StructuredToolSample {
  const fp = (args.path as string) || (args.file_path as string) || '';
  switch (category) {
    case 'shell':
      return { category: 'shell', command: (args.command as string) || (args.cmd as string) || '' };
    case 'read':
      return { category: 'read', filePath: fp };
    case 'write':
      return { category: 'write', filePath: fp };
    case 'edit':
      return { category: 'edit', filePath: fp };
    case 'grep':
      return {
        category: 'grep',
        pattern: (args.pattern as string) || (args.query as string) || '',
        ...(fp ? { targetPath: fp } : {}),
      };
    case 'glob':
      return { category: 'glob', pattern: (args.pattern as string) || fp };
    case 'search':
      return { category: 'search', query: (args.query as string) || '' };
    case 'fetch':
      return { category: 'fetch', url: (args.url as string) || '' };
    case 'task':
      return { category: 'task', description: (args.description as string) || '' };
    case 'ask':
      return { category: 'ask', question: ((args.question as string) || '').slice(0, 80) };
    default:
      return {
        category: 'mcp',
        toolName: name,
        ...(Object.keys(args).length > 0 ? { params: JSON.stringify(args).slice(0, 100) } : {}),
      };
  }
}
