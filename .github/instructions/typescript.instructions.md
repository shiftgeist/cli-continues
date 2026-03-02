---
applyTo: "**/*.ts"
---

# TypeScript Review Guidelines

## Type Safety

- Avoid `any` — use `unknown` for external data (JSON.parse results, JSONL lines), then narrow with type guards
- Define interfaces for all object shapes that cross module boundaries — not inline object literals
- Use `as const` for literal arrays like `TOOL_NAMES` to get narrower inferred types

```typescript
// Avoid
const parsed = JSON.parse(line) as any;
return parsed.type;

// Prefer
const parsed = JSON.parse(line) as unknown;
if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return;
// Narrowed — safe to access (parsed as Record<string, unknown>)
```

## Discriminated Unions

- Use `switch (d.category)` for narrowing `StructuredToolSample` — not `instanceof` checks
- New tool sample types must be added to the `StructuredToolSample` union in `src/types/index.ts`
- The `category` field is the discriminant — never use string-equality checks outside of switch

## Async Patterns

- All file I/O must be async: use `fs.promises.*` not `fs.readFileSync` / `fs.writeFileSync`
- JSONL files must be streamed with `readline.createInterface` — never loaded into memory wholesale
- Avoid blocking the event loop in parsers — they run in parallel via `Promise.allSettled`

## Import Rules

- Local imports must end in `.js`: `import { foo } from './bar.js'` — required for Node.js ESM module resolution
- Never import from `dist/` in source files
- Prefer named exports over default exports for better refactoring support

## Defensive Patterns

- Use optional chaining (`?.`) and nullish coalescing (`??`) for optional fields from parsed session data
- Sessions returned from parsers must be sorted by `updatedAt` descending (newest first)
- Use `process.exitCode = N` over `process.exit(N)` to allow SIGTERM/SIGINT handlers to run
