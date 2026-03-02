## Adapter Registry Architecture

This codebase uses a **registry-driven architecture** where all tool-specific behavior flows from a single `adapters` record in `src/parsers/registry.ts`. The CLI, session index, resume logic, and help text are all generated from the registry — no manual switch statements or hardcoded tool lists.

When reviewing PRs that touch tool-specific behavior, verify the change originates from or integrates with the registry rather than introducing a parallel lookup mechanism.

### Good — Derive behavior from registry
```ts
const adapter = adapters[session.source];
const args = adapter.nativeResumeArgs(session);
```

### Bad — Hardcoded tool enumeration
```ts
if (source === 'claude') { args = ['--resume', id]; }
else if (source === 'codex') { args = ['--resume', id]; }
// ...fragile, will break when new tools are added
```

## Adding a New Tool — The 4-Step Checklist

Adding a new AI coding tool requires changes in exactly 4 places, done in this order:

1. **`src/types/tool-names.ts`** — Add to `TOOL_NAMES` array (drives `SessionSource` type)
2. **`src/parsers/<tool>.ts`** — Create parser with `parse<Tool>Sessions()` + `extract<Tool>Context()`
3. **`src/parsers/registry.ts`** — Register with all `ToolAdapter` fields
4. **`src/__tests__/fixtures/index.ts`** — Add fixture factory + conversion tests

The registry has a completeness assertion at module load — if a name is in `TOOL_NAMES` but not registered, the CLI throws immediately. This is intentional: it ensures no tool is partially added.

### Good — Complete registration
```ts
// 1. tool-names.ts: add 'newtool' to TOOL_NAMES
// 2. parsers/newtool.ts: export parseNewtoolSessions + extractNewtoolContext
// 3. registry.ts:
register({
  name: 'newtool',
  label: 'NewTool',
  color: chalk.hex('#AABBCC'),
  storagePath: '~/.newtool/sessions/',
  binaryName: 'newtool',
  parseSessions: parseNewtoolSessions,
  extractContext: extractNewtoolContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `newtool --resume ${s.id}`,
});
```

### Bad — Incomplete registration
```ts
// Added parser file + registry entry, but forgot TOOL_NAMES
// Result: TypeScript error on SessionSource, or registry assertion throws at startup
```

## Parser Contract

Every parser must export two functions following the `ToolAdapter` interface:

1. `parse<Tool>Sessions()` — Discovers session files, returns `UnifiedSession[]` sorted by `updatedAt` descending
2. `extract<Tool>Context()` — Full conversation extraction, returns `SessionContext` with handoff markdown

Parsers must be **self-contained** (no cross-parser imports) and **fault-tolerant** (silently skip corrupted files).

### Good — Silent skip on parse failure
```ts
for (const file of sessionFiles) {
  try {
    const data = await parseSessionFile(file);
    sessions.push(data);
  } catch {
    // Skip corrupted/incompatible files silently
  }
}
```

### Bad — Letting parse errors propagate
```ts
for (const file of sessionFiles) {
  const data = await parseSessionFile(file); // Crashes CLI if any file is bad
  sessions.push(data);
}
```

## Zod Schema Validation

All raw data from disk must pass through Zod schemas defined in `src/types/schemas.ts`. Schemas use `.passthrough()` to tolerate unknown fields from future tool versions — never remove this.

### Good — Validate through schema
```ts
import { ClaudeMessageSchema } from '../types/schemas.js';

const parsed = ClaudeMessageSchema.safeParse(JSON.parse(line));
if (!parsed.success) continue; // Skip malformed line
const msg = parsed.data;
```

### Bad — Unsafe cast
```ts
const msg = JSON.parse(line) as ClaudeMessage; // No validation, crashes on malformed data
```

## ESM Module Discipline

This project is ESM-only (`"type": "module"` in package.json) with `NodeNext` module resolution. All local imports require `.js` extensions — TypeScript compiles `.ts` to `.js`, so import paths must reference the output extension.

### Good
```ts
import { cleanSummary } from '../utils/parser-helpers.js';
import { SummaryCollector } from '../utils/tool-summarizer.js';
```

### Bad
```ts
import { cleanSummary } from '../utils/parser-helpers';    // Missing .js — runtime crash
import { cleanSummary } from '../utils/parser-helpers.ts';  // .ts extension — wrong
```

## Error Hierarchy

Use the typed error classes from `src/errors.ts` instead of bare `Error`. Each class has a `.name` property for programmatic error handling.

| Error Class | When to Use |
|---|---|
| `ParseError` | Session file parsing failures |
| `SessionNotFoundError` | Session ID lookup misses |
| `ToolNotAvailableError` | CLI binary not found on PATH |
| `UnknownSourceError` | Invalid `SessionSource` value |
| `IndexError` | Cache read/write failures |
| `StorageError` | Handoff file I/O errors |

### Good
```ts
throw new ParseError('claude', filePath, `Malformed JSONL at line ${i}: ${e.message}`);
```

### Bad
```ts
throw new Error(`Parse failed`);  // No type, no context, not catchable by class
```

## Verbosity Config Passthrough

Parsers receive a `VerbosityConfig` parameter — this must be forwarded to `generateHandoffMarkdown()`. Dropping it silently falls back to the `'standard'` preset, ignoring user settings from `.continues.yml`.

### Good
```ts
async function extractToolContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  // ... parse messages, collect tool activity ...
  const markdown = generateHandoffMarkdown(session, messages, files, tasks, summaries, notes, config);
  return { session, recentMessages, filesModified, pendingTasks, toolSummaries, sessionNotes, markdown };
}
```

### Bad
```ts
// Forgot to pass config — user's verbosity settings are silently ignored
const markdown = generateHandoffMarkdown(session, messages, files, tasks, summaries, notes);
```
