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

### Web board (`ui: "web"`)

A second transport in front of the same `dispatch()`: `src/daemon/web-server.ts` serves `POST /api/rpc`, Server-Sent Events on `/api/events` (every `serverEvents` push except `session_update`) and the built React app (`web/` → `dist/web`) on `127.0.0.1:<web.port>` (default 4317). Localhost alone is not a boundary — any page in the browser can reach it — so every API call needs the token in `<stateDir>/web-token` (handed over once as `?t=`, swapped for an HttpOnly cookie), a matching `Host` (DNS rebinding) and no foreign `Origin`, and only `WEB_RPC_METHODS` are reachable. Widen that list deliberately; it is the whole write surface.

In web mode the tmux layout window has no board pane. It is found by its `@agentboard_web_layout` marker in any session, never by session name: run inside tmux, `agentboard --ui web` marks the window it was run in and its own process becomes the placeholder pane (`@agentboard_web_placeholder`); only outside tmux does it create the `layoutSessionName` session. Target sessions as `=name` — a bare `-t agentboard` also matches `agentboard-task-panes` by prefix. The placeholder is parked in `agentboard-task-panes` with the card panes, never killed — run inside tmux it is the user's own process; any other untagged pane in the window is the user's and is left alone. Because the window has no board pane, a card's pane can be the only one in it, and killing that pane (delete, restart) would close the window and the terminal looking at it: `TmuxBackend.terminate` calls `keepWebLayoutAlive` first, which puts the parked placeholder back (or starts a new one) whenever the dying panes are everything the window holds. `focusTask` (`web-layout.ts`) opens the card's session, joins its pane into the window marked `@agentboard_web_layout`, and only then parks the old pane in `agentboard-task-panes` — a window with no panes is destroyed along with the session the terminal is attached to. It checks the layout exists **before** opening the session: opening starts the agent, and a session nobody can see is one nobody asked for. It shares the pane tag, holding session and layout lock with the Go TUI's `attachTaskSessionInTmux`.

`WEB_RPC_METHODS` now includes card actions (create, rename, delete, restart, PR create/merge/comment, sync) and `notifyTaskSession` for the message box under the conversation — the TUI's own surface, not more: no `sendInput` (raw keystrokes), no repo/config edits, and of the remote-host methods only teleport (`teleportTaskPreflight` → `teleportTask`, behind a confirm that shows the preflight checks), not reconnect. A card whose `location` is `remote` is marked on its row (`☁ remote`, teal left edge) and in the details pane. From the browser, `deleteTask` always has `purge` forced to `false` and `notifyTaskSession` has `fromTaskId` removed, so a message can never claim to come from another card. The details pane's conversation preview is `getConversation` → `SessionManager.getConversation` → `readTranscriptTail` (`session-transcript.ts`), which reads only the last 768 KB of the primary slot's transcript and keeps user/assistant text plus one-line tool summaries (tool results, thinking, sidechains, `isMeta` and slash-command records are dropped; a compaction summary becomes a one-line marker).

The web board deliberately has no columns and no "done": a card is New / Working / Idle / Needs you / Stopped (from `getFleetStatus`), and progress is per pull request, with merged PRs advanced by `getReleaseStatus` (`web/src/model.ts`). Cards keep a fixed order so they do not jump while agents work (`compareNodes`): not-started cards last, the rest by creation date, oldest first, at every level. Live state is shown on the card, never used to move it.

## Key Constraints

- Node.js version must be exactly `24.x` (see `engines` in `package.json`)
- Go `>= 1.26.2`
- If you change daemon-side TypeScript code, the daemon must be restarted (`npm run reset-daemon`)
- If you change Go TUI code, run `npm run build:go` and relaunch the TUI
- Tests use `vitest` — no jest globals; use `import { describe, it, expect } from 'vitest'`

## Changing AgentBoard? Update the skill in the same PR

`skills/agentboard/SKILL.md` is the instruction set every agent working an AgentBoard card reads, and people copy it into their own `~/.claude/skills/`. A stale copy is worse than none: it reads as authoritative and sends agents down paths that no longer exist.

