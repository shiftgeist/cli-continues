import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSource, UnifiedSession } from '../types/index.js';

const require = createRequire(import.meta.url);
const tempDirs: string[] = [];

interface SqlitePreparedStatement {
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-parser-'));
  tempDirs.push(dir);
  return dir;
}

function globalStorageBase(home: string): string {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'Code', 'User', 'globalStorage');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage');
  }
  return path.join(home, '.config', 'Code', 'User', 'globalStorage');
}

async function loadClineParser(home: string): Promise<typeof import('../parsers/cline.js')> {
  vi.resetModules();
  vi.stubEnv('APPDATA', path.join(home, 'AppData', 'Roaming'));
  vi.doMock('../utils/parser-helpers.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/parser-helpers.js')>();
    return {
      ...actual,
      homeDir: () => home,
    };
  });
  vi.doMock('../utils/markdown.js', () => ({
    generateHandoffMarkdown: () => 'mock handoff markdown',
  }));
  return import('../parsers/cline.js');
}

function writeTask(home: string, extensionId: string, taskId: string, messages: unknown[]): string {
  const taskDir = path.join(globalStorageBase(home), extensionId, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'ui_messages.json');
  fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf8');
  return filePath;
}

function writeRawTask(home: string, extensionId: string, taskId: string, content: string): string {
  const taskDir = path.join(globalStorageBase(home), extensionId, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'ui_messages.json');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function sessionFor(source: SessionSource, originalPath: string): UnifiedSession {
  return {
    id: `${source}-task`,
    source,
    cwd: '',
    lines: 1,
    bytes: fs.statSync(originalPath).size,
    createdAt: new Date('2026-04-15T10:00:00.000Z'),
    updatedAt: new Date('2026-04-15T10:00:00.000Z'),
    originalPath,
    summary: 'Parser hardening',
  } satisfies UnifiedSession;
}

function openWritableSqlite(dbPath: string): SqliteDatabase {
  const sqliteModule = require('node:sqlite') as {
    DatabaseSync: new (database: string) => SqliteDatabase;
  };
  return new sqliteModule.DatabaseSync(dbPath);
}

function writeKiloDb(root: string, dbName = 'kilo.db'): string {
  const dbPath = path.join(root, dbName);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openWritableSqlite(dbPath);
  const created = Date.parse('2026-04-16T10:00:00.000Z');
  const updated = Date.parse('2026-04-16T10:03:00.000Z');

  try {
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

    db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('proj_kilo', '/tmp/kilo-project');
    db.prepare(
      'INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'ses_kilo_db',
      'proj_kilo',
      'kilo-db-session',
      '/tmp/kilo-project',
      'New session',
      '7.1.17',
      created,
      updated,
    );

    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'msg_user',
      'ses_kilo_db',
      created,
      created,
      JSON.stringify({ role: 'user' }),
    );
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'part_user',
      'msg_user',
      'ses_kilo_db',
      created,
      created,
      JSON.stringify({ type: 'text', text: 'Build DB-backed Kilo support' }),
    );
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'msg_assistant',
      'ses_kilo_db',
      updated,
      updated,
      JSON.stringify({
        role: 'assistant',
        modelID: 'claude-sonnet-4',
        tokens: { input: 12, output: 34, reasoning: 5, cache: { read: 3, write: 2 } },
      }),
    );
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'part_assistant',
      'msg_assistant',
      'ses_kilo_db',
      updated,
      updated,
      JSON.stringify({ type: 'text', text: 'Kilo DB sessions are now parsed safely.' }),
    );
  } finally {
    db.close();
  }

  return dbPath;
}

function writeUnsupportedKiloDb(root: string): string {
  const dbPath = path.join(root, 'kilo.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openWritableSqlite(dbPath);
  try {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY);');
  } finally {
    db.close();
  }
  return dbPath;
}

