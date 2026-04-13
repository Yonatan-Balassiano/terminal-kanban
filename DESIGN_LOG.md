# AgentBoard — Design Log

A living record of architecture decisions, features, bugs, fixes, and lessons learned.

---

## What AgentBoard Is

A terminal-native Kanban board for managing AI coding sessions. The mental model:

- Each **task** maps to a Git branch and a shell session on a specific repo.
- Workflow state is one axis; **pillar / epic / label metadata** is a separate axis used for filtering, grouping, and saved views.
- The board tracks four default states: **Backlog → In Progress → Review → Done**.
- Opening a task spawns a real shell in the right panel, pre-checked-out to the task's branch.
- The workstation is **machine-wide**: it must work from any terminal on the machine, across multiple repos, with persistent tasks, sessions, filters, and UI state.
- GitHub sync polls for PR status and CI results and auto-advances tasks from In Progress → Review when a PR opens.

The goal is to replace the cognitive overhead of juggling many terminal tabs, tmux windows, and GitHub tabs when orchestrating several AI agents at once.

---

## Architecture Overview

```
agentboard (thin CLI client)
    ├── TUI client (ink)
    ├── attach / send / list commands
    └── AgentBoard daemon RPC client

AgentBoard daemon (single machine-wide process)
    ├── WorkspaceRegistryService   — repo registry, repo overlays, discovery
    ├── BoardService               — SQLite CRUD for tasks, labels, pillars, saved views
    ├── SessionService             — durable shell/session lifecycle
    │     ├── TmuxSessionBackend   — default on Unix, attachable from any terminal
    │     └── PtySessionBackend    — optional fallback/dev backend
    ├── TerminalBufferService      — xterm/headless screen snapshots + scrollback
    ├── GitService                 — branch/worktree management, repo state
    ├── GitHubService              — delegates to `gh` CLI for authed API calls
    │                                and `delta` for diff rendering
    ├── SyncService                — orchestrates GitHub poll loop
    ├── ViewService                — filters, search, grouping, saved views
    ├── EventLogService            — audit trail, activity feed, crash recovery markers
    └── Local IPC transport        — Unix socket / named pipe
```

### Data flow

```
user keystroke
  → TUI client useInput (board focus) OR terminal raw handler (terminal focus)
  → RPC call to daemon
  → BoardService / SessionService / ViewService mutation
  → daemon emits state patch / event stream
  → dispatch(AppAction) → useReducer → React re-render
```

Transient UI state is held in a client `useReducer` store (`src/store/index.ts`). Durable state lives in the daemon-owned SQLite database and session backends. The controller holds a `dispatchRef` so it can push actions from the daemon event stream into the React tree without coupling them through props.

---

## Tech Stack

### Under the Hood

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** (NodeNext modules) | ESM-first; strict mode; rich ecosystem for terminal tooling |
| TUI framework | **ink** (React for terminals) | Component model, no manual cursor math; hooks-based state |
| Styling | **ink** Box/Text + **chalk** | Composable layout primitives; truecolor + 256 + mono fallback |
| Markdown rendering | **marked-terminal** | Renders markdown inside the TUI (task notes, PR bodies, help text) |
| CLI framework | **Commander** | Familiar Node.js CLI; subcommands, flags, auto-help |
| GitHub integration | **gh** (GitHub CLI) | Reuses user's authenticated `gh` session; no token management required |
| PR diff viewing | **delta** | Syntax-highlighted, side-by-side diffs when inspecting a PR |
| Demo recording | **vhs** | Generates the project GIF from a `.tape` script; reproducible demo |
| Session backend | **tmux** (default on Unix) | Durable detach/reattach; accessible from any terminal |
| Embedded terminal plumbing | **node-pty** + **@xterm/headless** | Real PTY fallback plus terminal buffer rendering |
| Persistence | **better-sqlite3** | Synchronous API fits the single-process model; WAL mode |
| Config validation | **zod** | Schema + safe-parse with readable error messages |

---

## Design Review — Missing Pieces Closed In This Revision

The prototype design was functional, but it was not yet a production-grade workstation. The major gaps:

- **No machine-wide runtime** — local config precedence and a co-located DB make the experience depend on where the command was launched.
- **No durable sessions** — ephemeral in-process PTYs break restartability, crash recovery, and "attach from any terminal".
- **No first-class pillar/epic model** — workflow columns and work categorization were conflated; industry-standard boards keep status and thematic grouping separate.
- **Weak information architecture** — there was no global view, filter bar, saved views, search model, or distinction between repo, pillar, label, and session state.
- **UI semantics were too implicit** — colors existed, but there was no icon legend, accessibility fallback, focus system, or narrow-terminal degradation strategy.
- **Not enough operational hardening** — missing daemon ownership, DB migration discipline, crash recovery, stale session cleanup, log files, and security boundaries for secrets.

This revision makes those requirements part of the core architecture rather than future nice-to-haves.

---

## Feature Inventory

