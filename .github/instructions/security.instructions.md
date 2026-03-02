---
applyTo: "src/utils/**/*.ts"
---

# Security Review Guidelines — Core Utilities

## Command Injection Prevention (resume.ts)

- External processes must be spawned with `spawn()` and arguments as an **array** — NEVER `exec()` with string interpolation
- Session IDs and file paths from parsed sessions are user-controlled and may contain shell metacharacters (`;`, `|`, `&`, `$`, backticks) — they must always be array elements, never embedded in a shell string

```typescript
// Avoid — command injection if sessionId contains ; or | or $()
exec(`claude --resume ${sessionId}`);

// Prefer — safe regardless of sessionId content
spawn('claude', ['--resume', sessionId], { stdio: 'inherit' });
```

## Forward Flag Security (forward-flags.ts)

- `--dangerously-skip-permissions` (Claude) and `--dangerously-bypass-approvals-and-sandbox` (Codex) must ONLY be set when the source session **explicitly** requested auto-approve behavior
- Flag precedence is security-critical: auto-approve > full-auto > sandbox > ask-for-approval — deviations from this order could grant unintended permissions in the target tool
- Never map a "plan mode" flag or any scheduling flag to auto-approve behavior

## Handoff Output Safety (markdown.ts)

- Do NOT embed secrets, API keys, tokens, or environment variable values in handoff markdown output
- Tool activity summaries (shell command output, file diffs) may contain sensitive data — the verbosity config caps limit exposure; do not bypass these caps
- Home directory paths in handoff output must be tildified (`~/`) using `safePath()` — never expose the full absolute home path

## General

- No hardcoded credentials, API keys, or tokens anywhere in source files
- User-supplied paths (session file paths, `cwd` values) must not be passed to shell execution without sanitization — use `spawn()` with array args only
