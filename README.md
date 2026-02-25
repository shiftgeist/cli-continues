# continues

> Pick up where you left off — seamlessly continue AI coding sessions across Claude Code, Codex, Copilot, Gemini CLI, Cursor, Amp, Cline, Roo Code, Kilo Code, Kiro, Crush, OpenCode, Droid & Antigravity.

```bash
npx continues
```

https://github.com/user-attachments/assets/6945f3a5-bd19-45ab-9702-6df8e165a734


[![npm version](https://img.shields.io/npm/v/continues.svg)](https://www.npmjs.com/package/continues)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why?

Have you ever hit your daily limit on Claude Code mid-debug? Or burned through your Gemini quota right when things were getting interesting?

You've built up 30 messages of context — file changes, architecture decisions, debugging history. And now you either wait hours for the limit to reset, or start fresh in another tool and explain everything from scratch.

**`continues` reads your session from any supported tool, extracts the context, and injects it into whichever tool you switch to.** Your conversation history, file changes, and working directory all come along.

## Features

- 🔄 **Cross-tool handoff** — Move sessions between Claude Code, Codex, Copilot, Gemini CLI, Cursor, Amp, Cline, Roo Code, Kilo Code, Kiro, Crush, OpenCode, Droid & Antigravity
- 🔍 **Auto-discovery** — Scans all 14 tools' session directories automatically
- 🛠️ **Tool activity extraction** — Parses shell commands, file edits, MCP tool calls, patches, and more from every session
- 🧠 **AI reasoning capture** — Extracts thinking blocks, agent reasoning, and model info for richer handoffs
- 📋 **Interactive picker** — Browse, filter, and select sessions with a beautiful TUI
- ⚡ **Quick resume** — `continues claude` / `continues codex 3` — one command, done
- 🖥️ **Scriptable** — JSON/JSONL output, TTY detection, non-interactive mode
- 📊 **Session stats** — `continues scan` to see everything at a glance
- 📊 **Verbosity presets** — `minimal`/`standard`/`verbose`/`full` control over output detail
- 🔎 **Session inspector** — `continues inspect <id>` — diagnostic view of parsing pipeline
- ⚙️ **YAML configuration** — `.continues.yml` for per-project verbosity tuning

## Installation

No install needed — just run:

```bash
npx continues
```

Or install globally:

```bash
npm install -g continues
```

Both `continues` and `cont` work as commands after global install.

## Quick Start

```bash
# Interactive session picker — browse, pick, switch tools
continues

# List all sessions across every tool
continues list

# Grab a Claude session and continue it in Gemini
continues resume abc123 --in gemini

# Pass launch flags to the destination tool during cross-tool handoff
continues resume abc123 --in codex --yolo --search --add-dir /tmp

# Quick-resume your latest Claude session (native resume)
continues claude
```

## Usage

### Interactive Mode (default)

Just run `continues`. It walks you through:

1. Filter by directory, CLI tool, or browse all
2. Pick a session
3. Choose which CLI tool to continue in (only shows *other* tools — the whole point is switching)

When you run `continues` from a project directory, it prioritizes sessions from that directory first:

```
┌  continues — pick up where you left off
│
│  ▸ 18 sessions found in current directory
│  Found 1842 sessions across 14 CLI tools
│    claude: 723  codex: 72  cursor: 68  copilot: 39  opencode: 38  droid: 71  gemini: 31
│    amp: 84  kiro: 22  crush: 45  cline: 312  roo-code: 198  kilo-code: 56  antigravity: 83
│
◆  Filter sessions
│  ● This directory (18 sessions)
│  ○ All CLI tools (1842 sessions)
│  ○ Claude (723)
│  ○ Codex (72)
│  ○ Copilot (39)
│  ○ Droid (71)
│  ○ Opencode (38)
│  ○ Gemini (31)
│  ○ Cursor (68)
│  ○ Amp (84)
│  ○ Kiro (22)
│  ○ Crush (45)
│  ○ Cline (312)
│  ○ Roo Code (198)
│  ○ Kilo Code (56)
│  ○ Antigravity (83)
└

◆  Select a session (12 available)
│  [claude]    2026-02-19 05:28  my-project    Debugging SSH tunnel config   84a36c5d
│  [copilot]   2026-02-19 04:41  my-project    Migrate presets from Electron c2f5974c
│  [codex]     2026-02-18 23:12  my-project    Fix OpenCode SQLite parser    a1e90b3f
│  ...
└

◆  Continue claude session in:
│  ○ Gemini
│  ○ Copilot
│  ○ Codex
│  ○ OpenCode
│  ○ Droid
│  ○ Cursor
│  ○ Amp
│  ○ Kiro
│  ○ Crush
│  ○ Cline
│  ○ Roo Code
│  ○ Kilo Code
│  ○ Antigravity
└
```

If no sessions are found for the current directory, all sessions are shown automatically.

### Non-interactive

```bash
continues list                          # List all sessions
continues list --source claude --json   # JSON output, filtered
continues list --jsonl -n 10            # JSONL, limit to 10
continues scan                          # Session discovery stats
continues rebuild                       # Force-rebuild the index
```

`list` output:

```
Found 894 sessions (showing 5):

[claude]   2026-02-19 05:28  dev-test/SuperCmd     SSH tunnel config debugging         84a36c5d
[copilot]  2026-02-19 04:41  migrate-to-tauri      Copy Presets From Electron          c2f5974c
[codex]    2026-02-18 23:12  cli-continues         Fix OpenCode SQLite parser          a1e90b3f
[gemini]   2026-02-18 05:10  my-project            Tauri window management             96315428
[opencode] 2026-02-14 17:12  codex-session-picker  Where does Codex save JSON files    ses_3a2d
```

### Quick Resume

Resume the Nth most recent session from a specific tool using native resume (no context injection — fastest, preserves full history):

```bash
continues claude        # Latest Claude session
continues codex 3       # 3rd most recent Codex session
continues copilot       # Latest Copilot session
continues gemini 2      # 2nd most recent Gemini session
continues opencode      # Latest OpenCode session
continues droid         # Latest Droid session
continues cursor        # Latest Cursor session
continues amp           # Latest Amp session
continues kiro          # Latest Kiro session
continues crush         # Latest Crush session
continues cline         # Latest Cline session
continues roo-code      # Latest Roo Code session
continues kilo-code     # Latest Kilo Code session
continues antigravity   # Latest Antigravity session
```

### Cross-tool Handoff

This is the whole point. Start in one tool, finish in another:

```bash
# You were debugging in Claude, but hit the rate limit.
# Grab the session ID from `continues list` and hand it off:
continues resume abc123 --in gemini

# Or pick interactively — just run `continues`, select a session,
# and choose a different tool as the target.

# In picker flows, forward destination flags after `--`
continues pick -- --model gpt-5 --sandbox workspace-write
```

`continues` extracts your conversation context (messages, file changes, pending tasks) and injects it as a structured prompt into the target tool. The target picks up with full awareness of what you were working on.

When forwarding flags in cross-tool mode, `continues` maps common interactive settings to the selected target tool (model, sandbox/permissions, yolo/auto-approve, extra directories, etc.). Any flag that is not mapped is passed through as-is to the destination CLI.

## How It Works

```
1. Discovery    → Scans session directories for all 14 tools
2. Parsing      → Reads each tool's native format (JSONL, JSON, SQLite, YAML)
3. Extraction   → Pulls recent messages, file changes, tool activity, AI reasoning
4. Summarizing  → Groups tool calls by type with concise one-line samples
5. Handoff      → Generates a structured context document
6. Injection    → Launches target tool with the context pre-loaded
```

### Tool Activity Extraction

Every tool call from the source session is parsed, categorized, and summarized. The handoff document includes a **Tool Activity** section so the target tool knows exactly what was done — not just what was said.

Shared formatting helpers (`SummaryCollector` + per-tool formatters in `src/utils/tool-summarizer.ts`) keep summaries consistent across all 14 CLIs. Adding support for a new tool type is a one-liner.

**What gets extracted per CLI:**

| Tool | Extracted |
|:-----|:----------|
| Claude Code | Bash commands (with exit codes), Read/Write/Edit (file paths), Grep/Glob, WebFetch/WebSearch, Task/subagent dispatches, MCP tools (`mcp__*`), thinking blocks → reasoning notes |
| Codex CLI | exec_command/shell_command (grouped by base command: `npm`, `git`, etc.), apply_patch (file paths from patch format), web_search, write_stdin, MCP resources, agent_reasoning → reasoning notes, token usage |
| Gemini CLI | read_file/write_file (with `diffStat`: +N -M lines), thoughts → reasoning notes, model info, token usage (accumulated) |
| Copilot CLI | Session metadata from workspace.yaml (tool calls not persisted by Copilot) |
| OpenCode | Messages from SQLite DB or JSON fallback (tool-specific parts TBD) |
| Factory Droid | Create/Read/Edit (file paths), Execute/Bash (shell commands), LS, MCP tools (`context7___*`, etc.), thinking blocks → reasoning notes, todo tasks, model info, token usage from companion `.settings.json` |
| Cursor (CLI) | Bash/terminal commands, Read/Write/Edit/apply_diff (file paths), Grep/codebase_search, Glob/list_directory/file_search, WebFetch, WebSearch, Task/subagent dispatches, MCP tools (`mcp__*`), thinking blocks → reasoning notes |
| Amp CLI | Messages and tool calls from thread JSON, shell commands, file operations, thinking blocks → reasoning notes |
| Kiro IDE | Workspace session messages, file edits, tool invocations from session JSON |
| Crush CLI | Messages from SQLite DB (`crush.db`), shell commands, file operations |
| Cline | VS Code extension task JSON — shell commands, file read/write/edit, MCP tools, thinking blocks → reasoning notes |
| Roo Code | VS Code extension task JSON (same schema as Cline) — shell commands, file operations, MCP tools |
| Kilo Code | VS Code extension task JSON (same schema as Cline) — shell commands, file operations, MCP tools |
| Antigravity | JSONL code tracker logs — file operations, shell commands, session metadata |

**Example handoff output:**

```markdown
## Tool Activity
- **Bash** (×47): `$ npm test → exit 0` · `$ git status → exit 0` · `$ npm run build → exit 1`
- **Edit** (×12): `edit src/auth.ts` · `edit src/api/routes.ts` · `edit tests/auth.test.ts`
- **Grep** (×8): `grep "handleLogin" src/` · `grep "JWT_SECRET"` · `grep "middleware"`
- **apply_patch** (×5): `patch: src/utils/db.ts, src/models/user.ts`

## Session Notes
- **Model**: claude-sonnet-4
- **Tokens**: 45,230 input, 12,847 output
- 💭 Need to handle the edge case where token refresh races with logout
- 💭 The middleware chain order matters — auth must come before rate limiting
```

### Session Storage

`continues` reads session data from each tool's native storage. Read-only — it doesn't modify or copy anything.

| Tool | Location | Format |
|:-----|:---------|:-------|
| Claude Code | `~/.claude/projects/` | JSONL |
| GitHub Copilot | `~/.copilot/session-state/` | YAML + JSONL |
| Google Gemini CLI | `~/.gemini/tmp/*/chats/` | JSON |
| OpenAI Codex | `~/.codex/sessions/` | JSONL |
| OpenCode | `~/.local/share/opencode/storage/` | SQLite |
| Factory Droid | `~/.factory/sessions/` | JSONL + JSON |
| Cursor (CLI) | `~/.cursor/projects/*/agent-transcripts/` | JSONL |
| Amp | `~/.local/share/amp/threads/` | JSON |
| Kiro | `~/Library/Application Support/Kiro/workspace-sessions/` | JSON |
| Crush | `~/.crush/crush.db` | SQLite |
| Cline | VS Code `globalStorage/saoudrizwan.claude-dev/tasks/` | JSON |
| Roo Code | VS Code `globalStorage/rooveterinaryinc.roo-cline/tasks/` | JSON |
| Kilo Code | VS Code `globalStorage/kilocode.kilo-code/tasks/` | JSON |
| Antigravity | `~/.gemini/antigravity/code_tracker/` | JSONL |

Session index cached at `~/.continues/sessions.jsonl`. Auto-refreshes when stale (5 min TTL).

## Commands

```
continues                           Interactive TUI picker (default)
continues list                      List all sessions
continues resume <id>               Resume by session ID
continues resume <id> --in <tool>   Cross-tool handoff
continues inspect <id>              Diagnostic view of parsing pipeline
continues scan                      Session discovery statistics
continues rebuild                   Force-rebuild session index
continues <tool> [n]                Quick-resume Nth session from tool
```

### Global Options

| Flag | Description |
|:-----|:------------|
| `--config <path>` | Path to a `.continues.yml` config file |
| `--preset <name>` | Verbosity preset: `minimal`, `standard`, `verbose`, `full` |

### `continues` / `continues pick`

Interactive session picker. Requires a TTY.

| Flag | Description |
|:-----|:------------|
| `-s, --source <tool>` | Pre-filter to one tool |
| `--no-tui` | Disable interactive mode |
| `--rebuild` | Force-rebuild index first |
| `-- ...` | Forward raw launch flags to selected destination tool |

### `continues list` (alias: `ls`)

| Flag | Description | Default |
|:-----|:------------|:--------|
| `-s, --source <tool>` | Filter by tool | all |
| `-n, --limit <number>` | Max sessions to show | 50 |
| `--json` | Output as JSON array | — |
| `--jsonl` | Output as JSONL | — |
| `--rebuild` | Force-rebuild index first | — |

### `continues resume <id>` (alias: `r`)

| Flag | Description | Default |
|:-----|:------------|:--------|
| `-i, --in <tool>` | Target tool for cross-tool handoff | — |
| `--preset <name>` | Verbosity preset for handoff generation | `standard` |
| `--no-tui` | Skip interactive prompts | — |
| `...` unknown flags | In cross-tool mode, map common flags and pass unmapped ones directly to destination CLI | — |

### `continues inspect <id>`

Diagnostic command that runs the full parsing pipeline and outputs detailed statistics — what was parsed, how much made it into the markdown, and conversion efficiency.

| Flag | Description | Default |
|:-----|:------------|:--------|
| `--preset <name>` | Verbosity preset to use for inspection | `standard` |
| `--truncate <n>` | Truncate long values to N characters | — |
| `--write-md <path>` | Write the generated handoff markdown to a file | — |

### `continues scan`

| Flag | Description |
|:-----|:------------|
| `--rebuild` | Force-rebuild index first |

### `continues <tool> [n]`

Quick-resume using native resume (same tool, no context injection).  
Tools: `claude`, `codex`, `copilot`, `gemini`, `opencode`, `droid`, `cursor`, `amp`, `kiro`, `crush`, `cline`, `roo-code`, `kilo-code`, `antigravity`. Default `n` is 1.

## Verbosity Configuration

Control how much detail goes into handoff documents with presets or YAML config.

### Presets

| Preset | Recent Messages | Tool Samples | Subagent Detail | Use Case |
|:-------|:----------------|:-------------|:----------------|:---------|
| `minimal` | 3 | 0 | None | Quick context, small handoffs |
| `standard` | 10 | 5 | 500 chars | Default, balanced |
| `verbose` | 20 | 10 | 2000 chars | Detailed debugging |
| `full` | 50 | All | Full | Complete session capture |

```bash
continues resume abc123 --preset full
continues inspect abc123 --preset verbose --write-md handoff.md
```

### YAML Config

Create `.continues.yml` in your project root:

```yaml
preset: verbose
recentMessages: 15
shell:
  maxSamples: 10
  stdoutLines: 20
```

Config resolution order:
1. Explicit `--config <path>` CLI flag
2. `.continues.yml` in current directory
3. `~/.continues/config.yml`
4. `standard` preset (built-in default)

See `.continues.example.yml` for a fully annotated reference.

## Conversion Matrix

All 182 cross-tool paths are supported and tested:

|  | → Cld | → Cdx | → Cop | → Gem | → OC | → Drd | → Cur | → Amp | → Kir | → Cru | → Cln | → Roo | → Kilo | → AG |
|:--|:-----:|:-----:|:-----:|:-----:|:----:|:-----:|:-----:|:-----:|:-----:|:-----:|:-----:|:-----:|:------:|:----:|
| **Claude** | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Codex** | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Copilot** | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Gemini** | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **OpenCode** | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Droid** | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Cursor** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Amp** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Kiro** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Crush** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| **Cline** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| **Roo Code** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| **Kilo Code** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Antigravity** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |

<sub>Cld = Claude, Cdx = Codex, Cop = Copilot, Gem = Gemini, OC = OpenCode, Drd = Droid, Cur = Cursor, AG = Antigravity</sub>

Same-tool resume is available via `continues <tool>` shortcuts (native resume, not shown in matrix).

## Requirements

- **Node.js 22+** (uses built-in `node:sqlite` for OpenCode and Crush parsing)
- At least one of: Claude Code, Codex, GitHub Copilot, Gemini CLI, OpenCode, Factory Droid, Cursor, Amp, Kiro, Crush, Cline, Roo Code, Kilo Code, or Antigravity

## Development

```bash
git clone https://github.com/yigitkonur/cli-continues
cd cli-continues
pnpm install

pnpm run dev          # Run with tsx (no build needed)
pnpm run build        # Compile TypeScript
pnpm test             # Run 122 tests
pnpm run test:watch   # Watch mode
```

## License

MIT © [Yigit Konur](https://github.com/yigitkonur)
