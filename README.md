# AgentBoard

Terminal-native kanban for managing AI coding work across multiple repos, tasks, branches, worktrees, terminals, and pull requests.

The repository name is `terminal-canban`, but the app/CLI command is `agentboard`.

## What It Does

AgentBoard gives you a local board for coding tasks and connects each task to a real shell session. It is built for the workflow where you are actively moving between branches, PRs, CI states, and multiple repositories.

Core ideas:

- tasks live on a board (`Backlog`, `In Progress`, `Done`)
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

## Requirements

Required:

- Node.js `>= 20`
- Git

Recommended:

- `gh` for PR creation, PR status sync, checks, and merge
- `tmux` if you want tmux-backed sessions available
- `claude` in your shell `PATH` if you want new task sessions to launch Claude Code automatically

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

Or use the bootstrap script to do the full first-run setup in one shot:

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
agentboard init            # initialize config/state directories
agentboard doctor          # run environment checks
agentboard ls              # list tasks
agentboard ls --archived   # list archived tasks
agentboard ls --json       # list tasks as JSON
agentboard sync            # trigger GitHub sync manually
agentboard attach <task>   # open session and print attach command
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
npm run dev
npm run test
npm run lint
npm run typecheck
npm run reset-daemon
npm run reset-deamon
```

## TUI Keyboard Guide

### Navigation

- `hjkl` / arrows: move between columns and tasks
- `,` / `.`: switch repo tab
- `Esc`: return from terminal to board

### Task actions

- `n`: create task
- `r`: rename task
- `Ctrl+D`: edit task description
- `d`: delete task
- `P`: create pillar
- `D`: delete selected task pillar and all tasks in it
- `p`: assign pillar
- `[` / `]`: move task left/right between tracks

### Session / terminal

- `Enter`: open selected task shell
- `t`: focus terminal pane
- `z`: terminal fullscreen
- `Ctrl+C`: interrupt current terminal command
- `PgUp` / `PgDn`: scroll terminal output
- `R`: recreate selected task shell

### Repo / workspace actions

- `i`: open selected task workspace in IDE
- `x`: reveal selected task workspace in Finder/File Explorer

### GitHub actions

- `c`: create/ensure PR for selected task
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

## Layout Modes

Press `g` to switch between:

- `side-by-side`: board on the left, terminal on the right
- `top / bottom`: board on top, terminal below

Layout choice is persisted in UI state.

## Task Sessions

When a task session is created, AgentBoard resolves the workspace first:

- if needed, it prepares a git worktree for the task
- otherwise it uses the repo root

New sessions then bootstrap the shell and end by launching:

```bash
claude
```

For non-worktree repo-root sessions, the bootstrap flow is:

1. checkout repo base branch
2. pull latest changes
3. checkout or create the task branch
4. clear terminal
5. launch `claude`

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
- If `claude` is unavailable in `PATH`, new session bootstrap will fail at the final launch step.

## Project Status

This repository is an active local-tooling project. The board, terminal, worktree, and GitHub flows are already usable, but the UX is still being tuned aggressively inside the TUI.
