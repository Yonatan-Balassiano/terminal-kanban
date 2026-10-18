# AgentBoard

Terminal-native kanban for managing AI coding work across multiple repos, tasks, branches, worktrees, terminals, and pull requests.

The repository name is `terminal-canban`, but the app/CLI command is `agentboard`.

## What It Does

AgentBoard gives you a local board for coding tasks and connects each task to a real shell session. It is built for the workflow where you are actively moving between branches, PRs, CI states, and multiple repositories.

Core ideas:

- tasks live on a board (`Backlog`, `In Progress`, `PR`, `Done`)
- each task belongs to a repo and can optionally belong to a pillar
- opening a task opens a shell session for that task
- same-repo tasks can use separate git worktrees
- GitHub PR / CI / review state is synced into the board
- common developer actions are available directly from the TUI

## Highlights

- Embedded terminal inside the app
- Per-task branch naming
- Automatic worktree preparation for parallel same-repo work
- PR auto-detection and creation
- CI / review / merge status directly on cards
- Merge from the board with squash merge
- Open task workspace in IDE or Finder/File Explorer
- Repo and pillar filters
- Layout switch: `side-by-side` or `top / bottom`
- Local daemon for board state, session management, and GitHub sync
- Subtasks: spin off follow-up work as an auto-linked card, with PR rollup and cross-task notifications

## Requirements

Required:

- Node.js `24.x`
- Go `>= 1.26.2`
- Git

Recommended:

- `gh` for PR creation, PR status sync, checks, and merge
- `tmux` if you want tmux-backed sessions available
- `claude` and/or `codex` in your shell `PATH` if you want task sessions to launch those agent CLIs automatically

Optional:

- JetBrains CLI launchers (`webstorm`, `idea`) or other editors if you want one-key IDE opening

## Installation

### 1. Clone

```bash
git clone git@github.com:Yonatan-Balassiano/terminal-canban.git
cd terminal-canban
```

### 2. Install dependencies

```bash
npm install
```

Or use the bootstrap script to do the full first-run setup in one shot. It validates
the required local toolchain first, including Node.js, Git, and Go:

```bash
bash scripts/bootstrap.sh
```

With an initial repo registration:

```bash
bash scripts/bootstrap.sh --repo /absolute/path/to/repo --label my-repo
```

### 3. Build

```bash
npm run build
```

### 4. Run

Use one of these:

```bash
node dist/bin/agentboard.js
```

or install/link the CLI locally:

```bash
npm link
agentboard
```

## First-Time Setup

Initialize the local AgentBoard state:

```bash
agentboard init
```

Register one or more repos:

```bash
agentboard repos add /absolute/path/to/repo
agentboard repos add /absolute/path/to/repo --label my-repo
```

Launch the TUI:

```bash
agentboard
```

## Quick Start

### Create a task

Inside the TUI:

- press `n`
- enter a task title
- choose the repo
- choose the pillar
- press `Enter`

### Open a task shell

- move to a task
- press `Enter`

AgentBoard opens the task session in the embedded terminal pane.

### Push code and let GitHub sync

Inside the task shell:

```bash
git push --set-upstream origin <task-branch>
```

After push:

- AgentBoard syncs GitHub state in the background
- PR information appears on the task card
- CI and review status update on the board

### Merge from the board

When the task has:

- open PR
- passing CI
- approved review

Press:

```text
m
```

AgentBoard merges using:

```bash
gh pr merge <pr-number> -s
```

## CLI Commands

### Main commands

```bash
agentboard                 # launch the TUI
agentboard --ui web        # web board in the browser; the terminal shows only the selected card's session
agentboard web [--print]   # open (or print the sign-in URL of) the web board
agentboard init            # initialize config/state directories
agentboard doctor          # run environment checks
agentboard ls              # list tasks
agentboard ls --json       # list tasks as JSON
agentboard sync            # trigger GitHub sync manually
agentboard attach <task>   # open session and print attach command
agentboard fleet           # every live session and its state, in one view
agentboard attention       # every card that wants a human right now, and why
```

