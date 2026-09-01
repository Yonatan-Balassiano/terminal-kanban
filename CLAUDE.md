# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentBoard is a terminal-native kanban board for managing AI coding sessions. The CLI command is `agentboard` (repo name is `terminal-canban`). It is a **hybrid TypeScript + Go** project:

- **TypeScript (Node.js 24.x)**: daemon, CLI, session management, GitHub sync, board state (SQLite via `better-sqlite3`)
- **Go**: TUI (`internal/tui/`) built with Bubble Tea + Lipgloss, compiled to `dist-go/agentboard-tui`

The TypeScript daemon and Go TUI communicate over a Unix socket (`/tmp/agentboard-<uid>.sock`) using an RPC protocol defined in `internal/tui/rpc.go` and `src/daemon/server.ts`.

## Commands

```bash
# Build both TS and Go
npm run build

# Build individually
npm run build:ts
npm run build:go

# Run tests
npm run test               # vitest run (all tests)
npm run test:watch         # vitest watch mode

# Run a single test file
npx vitest run tests/session-manager.test.ts

# Type check
npm run typecheck

# Lint
npm run lint

# Dev (builds Go then runs TS from source)
npm run dev

# Restart daemon
npm run reset-daemon
```

## Architecture

### TypeScript side (`src/`)

- **`src/daemon/`**: Background daemon process — HTTP-like server over a Unix socket. Owns board state, GitHub sync, session lifecycle.
- **`src/services/`**: Core business logic:
  - `session-manager.ts`: Creates/destroys/attaches task sessions
  - `session-backends/`: `pty.ts` (embedded PTY via node-pty) and `tmux.ts` (tmux-backed sessions)
  - `task-lifecycle.ts`: Task state transitions (backlog → in-progress → PR → done)
  - `github.ts`: `gh` CLI integration for PR/CI/review sync
  - `sync.ts`: Periodic GitHub state sync loop
  - `workspace.ts` / `worktree.ts`: Git worktree management per task
  - `board.ts`: SQLite board state queries
- **`src/cli/`**: Commander-based CLI (`rpc.ts` client sends commands to daemon)
- **`src/config/`**: Config loading (macOS: `~/Library/Application Support/AgentBoard`, Linux: XDG paths)

### Go TUI side (`internal/tui/`)

- `model.go`: Main Bubble Tea model — app state, message handling, update loop
- `view.go`: Rendering the kanban board columns/cards
- `tmux_layout.go`: tmux pane layout management (side-by-side vs top/bottom)
- `rpc.go`: RPC client that polls the daemon socket for board state
- `modals.go` / `modal_view.go`: Overlay modals (create task, filters, etc.)
- `workspace_actions.go`: Keybindings that trigger workspace actions (IDE open, worktree, etc.)

### Data

- Board state: SQLite at `~/Library/Application Support/AgentBoard/agentboard.db` (macOS)
- Schema: `src/db/schema.sql` (copied to `dist/db/` on build)

### Session backends

Sessions are either PTY-backed (embedded in the TUI terminal pane) or tmux-backed (external tmux window). The backend is selected per-session. The bootstrap script (`scripts/session-bootstrap.sh`) runs when a session opens — it checks out the task branch and launches the configured agent CLI (`claude` or `codex`).

## Key Constraints

- Node.js version must be exactly `24.x` (see `engines` in `package.json`)
- Go `>= 1.26.2`
- If you change daemon-side TypeScript code, the daemon must be restarted (`npm run reset-daemon`)
- If you change Go TUI code, run `npm run build:go` and relaunch the TUI
- Tests use `vitest` — no jest globals; use `import { describe, it, expect } from 'vitest'`

## Creating sub-tasks (`agentboard task create`)

An agent working a card in this repo can spin off follow-up work as a new card via `agentboard task create <title> --repo <id> --description "..."`. Before doing so:

- **Always pass `--start`.** Launch the subtask's agent immediately, every time, with no separate confirmation step — see the `spawn-subtask` skill. Creating the card without `--start` just leaves it idle in `backlog`, which defeats the point of spawning it.
- **Check the board before creating.** Query the existing tasks (`getBoard` via the TUI, or list cards) to make sure the same work isn't already backlogged or in progress — don't duplicate cards.
- **Write the brief for a stranger.** `--description` / `--context-file` becomes the new agent's entire opening prompt — it has none of the current conversation. State the why, the relevant file paths, and what's out of scope, the way you'd brief a fresh subagent with zero context.
- **Resolve `--repo`/`--pillar` explicitly** (`agentboard repos`) rather than guessing — a card created against the wrong repo starts its session in the wrong checkout.
- **One concrete task per card.** Only create a card for well-defined, ready-to-start follow-up work — don't fan out speculative sub-tasks.

