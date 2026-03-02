---
applyTo: ".github/workflows/**/*.{yml,yaml}"
---

# CI Workflow Review Guidelines

## Security

- Pin action versions to at least a named tag (`actions/checkout@v4`); prefer full commit SHA for security-critical actions
- Set `permissions` explicitly on any job that needs elevated access (e.g., `pull-requests: write`) — do not rely on repository-wide defaults
- Never print secret values to logs — use GitHub's secret masking for dynamic secrets

```yaml
# Prefer explicit permissions scoping
permissions:
  pull-requests: write
  contents: read
```

## Node.js Version Requirements

- Node 22 is the minimum supported version (`engines.node >= 22.0.0` in `package.json`)
- The CI matrix must include at least Node 22 and the latest even-numbered LTS — do not drop below 22
- `node:sqlite` (built-in, Node 22.5+) is used by OpenCode and Crush parsers — do not add third-party SQLite packages

## Package Manager

- Use `pnpm` exclusively — not `npm ci` or `yarn` — to stay consistent with `pnpm-lock.yaml`
- Always run `pnpm install --frozen-lockfile` in CI to prevent accidental lockfile mutations
- Use `pnpm/action-setup@v4` for pnpm setup

## Build and Test Order

- Run `pnpm run build` (TypeScript compile) before `pnpm test` — `tsc` validates type correctness; test failures may be caused by type errors caught at build time
- The `test-quality` job posts a PR comment summarizing test counts and flags source-file changes without corresponding test changes — do not remove this job without an equivalent replacement
- The `test-quality` job should only run on `pull_request` events (not push to `main`)