### Task commands

```bash
agentboard task create <title> --repo <id> [--description "..."] [--start]   # create a task
agentboard task create <title> --general [--start]                           # create a repo-less task
agentboard task create <title> --parent <id> --start                         # create it as an explicit subtask
agentboard task create <title> --session-name <name> --start                 # name its session explicitly
agentboard task create <title> --context-file <path> --start                 # take the brief from a file
agentboard task notify <id> "<message>"                                      # message a card; queued if its session is closed
agentboard task restart <id>                                                 # relaunch its pane, keeping id/branch/worktree/conversation
agentboard task redeliver-prompt <id>                                        # re-send a card's opening brief (rarely needed)
agentboard task attach-pr <id> <pr-number> [--repo <ref>] [--base <branch>]  # attach a PR auto-discovery missed
agentboard task orchestrator [<id>] [--off]                                  # pin a card to the top of its column in its own colour; its subtasks share it (automatic on a top-level card's first subtask)
agentboard task delete <id> [--force] [--purge]                              # delete a card; archives uncommitted work unless --purge
```

### Repository commands

```bash
agentboard repos add <path>
agentboard repos add <path> --label <label>
agentboard repos ls
agentboard repos ls --json
agentboard repos rm <id>
```

### Daemon commands

```bash
agentboard daemon start
agentboard daemon stop
agentboard daemon status
agentboard daemon status --json
```

### Convenience npm scripts

```bash
npm run build
npm run build:web          # build only the web board (web/ → dist/web)
npm run dev
npm run dev:web            # web board with hot reload, proxied to the running daemon
npm run test
npm run lint
npm run typecheck
npm run reset-daemon
npm run reset-deamon
```

## TUI Keyboard Guide

### Navigation

- `←` / `→` / `↑` / `↓`: move between columns and tasks
- `h` / `k` / `l`: left/up/right navigation shortcuts
- `,` / `.`: switch repo tab
- `/`: search card titles — type a query and press `Enter` to jump to the first matching card; `N` next match, `P` previous match (both wrap), `Esc` clears the search
- `Esc`: return from terminal to board

### Task actions

- `n`: create task
- `r`: rename task
- `Ctrl+D`: edit task description
- `d`: delete task
- `P`: create pillar (steps to the previous match instead while a `/` search is live)
- `D`: delete selected task pillar and all tasks in it
- `p`: assign pillar
- `[` / `]`: move task left/right between tracks

### Session / terminal

- `Enter`: open selected task shell
- `t`: focus terminal pane
- `z`: terminal fullscreen
- `Shift+←` / `Shift+→`: resize the side-by-side terminal pane
- `Ctrl+C`: interrupt current terminal command
- `PgUp` / `PgDn`: scroll terminal output
- `R`: recreate selected task shell

### Repo / workspace actions

- `i`: open selected task workspace in IDE
- `x`: reveal selected task workspace in Finder/File Explorer

### GitHub actions

- `j`: open a PR comment modal and post with `gh pr comment`
- `c`: create/ensure PR for selected task immediately
- `C`: retry PR creation for a pushed branch
- `o`: open PR in browser
- `v`: open PR checks page
- `m`: merge approved + green PR
- `s`: trigger sync manually

### Filters and layout

- `f`: open filters
- `g`: choose terminal layout
- `/`: search

## Filters

Press `f` to open the filter picker.

Current behavior:

- left list = repos
- right list = pillars
- `←/→` switches lists
- `↑/↓` moves inside the active list
- `Space` toggles checks
- multiple repos are supported
- multiple pillars are supported
- no checks means “all”

Applied filters are summarized in the filter bar under the header.

## Web Board