It is part of the change, not a follow-up, whenever you touch:

- **the CLI an agent drives** — `task create` and its flags, `notify`, `restart`, `orchestrator`, `redeliver-prompt`, `delete`, `ls`, `fleet`, `attention`, `repos ls`;
- **what a `fleet` column means** — `BUSY`, `DELIVERY`, `TRUST-PROMPT` and `PANE` all carry semantics an agent acts on;
- **how a brief reaches an agent**, or how sessions are named, auto-linked as subtasks, or notified about a subtask's PR;
- **what cleanup preserves** — including the `refs/agentboard/archive/<taskId>` name itself.

Adding a command without a line in the skill is the same defect pointing the other way: agents will not find it.

Two rules, both learned by getting this wrong:

1. **Verify against the CLI; do not write from memory.** Run the command and read its output. This file *and* the old skill both claimed `agentboard repos` lists repos — it is a command group that prints help, and `repos ls` is the listing. The error survived because nobody ran it.
2. **The command's own `--help` is documentation too.** `redeliver-prompt`'s description outlived the delivery pipeline it described by five PRs, and it is the first thing an agent reads. Update it with the behaviour, and check the command list in `README.md` while you are there.

## Creating sub-tasks (`agentboard task create`)

An agent working a card in this repo can spin off follow-up work as a new card via `agentboard task create <title> --repo <id> --description "..."`. Before doing so:

- **Always pass `--start`.** Launch the subtask's agent immediately, every time, with no separate confirmation step — see the `agentboard` skill. Creating the card without `--start` just leaves it idle in `backlog`, which defeats the point of spawning it.
- **Check the board before creating.** Query the existing tasks (`getBoard` via the TUI, or list cards) to make sure the same work isn't already backlogged or in progress — don't duplicate cards.
- **Write the mission to a file; keep `--description` a pointer.** `--description` becomes the new agent's entire opening prompt. It is delivered on the agent CLI's own argv now, so it is no longer at risk of being cut off or partially submitted — but a brief is still far more useful as a file the agent can re-read than as one long inline paragraph. Write the actual brief (why, file paths, what's out of scope, the way you'd brief a stranger with zero context) to a file outside any worktree — see the `agentboard` skill — and pass only a short pointer to it in `--description`.

