import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tmpDirs: string[] = [];

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-parser-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function makeRows(opts: { id: string; first: string; last: string; cwd: string }): unknown[] {
  return [
    {
      type: 'user',
      uuid: `${opts.id}-user`,
      timestamp: opts.first,
      sessionId: opts.id,
      cwd: opts.cwd,
      gitBranch: 'main',
      message: { role: 'user', content: [{ type: 'text', text: `Start ${opts.id}` }] },
    },
    {
      type: 'assistant',
      uuid: `${opts.id}-assistant`,
      timestamp: opts.last,
      sessionId: opts.id,
      cwd: opts.cwd,
      gitBranch: 'main',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'This assistant response is intentionally long enough to keep the fixture above the parser size filter.',
          },
        ],
      },
    },
  ];
}

async function loadClaudeParser(configDir: string): Promise<typeof import('../parsers/claude.js')> {
  vi.resetModules();
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  return import('../parsers/claude.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('claude parser hardening', () => {
  it('normalizes Windows cwd paths for direct Claude project lookup', async () => {
    const configDir = makeConfigDir();
    const id = '33333333-3333-4333-8333-333333333333';
    const cwd = 'C:\\Users\\me\\my.project';
    const projectDir = path.join(configDir, 'projects', 'C-Users-me-my-project');
    writeJsonl(
      path.join(projectDir, `${id}.jsonl`),
      makeRows({ id, first: '2026-04-15T10:00:00.000Z', last: '2026-04-15T10:05:00.000Z', cwd }),
    );

    const { claudeProjectSlugFromCwd, parseClaudeSessions } = await loadClaudeParser(configDir);
    const sessions = await parseClaudeSessions({ cwd, lightweight: true });

    expect(claudeProjectSlugFromCwd(cwd)).toBe('C-Users-me-my-project');
    expect(sessions.map((session) => session.id)).toContain(id);
  });

  it('orders sessions by transcript timestamps instead of filesystem mtime', async () => {
    const configDir = makeConfigDir();
    const projectDir = path.join(configDir, 'projects', '-tmp-claude-project');
    const olderId = '11111111-1111-4111-8111-111111111111';
    const newerId = '22222222-2222-4222-8222-222222222222';
    const olderPath = path.join(projectDir, `${olderId}.jsonl`);
    const newerPath = path.join(projectDir, `${newerId}.jsonl`);

    writeJsonl(
      olderPath,
      makeRows({
        id: olderId,
        first: '2026-04-15T10:00:00.000Z',
        last: '2026-04-15T10:05:00.000Z',
        cwd: '/tmp/claude-project',
      }),
    );
    writeJsonl(
      newerPath,
      makeRows({
        id: newerId,
        first: '2026-04-15T11:00:00.000Z',
        last: '2026-04-15T11:30:00.000Z',
        cwd: '/tmp/claude-project',
      }),
    );

    fs.utimesSync(olderPath, new Date('2026-04-15T12:00:00.000Z'), new Date('2026-04-15T12:00:00.000Z'));
    fs.utimesSync(newerPath, new Date('2026-04-15T09:00:00.000Z'), new Date('2026-04-15T09:00:00.000Z'));

    const { parseClaudeSessions } = await loadClaudeParser(configDir);
    const sessions = await parseClaudeSessions();

    expect(sessions[0].id).toBe(newerId);
    expect(sessions[0].updatedAt.toISOString()).toBe('2026-04-15T11:30:00.000Z');
    expect(sessions[1].id).toBe(olderId);
  });
});