### Workspace
- Global **All Repos** board plus per-repo views
- Repo registry stored once per machine, not per working directory
- Optional repo overlays for repo-specific defaults, prompts, and macros
- One daemon and one durable state store per user profile
- Launch from any terminal via `agentboard` CLI, regardless of current directory

### Board
- Four workflow tracks: Backlog, In Progress, Review, Done
- Tracks are configurable, but status columns are distinct from tags, labels, and pillars
- Multi-repo support — tasks scoped to a repo; switch repos with `,` / `.`, or open a global combined view
- Keyboard navigation: `hjkl` / arrow keys for track and task selection
- Task CRUD: `n` create, `r` rename, `d` delete (with confirm modal)
- Move task between tracks: `[` left, `]` right
- Task ordering within a track via explicit `sort_key`, not `created_at`
- Pillar / epic assignment on every task, with optional multi-label tagging
- Filter bar for repo, pillar, label, workflow state, PR status, and session state
- Saved views such as `@frontend`, `@infra`, `repo:api`, `needs-review`, `waiting-on-me`
- Search across task title, branch, repo, labels, and recent terminal/session metadata
- Archive / history view for completed sessions and closed tasks
- Live session indicator on each card (`● shell` / `○ shell`)
- PR status badge: none / open (`↑`) / merged (`⇑`) with colours
- CI status badge: none / pending (`◐`) / failed (`✗`) / passed (`✓`) with colours
- Pillar badge on each card, rendered as a colored chip with a short icon
- Repo badge on each card in global view
- Short task ID (`#xxxxxxxx`) shown on each card

### Shell Sessions
- `Enter` on a task opens (or re-attaches to) its shell session in the right panel
- Sessions are **durable** across TUI exit and daemon restart recovery
- Shell spawns with the task's branch already checked out via a git setup sequence
- Session backend is pluggable; default Unix backend is `tmux` for attachability and persistence
- `agentboard attach <task>` attaches from any terminal on the machine
- Multiple terminals per task are supported: `agent`, `shell`, `server`, `tests`, or named custom terminals
- `t` toggles keyboard focus between board and terminal pane
- `Esc` inside terminal focus returns to board
- Terminal pane header shows task title so you know what you're working on
- Live shell output rendered from xterm headless buffer
- Cursor position injected as `█` block at the real cursor location
- Scrollback, copy mode, and attach command are exposed in the UI

### Persistence & Recovery
- SQLite is the durable source of truth for tasks, repos, labels, pillars, saved views, and session metadata
- Session metadata includes backend type, session id, cwd, branch, attached terminals, last heartbeat, and restore policy
- Last-open view, focused repo, selected filters, and card selection persist per user
- Crash recovery marks sessions as `orphaned`, `alive`, or `needs-reconcile`
- Startup reconcile scans session backends and repo state to repair stale records
- Durable event log stores task moves, session starts/stops, sync results, and failures

### GitHub Sync
- Background poll at configurable interval (`pollIntervalMs`, default 60s)
- `s` key triggers manual sync
- Looks up PR by branch name via GitHub API
- Reads check suites for CI status
- Auto-advances task from In Progress → Review when PR is first opened
- Tracks draft/open/merged/closed state, review decision, and unresolved thread count
- Sync spinner shown in status bar while in-flight

### Agent Macros
- `a` key opens macro picker
- Macros send a command string to the task's shell session
- Macro `env` map prepends environment variables to the command
- Defined in config as `{ id, label, command, args[], env? }`

### UI / UX
- Consistent icon system: workflow, PR, CI, focus, and session states each have a stable icon vocabulary
- Color is never the only signal; every color-coded state also has text or icon meaning
- Support `truecolor`, `256-color`, and monochrome fallback themes
- Focus ring / highlight system makes it obvious whether the board, filter bar, modal, or terminal owns the keyboard
- `?` opens an in-app legend for icons, colors, and keybindings
- Narrow-terminal fallback collapses metadata into one-line cards and allows board-only mode
- Empty states explain what to do next: add repo, create task, attach session, run sync
- Status bar shows mode, active filters, daemon health, and background job activity

### CLI Commands
- `agentboard` — launch TUI
- `agentboard init` — write default config, create state dirs, and start daemon
- `agentboard doctor` — health check (node-pty, git, node version, GitHub token, repo paths)
- `agentboard attach <task>` — attach to a task session from any terminal
- `agentboard ls` — list tasks/sessions in text form
- `agentboard repos add <path>` — register a repo globally
- `agentboard views` — list and manage saved views
- `agentboard gc` — clean stale sessions, archived worktrees, and orphan metadata

---

## Configuration

Configuration is split by responsibility:

- **Global config** lives in the platform config directory and is the primary source of truth.
- **Global state** lives in the platform state directory and is never co-located with a repo.
- **Repo overlay config** is optional and only provides repo-local defaults. It must never change DB location or take ownership away from the machine-wide workspace.

Suggested paths:

- macOS config: `~/Library/Application Support/AgentBoard/config.json`
- macOS state: `~/Library/Application Support/AgentBoard/state/agentboard.db`
- Linux config: `${XDG_CONFIG_HOME:-~/.config}/agentboard/config.json`
- Linux state: `${XDG_STATE_HOME:-~/.local/state}/agentboard/agentboard.db`