**Subtask marking.** A card created from inside a running session is automatically linked to that session's task as its parent, no flag needed (pass `--parent <id>` to link explicitly instead). Two detection paths, tried in order: the `AGENTBOARD_TASK_ID` env var (set by `session-bootstrap.ts`), then — if that didn't make it into this process's environment, e.g. a Bash tool call running through a sandbox that does not forward the outer shell's env vars — the `.agentboard/task-id` marker file `session-bootstrap.sh` drops in the worktree, found by walking up from `process.cwd()` (`findParentTaskIdFromWorktree` in `src/cli/index.ts`). That marker is excluded via `.git/info/exclude`, never `.gitignore`, and is skipped for general tasks (they all share `$HOME` as cwd, where one marker file would be ambiguous). A subtask's card shows a badge naming its parent (`↳ <parent title>`), not just a bare "Subtask" tag — see `parentTaskLabel` in `internal/tui/view.go`. When a subtask's PR first opens, the parent card gets flagged (`child_pr_alert_task_id`) — the durable, always-correct record, checked on the board even if no session was live to see anything at the time. On top of that, the subtask's own opening brief (`createTask` in `board.ts`) instructs it to proactively `SendMessage` its parent session the moment it opens the PR — a courtesy nudge using Claude Code's own native `SendMessage`/`ListAgents`, addressed by session name, with no daemon involvement. The nudge is best-effort (the parent session may not be running, or may skip/miss it); the board flag is what to trust when in doubt. The flag also clears itself — `SyncService` (`sync.ts`) resolves it automatically the moment that PR reaches merged/closed, or the subtask card itself reaches done, whichever comes first (only if the flag still points at that same child, so one sibling resolving never clobbers a different sibling's still-open alert). No manual acknowledge is needed to keep it from going stale; the Go TUI's own acknowledge action still exists as a manual override on top.

**A parent with open subtasks stays in shipping until they're all done.** `evaluateTrackTransition` (`sync.ts`) already parks a card in `shipping` rather than `done` while `isFullyReleased` says a merged change hasn't shipped yet; `BoardService.hasIncompleteChildTasks` extends the same gate to subtasks. A parent whose own branches are fully released but still has a subtask not yet in `done` stays in `shipping` too — the work the card stands for is not finished. Once the last subtask reaches `done`, the parent's own next sync poll re-evaluates and moves it to `done` on its own — nothing has to reactively notify the parent when a subtask finishes.

**Done is only a column — it does not touch the session or the worktree.** Reaching `done` used to run `cleanupTaskResources`, from the sync loop and from a manual `moveTask` alike, which killed the card's sessions and removed its worktrees. A finished card is often exactly the one you still want to talk to (a follow-up question, a rollback, a subtask to check on), so both hooks are gone: `evaluateTrackTransition` and the `moveTask` handler (`server.ts`) only move the card. Sessions and worktrees are released by the explicit action instead — `agentboard task delete` (`d` in the TUI). Do not re-add a cleanup on the done transition.

**Session naming.** Every card's session launches with an explicit `--name` (Claude Code's own display-name flag — see `resolveAgentArgs`/`NAME_FLAG` in `session-bootstrap.ts`, verified for `claude` only), stored once on the task as `sessionName` and reused on every reopen, the same as `branchName`. Defaults to the title; a subtask's default is prefixed with its parent's own `sessionName` (`board.ts`'s `createTask`), so the hierarchy reads directly off Claude Code's own `ListAgents`/`SendMessage` peer list without a lookup. `agentboard task create --session-name <name>` overrides it explicitly — this is the "name your subagent yourself" case. The subtask preamble in `createTask` tells the agent both its own and its parent's session name, plus that `agentboard task notify` addresses by task id instead (a different identifier from the session name — don't conflate the two).

**Manually attaching a missed PR.** `agentboard task attach-pr <task> <pr-number> [--repo <ref>]` exposes `addTaskBranch` (previously RPC/TUI-only) for the case auto-discovery genuinely can't handle. It resolves the branch itself via `GitHubService.getPRHeadBranch` — pass a PR number, not a branch name, unless you already know the exact one. In `addTaskBranch`'s handler (`src/daemon/server.ts`), `prNumber` **must** be checked before falling back to the card's own `branchName`: every repo task already has one auto-assigned at creation, so checking it first makes `prNumber` silently do nothing almost every time (a real bug caught live before this shipped — see the git history for `attach-pr` if touching this fallback chain).

**Manually re-delivering a stuck brief.** `agentboard task redeliver-prompt <id>` exposes `SessionManager.redeliverInitialPrompt`. This is now a genuine rarity rather than the routine recovery it used to be: a card's opening brief rides the agent CLI's argv (see below), so there is no delivery to fail. What remains is the case where you want the stored brief re-sent into an already-running session. `agentboard task notify <id> "..."` (`SessionManager.notifyTaskSession`) is the same mechanism for an arbitrary message. Both type into a live pane — the one thing that genuinely has no channel other than the terminal — so both keep the paste-and-verify pipeline (`pasteAndVerify`, `submitAndVerify` in `pane-idle.ts`). `notify` no longer fails when there is no pane, though: see queued messages below. Only tmux and ssh implement `SessionBackend.redeliverPrompt`; calling either command on a PTY session throws rather than silently no-op-ing. `redeliverInitialPrompt` returns which of four things happened — `no-session`, `no-brief`, `not-verified` (a delivery ran and its paste was never confirmed, so nothing was submitted), or `not-submitted` (the text is verifiably in the input box and no Enter would move it) — because a single "no live session, or no stored brief" message used to be printed for all of them, including the cases it was definitively not.

