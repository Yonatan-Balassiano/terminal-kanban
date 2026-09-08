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

### `o` opens the PR — or, once merged and built, the dev portal

`getTaskDevPortalURL` (`view.go`) links `https://wix-bo.com/dev/project/<artifact-id>`, using `task.Release.BlockingArtifactName` — but only while `task.Release.Stage` is `"rc-built"` or `"rolling-out"`. Both are load-bearing: `BlockingArtifactName` is empty until the card has merged (no `TaskReleaseSummary` at all pre-merge — see `summarizeRelease` in `release-matching.ts`) and empty again once fully `"ga"` (nothing left blocking it, so there's no name to build the link from), and `"awaiting-build"` means there's no release candidate built yet for the page to show anything about — for both of those edges `openPRCmd` (`model.go`) falls back to the PR link, same as before this existed. Only the plain `o` keypress prefers the dev portal; `v` (open PR checks) always stays PR-specific, since checks are a property of the pull request, not the artifact.

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
- **Write the mission to a file; keep `--description` a pointer.** `--description` becomes the new agent's entire opening prompt. It is delivered on the agent CLI's own argv now, so it is no longer at risk of being cut off or partially submitted — but a brief is still far more useful as a file the agent can re-read than as one long inline paragraph. Write the actual brief (why, file paths, what's out of scope, the way you'd brief a stranger with zero context) to a file outside any worktree — see the `spawn-subtask` skill — and pass only a short pointer to it in `--description`.

**Subtask marking.** A card created from inside a running session is automatically linked to that session's task as its parent, no flag needed (pass `--parent <id>` to link explicitly instead). Two detection paths, tried in order: the `AGENTBOARD_TASK_ID` env var (set by `session-bootstrap.ts`), then — if that didn't make it into this process's environment, e.g. a Bash tool call running through a sandbox that does not forward the outer shell's env vars — the `.agentboard/task-id` marker file `session-bootstrap.sh` drops in the worktree, found by walking up from `process.cwd()` (`findParentTaskIdFromWorktree` in `src/cli/index.ts`). That marker is excluded via `.git/info/exclude`, never `.gitignore`, and is skipped for general tasks (they all share `$HOME` as cwd, where one marker file would be ambiguous). A subtask's card shows a badge naming its parent (`↳ <parent title>`), not just a bare "Subtask" tag — see `parentTaskLabel` in `internal/tui/view.go`. When a subtask's PR first opens, the parent card gets flagged (`child_pr_alert_task_id`) — the durable, always-correct record, checked on the board even if no session was live to see anything at the time. On top of that, the subtask's own opening brief (`createTask` in `board.ts`) instructs it to proactively `SendMessage` its parent session the moment it opens the PR — a courtesy nudge using Claude Code's own native `SendMessage`/`ListAgents`, addressed by session name, with no daemon involvement. The nudge is best-effort (the parent session may not be running, or may skip/miss it); the board flag is what to trust when in doubt. The flag also clears itself — `SyncService` (`sync.ts`) resolves it automatically the moment that PR reaches merged/closed, or the subtask card itself reaches done, whichever comes first (only if the flag still points at that same child, so one sibling resolving never clobbers a different sibling's still-open alert). No manual acknowledge is needed to keep it from going stale; the Go TUI's own acknowledge action still exists as a manual override on top.

**Session naming.** Every card's session launches with an explicit `--name` (Claude Code's own display-name flag — see `resolveAgentArgs`/`NAME_FLAG` in `session-bootstrap.ts`, verified for `claude` only), stored once on the task as `sessionName` and reused on every reopen, the same as `branchName`. Defaults to the title; a subtask's default is prefixed with its parent's own `sessionName` (`board.ts`'s `createTask`), so the hierarchy reads directly off Claude Code's own `ListAgents`/`SendMessage` peer list without a lookup. `agentboard task create --session-name <name>` overrides it explicitly — this is the "name your subagent yourself" case. The subtask preamble in `createTask` tells the agent both its own and its parent's session name, plus that `agentboard task notify` addresses by task id instead (a different identifier from the session name — don't conflate the two).

**Manually attaching a missed PR.** `agentboard task attach-pr <task> <pr-number> [--repo <ref>]` exposes `addTaskBranch` (previously RPC/TUI-only) for the case auto-discovery genuinely can't handle. It resolves the branch itself via `GitHubService.getPRHeadBranch` — pass a PR number, not a branch name, unless you already know the exact one. In `addTaskBranch`'s handler (`src/daemon/server.ts`), `prNumber` **must** be checked before falling back to the card's own `branchName`: every repo task already has one auto-assigned at creation, so checking it first makes `prNumber` silently do nothing almost every time (a real bug caught live before this shipped — see the git history for `attach-pr` if touching this fallback chain).

**Manually re-delivering a stuck brief.** `agentboard task redeliver-prompt <id>` exposes `SessionManager.redeliverInitialPrompt`. This is now a genuine rarity rather than the routine recovery it used to be: a card's opening brief rides the agent CLI's argv (see below), so there is no delivery to fail. What remains is the case where you want the stored brief re-sent into an already-running session. `agentboard task notify <id> "..."` (`SessionManager.notifyTaskSession`) is the same mechanism for an arbitrary message. Both type into a live pane — the one thing that genuinely has no channel other than the terminal — so both keep the paste-and-verify pipeline (`pasteAndVerify`, `submitAndVerify` in `pane-idle.ts`). Only tmux and ssh implement `SessionBackend.redeliverPrompt`; calling either command on a PTY session throws rather than silently no-op-ing. `redeliverInitialPrompt` returns which of three things happened — `no-session`, `no-brief`, or `not-verified` (a delivery ran and its paste was never confirmed, so nothing was submitted) — because a single "no live session, or no stored brief" message used to be printed for all three, including the one case it was definitively not.

**A pane's input box cannot be cleared from outside it.** Worth knowing before reaching for it: `notify` appends to whatever is already in the box, so a message sent into a pane holding an unsubmitted fragment arrives concatenated onto it. A `--replace` that clears first was built and dropped — tested live against claude 2.1.263 with a two-line pasted fragment in the box, `C-u`, `Escape`, `C-c` and `C-c C-c` all leave it exactly as it was. `C-u` *does* clear a paste the CLI collapsed into a `[Pasted text #N]` block, which is what makes this easy to get wrong: whether a paste collapses depends on its size, so the same keystroke appears to work and then silently does not. The answer for a pane in a bad input state is `agentboard task restart` — replace the pane, don't try to edit it.

**Restarting a card in place.** `agentboard task restart <id>` (`SessionManager.recreateSession`, previously TUI/RPC-only) kills the pane and relaunches it, keeping the card id, its branch, its worktree and its conversation. Nothing about a card ever needed throwing away to get a working pane back: the conversation lives in the agent's own transcript under an id AgentBoard pins, and `resolveAgentSessionId` reads that id back from terminated session rows, so the relaunch resumes rather than starts blank. This replaces the old `delete --force` + `task create` dance, which minted a new card id and rotted every reference to the old one.

**Every backend gets its brief the same way.** PTY used to be special: it cannot paste into its own pty, so its brief was replayed through a headless `claude --print` call first, purely so `session-bootstrap.sh`'s resume-check would find a transcript. That was a bad trade — `--print` runs with tool access, so the seed *executed* the mission rather than receiving it, unsupervised, for as long as that took (~4 minutes of real tool calls, observed) before the interactive pane ever opened. Now that the brief rides argv, every backend gets it from the one mechanism and nothing runs ahead of the pane.

**Fleet status across every live session.** `agentboard fleet` (`--json` for machine-readable output) exposes `SessionManager.getFleetStatus`, one row per session currently `active`/`idle`: task id/title, slot, backend, `sessionStatus`/`isBusy`, `attentionNeeded`, `trustPromptShowing`, `delivered`, `paneId`, and age. Built for the case of N concurrent subagents whose state you'd otherwise check by poking N tmux panes by hand.

`paneId` (and `backendSessionId`) are reported because `agentboard-task-panes` windows are **renumbered** as cards come and go — a window index cached even minutes earlier silently addresses a different card. A tmux pane id is fixed for the pane's life, so external tooling should address `tmux ... -t %42`, never an index.

`isBusy` and `delivered` both come from the session's own conversation file (`session-transcript.ts`), not from what the terminal is rendering. Only a PTY session streams output through the daemon, so tmux and ssh cards had no activity signal at all and reported `isBusy: false` unconditionally — that column was saying "no idea", not "idle". An agent that is working writes to its transcript continuously, so its mtime is the missing heartbeat, and a real user turn in it is the exact answer to whether the card's brief arrived. Kept cheap enough for the polling loop: busy is one `stat`, the user-turn check reads a bounded 256 KB prefix (real transcripts reach 29 MB), and resolved paths are cached per session id. Best-effort throughout — the JSONL layout is Claude Code's own, so every reader returns null on anything unexpected and callers fall back. Remote sessions keep the previous behaviour; their transcript is on the far host.

**Deleting a card from the CLI.** `agentboard task delete <task> [--force] [--purge]` exposes `taskLifecycle.deleteTask` (previously TUI-only, `d`). It terminates every session on the card and removes every worktree — but it no longer throws the agent's work away. Anything uncommitted in a worktree is committed first and pinned under `refs/agentboard/archive/<taskId>`, and the command prints the sha, the ref, and the command to read it back. A ref rather than a branch or a stash on purpose: deleting a card usually means the branch goes too, and a plain ref survives that, stays out of `git branch`, keeps the commit from being collected, and is recoverable with ordinary git. `--force` and `--purge` are separate decisions — `--force` means "don't ask me", `--purge` means "don't keep it" — and conflating them is what made deletion quietly lossy: an agent's 257-line investigation report, written into its worktree where agents naturally write things, went with the card. Secret-looking files are excluded from the archive commit and left on disk. The same archiving applies to `cleanupTaskResources` as a whole, so a card reaching done keeps its notes too.

**`--start` prompt delivery.** The brief rides the agent CLI's own argv, restored in `session-bootstrap.sh`: the file's path travels through the bootstrap command, the script reads it, and appends the contents as a positional argument. The kernel hands the string to the process before it runs, so there is no race to lose and no partial arrival to detect.

This replaced a pipeline that pasted the brief into the pane and retried Enter for up to 274s. A pane offers no way to answer the four questions that pipeline needed — is the CLI up, is it listening, did the text arrive intact, did Enter submit it — so each became a heuristic, each heuristic had a documented live failure, and each failure was answered with a wider retry window. Getting any one wrong left the brief sitting unsubmitted with the card silently idle.

**Do not "fix" this back to pasting.** An earlier commit (`5c62f10`) concluded argv was unreliable. Two *other* bugs were in play at that moment, both since fixed for unrelated reasons: the brief rode the command line typed into the pane, which the tty truncated at ~4 KB (fixed in `d06977a`, which moved the contents into a file), and the CLI was not `exec`'d so it was not the pane's foreground process (fixed in `f9c6883`). Re-verified against claude 2.1.263 through the real script in a real pane: a markdown brief with quotes, `$VARS` and backticks arrives byte-for-byte and is answered without anything touching the pane, and so does a 42 KB one.

A resumed conversation never gets the brief replayed — `session-bootstrap.sh` decides fresh-vs-resume from whether a transcript already exists under the session id, and removes the brief file either way.

**Auto-trusting a never-trusted worktree.** A session whose directory Claude Code has never seen shows an interactive "do you trust this folder?" prompt before anything else — including before it reads its own argv, so an unattended `--start`ed card would sit there forever. Confirmed live, the default-highlighted option is "No, exit", so a bare Enter quits the CLI rather than accepting. AgentBoard created the worktree itself under a repo the user registered, so that trust is implicit: `dismissTrustPromptInBackground` (tmux/ssh) polls for the prompt via `waitForTrustPromptAndDismiss` (`pane-idle.ts`) and sends `Down` then `Enter`. This is now the *only* thing the daemon types into a starting session, and is deliberately decoupled from the brief, which no longer touches the pane. It has to be a bounded poll rather than a snapshot: the dialog can render at any point during startup, so a one-shot check misses it and a second one only narrows the gap.

**Receiving a subtask PR notice.** A subtask you spawned from this card is instructed to message you directly via `SendMessage` the moment it opens its pull request — naming the PR number/URL and a one-line summary — rather than waiting to be asked. That message arrives as a normal `SendMessage` from a peer session, not a daemon-typed notice — there is no more automated pane injection for this. Actually review the PR (`gh pr diff`, `gh pr view`, `gh pr review`) rather than only acknowledging the message; report what you found back to the user. If it arrives mid-task, finish the step you're on first, but don't drop it — get to the review before ending your turn. The nudge is a courtesy, not the record of truth: it can be missed if your session wasn't running or the subtask skipped it, so `child_pr_alert_task_id` on the board is the durable flag to check if you suspect a subtask opened a PR you never heard about.