**Subtask marking.** A card created from inside a running session is automatically linked to that session's task as its parent, no flag needed (pass `--parent <id>` to link explicitly instead). Two detection paths, tried in order: the `AGENTBOARD_TASK_ID` env var (set by `session-bootstrap.ts`), then — if that didn't make it into this process's environment, e.g. a Bash tool call running through a sandbox that does not forward the outer shell's env vars — the `.agentboard/task-id` marker file `session-bootstrap.sh` drops in the worktree, found by walking up from `process.cwd()` (`findParentTaskIdFromWorktree` in `src/cli/index.ts`). That marker is excluded via `.git/info/exclude`, never `.gitignore`, and is skipped for general tasks (they all share `$HOME` as cwd, where one marker file would be ambiguous). A subtask's card shows a badge naming its parent (`↳ <parent title>`), not just a bare "Subtask" tag — see `parentTaskLabel` in `internal/tui/view.go`. When a subtask's PR first opens, the parent card gets flagged (`child_pr_alert_task_id`) and, if the parent has a live session, the notice is typed straight into it — see `notifyParentOfSubtaskPR` in `src/services/sync.ts` and `notifyTaskSession` in `src/services/session-manager.ts`.

**Session naming.** Every card's session launches with an explicit `--name` (Claude Code's own display-name flag — see `resolveAgentArgs`/`NAME_FLAG` in `session-bootstrap.ts`, verified for `claude` only), stored once on the task as `sessionName` and reused on every reopen, the same as `branchName`. Defaults to the title; a subtask's default is prefixed with its parent's own `sessionName` (`board.ts`'s `createTask`), so the hierarchy reads directly off Claude Code's own `ListAgents`/`SendMessage` peer list without a lookup. `agentboard task create --session-name <name>` overrides it explicitly — this is the "name your subagent yourself" case. The subtask preamble in `createTask` tells the agent both its own and its parent's session name, plus that `agentboard task notify` addresses by task id instead (a different identifier from the session name — don't conflate the two).

**Manually attaching a missed PR.** `agentboard task attach-pr <task> <pr-number> [--repo <ref>]` exposes `addTaskBranch` (previously RPC/TUI-only) for the case auto-discovery genuinely can't handle. It resolves the branch itself via `GitHubService.getPRHeadBranch` — pass a PR number, not a branch name, unless you already know the exact one. In `addTaskBranch`'s handler (`src/daemon/server.ts`), `prNumber` **must** be checked before falling back to the card's own `branchName`: every repo task already has one auto-assigned at creation, so checking it first makes `prNumber` silently do nothing almost every time (a real bug caught live before this shipped — see the git history for `attach-pr` if touching this fallback chain).

**Deleting a card from the CLI.** `agentboard task delete <task> [--force]` exposes `taskLifecycle.deleteTask` (previously TUI-only, `d`). Genuinely destructive — it terminates every session on the card and removes every worktree unconditionally, discarding uncommitted work there — so without `--force` it only prints what would be deleted (including an uncommitted-changes warning read off the task's own `gitState`/`hasUntracked`/`hasConflicts`) and exits nonzero; no interactive prompt, since an agent driving this through a shell tool can't answer one and it would just hang.

**`--start` prompt delivery.** The brief is no longer trusted to the agent CLI's own argv handling (that path was unreliable — see `src/services/session-backends/pane-idle.ts` for why). The daemon spawns the session, waits for the pane to settle, pastes the brief in, then sends Enter and *verifies* the pane actually changed (`submitAndVerify` in `pane-idle.ts`), resending Enter (never re-pasting) up to `maxSubmitRetries` times if it didn't — a fixed delay alone was seen live to sometimes not be enough for a slow SessionStart hook chain to finish before the first Enter landed. If a session ever does still come up with the brief sitting unsubmitted, that is a regression worth a bug report, not something to route around by hand.

**Known gap, not yet fixed:** a session whose worktree/directory Claude Code has never trusted shows an interactive trust prompt before anything else — a `--start`ed subtask with nobody watching will hang there forever, and `submitAndVerify`'s "did the pane change" check will misread the *first* Enter dismissing that prompt (e.g. selecting "No, exit") as a successful submit. Confirmed live only for a `--general` task's `$HOME` cwd; unconfirmed whether it recurs for a repo task whose worktree root was already trusted once.

**Receiving a subtask PR notice.** If a message starting with `[agentboard] Automated notice, not from the user:` appears in your input, the daemon typed it — it is not the user talking, and it means a subtask you spawned from this card just opened a pull request. Actually review it (`gh pr diff`, `gh pr view`, `gh pr review`) rather than only acknowledging it; report what you found back to the user. If it arrives mid-task, finish the step you're on first, but don't drop it — get to the review before ending your turn.