**A paste the CLI collapses is still a paste.** `waitForPasteToLand` confirms a delivery by finding the text's own opening on the pane — which a large paste never shows, because claude renders it as a `[Pasted text #N +M lines]` chip instead. So a long `notify` verified as mangled, its Enter was withheld on purpose, and the CLI reported it queued while it sat in the input box; a short one, rendered inline, worked every time. That is why #34 measured `notify` at 5/5 and issue #46 hit it at ~20 lines — the difference is the collapse threshold, not the code path. A new-or-changed chip now counts as landed, compared against the pane as it looked immediately before the paste so an older chip can never verify a delivery that did not happen.

**"Landed but never submitted" is its own answer.** `submitAndVerify` reports whether any Enter moved the pane; exhausting every retry against a still pane used to resolve exactly like a clean submit. `notifyTaskSession` returns that as `landedUnsubmitted` and deliberately does *not* queue it — the text is already on the pane, so queuing would deliver a second copy the moment the box is flushed. The answer for that pane is `agentboard task restart`.

**Cross-task messages survive a closed card.** `notify` used to drop a message when the target had no live session and report `delivered: false`, which is why the board grew `child_pr_alert_task_id` — a badge can say an event happened, but not what was said, and it only covers the one event AgentBoard derives itself. A message with nowhere to go is now stored in `pending_messages` (`pending-messages.ts`) and handed to the agent on its own argv the next time that card's session opens, so it reaches the conversation either way. Verified live: `claude --resume <id> "<message>"` resumes the existing conversation *and* delivers the argument as a new turn.

Two prompt files, not one, because only `session-bootstrap.sh` knows which case it is in — it is the thing that decides fresh vs. resume. A brief must never be replayed into a resumed conversation, and a queued message must never be lost because the card happens to be starting fresh, so the daemon writes both (`AGENTBOARD_INITIAL_PROMPT_FILE`, `AGENTBOARD_RESUME_PROMPT_FILE`) and the script uses exactly one. Both are removed either way, so nothing is delivered twice. Messages leave the queue only once the session carrying them exists — a `create` that throws leaves them queued, or this reintroduces the same loss in a narrower window — and they cascade with the card. Several fold into one turn, each attributed to the sending card, since a resumed session takes a single positional argument and the message arrives unprompted in a conversation that may be hours old.

**A pane's input box cannot be cleared from outside it.** Worth knowing before reaching for it: `notify` appends to whatever is already in the box, so a message sent into a pane holding an unsubmitted fragment arrives concatenated onto it. A `--replace` that clears first was built and dropped — tested live against claude 2.1.263 with a two-line pasted fragment in the box, `C-u`, `Escape`, `C-c` and `C-c C-c` all leave it exactly as it was. `C-u` *does* clear a paste the CLI collapsed into a `[Pasted text #N]` block, which is what makes this easy to get wrong: whether a paste collapses depends on its size, so the same keystroke appears to work and then silently does not. The answer for a pane in a bad input state is `agentboard task restart` — replace the pane, don't try to edit it.