afterEach(() => {
  vi.doUnmock('../utils/parser-helpers.js');
  vi.doUnmock('../utils/markdown.js');
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('Cline-family parser hardening', () => {
  it('discovers and labels Cline, Roo Code, and Kilo Code task storage variants', async () => {
    const home = makeHome();
    writeTask(home, 'saoudrizwan.claude-dev', 'cline-task', [
      { ts: 1770000000000, type: 'say', say: 'task', text: 'Build the Cline parser fixture' },
    ]);
    writeTask(home, 'rooveterinaryinc.roo-cline', 'roo-legacy-task', [
      { ts: 1770000001000, type: 'say', say: 'text', text: 'Build the legacy Roo parser fixture' },
    ]);
    writeTask(home, 'roo-code.roo-cline', 'roo-current-task', [
      { ts: 1770000002000, type: 'say', say: 'text', text: 'Build the current Roo parser fixture' },
    ]);
    writeTask(home, 'kilocode.kilo-code', 'kilo-task', [
      { ts: 1770000003000, type: 'say', say: 'text', text: 'Build the Kilo parser fixture' },
    ]);

    const { parseClineSessions, parseRooCodeSessions, parseKiloCodeSessions } = await loadClineParser(home);

    const clineSessions = await parseClineSessions();
    const rooSessions = await parseRooCodeSessions();
    const kiloSessions = await parseKiloCodeSessions();

    expect(clineSessions).toHaveLength(1);
    expect(clineSessions[0]).toMatchObject({
      id: 'cline-task',
      source: 'cline',
      summary: 'Build the Cline parser fixture',
    });
    expect(clineSessions[0].originalPath).toContain('saoudrizwan.claude-dev');

    expect(rooSessions.map((session) => session.id).sort()).toEqual(['roo-current-task', 'roo-legacy-task']);
    expect(rooSessions.every((session) => session.source === 'roo-code')).toBe(true);
    expect(rooSessions.map((session) => session.summary).sort()).toEqual([
      'Build the current Roo parser fixture',
      'Build the legacy Roo parser fixture',
    ]);

    expect(kiloSessions).toHaveLength(1);
    expect(kiloSessions[0]).toMatchObject({
      id: 'kilo-task',
      source: 'kilo-code',
      summary: 'Build the Kilo parser fixture',
    });
    expect(kiloSessions[0].originalPath).toContain('kilocode.kilo-code');
  });

  it('discovers and extracts Kilo Code sessions from XDG kilo.db storage while preserving legacy task support', async () => {
    const home = makeHome();
    const xdgDataHome = path.join(home, '.xdg-data');
    const dbPath = writeKiloDb(path.join(xdgDataHome, 'kilo'));
    writeTask(home, 'kilocode.kilo-code', 'kilo-legacy-task', [
      { ts: 1770000003000, type: 'say', say: 'text', text: 'Keep legacy Kilo task support' },
    ]);
    vi.stubEnv('XDG_DATA_HOME', xdgDataHome);

    const { parseKiloCodeSessions, extractKiloCodeContext } = await loadClineParser(home);
    const sessions = await parseKiloCodeSessions();

    expect(sessions.map((session) => session.id).sort()).toEqual(['kilo-legacy-task', 'ses_kilo_db']);

    const dbSession = sessions.find((session) => session.id === 'ses_kilo_db');
    expect(dbSession).toMatchObject({
      source: 'kilo-code',
      cwd: '/tmp/kilo-project',
      originalPath: dbPath,
      summary: 'Build DB-backed Kilo support',
      model: 'claude-sonnet-4',
      lines: 2,
    });

    const context = await extractKiloCodeContext(dbSession as UnifiedSession);

    expect(context.recentMessages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Build DB-backed Kilo support'],
      ['assistant', 'Kilo DB sessions are now parsed safely.'],
    ]);
    expect(context.session.model).toBe('claude-sonnet-4');
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 12, output: 34 });
    expect(context.sessionNotes?.thinkingTokens).toBe(5);
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 2, read: 3 });
    expect(context.sessionNotes?.rawAccess).toEqual({ kind: 'sqlite', path: dbPath });
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      storage: 'sqlite',
      dbPath,
      slug: 'kilo-db-session',
      version: '7.1.17',
      projectId: 'proj_kilo',
    });
    expect(context.sessionNotes?.fidelityWarnings).toBeUndefined();
  });

  it('uses explicit KILO_DB and tolerates unsupported Kilo SQLite schemas with fidelity warnings', async () => {
    const home = makeHome();
    const dbPath = writeUnsupportedKiloDb(home);
    vi.stubEnv('KILO_DB', dbPath);

    const { parseKiloCodeSessions, extractKiloCodeContext } = await loadClineParser(home);
    const sessions = await parseKiloCodeSessions();
    const context = await extractKiloCodeContext(sessionFor('kilo-code', dbPath));

    expect(sessions).toEqual([]);
    expect(context.recentMessages).toEqual([]);
    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([
        'Kilo SQLite schema unsupported: missing "message" table.',
        'Kilo SQLite schema unsupported: missing "part" table.',
      ]),
    );
    expect(context.sessionNotes?.rawAccess).toEqual({ kind: 'sqlite', path: dbPath });
  });

  it('discovers and extracts Kilo Code sessions from an explicit KILO_DB path without requiring a .db suffix', async () => {
    const home = makeHome();
    const dbPath = writeKiloDb(path.join(home, 'custom-storage'), 'custom-kilo-store');
    vi.stubEnv('KILO_DB', dbPath);

    const { parseKiloCodeSessions, extractKiloCodeContext } = await loadClineParser(home);
    const sessions = await parseKiloCodeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'ses_kilo_db',
      source: 'kilo-code',
      originalPath: dbPath,
      summary: 'Build DB-backed Kilo support',
    });

    const context = await extractKiloCodeContext(sessions[0]);

    expect(context.recentMessages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Build DB-backed Kilo support'],
      ['assistant', 'Kilo DB sessions are now parsed safely.'],
    ]);
    expect(context.sessionNotes?.rawAccess).toEqual({ kind: 'sqlite', path: dbPath });
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      storage: 'sqlite',
      dbPath,
    });
  });

  it('skips invalid JSON, non-array JSON, malformed entries, and metadata-only tasks during discovery', async () => {
    const home = makeHome();
    writeRawTask(home, 'saoudrizwan.claude-dev', 'invalid-json', '{not valid json');
    writeRawTask(home, 'saoudrizwan.claude-dev', 'non-array-json', JSON.stringify({ type: 'say', say: 'task' }));
    writeTask(home, 'saoudrizwan.claude-dev', 'metadata-only', [
      null,
      42,
      {},
      { type: 'say', say: 'api_req_started', text: '{"tokensIn":1}' },
      { type: 'say', say: 'command_output', text: 'metadata noise' },
    ]);
    writeTask(home, 'saoudrizwan.claude-dev', 'valid-task', [
      null,
      { type: 'say', say: 'text', text: { nested: 'not text' } },
      { ts: 1770000100000, type: 'say', say: 'task', text: 'Keep this valid task' },
    ]);

    const { parseClineSessions } = await loadClineParser(home);
    const sessions = await parseClineSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'valid-task',
      summary: 'Keep this valid task',
    });
  });

  it('extracts shared context without duplicating streaming partials or fabricating tool summaries', async () => {
    const home = makeHome();
    const messages = [
      null,
      42,
      { ts: 1770000200000, type: 'say', say: 'task', text: 'Implement parser hardening' },
      { ts: 1770000201000, type: 'say', say: 'api_req_started', text: 'not json' },
      {
        ts: 1770000202000,
        type: 'say',
        say: 'api_req_started',
        text: '{"tokensIn":10,"tokensOut":0,"cacheWrites":2,"cacheReads":3,"cost":0.01}',
      },
      { ts: 1770000203000, type: 'say', say: 'text', text: 'Draft assistant answer', partial: true },
      { ts: 1770000204000, type: 'say', say: 'text', text: 'Final assistant answer', partial: false },
      { ts: 1770000205000, type: 'ask', ask: 'followup', text: 'Should I add parser tests?' },
      { ts: 1770000206000, type: 'say', say: 'user_feedback', text: 'Yes, add parser tests' },
      {
        ts: 1770000207000,
        type: 'say',
        say: 'reasoning',
        reasoning: 'Need to cover malformed messages, streaming finalization, and all source variants.',
      },
      {
        ts: 1770000208000,
        type: 'say',
        say: 'api_req_finished',
        text: '{"totalTokensIn":7,"totalTokensOut":8,"totalCacheWrites":1,"totalCacheReads":4,"totalCost":0.02}',
      },
      {
        ts: 1770000209000,
        type: 'ask',
        ask: 'completion_result',
        text: 'Done with parser hardening.\n- [ ] Run manual release check\nNext step: inspect handoff output',
      },
      { ts: 1770000210000, type: 'say', say: 'command_output', text: 'metadata noise' },
      { ts: 1770000211000, type: 'ask', ask: 'command', text: 'npm test' },
      { ts: 1770000212000, type: 'say', say: 'text', text: { nested: 'not text' } },
    ];
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'context-task', messages);

    const { extractClineContext, extractRooCodeContext, extractKiloCodeContext } = await loadClineParser(home);
    const extractors = [
      ['cline', extractClineContext],
      ['roo-code', extractRooCodeContext],
      ['kilo-code', extractKiloCodeContext],
    ] as const;

    for (const [source, extractContext] of extractors) {
      const context = await extractContext(sessionFor(source, originalPath));
      const contents = context.recentMessages.map((message) => message.content);

      expect(context.recentMessages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'assistant',
        'user',
        'assistant',
        'assistant',
      ]);
      expect(contents).toEqual([
        'Implement parser hardening',
        'Final assistant answer',
        'Should I add parser tests?',
        'Yes, add parser tests',
        'Need to cover malformed messages, streaming finalization, and all source variants.',
        'Done with parser hardening.\n- [ ] Run manual release check\nNext step: inspect handoff output',
      ]);
      expect(contents).not.toContain('Draft assistant answer');
      expect(contents).not.toContain('metadata noise');
      expect(contents).not.toContain('npm test');
      expect(context.sessionNotes?.tokenUsage).toEqual({ input: 17, output: 8 });
      expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 3, read: 7 });
      expect(context.sessionNotes?.reasoning).toEqual([
        'Need to cover malformed messages, streaming finalization, and all source variants.',
      ]);
      expect(context.pendingTasks).toEqual(['- [ ] Run manual release check', 'Next step: inspect handoff output']);
      expect(context.filesModified).toEqual([]);
      expect(context.toolSummaries).toEqual([]);
    }
  });

  it('returns empty context instead of throwing for invalid or non-array ui_messages.json files', async () => {
    const home = makeHome();
    const invalidPath = writeRawTask(home, 'saoudrizwan.claude-dev', 'invalid-context', '{not valid json');
    const nonArrayPath = writeRawTask(
      home,
      'saoudrizwan.claude-dev',
      'non-array-context',
      JSON.stringify({ ok: true }),
    );

    const { extractClineContext } = await loadClineParser(home);

    for (const originalPath of [invalidPath, nonArrayPath]) {
      const context = await extractClineContext(sessionFor('cline', originalPath));

      expect(context.recentMessages).toEqual([]);
      expect(context.pendingTasks).toEqual([]);
      expect(context.filesModified).toEqual([]);
      expect(context.toolSummaries).toEqual([]);
      expect(context.sessionNotes).toEqual({});
    }
  });
});