```json
{
  "sessionBackend": "tmux",
  "pollIntervalMs": 60000,
  "githubTokenEnvVar": "GITHUB_TOKEN",
  "tracks": [...],
  "pillars": [
    {
      "id": "platform",
      "label": "Platform",
      "icon": "⬢",
      "color": "cyan"
    },
    {
      "id": "growth",
      "label": "Growth",
      "icon": "▲",
      "color": "green"
    }
  ],
  "repos": [
    {
      "id": "my-repo",
      "label": "My Project",
      "path": "/code/my-project",
      "githubOwner": "org",
      "githubRepo": "my-project",
      "defaultBaseBranch": "main",
      "defaultPillarId": "platform"
    }
  ],
  "savedViews": [
    {
      "id": "platform-review",
      "label": "Platform Review",
      "filters": {
        "pillarIds": ["platform"],
        "trackIds": ["review"]
      }
    }
  ],
  "agentMacros": [
    {
      "id": "claude",
      "label": "Run Claude",
      "command": "claude",
      "args": [],
      "env": { "ANTHROPIC_API_KEY": "${env:ANTHROPIC_API_KEY}" }
    }
  ]
}
```

Secrets should not be stored inline in config. Config stores environment variable references, command names, and defaults; secrets remain in the shell environment or platform keychain.

### Data model additions required for v1

- `repos`: stable repo registry keyed by id and absolute path
- `pillars`: first-class work streams, equivalent to epics / domains / initiatives
- `labels`: free-form tags orthogonal to pillars
- `tasks`: includes `repo_id`, `pillar_id`, `track_id`, `sort_key`, `branch_name`, `worktree_path`, `session_id`, `archived_at`
- `sessions`: includes backend metadata, attach command, status, heartbeat, and last buffer snapshot
- `saved_views`: reusable filters and board presets
- `events`: append-only operational log for audit and recovery
- `ui_state`: last active repo, filters, theme, and selection

---

## Key Design Decisions

### 1. Runtime is split into a daemon and thin clients

**Problem**: A single-process TUI cannot provide durable sessions, global access from any shell, or reliable crash recovery. If the UI owns the PTYs, closing the UI destroys the workstation.

**Decision**: The UI becomes a client. A background daemon owns durable state, session lifecycle, sync loops, and reconciliation. The TUI, `attach`, and future automation commands all talk to the same daemon over local IPC.

**Result**: Exiting the TUI no longer destroys tasks or sessions, and the system can be used from any terminal on the machine.

### 2. Session backend abstraction with durable default

**Prototype lesson**: Pure in-process PTY simplified rendering, but it failed the persistence requirement and made external attach impossible.

**Decision**: `SessionService` exposes a backend interface. The default Unix backend is `tmux`, because it provides durable detach/reattach semantics and shell access from any terminal. `node-pty` remains useful as an embedded rendering adapter and optional fallback backend for constrained environments.

**Operational rule**: Task records refer to logical sessions, not backend-specific ids. The backend can be swapped without changing board semantics.

### 3. Workflow state and pillar/epic are separate dimensions

**Problem**: Using columns for both "where work is" and "what work is about" breaks down immediately in multi-repo usage.

**Decision**: Columns represent workflow state only. Pillars/epics are first-class metadata with their own chips, filters, saved views, and grouping rules. A task can move from Backlog to Review without changing its pillar.

### 4. Global workspace first, repo overlays second

**Problem**: Local config precedence creates split-brain behavior and fragments the board across repositories.

**Decision**: One machine-wide workspace owns the database, daemon, saved views, and repo registry. Repo-local overlays may supply defaults such as preferred base branch, default macros, or prompt templates, but never primary ownership of persistence.

### 5. CJS/ESM interop for node-pty and @xterm/headless

Both packages are CommonJS. The project uses `"type": "module"` with NodeNext resolution.

- **node-pty**: Cannot be default-imported in ESM. Used `createRequire(import.meta.url)` to get a CJS `require`, then type-cast: `const nodePty = require("node-pty") as typeof import("node-pty")`. The `IPty` type is imported separately as a type-only import.
- **@xterm/headless**: Has a default export wrapping the CJS module. Used `import headlessPkg from "@xterm/headless"; const { Terminal } = headlessPkg`. Since `Terminal` is then a runtime value (not a static type), the instance type uses `type TerminalInstance = InstanceType<typeof Terminal>`.

### 6. GitHub integration delegates to `gh` CLI

**Context**: The project needs PR status, CI checks, and diff viewing. Managing a raw Octokit client and API token adds operational burden — users already have `gh` installed and authenticated.

**Decision**: `GitHubService` shells out to `gh` (e.g., `gh pr view --json`, `gh pr checks`) and parses JSON output. The user's existing `gh auth login` session is reused — no token config required in AgentBoard. For diff viewing, the service calls `gh pr diff | delta` to render syntax-highlighted, line-numbered diffs inside the terminal pane.