`agentboard --ui web` (or `"ui": "web"` in the config) moves the board into the
browser. Run inside tmux, the window you ran it in becomes the layout (like the
TUI); outside tmux, it opens a `agentboard` tmux session. That window then holds
only the selected card's Claude session; clicking a card in the browser opens
its details and shows its session there. The TUI stays the default.

- **Cards are grouped by parent and subtask**, not by column. A card's own
  state is only *New*, *Working*, *Idle*, *Needs you* or *Stopped*; progress
  lives on each pull request: *Draft*, *Open*, *Merged*, *RC built*,
  *Rolling out*, *GA'd* or *Closed*.
- **Shipped families are hidden by default** — no live session and every PR
  GA'd, closed, or merged with nothing to deploy. Tick *Show shipped* to see them.
- **The conversation, in the details pane.** The last turns of the selected
  card's Claude conversation, read from its transcript and refreshed every few
  seconds. The box below it sends a message to the session, the same way as
  `agentboard task notify`: typed in and submitted, or queued until the
  session next starts.
- **Actions and the TUI's keys.** `n` new card (optionally a subtask, started
  right away), `r` rename, `d` delete (uncommitted work is archived; the browser
  can never purge), `R` restart, `v` open the PR checks, `s` sync. Arrows (and
  `k`, `h`, `l`) move through the tree; Enter (or a click) shows the card in
  the terminal. `?` lists them all.
- The daemon serves it on `http://127.0.0.1:4317` (`"web": { "port": … }` to
  change). API calls need a token from the state dir, which `agentboard web`
  hands to the browser once as a cookie. tmux backend only.

## Layout Modes

Press `g` to switch between:

- `side-by-side`: board on the left, terminal on the right
- `top / bottom`: board on top, terminal below

Layout choice is persisted in UI state.
In side-by-side layout, `Shift+←` grows the terminal and `Shift+→` gives space back to the board.

## Task Sessions

When a task session is created, AgentBoard resolves the workspace first:

- if needed, it prepares a git worktree for the task
- otherwise it uses the repo root

New sessions now run the configured bootstrap script, which by default lives at:

```bash
scripts/session-bootstrap.sh
```

The default script:

1. reads the selected task agent (`claude` or `codex`)
2. checks out the repo base branch and pulls when launching from the repo root
3. checks out or creates the task branch
4. clears the terminal
5. launches the selected agent CLI

New tasks prompt for the agent choice in the create-task modal and store it on the task, so reopening that task uses the same CLI again.

You can override the default script with the global `sessionBootstrapScript` config field.

## Worktrees

AgentBoard supports per-task git worktrees.

Why this matters:

- prevents same-repo tasks from fighting over one checkout
- lets you keep multiple branches live at the same time
- makes IDE-open and shell-open task-specific

The board shows whether a task is using:

- `worktree`
- `regular`

## GitHub Integration

With `gh` configured, AgentBoard can:

- detect existing PRs for task branches
- create PRs
- move tasks with open or draft PRs into the `PR` column automatically
- retry post-push PR creation from the board with `C` if the automatic watcher misses a push
- attach a PR that automatic discovery missed by its number: `agentboard task attach-pr <id> <pr-number> [--repo <ref>]` — resolves the branch itself and lets the next sync fill in its state
- show PR number and URL
- show build status
- show review status
- show merge-ready state
- open PR/checks in browser
- merge from the board

PR title format:

```text
[auto|<taskId>] <task title>
```

Merge command used by the board:

```bash
gh pr merge <pr-number> -s
```

## Subtasks

An agent working a task can spin off follow-up work as its own card, linked back to the task it came from:

```bash
agentboard task create "Extract the rate limiter" --repo <id> --description "..." --start
```