**Marking an orchestrator.** `agentboard task orchestrator [<id>] [--off]` sets `tasks.is_orchestrator` via the `setTaskOrchestrator` RPC. With no id it resolves the calling session's own card the same two ways `task create` does (`AGENTBOARD_TASK_ID`, then the `.agentboard/task-id` marker), so an agent can mark itself. A top-level card is also marked automatically when its first subtask is created (`createTask` in `board.ts`): top-level only, so a nested parent never splits off its own colour from the family, and first subtask only (`hasChildTasks`), so an explicit `--off` is not undone by the next one. It is presentational only: `tasksByTrack` (`model.go`) sorts orchestrators to the top of each column ahead of sort key, and `taskCardFrame` (`orchestrator.go`) fills the card with its own `orchestratorPalette` colour and outlines it in that colour's bright `Border` shade (overriding the state colour `taskCardBorderColor` would give it), assigned in creation order so it is stable across redraws. Every card below an orchestrator (walking `parentTaskId`, so a subtask's subtask too) gets that colour's dimmer `Tint` behind its title — `orchestratorColourFor`. The fill needs `reapplyBackgroundAfterResets`: every styled segment inside a card ends in a full SGR reset, which would otherwise drop the outer background for the rest of that line and tint only the padding.

**Restarting a card in place.** `agentboard task restart <id>` (`SessionManager.recreateSession`, previously TUI/RPC-only) kills the pane and relaunches it, keeping the card id, its branch, its worktree and its conversation. Nothing about a card ever needed throwing away to get a working pane back: the conversation lives in the agent's own transcript under an id AgentBoard pins, and `resolveAgentSessionId` reads that id back from terminated session rows, so the relaunch resumes rather than starts blank. This replaces the old `delete --force` + `task create` dance, which minted a new card id and rotted every reference to the old one.

**A conversation Claude Code forked is followed, not abandoned.** Claude Code can reopen a conversation under a new id mid-pane (observed when it relaunched itself after an update), leaving only a `{"type":"continued-in","continuedInSessionId":…}` record in the original. Resuming the pinned id then brings back a conversation that stops where the fork began, with everything after it stranded in a file the card no longer points at. `resolveAgentSessionId` runs the stored id through `resolveContinuedSessionId` (`session-transcript.ts`), which follows that chain — but only to a fork written at least as recently as the conversation it left, so an original someone deliberately resumed and kept working in is not thrown over for a stale fork. The new session row records the followed id.

**Every backend gets its brief the same way.** PTY used to be special: it cannot paste into its own pty, so its brief was replayed through a headless `claude --print` call first, purely so `session-bootstrap.sh`'s resume-check would find a transcript. That was a bad trade — `--print` runs with tool access, so the seed *executed* the mission rather than receiving it, unsupervised, for as long as that took (~4 minutes of real tool calls, observed) before the interactive pane ever opened. Now that the brief rides argv, every backend gets it from the one mechanism and nothing runs ahead of the pane.

**Fleet status across every live session.** `agentboard fleet` (`--json` for machine-readable output) exposes `SessionManager.getFleetStatus`, one row per session currently `active`/`idle`: task id/title, slot, backend, `sessionStatus`/`isBusy`, `attentionNeeded`, `trustPromptShowing`, `delivered`, `paneId`, and age. Built for the case of N concurrent subagents whose state you'd otherwise check by poking N tmux panes by hand.

`paneId` (and `backendSessionId`) are reported because `agentboard-task-panes` windows are **renumbered** as cards come and go — a window index cached even minutes earlier silently addresses a different card. A tmux pane id is fixed for the pane's life, so external tooling should address `tmux ... -t %42`, never an index.

`isBusy` and `delivered` both come from the session's own conversation file (`session-transcript.ts`), not from what the terminal is rendering. Only a PTY session streams output through the daemon, so tmux and ssh cards had no activity signal at all and reported `isBusy: false` unconditionally — that column was saying "no idea", not "idle". An agent that is working writes to its transcript continuously, so its mtime is the missing heartbeat, and a real user turn in it is the exact answer to whether the card's brief arrived. Kept cheap enough for the polling loop: busy is one `stat`, the user-turn check reads a bounded 256 KB prefix (real transcripts reach 29 MB), and resolved paths are cached per session id. Best-effort throughout — the JSONL layout is Claude Code's own, so every reader returns null on anything unexpected and callers fall back. Remote sessions keep the previous behaviour; their transcript is on the far host.

**Deleting a card from the CLI.** `agentboard task delete <task> [--force] [--purge]` exposes `taskLifecycle.deleteTask` (previously TUI-only, `d`). It terminates every session on the card and removes every worktree — but it no longer throws the agent's work away. Anything uncommitted in a worktree is committed first and pinned under `refs/agentboard/archive/<taskId>`, and the command prints the sha, the ref, and the command to read it back. A ref rather than a branch or a stash on purpose: deleting a card usually means the branch goes too, and a plain ref survives that, stays out of `git branch`, keeps the commit from being collected, and is recoverable with ordinary git. `--force` and `--purge` are separate decisions — `--force` means "don't ask me", `--purge` means "don't keep it" — and conflating them is what made deletion quietly lossy: an agent's 257-line investigation report, written into its worktree where agents naturally write things, went with the card. Secret-looking files are excluded from the archive commit and left on disk.

**`--start` prompt delivery.** The brief rides the agent CLI's own argv, restored in `session-bootstrap.sh`: the file's path travels through the bootstrap command, the script reads it, and appends the contents as a positional argument. The kernel hands the string to the process before it runs, so there is no race to lose and no partial arrival to detect.

This replaced a pipeline that pasted the brief into the pane and retried Enter for up to 274s. A pane offers no way to answer the four questions that pipeline needed — is the CLI up, is it listening, did the text arrive intact, did Enter submit it — so each became a heuristic, each heuristic had a documented live failure, and each failure was answered with a wider retry window. Getting any one wrong left the brief sitting unsubmitted with the card silently idle.

**Do not "fix" this back to pasting.** An earlier commit (`5c62f10`) concluded argv was unreliable. Two *other* bugs were in play at that moment, both since fixed for unrelated reasons: the brief rode the command line typed into the pane, which the tty truncated (at 1024 bytes on macOS; fixed in `d06977a`, which moved the contents into a file), and the CLI was not `exec`'d so it was not the pane's foreground process (fixed in `f9c6883`). Re-verified against claude 2.1.263 through the real script in a real pane: a markdown brief with quotes, `$VARS` and backticks arrives byte-for-byte and is answered without anything touching the pane, and so does a 42 KB one.

A resumed conversation never gets the brief replayed — `session-bootstrap.sh` decides fresh-vs-resume from whether a transcript already exists under the session id, and removes the brief file either way.

**The bootstrap command carries two paths, nothing else.** Every `AGENTBOARD_*` setting is written to `briefs/<task>-<slot>-env.sh` (`buildSessionBootstrapEnv`), which `session-bootstrap.sh` sources, deletes and unsets; the pane only receives `AGENTBOARD_BOOTSTRAP_ENV_FILE=<path> <script>`. That line is typed while the pane's shell is usually still starting, when the terminal keeps at most 1024 bytes of it (`MAX_CANON` on macOS) and drops the rest — the Enter included. A long `--name`, a multi-branch workspace map or a git error in the bootstrap notice was enough to leave a card on a shell holding half a command, with no agent. Do not put a value back on the command line.

**A branch that is already checked out is used, not re-added.** git allows one checkout per branch, so `ensureBranchWorkspace` (`worktree.ts`) asks `findBranchCheckoutAsync` before `git worktree add`. When the user already has the branch in the main checkout or a worktree of their own, the session works there instead of the whole card failing into a notice shell. That borrowed path is never written to `tasks.worktree_path` or `task_branches.worktree_path`: cleanup force-removes whatever is recorded there, and the checkout is not the card's to remove.

**Auto-trusting a never-trusted worktree.** A session whose directory Claude Code has never seen shows an interactive "do you trust this folder?" prompt before anything else — including before it reads its own argv, so an unattended `--start`ed card would sit there forever. Confirmed live, the default-highlighted option is "No, exit", so a bare Enter quits the CLI rather than accepting. AgentBoard created the worktree itself under a repo the user registered, so that trust is implicit: `dismissTrustPromptInBackground` (tmux/ssh) polls for the prompt via `waitForTrustPromptAndDismiss` (`pane-idle.ts`) and sends `Down` then `Enter`. This is now the *only* thing the daemon types into a starting session, and is deliberately decoupled from the brief, which no longer touches the pane. It has to be a bounded poll rather than a snapshot: the dialog can render at any point during startup, so a one-shot check misses it and a second one only narrows the gap.

**Receiving a subtask PR notice.** A subtask you spawned from this card is instructed to message you directly via `SendMessage` the moment it opens its pull request — naming the PR number/URL and a one-line summary — rather than waiting to be asked. That message arrives as a normal `SendMessage` from a peer session, not a daemon-typed notice — there is no more automated pane injection for this. Actually review the PR (`gh pr diff`, `gh pr view`, `gh pr review`) rather than only acknowledging the message; report what you found back to the user. If it arrives mid-task, finish the step you're on first, but don't drop it — get to the review before ending your turn. The nudge is a courtesy, not the record of truth: it can be missed if your session wasn't running or the subtask skipped it, so `child_pr_alert_task_id` on the board is the durable flag to check if you suspect a subtask opened a PR you never heard about.