**Trade-off**: Requires `gh` and optionally `delta` to be installed. The `doctor` command checks for both and shows remediation hints if absent.

### 7. Stable ref pattern for stdin handler

**Problem**: `TerminalPane` forwards raw stdin bytes to the pty when focused. The effect that registers the stdin handler had `[isActive, stdin, onClose, taskId, ptyService]` as deps. `onClose` was an inline arrow function in App.tsx's JSX — new reference on every render. Every pty data event triggered a re-render, which triggered a new `onClose` reference, which re-ran the stdin effect (teardown + re-register). During the brief re-registration gap, keystrokes were dropped or delayed, causing the "one char behind" symptom.

**Fix**: `latestRef` pattern — store all mutable props in a ref updated via `useLayoutEffect` with no deps (runs every render, synchronously before paint). The stdin handler reads from the ref rather than closing over the props. Effect dep array reduced to `[isActive, stdin]` — both stable references. Handler is registered once per focus change, not once per pty data event.

```typescript
const latestRef = useRef({ onClose, ptyService, taskId });
useLayoutEffect(() => { latestRef.current = { onClose, ptyService, taskId }; });

useEffect(() => {
  if (!isActive) return;
  const handler = (data) => {
    latestRef.current.ptyService.write(latestRef.current.taskId, str);
  };
  stdin?.on("data", handler);
  return () => stdin?.off("data", handler);
}, [isActive, stdin]); // ← stable deps only
```

### 8. xterm write callback for buffer timing

**Problem**: `terminal.write(data)` in `@xterm/headless` is asynchronous — xterm defers parsing to the next tick. We were calling listeners immediately after `terminal.write()`, triggering a React re-render before xterm had updated the buffer. Every render showed the buffer state from the previous write — the "one behind" bug.

**Fix**: Move listener notification into xterm's optional write callback, which fires after the buffer is fully parsed:

```typescript
terminal.write(data, () => {
  this.listeners.get(task.id)?.forEach((cb) => cb());
});
```

### 9. Scrollback buffer — always show the bottom

**Problem**: `getBuffer` read lines `0..terminal.rows`, which is the top of the xterm buffer. As the shell produced output that scrolled past the first screen, the pane stayed frozen at the initial output.

**Fix**: Read the last `terminal.rows` lines from `buf.length`:

```typescript
const totalLines = buf.length;
const start = Math.max(0, totalLines - terminal.rows);
for (let i = start; i < totalLines; i++) {
  lines.push(buf.getLine(i)?.translateToString(true) ?? "");
}
```

`cursorY` from xterm is viewport-relative (within the current visible screen), so it still indexes correctly into the slice without adjustment.

### 10. BOARD_LOADED must not reset selection

`handleOpenSession` calls `refreshBoard()` which dispatches `BOARD_LOADED`. The original `BOARD_LOADED` reducer case reset `selectedTaskIndex: 0`. So pressing Enter on any task other than the first card would immediately jump the board cursor back to position 0.

**Fix**: Remove `selectedTaskIndex: 0` from `BOARD_LOADED`. Selection only resets on `TRACK_SELECT` and `REPO_SWITCH`, where the task list actually changes.

### 11. vhs demo tape — reproducible GIF from source

**Decision**: `vhs` tapes live in `demo/` and are not part of the build. CI runs `vhs demo/demo.tape` to regenerate the project GIF on release tags. This keeps the artifact reproducible from source without bloating the npm package.

### 12. node-pty spawn-helper permissions

**Problem**: After `npm install`, the prebuilt binary at `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` had permissions `644` (no execute bit). `node-pty` relies on this helper binary to spawn the child process. Without the execute bit: `Error: posix_spawnp failed`.

**Fix**: Added a `postinstall` script to `package.json`:
```json
"postinstall": "chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true"
```

---

## Things That Did Not Work

| Attempt | Problem | Resolution |
|---|---|---|
| tmux side-by-side via `split-window` | Panel kept duplicating; layout outside ink control | Replaced with in-process pty |
| Named ESM import `import { Terminal } from "@xterm/headless"` | SyntaxError — package is CJS, has no named ESM exports | Default import + destructure |
| Calling `this.listeners` immediately after `terminal.write()` | xterm parses async; buffer not yet updated on first render read | Moved call into write callback |
| `setRawMode` calls in TerminalPane | ink manages raw mode for its own input system; double-setting caused conflicts | Removed all `setRawMode` calls from components |
| TextInput box at the bottom of TerminalPane | Characters appeared in a separate input widget, not in the shell's own prompt line | Reverted to raw stdin forwarding |
| Inline `onClose` arrow in JSX as effect dep | New reference on every render → stdin handler re-registered on every pty data event → gaps → dropped/delayed keystrokes | Stable ref pattern |
| Reading xterm buffer from line 0..rows always | Terminal doesn't scroll; stuck on first screen of output | Read last N lines from `buf.length` |
| `selectedTaskIndex: 0` in BOARD_LOADED reducer | Board cursor jumped to first card every time a session opened | Removed reset; only reset on track/repo switch |
| `gh pr diff` piped to delta | delta requires a real TTY for color output; pipe stripped all ANSI | Use `delta --no-pager` with `COLORTERM=truecolor` set explicitly in the child process env |