- **Auto-linking.** Run from inside a running session, the new card is automatically linked as a subtask of the task that spawned it — no flag needed. Linking is tried two ways: the `AGENTBOARD_TASK_ID` environment variable the session was started with, then — if that didn't reach the process (e.g. a sandboxed shell that doesn't forward the outer environment) — a `.agentboard/task-id` marker file the session drops in its own worktree, found by walking up from the current directory. Pass `--parent <id>` to link explicitly instead.
- **On the board.** A subtask's card shows a badge naming its parent (`↳ Add rate limiting`) rather than a generic "Subtask" tag, so two different parents' subtasks stay distinguishable at a glance.
- **Session naming.** Every card's session launches with an explicit Claude Code `--name`, so it's addressable via Claude Code's own `SendMessage`/`ListAgents`. Defaults to the title; a subtask's default is prefixed with its parent's (`Add rate limiting/Extract the limiter`), so hierarchy is visible directly in `ListAgents` with no lookup needed. Pass `--session-name <name>` to choose it explicitly instead.
- **PR rollup.** A card's PR list (`Shift+E`) shows its own branches followed by every direct subtask's, each such row named with its own owning task (`↳ Extracted helper`). Every action there (open, checks, merge, comment) resolves against the branch's actual owning task, so it works the same whether the row is the card's own or a subtask's.
- **PR notification.** When a subtask's PR first opens, the parent card is flagged on the board — the durable record, correct whether or not either session was running. The subtask is also told to message its parent directly via Claude Code's own `SendMessage` the moment it opens the PR; that one is prompt but skippable, so the board flag is what to trust. The flag clears itself once the PR merges or closes, or the subtask reaches done.
- **Pinging a card's session.** `agentboard task notify <id> "<message>"` delivers a message into any card's live session — generally for one task's agent to prompt another's (e.g. telling a subtask to address review comments after its PR is checked).

All of this is written up as a Claude Code skill teammates can install — see [`skills/agentboard`](skills/agentboard).

## Card Statuses

Task cards show:

- PR state
- CI state
- review state
- repo name
- workspace mode (`worktree` / `regular`)
- git cleanliness / divergence
- shell/session presence

Border colors are used for PR/build state:

- orange: PR open / pending
- green: build passed
- red: build failed
- purple: merged

## Config and Data Locations

### macOS

AgentBoard stores state here:

```text
~/Library/Application Support/AgentBoard
```

Important files:

- `config.json`
- `agentboard.db`
- `agentboard.log`

The daemon socket is created under:

```text
/tmp/agentboard-<uid>.sock
```

### Linux

Uses XDG paths:

- config: `~/.config/agentboard`
- state: `~/.local/state/agentboard`

## Repo Overlay

Per-repo overrides can live in:

```text
.agentboard.json
```

Supported fields include:

- `defaultBaseBranch`
- `defaultPillarId`
- `preferredIde`
- `ideCommand`
- `worktreeMode`
- `worktreeRoot`
- `agentMacros`

Example:

```json
{
  "defaultBaseBranch": "main",
  "preferredIde": "webstorm",
  "worktreeMode": "auto"
}
```

To change the stored default base branch for an already-registered repo:

```bash
agentboard repos set-default-base-branch <repo-id> <branch>
```

Example for repos whose default branch is `master`:

```bash
agentboard repos set-default-base-branch <repo-id> master
```

## Development

### Local dev loop

```bash
npm install
npm run build
npm run dev
```

### Quality checks

```bash
npm run typecheck
npm run lint
npm run test
```

### Reset daemon during development

```bash
npm run reset-daemon
```

## Notes

- The daemon is a background process; the TUI connects to it over a local socket.
- If you change daemon-side code, restart the daemon.
- If you change TUI-side code, restart the TUI client.
- If `gh` is unavailable or unauthenticated, GitHub features will not work.
- If the selected task agent CLI is unavailable in `PATH`, the bootstrap script prints an error and leaves the shell open.

## Project Status

This repository is an active local-tooling project. The board, terminal, worktree, and GitHub flows are already usable, but the UX is still being tuned aggressively inside the TUI.
