---
applyTo: "src/__tests__/**/*.ts"
---

# Test Review Guidelines

## Fixture-Based Testing

- Tests must NOT require real session files on the local machine — use fixture factories from `src/__tests__/fixtures/index.ts`
- Each tool has a `create<Tool>Fixture()` factory that creates a temp directory with realistic session data
- Ground fixture schemas in real session file formats — verify field names against actual tool storage before creating fixtures; do not invent schemas

## Conversion Coverage

- `unit-conversions.test.ts` is the primary suite — it must cover all N tools × (N-1) target conversion paths
- Adding a new tool requires: a fixture factory AND conversion tests covering all N-1 directions (as both source and target)
- PRs that add a new parser but do not update `unit-conversions.test.ts` are incomplete

## Test Quality

- Each test asserts ONE behavior — not multiple unrelated assertions bundled into a single test case
- Test names should describe the scenario: `should extract session summary from Claude JSONL`
- Tests must be independent — no shared mutable state between test cases
- Use `beforeAll` / `afterAll` for fixture setup and cleanup (create temp dir → run tests → delete temp dir)

## Regression Tests

- Bug fixes must include a regression test that fails before the fix and passes after
- PRs that modify parser logic without touching any test file should be flagged — the CI `test-quality` job will also flag this

## Performance

- Test timeout is 30 seconds (`vitest.config.ts`) — a test that times out indicates a parser with blocking or synchronous I/O
- Excluded by vitest config: `e2e*`, `real-e2e*`, `stress*`, `injection*`, `parsers.test*` — these require a real environment and are not run in CI
- Node.js 22+ is required; `node:sqlite` built-in is used by OpenCode/Crush fixtures — do not add third-party SQLite deps