---

---

## Implementation Log

The sections below document everything that was actually built, in the order problems were encountered. Each entry names the problem, the decision made, and the exact resolution. This is separate from the *design* decisions above — those describe the intended architecture; this section describes what actually happened when building it.

---

### Phase 1 — Project Scaffold

**Package configuration**

`package.json` was created with `"type": "module"` (ESM-first), `"module": "NodeNext"` resolution, and `"jsx": "react-jsx"` in `tsconfig.json`. Key decisions:

- `"moduleResolution": "NodeNext"` requires `.js` extensions on all relative TypeScript imports. Every `import from '../foo'` must be `import from '../foo.js'` even though the source file is `.ts`. This is not a bug — it is the NodeNext spec.
- `"jsx": "react-jsx"` uses the automatic JSX runtime. React does not need to be explicitly imported in `.tsx` files. Any `import React from 'react'` in a JSX file becomes an unused import that TypeScript will warn about. These were removed with `sed -i ''`.
- `"react-jsx"` still requires `react` in `dependencies` (the runtime is `react/jsx-runtime`), just not an explicit import in every file.

**CJS/ESM interop for native packages**

Three packages are CommonJS and cannot be statically imported in an ESM module:

| Package | Interop pattern |
|---|---|
| `better-sqlite3` | `import type { Database } from 'better-sqlite3'` for types; `const BetterSqlite3 = require('better-sqlite3') as { new(path: string, opts?: Options): Database }` via `createRequire` |
| `node-pty` | `const nodePty = require('node-pty') as typeof import('node-pty')` via `createRequire` |
| `@xterm/headless` | `import headlessPkg from '@xterm/headless'; const { Terminal } = headlessPkg` — has a CJS default export, so a default import works |

The `createRequire` pattern: `import { createRequire } from 'module'; const require = createRequire(import.meta.url)`.

**`better-sqlite3` type error TS4023**

Exporting a variable typed as `InstanceType<typeof BetterSqlite3>` exposed the private `BetterSqlite3.DatabaseConstructor` type. Fix: use `import type { Database } from 'better-sqlite3'` and export `Db = Database`. The `require`-loaded constructor is typed as `{ new(path, options?): Database }` — just enough to call it, without leaking the private constructor type name.

**`postinstall` for node-pty permissions**

After `npm install`, the spawn-helper prebuilt binary at `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` had permissions `644` (no execute bit). Added `postinstall` script:

```json
"postinstall": "chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true"
```

---

### Phase 2 — Config, DB, Daemon Skeleton

**macOS vs XDG paths**

`configPaths()` in `src/config/index.ts`:
- macOS: `~/Library/Application Support/AgentBoard/` for both `configDir` and `stateDir`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/agentboard/` and `${XDG_STATE_HOME:-~/.local/state}/agentboard/`
- Socket: always `os.tmpdir()/agentboard-<uid>.sock` — avoids the 104-character Unix domain socket path length limit regardless of how deep the home directory is

**Migration runner**

`runMigrations()` in `src/db/index.ts` uses `fileURLToPath(import.meta.url)` to locate `migrations/` relative to the compiled `.js` output. This means the `.sql` files must be in `dist/db/migrations/`, not just `src/db/migrations/`. TypeScript does not copy non-`.ts` assets.

Fix added to `package.json` build script:

```
"build": "tsc && mkdir -p dist/db/migrations && cp src/db/migrations/*.sql dist/db/migrations/"
```

The first attempt used `cp -r src/db/migrations dist/db/migrations`. On subsequent builds this created a nested `dist/db/migrations/migrations/` directory because the target already existed. Switched to explicit `*.sql` glob copy to avoid nesting.

**`tracks` table missing from initial migration**

`ViewService.getBoardSnapshot()` queries `SELECT id, label, sort_order FROM tracks`. The initial `001_initial.sql` migration had no `tracks` table — tracks were designed as config-only. This caused `SqliteError: no such table: tracks` on every `getBoard` call.

Resolution:
1. Added `002_tracks.sql` migration that `CREATE TABLE IF NOT EXISTS tracks`.
2. Added `BoardService.upsertTrack()` method.
3. In `runDaemon()`, after `openDb` and after loading config, the daemon seeds tracks from `cfg.tracks` into the DB. Fallback seeds the four built-in tracks if config is unavailable.

**Config field name mismatch in user's config.json**

The config file written before implementation used `sort_order` (snake_case) for tracks and had `theme` as an object `{ name, monochrome, trueColor }`. The Zod schema requires `sortOrder` (camelCase) and `theme` as a string enum. On daemon start, `loadConfig()` logged validation failures and fell back to defaults — which is the correct behavior, but worth noting: the config file at `~/Library/Application Support/AgentBoard/config.json` may need to be updated manually to match the current schema.

---

### Phase 3 — Services

**SyncService event name**

`SyncService.syncEvent` emits `'sync'` (with the result) at the end of `runSync()`. There are no separate `'started'` or `'done'` events. The daemon fan-out in `index.ts` was initially wired to listen for `'started'` and `'done'`, causing the sync status to never propagate to connected TUI clients.

Fix: listen for `'sync'` and emit one `sync_status` done payload plus a fresh `board_patch`:

```typescript
sync.syncEvent.on('sync', (result) => {
  serverEvents.emit('event', { type: 'sync_status', payload: { status: 'done', result } });
  serverEvents.emit('event', { type: 'board_patch', payload: view.getBoardSnapshot() });
});
```

**SyncService method name**

The internal `runSync()` method is private. The public API is `trigger()`, not `run()`. The server dispatch for `triggerSync` was initially calling `services.sync.run()` — a type error caught by `tsc`.

**`createSavedView` not on BoardService**

`BoardService` has `upsertSavedView(v: SavedViewRecord)` but no `createSavedView`. The RPC dispatch for `createSavedView` was implemented directly in the server: generate an ID with `generateId()`, assemble a `SavedViewRecord`, then call `board.upsertSavedView()`.

**Unused constructor parameter in AppController**

`AppController` used a `dispatchRef: { current: Dispatch<AppAction> }` pattern internally, but the constructor also declared `private dispatch: Dispatch<AppAction>`. TypeScript flagged this as declared but never read. Fix: remove the `private` modifier so the parameter is not promoted to a class property.

**`uptime` units**

`process.uptime()` returns seconds as a float. `DaemonStatus.uptime` is documented in milliseconds. Fixed by multiplying: `uptime: process.uptime() * 1000`.

**Services were stub-only in the daemon**

The original `runDaemon()` body created only `{ db }` for the `ServiceContainer`, leaving all other services as `undefined` at runtime. All RPC handlers returned "Not implemented". After wiring all services properly, the full `ServiceContainer` is now:

```typescript
{ db, dbPath, board, workspace, view, git, github, sync, events, doctor, session }
```

---

### Phase 4 — TUI

**`App.tsx` still used inline stub components**

`App.tsx` was scaffolded with local stub functions (`function Board() { return <Text>Board</Text> }`, etc.). The real implementations in `Board.tsx`, `Header.tsx`, etc. existed but were never imported. The visible result was a blank screen showing only "AgentBoard" and "Board".

Fix: rewrote `App.tsx` to import all real components:

```typescript
import { Header } from './Header.js';
import { FilterBar } from './FilterBar.js';
import { Board } from './Board.js';
import { TerminalPane } from './TerminalPane.js';
import { StatusBar } from './StatusBar.js';
import { HelpOverlay } from './HelpOverlay.js';
import { CreateTaskModal } from './modals/CreateTask.js';
// … etc.
```

**Modal focus was not set on open**

The keyboard handler dispatched `MODAL_OPEN` but did not dispatch `FOCUS_SET` to `'modal'`. Without the focus change, `useInput` continued routing keypresses to the board (e.g., pressing `n` to start typing a task title would also navigate tracks). Every `MODAL_OPEN` dispatch was paired with `dispatch({ type: 'FOCUS_SET', payload: 'modal' })`.

**Help modal used a non-existent `ModalType`**

The original code used `'label-editor'` with a `{ isHelp: true }` payload as a hack for the help modal. `'help'` was added to the `ModalType` union in `src/types/index.ts` and `HelpOverlay` is now rendered directly for `modal === 'help'`.

**Board keyboard handler used wrong track order**

The keystroke router in `App.tsx` used `tracks[selectedTrackIndex]` from raw `state.tracks`, but `Board.tsx` renders `[...tracks].sort((a, b) => a.sortOrder - b.sortOrder)`. If tracks were stored in a different order in the DB, the selected track in the router would be out of sync with the rendered track. Fixed by sorting tracks in the router with the same sort expression.

**Double `controller.start()` in CLI**

`src/cli/index.ts` called `render(...)` and then `await controller.start()`. `App.tsx` also calls `controller.start()` in its mount effect. This caused two simultaneous `connect()` calls and two `refreshBoard()` calls, resulting in duplicate board snapshots and race conditions.

Fix: removed the `await controller.start()` call from `src/cli/index.ts`. The App component owns the lifecycle entirely through its mount/unmount effect.

**`--daemon` flag not handled in entry point**

`startDaemon()` spawns a new process as: `node dist/bin/agentboard.js --daemon`. The original `src/bin/agentboard.tsx` passed all argv directly to `buildCli().parse(process.argv)`. Commander treats `--daemon` as an unknown option and exits with an error. The child process died immediately, explaining why `ensureRunning()` always timed out.

Fix: the entry point now checks `process.argv.includes('--daemon')` before Commander runs, and routes to `runDaemon()` if true:

```typescript
if (process.argv.includes('--daemon')) {
  const { runDaemon } = await import('../daemon/index.js');
  const { AGENTBOARD_DAEMON_CONFIG: configFile = '', ... } = process.env;
  await runDaemon({ configFile, dbPath, socketPath, logFile, stateDir });
  process.exit(0);
} else {
  const { buildCli } = await import('../cli/index.js');
  buildCli().parse(process.argv);
}
```

Both branches use dynamic `import()` so neither pulls in the other's dependencies in the binary's startup path.

---

### Phase 5 — Integration and End-to-End Testing

**Smoke test results after all fixes:**

```
$ agentboard doctor
✓ pass — node-version: v22.22.2
✓ pass — git: git version 2.46.0
✓ pass — tmux: tmux 3.6a
✓ pass — gh: gh version 2.88.1
✓ pass — gh-auth: Authenticated with GitHub
⚠ warn — delta: delta not found (optional)
           remediation: brew install git-delta
✓ pass — db: Database OK
✓ pass — socket: Socket directory writable
✓ pass — repos: No repos registered
```

```
$ agentboard daemon status
version     0.1.0
pid         83998
uptime (s)  3
db          ~/Library/Application Support/AgentBoard/agentboard.db
socket      /var/folders/.../T/agentboard-501.sock
```

```
$ agentboard ls
No tasks found.
```

TUI renders correctly: Header (daemon status + repo tabs), 4 kanban columns (Backlog / In Progress / Review / Done), StatusBar with mode indicator and keyboard hints. All modal flows wired: `n` create, `r` rename, `d` delete, `p` pillar, `g` view-picker, `?` help.

---

### Known Limitations / Future Work

- **No scrollback navigation** — the terminal pane always shows the tail of the buffer. There is no way to scroll up in the pane (planned: Shift+↑/↓ or PgUp/PgDn when terminal is focused).
- **Single visible terminal pane in the TUI** — multiple task terminals may exist, but only one is rendered at a time in the embedded pane.
- **Fixed column width** — COLS is hardcoded to 100. Does not adapt if the terminal is narrower than ~145 columns (board + pane).
- **Branch name in DB schema still named `tmux_session`** — leftover from the tmux era. The column stores the old tmux session name pattern (`ab_task_xxx`) which is now unused. Should be migrated out.
- **TaskRecord.tmuxSession field** — same legacy field kept in the TypeScript type and DB schema. No functional impact since PtyService uses `task.id` as its key, not the tmux session name.
- **No Ctrl+C forwarding** — because ink intercepts it for process exit. Sending interrupt to the shell requires typing `kill %1` or similar via the shell prompt.
- **GitHub sync is polling-only** — no webhooks. Sync interval minimum is 10 seconds (config-validated).
- **Remote execution is deferred** — local multi-repo orchestration comes first; remote workers are a later expansion.
- **Notifications are deferred** — local workstation quality and durable sessions take precedence over phone/push integrations.

---

## File Map

```
src/
  bin/agentboard.tsx          Entry point — detects --daemon flag first, then routes to buildCli()
  cli/index.ts                Commander subcommands: init, doctor, attach, ls, repos, sync, gc,
                              daemon start/stop/status; default action launches TUI
  cli/rpc.ts                  RPCClient — call<T>(method, params), subscribe(handler), UUID
                              correlation IDs, 10 s timeouts, newline-delimited JSON framing
  daemon/index.ts             Daemon bootstrap + lifecycle; full service wiring in runDaemon();
                              seeds tracks from config on startup; sync event fan-out
  daemon/server.ts            Unix socket server; dispatch() implements all 22 RPCMethod cases;
                              serverEvents EventEmitter fans board_patch and sync_status to
                              all subscribed connections
  config/index.ts             Zod schemas (AppConfigSchema, PartialAppConfigSchema,
                              RepoOverlayConfigSchema); configPaths() with macOS/XDG branches;
                              loadConfig(), writeDefaultConfig(), ensureDirectories(),
                              loadRepoOverlay(), mergeOverlay()
  db/
    index.ts                  openDb(): WAL, FK ON, NORMAL sync, 32 MB cache, runMigrations();
                              generateId() (8 hex chars via crypto.randomBytes); CJS interop
                              for better-sqlite3 via createRequire; exports Db = Database
    migrations/
      001_initial.sql         repos, pillars, labels, tasks, task_labels, sessions,
                              saved_views, events, ui_state; all indexes
      002_tracks.sql          tracks table (id, label, sort_order) — added post-initial
  types/index.ts              All domain records, RPC envelopes, AppState, AppAction (16 types),
                              AppFocus, ModalType (now includes 'help'), FilterModel,
                              BoardSnapshot, SessionBackend interface
  services/
    board.ts                  BoardService: full CRUD for tasks (getTasks, createTask,
                              renameTask, moveTask, reorderTask, archiveTask, deleteTask),
                              assignPillar, setLabels, getPillars, getLabels, getSavedViews,
                              upsertSavedView, deleteSavedView, upsertTrack, getUIState,
                              setUIState; label join in bulk select, auto sort_key
    workspace.ts              WorkspaceService: addRepo (validates realpath + .git + duplicate
                              check + GitHub remote detection), listRepos, getRepo,
                              updateRepo, removeRepo, checkRepoHealth, reconcileHealth
    view.ts                   ViewService: applyFilter (all dimensions), resolveView,
                              getBoardSnapshot (queries tracks and repos directly from DB)
    session-manager.ts        SessionManager: openSession (reattach check), sendInput,
                              getBuffer; lazy backend singletons; reconcileAll marks orphans
    session-backends/
      tmux.ts                 TmuxBackend: session naming ab_<taskId>; create, list,
                              inspect, terminate via tmux CLI; sendInput via send-keys
      pty.ts                  PtyBackend: node-pty via createRequire; in-memory Map<id, IPty>
    terminal-buffer.ts        TerminalBufferService: @xterm/headless via default import;
                              listeners called inside write callback (not after); getBuffer
                              reads last terminal.rows lines from buf.length (tail, not head)
    git.ts                    GitService: deriveBranchName (slug to ab/<slug>/<taskId>),
                              getCurrentBranch, createBranch, checkoutBranch, getRepoRoot
    github.ts                 GitHubService: all calls via gh subprocess; getPR parses
                              JSON from gh pr view --json; getDiff pipes gh pr diff | delta
                              --no-pager; fallback to raw diff if delta absent
    sync.ts                   SyncService: start(intervalMs)/stop()/trigger(); running guard;
                              auto-advances in-progress→review on PR open; emits 'sync' event
    events.ts                 EventLogService: append-only log(), recent(), recentByType(),
                              since()
    doctor.ts                 DoctorService: 9 parallel checks (node-version, git, tmux, gh,
                              gh-auth, delta, db, socket, repos); pass/warn/fail + remediation
  store/index.ts              initialState, reducer (16 action types), AppContext,
                              useAppState(), useAppDispatch()
  controller/index.ts         AppController: dispatchRef pattern for stable callbacks;
                              createTask, moveTask, renameTask, archiveTask, deleteTask,
                              assignPillar, openSession, sendInput, triggerSync, refreshBoard
  ui/
    App.tsx                   Root layout; imports all real components; renderModal() handles
                              all 7 modal types; focus FSM in useInput; sortedTracks sort
                              applied in both router and Board
    Board.tsx                 Renders Track columns sorted by sortOrder; groups tasks by
                              trackId; shows empty-state hint when no repos registered
    Track.tsx                 Single column: borderStyle="single", 32-char width, task list
                              or "No tasks" empty state
    TaskCard.tsx              3-row card: indicator+title, pillar+PR+CI badges (chalk),
                              session dot+label+shortId; selected row uses backgroundColor
    Header.tsx                Repo tabs + [All*] tab + active view name + daemon status icon
    FilterBar.tsx             Active filter chips; shown only when focus=filterbar or
                              filters are non-empty
    StatusBar.tsx             Mode label (BOARD/TERMINAL/FILTER/MODAL) + statusMessage +
                              syncInProgress spinner + keyboard hints
    TerminalPane.tsx          Buffer lines with cursor injection (█); shows narrow-terminal
                              fallback message if terminal < 40 cols available
    HelpOverlay.tsx           Sections: Navigation, Task actions, View, Session, Sync, Icons
    modals/
      CreateTask.tsx          Title input + repo picker (if >1 repo); onSubmit(title, repoId)
      RenameTask.tsx          Prefilled title input; onSubmit(title)
      DeleteConfirm.tsx       [y]/[n/Esc] confirm; onConfirm() / onCancel()
      MacroPicker.tsx         Arrow key list of agent macros; onSelect(macro)
      PillarPicker.tsx        Arrow key list; includes None option; onSelect(pillarId|null)
      SavedViewPicker.tsx     Arrow key list of saved views; onSelect(viewId)
db/
  migrations/
    001_initial.sql           (same as src — copied to dist at build time)
    002_tracks.sql
demo/
  demo.tape                   VHS tape script — walks init → TUI → create → session → sync → quit
dist/                         Compiled output (gitignored)
```

---

## Keyboard Reference

| Key | Context | Action |
|---|---|---|
| `↑` / `k` | Board | Select task above |
| `↓` / `j` | Board | Select task below |
| `←` / `h` | Board | Move to left track |
| `→` / `l` | Board | Move to right track |
| `,` | Board | Switch to previous repo |
| `.` | Board | Switch to next repo |
| `g` | Board | Toggle global all-repos view |
| `n` | Board | New task |
| `r` | Board | Rename selected task |
| `d` | Board | Delete selected task (with confirm) |
| `[` | Board | Move task one track left |
| `]` | Board | Move task one track right |
| `p` | Board | Set / change pillar for selected task |
| `f` | Board | Open filter bar |
| `/` | Board | Search tasks |
| `Enter` | Board | Open shell session for selected task |
| `t` | Board (session open) | Focus terminal pane |
| `a` | Board | Open macro picker |
| `s` | Board | Trigger manual GitHub sync |
| `?` | Any | Open keybinding + icon legend |
| `q` | Board | Quit TUI client (sessions keep running) |
| `Esc` | Terminal | Return focus to board |
| `Esc` | Any modal | Cancel / close modal |
