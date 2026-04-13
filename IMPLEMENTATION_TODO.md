# AgentBoard Implementation TODO

This document is the execution plan for building AgentBoard as a machine-wide, terminal-native kanban workstation for AI-assisted development.

Scope covered here:

- Multi-repo support from any terminal on the machine
- Durable sessions and local persistence
- Pillars / epics / labels / saved views
- Clear terminal UI with icons, colors, and accessibility fallbacks
- Git, GitHub, sync, recovery, and operational hardening

This is intentionally exhaustive. Every item should be either implemented, explicitly deferred, or rejected with a written reason.

---

## 0. Product Lock Before Coding

- [ ] Freeze the product name to one canonical string
- [ ] Freeze the package / binary name (`agentboard` or final alternative)
- [ ] Freeze the support matrix:
  - [ ] macOS first-class support
  - [ ] Linux first-class support
  - [ ] Windows explicitly unsupported in v1, or scoped with fallback behavior
- [ ] Freeze the v1 session backend policy:
  - [ ] `tmux` is the default durable Unix backend
  - [ ] `node-pty` fallback is supported or explicitly postponed
- [ ] Freeze the persistence policy:
  - [ ] one machine-wide workspace per OS user
  - [ ] one global DB per OS user
  - [ ] repo-local overlays are defaults only, never primary state
- [ ] Freeze the core workflow column model for v1
- [ ] Freeze the v1 data taxonomy:
  - [ ] task
  - [ ] repo
  - [ ] pillar
  - [ ] label
  - [ ] session
  - [ ] saved view
  - [ ] event
- [ ] Freeze the default theme philosophy:
  - [ ] readable in standard terminals
  - [ ] color is supplemental, never the only signal
  - [ ] icon set must degrade safely in low-Unicode terminals
- [ ] Freeze the definition of done for v1:
  - [ ] create task
  - [ ] assign repo
  - [ ] assign pillar
  - [ ] open session
  - [ ] quit TUI
  - [ ] re-open TUI from another terminal
  - [ ] reattach to same durable session
  - [ ] filter by pillar
  - [ ] persist view/session/task state

---

## 1. Repository and Project Skeleton

Stack: TypeScript + Node.js + ink (TUI) + Commander (CLI) + vhs (demo)

- [ ] Create initial project structure under `src/`
- [ ] Create package manifest with scripts for:
  - [ ] build
  - [ ] dev
  - [ ] lint
  - [ ] typecheck
  - [ ] test
  - [ ] test:watch
  - [ ] format
  - [ ] doctor
  - [ ] demo (`vhs demo/demo.tape`)
- [ ] Configure TypeScript:
  - [ ] strict mode
  - [ ] NodeNext module resolution
  - [ ] source maps
  - [ ] separate output directory
- [ ] Configure test runner
- [ ] Configure linting
- [ ] Configure formatting
- [ ] Add `.editorconfig`
- [ ] Add `.gitignore` (`dist/`, `*.db`, `*.log`, generated `demo.gif`)
- [ ] Add basic README placeholder
- [ ] Add license file if needed
- [ ] Add package `bin` mapping for CLI entry
- [ ] Add `postinstall` handling for native helper permissions if required
- [ ] Add CI workflow skeleton:
  - [ ] install
  - [ ] lint
  - [ ] typecheck
  - [ ] unit tests
  - [ ] `vhs demo/demo.tape` on release tag
- [ ] Define minimum Node version
- [ ] Ensure terminal dependencies compile on macOS and Linux

Exit criteria:

- [ ] Fresh install succeeds
- [ ] `npm run build` succeeds
- [ ] `npm run test` succeeds
- [ ] CLI binary can be invoked locally

---

## 2. Runtime and Directory Layout

- [ ] Define platform-specific config, state, cache, log, and socket paths
- [ ] Implement path resolver module
- [ ] Define directory creation rules on first run
- [ ] Create workspace directories automatically when missing
- [ ] Ensure directories use safe permissions
- [ ] Decide socket path format:
  - [ ] deterministic per-user path
  - [ ] short enough for Unix socket length limits
- [ ] Define PID file / lock file strategy for daemon singleton
- [ ] Define daemon log file location
- [ ] Define DB backup / vacuum policy
- [ ] Define temp directory usage for exports and transient files
- [ ] Define migration storage location
- [ ] Define repo overlay discovery rules

Exit criteria:

- [ ] `agentboard init` creates all required directories
- [ ] Re-running init is idempotent
- [ ] Paths resolve correctly on macOS and Linux

---

## 3. Configuration System

- [ ] Define global config schema with Zod
- [ ] Define repo overlay schema with Zod
- [ ] Define config merge rules:
  - [ ] global defaults
  - [ ] repo overlay overrides
  - [ ] runtime flags / CLI overrides
- [ ] Validate schema error messages for human readability
- [ ] Add support for:
  - [ ] session backend selection
  - [ ] poll interval
  - [ ] GitHub token env var
  - [ ] tracks
  - [ ] pillars
  - [ ] repos
  - [ ] saved views
  - [ ] macros
  - [ ] theme
  - [ ] icon mode
  - [ ] monochrome mode
- [ ] Support env references in config values
- [ ] Prevent inline secret storage where possible
- [ ] Add config upgrade / normalization step
- [ ] Add default config generator
- [ ] Add config write command or init flow
- [ ] Add config doctor validation
- [ ] Add tests for valid config
- [ ] Add tests for invalid config
- [ ] Add tests for repo overlay precedence

Exit criteria:

- [ ] Broken config fails fast with actionable errors
- [ ] Valid config round-trips correctly
- [ ] Repo overlays cannot relocate global DB/state ownership

---

## 4. Database Schema and Migrations

- [ ] Choose migration format and runner
- [ ] Create initial schema migration
- [ ] Enable WAL mode
- [ ] Define foreign key behavior
- [ ] Define cascade behavior carefully
- [ ] Create tables:
  - [ ] `repos`
  - [ ] `pillars`
  - [ ] `labels`
  - [ ] `tasks`
  - [ ] `task_labels`
  - [ ] `sessions`
  - [ ] `saved_views`
  - [ ] `events`
  - [ ] `ui_state`
  - [ ] optional `sync_runs`
  - [ ] optional `task_activity`
- [ ] Add indexes for:
  - [ ] repo lookups
  - [ ] track lookups
  - [ ] pillar lookups
  - [ ] session status
  - [ ] branch lookup
  - [ ] worktree path lookup
  - [ ] updated_at sorting
  - [ ] saved view lookup
- [ ] Add unique constraints:
  - [ ] repo path
  - [ ] repo id
  - [ ] pillar id
  - [ ] label id
  - [ ] saved view id
  - [ ] session backend/session key where needed
- [ ] Add `sort_key` support for manual ordering
- [ ] Add archival fields:
  - [ ] `archived_at`
  - [ ] `closed_at`
  - [ ] `deleted_at` if soft-delete is desired
- [ ] Add audit timestamps to every durable entity
- [ ] Define enum storage strategy for statuses
- [ ] Define migration for legacy `tmux_session` naming if old prototype DBs are imported
- [ ] Add migration smoke tests
- [ ] Add downgrade policy documentation even if downgrade is unsupported

Exit criteria:

- [ ] Fresh DB creation works
- [ ] Existing DB migrates forward cleanly
- [ ] Indexes cover the main board queries

---

## 5. Core Domain Types

- [ ] Define TypeScript types for all durable entities
- [ ] Define API DTOs for RPC boundaries
- [ ] Define strict input schemas for all mutations
- [ ] Define status enums:
  - [ ] task workflow state
  - [ ] session state
  - [ ] PR state
  - [ ] CI state
  - [ ] review state
  - [ ] daemon health state
- [ ] Define normalized filter model
- [ ] Define saved view model
- [ ] Define event model
- [ ] Define terminal snapshot model
- [ ] Define session backend interface
- [ ] Define error envelope model for CLI and UI presentation

Exit criteria:

- [ ] No service relies on ambiguous untyped records
- [ ] RPC contract is stable and explicit

---

## 6. Daemon Lifecycle

- [ ] Create daemon entrypoint
- [ ] Implement singleton detection
- [ ] Implement daemon start command
- [ ] Implement daemon auto-start from `agentboard` when not already running
- [ ] Implement graceful shutdown
- [ ] Handle stale PID/socket cleanup
- [ ] Add startup health log
- [ ] Add signal handling:
  - [ ] SIGINT
  - [ ] SIGTERM
  - [ ] SIGHUP if relevant
- [ ] Ensure DB closes cleanly on shutdown
- [ ] Ensure session backends are not unintentionally killed on TUI exit
- [ ] Implement startup reconcile pass
- [ ] Implement periodic housekeeping scheduler
- [ ] Add daemon heartbeat endpoint
- [ ] Add daemon version endpoint
- [ ] Add daemon status command for CLI

Exit criteria:

- [ ] Multiple CLI invocations reuse one daemon
- [ ] Quitting the TUI does not kill durable sessions
- [ ] Restarting the daemon preserves recoverable state

---

## 7. IPC / RPC Layer

- [ ] Choose IPC transport:
  - [ ] Unix domain socket on Unix
  - [ ] named pipe strategy if Windows is later added
- [ ] Define request/response envelope
- [ ] Define streaming event channel
- [ ] Define subscription model for board updates
- [ ] Define RPC timeouts
- [ ] Define reconnect behavior for TUI clients
- [ ] Add request correlation ids
- [ ] Add structured RPC errors
- [ ] Add auth boundary assumptions for local-only use
- [ ] Guard against socket file permission issues
- [ ] Implement methods for:
  - [ ] board snapshot
  - [ ] task create
  - [ ] task rename
  - [ ] task delete/archive
  - [ ] task move
  - [ ] task reorder
  - [ ] task assign pillar
  - [ ] task set labels
  - [ ] repo add/list/update
  - [ ] saved view CRUD
  - [ ] session open
  - [ ] session attach metadata
  - [ ] session send input
  - [ ] sync trigger
  - [ ] doctor summary
  - [ ] daemon status
- [ ] Add RPC tests
- [ ] Add reconnect tests

Exit criteria:

- [ ] TUI can cold-start by fetching one board snapshot
- [ ] TUI updates via event stream after mutations
- [ ] CLI subcommands work without direct DB access

---

## 8. Repo Registry and Discovery

- [ ] Build `WorkspaceRegistryService`
- [ ] Support explicit repo registration by path
- [ ] Validate repo path exists
- [ ] Validate repo path is a git repository
- [ ] Read repo metadata:
  - [ ] repo label default
  - [ ] root path
  - [ ] current default branch
  - [ ] remote origin URL
  - [ ] GitHub owner/repo if derivable
- [ ] Prevent duplicate repo registration
- [ ] Handle symlink / canonical path normalization
- [ ] Decide whether nested repos are allowed
- [ ] Decide whether bare repos are rejected
- [ ] Add repo update command
- [ ] Add repo removal / archive command
- [ ] Define behavior when a registered repo is missing on disk
- [ ] Add repo health state
- [ ] Add tests for duplicate, missing, invalid, moved repos

Exit criteria:

- [ ] Repo registry remains consistent across restarts
- [ ] Same repo cannot be added twice under different path variants

---

## 9. Task Service

- [ ] Build `BoardService` CRUD for tasks
- [ ] Implement task creation with required fields:
  - [ ] title
  - [ ] repo id
  - [ ] track id
  - [ ] pillar id optional or required per final policy
- [ ] Auto-generate short task id
- [ ] Implement task rename
- [ ] Implement task description / notes field if included
- [ ] Implement task move across tracks
- [ ] Implement task reorder within track
- [ ] Implement task archive
- [ ] Implement task unarchive if supported
- [ ] Implement task delete policy:
  - [ ] hard delete forbidden or allowed only when safe
  - [ ] default to archive if uncertain
- [ ] Persist selected branch name
- [ ] Persist selected worktree path
- [ ] Persist linked session id
- [ ] Persist PR/CI/review fields or separate them into sync tables
- [ ] Emit events for all mutations
- [ ] Add unit tests for all mutations

Exit criteria:

- [ ] Full task lifecycle works through service and RPC
- [ ] Ordering is deterministic and editable

---

## 10. Pillars, Labels, and Saved Views

### Pillars

- [ ] Build CRUD for pillars
- [ ] Enforce stable pillar ids
- [ ] Support icon and color metadata
- [ ] Support repo-specific default pillar
- [ ] Support pillar reassignment on tasks
- [ ] Support filtering by one or multiple pillars
- [ ] Support grouping by pillar where appropriate
- [ ] Add tests for pillar deletion / reassignment edge cases

### Labels

- [ ] Build CRUD for labels
- [ ] Support multi-label tagging on tasks
- [ ] Support label color metadata if desired
- [ ] Support label filters
- [ ] Support quick add/remove from task card
- [ ] Decide label cardinality limits
- [ ] Add tests for label assignment and filter behavior

### Saved Views

- [ ] Define filter serialization model
- [ ] Build CRUD for saved views
- [ ] Support built-in system views
- [ ] Support user-created views
- [ ] Support default startup view
- [ ] Support view pinning/favoriting if desired
- [ ] Add tests for view persistence and invalid filter repair

Exit criteria:

- [ ] Tasks can be filtered by pillar and labels
- [ ] Saved views survive restart and load correctly

---

## 11. Search and Filtering Engine

- [ ] Define filter grammar for CLI and UI
- [ ] Support filters on:
  - [ ] repo
  - [ ] pillar
  - [ ] label
  - [ ] workflow state
  - [ ] PR state
  - [ ] CI state
  - [ ] review state
  - [ ] session state
  - [ ] archived/non-archived
- [ ] Implement free-text search over:
  - [ ] title
  - [ ] branch
  - [ ] repo label
  - [ ] labels
  - [ ] pillar label
  - [ ] optional notes
- [ ] Decide whether v1 needs SQLite FTS or simple indexed LIKE queries
- [ ] Add search ranking rules if FTS is used
- [ ] Persist active filters in `ui_state`
- [ ] Clear invalid filters safely after config changes
- [ ] Add unit tests for combined filter behavior
- [ ] Add regression tests for empty result states

Exit criteria:

- [ ] Filter changes are instant on realistic boards
- [ ] Search results remain stable and predictable

---

## 12. Session Backend Abstraction

- [ ] Define `SessionBackend` interface:
  - [ ] create session
  - [ ] attach metadata
  - [ ] send input
  - [ ] resize
  - [ ] list sessions
  - [ ] inspect
  - [ ] terminate
  - [ ] health check
- [ ] Build `SessionService` around logical sessions, not backend ids
- [ ] Persist logical session records
- [ ] Track mapping from task to default terminal/session
- [ ] Support multiple terminals per task
- [ ] Track terminal roles:
  - [ ] agent
  - [ ] shell
  - [ ] server
  - [ ] tests
  - [ ] custom
- [ ] Define heartbeat/update policy
- [ ] Define idle vs active rules
- [ ] Define orphan detection
- [ ] Add tests for backend interchangeability

Exit criteria:

- [ ] Higher-level task logic does not care which backend is active

---

## 13. Tmux Backend

- [ ] Implement tmux availability detection
- [ ] Implement version check and minimum supported version
- [ ] Decide naming convention for sessions/windows/panes
- [ ] Create durable tmux session per logical task terminal
- [ ] Support attach command generation
- [ ] Support send-keys / stdin forwarding
- [ ] Support resize semantics if embedded view requires it
- [ ] Support list/inspect existing tmux sessions on startup
- [ ] Reconcile logical DB sessions with real tmux sessions
- [ ] Handle stale DB records when tmux session is gone
- [ ] Handle stale tmux sessions when DB record is gone
- [ ] Decide cleanup policy for archived tasks
- [ ] Decide whether to use one tmux server namespace or separate sockets
- [ ] Guard against session name collisions
- [ ] Add tests for command building
- [ ] Add integration tests where feasible

Edge cases:

- [ ] tmux not installed
- [ ] tmux installed but server not running
- [ ] task title changes after session creation
- [ ] repo path moved after session creation
- [ ] base branch no longer exists
- [ ] user manually kills tmux session

Exit criteria:

- [ ] A session can be started once and reattached from any terminal later

---

## 14. Optional `node-pty` Fallback Backend

- [ ] Decide whether fallback ships in v1 or is postponed
- [ ] If shipped, implement parity subset:
  - [ ] create
  - [ ] send input
  - [ ] resize
  - [ ] inspect
  - [ ] terminate
- [ ] Clearly mark fallback as non-durable if durability is impossible
- [ ] Ensure UI communicates backend limitations
- [ ] Add tests for fallback path

Exit criteria:

- [ ] Users cannot accidentally assume persistence where it does not exist

---

## 15. Terminal Buffer and Embedded Terminal View

- [ ] Build `TerminalBufferService`
- [ ] Consume tmux/backend output into xterm headless where applicable
- [ ] Support ANSI color parsing
- [ ] Support Unicode safely
- [ ] Support cursor rendering
- [ ] Support viewport tailing
- [ ] Support scrollback buffer retention policy
- [ ] Implement scrollback navigation
- [ ] Implement copy mode or selection export if feasible
- [ ] Handle terminal resize events
- [ ] Handle narrow width gracefully
- [ ] Ensure line wrapping is deterministic
- [ ] Ensure alternate screen apps degrade acceptably or document limitations
- [ ] Add tests for:
  - [ ] async writes
  - [ ] tail rendering
  - [ ] cursor position
  - [ ] color stripping in monochrome mode
  - [ ] scrollback navigation

Exit criteria:

- [ ] Embedded terminal view is reliable enough for watching and light interaction
- [ ] Full control remains possible through external attach

---

## 16. Git and Worktree Management

- [ ] Build `GitService`
- [ ] Validate git availability
- [ ] Resolve repo root from registered path
- [ ] Discover default base branch
- [ ] Create branch naming strategy from task metadata
- [ ] Decide whether worktrees are mandatory or optional in v1
- [ ] If worktrees are supported:
  - [ ] define worktree base directory policy
  - [ ] create worktree
  - [ ] register worktree path in DB
  - [ ] detect orphan worktrees
  - [ ] support cleanup flow
- [ ] If worktrees are not used:
  - [ ] ensure branch switching rules are safe
  - [ ] prevent multi-session repo corruption
- [ ] Prevent launching conflicting sessions on the same repo checkout when unsafe
- [ ] Handle dirty working tree cases
- [ ] Handle branch already existing
- [ ] Handle detached HEAD
- [ ] Handle missing remote
- [ ] Handle authentication failures
- [ ] Add tests for command generation and safety rules

Exit criteria:

- [ ] Starting work on a task always lands the user in a correct repo/branch context

---

## 17. Session Startup Workflow

- [ ] Design the exact "open task session" sequence
- [ ] Decide whether create-task immediately creates branch/session or only on first open
- [ ] Implement startup steps:
  - [ ] resolve repo
  - [ ] resolve or create branch
  - [ ] resolve or create worktree if enabled
  - [ ] create logical session
  - [ ] create backend session
  - [ ] run bootstrap shell commands
  - [ ] expose attach metadata
  - [ ] open embedded pane in TUI
- [ ] Implement retry behavior for partially failed startup
- [ ] Roll back partial records on failure where appropriate
- [ ] Emit structured events for each step
- [ ] Add startup integration tests

Exit criteria:

- [ ] Opening a task is predictable and recoverable after partial failures

---

## 18. GitHub Integration (via `gh` CLI + `delta`)

- [ ] Detect `gh` availability in `doctor`; fail fast with install hint if absent
- [ ] Validate `gh auth status` output to confirm user is authenticated
- [ ] Associate repos with GitHub owner/repo metadata (derived from `git remote get-url origin`)
- [ ] Implement PR lookup: `gh pr view --json number,state,title,headRefName,isDraft,reviews,statusCheckRollup`
- [ ] Implement CI status lookup: parse `statusCheckRollup` from above
- [ ] Implement review state lookup: parse `reviews` from above
- [ ] Implement unresolved review thread count if included
- [ ] Implement diff view: `gh pr diff <number> | delta --no-pager` with `COLORTERM=truecolor`
- [ ] Detect `delta` availability in `doctor`; diff falls back to raw `gh pr diff` if absent
- [ ] Decide storage model for sync results
- [ ] Handle `gh` rate limit messages in stderr
- [ ] Handle missing repo metadata
- [ ] Handle branch not pushed yet
- [ ] Handle multiple PRs for same branch
- [ ] Decide v1 behavior for multiple PRs per task
- [ ] Add tests with mocked `gh` subprocess output

Exit criteria:

- [ ] Task cards accurately reflect PR/CI/review state after sync

---

## 19. Sync Orchestration

- [ ] Build `SyncService`
- [ ] Implement periodic polling
- [ ] Implement manual sync trigger
- [ ] Prevent overlapping sync runs
- [ ] Add per-repo and per-task sync batching
- [ ] Add jitter/backoff if needed
- [ ] Record sync run results
- [ ] Emit UI events for sync start/finish/failure
- [ ] Auto-move task from In Progress to Review on PR open
- [ ] Decide whether auto-move can be disabled
- [ ] Decide whether merged PR auto-moves task to Done
- [ ] Add tests for move rules and failure isolation

Exit criteria:

- [ ] Sync never corrupts task ordering or user selection

---

## 20. Event Log and Activity History

- [ ] Build append-only event store
- [ ] Record events for:
  - [ ] task creation
  - [ ] task rename
  - [ ] task move
  - [ ] pillar change
  - [ ] label change
  - [ ] session create/attach/terminate
  - [ ] sync results
  - [ ] errors and recoveries
- [ ] Add timestamps and actor/source metadata
- [ ] Define retention policy
- [ ] Add event query methods for recent activity feed
- [ ] Decide whether event log powers audit/debug only or user-facing timeline too
- [ ] Add tests for event completeness

Exit criteria:

- [ ] Important operational changes can be reconstructed after a failure

---

## 21. TUI Information Architecture

- [ ] Define top-level layout regions:
  - [ ] header
  - [ ] filter bar
  - [ ] board
  - [ ] terminal pane
  - [ ] status bar
  - [ ] modal layer
- [ ] Define focus model for:
  - [ ] board
  - [ ] terminal
  - [ ] filter bar
  - [ ] modal
  - [ ] search
- [ ] Define narrow-terminal responsive behavior
- [ ] Define "board-only" mode when terminal pane is hidden
- [ ] Define "global all repos" vs "single repo" visual treatment
- [ ] Define task card information hierarchy
- [ ] Define status bar information hierarchy
- [ ] Define empty states
- [ ] Define loading states
- [ ] Define error states
- [ ] Define help/legend overlay (rendered with marked-terminal for markdown formatting)
- [ ] Define confirmation modal patterns

Exit criteria:

- [ ] A new user can understand what is selected, filtered, running, and blocked without reading source code

---

## 22. TUI Theming, Icons, and Accessibility

- [ ] Choose the icon set for:
  - [ ] task selection
  - [ ] session live/idle/orphaned
  - [ ] PR state
  - [ ] CI state
  - [ ] review state
  - [ ] sync activity
  - [ ] pillar chips
  - [ ] focus target
- [ ] Define ASCII fallback icons for low-Unicode terminals
- [ ] Define theme tokens:
  - [ ] background areas
  - [ ] selected card
  - [ ] focused pane
  - [ ] track headers
  - [ ] chips and badges
  - [ ] warnings
  - [ ] errors
  - [ ] muted text
- [ ] Add `truecolor`, `256-color`, and monochrome mode support
- [ ] Detect terminal capabilities conservatively
- [ ] Ensure color contrast is readable
- [ ] Ensure status is understandable without color
- [ ] Add `?` legend page with icons/colors/keybindings
- [ ] Add tests or snapshots for theme rendering if feasible

Exit criteria:

- [ ] UI remains understandable in monochrome mode

---

## 23. Board UI

- [ ] Implement column rendering
- [ ] Implement task card rendering
- [ ] Show repo badge in global view
- [ ] Show pillar chip on card
- [ ] Show labels if space allows
- [ ] Show session indicator
- [ ] Show PR/CI/review badges
- [ ] Show short task id
- [ ] Highlight selected task
- [ ] Preserve selection after board refresh where possible
- [ ] Preserve column scroll position if needed
- [ ] Handle empty columns
- [ ] Handle large task counts
- [ ] Support task move left/right
- [ ] Support reorder within track
- [ ] Add rendering tests if feasible

Exit criteria:

- [ ] The board can be scanned quickly in both single-repo and all-repos modes

---

## 24. Filter Bar and Search UI

- [ ] Implement filter bar component
- [ ] Show active repo filter
- [ ] Show active pillar filters
- [ ] Show active label filters
- [ ] Show active status filters
- [ ] Show active saved view name
- [ ] Support keyboard-driven filter editing
- [ ] Support clearing all filters
- [ ] Implement search input
- [ ] Persist active filter state
- [ ] Add empty-results state
- [ ] Add tests for filter bar behavior

Exit criteria:

- [ ] User can isolate one epic/pillar in a few keystrokes

---

## 25. Modal and Command Flows

- [ ] Create task modal
- [ ] Rename task modal
- [ ] Delete/archive confirm modal
- [ ] Macro picker modal
- [ ] Pillar picker modal
- [ ] Label editor modal
- [ ] Saved view picker modal
- [ ] Repo picker / repo registration modal if desired
- [ ] Ensure modal focus capture is correct
- [ ] Ensure `Esc` behavior is consistent
- [ ] Ensure validation errors are visible and actionable

Exit criteria:

- [ ] All write actions are possible without leaving the keyboard

---

## 26. CLI Commands

### Core

- [ ] `agentboard`
- [ ] `agentboard init`
- [ ] `agentboard doctor`
- [ ] `agentboard status`
- [ ] `agentboard daemon start`
- [ ] `agentboard daemon stop`
- [ ] `agentboard daemon restart`

### Task / Session

- [ ] `agentboard ls`
- [ ] `agentboard attach <task>`
- [ ] `agentboard send <task> <command>`
- [ ] `agentboard open <task>`
- [ ] `agentboard archive <task>`

### Repo

- [ ] `agentboard repos add <path>`
- [ ] `agentboard repos ls`
- [ ] `agentboard repos rm <id>`
- [ ] `agentboard repos sync`

### Views

- [ ] `agentboard views ls`
- [ ] `agentboard views save`
- [ ] `agentboard views rm`

### Maintenance

- [ ] `agentboard sync`
- [ ] `agentboard gc`
- [ ] `agentboard logs`

For every command:

- [ ] define args
- [ ] define flags
- [ ] define exit codes
- [ ] define human-readable output
- [ ] define machine-readable JSON output where useful
- [ ] add tests

Exit criteria:

- [ ] Users can manage the workstation from shell scripts as well as the TUI

---

## 27. Persistence of UI State

- [ ] Persist last selected repo or global view
- [ ] Persist active saved view
- [ ] Persist ad hoc filters
- [ ] Persist selected track
- [ ] Persist selected task where safe
- [ ] Persist terminal pane visibility state
- [ ] Persist theme mode
- [ ] Restore state on next TUI open
- [ ] Handle missing/deleted selected entities on restore
- [ ] Add tests for restore behavior

Exit criteria:

- [ ] Reopening the app feels like returning to the same workstation, not starting over

---

## 28. Recovery, Reconcile, and Garbage Collection

- [ ] Define reconcile pass at daemon startup
- [ ] Reconcile DB sessions with tmux sessions
- [ ] Reconcile worktree paths with disk
- [ ] Reconcile registered repos with disk presence
- [ ] Mark missing resources clearly instead of silently dropping them
- [ ] Define orphan session behavior
- [ ] Define stale session timeout
- [ ] Implement `gc` command for safe cleanup
- [ ] Require confirmation for destructive cleanup
- [ ] Add dry-run mode for cleanup
- [ ] Add tests for reconcile and cleanup flows

Exit criteria:

- [ ] Crashes and manual shell interference do not leave the system in an unusable state

---

## 29. Error Handling and User Messaging

- [ ] Standardize error categories:
  - [ ] config
  - [ ] repo
  - [ ] git
  - [ ] tmux
  - [ ] session
  - [ ] GitHub
  - [ ] IPC
  - [ ] DB
- [ ] Create friendly error formatter for CLI
- [ ] Create user-facing error surfaces in TUI
- [ ] Ensure transient errors do not crash the UI
- [ ] Log stack traces to file, not only terminal
- [ ] Add recovery suggestions for common failures
- [ ] Add tests for major error cases

Exit criteria:

- [ ] Most operational failures tell the user what broke and what to do next

---

## 30. Doctor and Diagnostics

- [ ] Implement `doctor` checks for:
  - [ ] Node version
  - [ ] git presence
  - [ ] tmux presence
  - [ ] config validity
  - [ ] state directory permissions
  - [ ] DB accessibility
  - [ ] GitHub token presence
  - [ ] registered repo health
  - [ ] socket health
  - [ ] daemon running state
- [ ] Print pass/warn/fail summary
- [ ] Add JSON output mode
- [ ] Add remediation hints
- [ ] Add tests for doctor formatting and codes

Exit criteria:

- [ ] A user can diagnose installation/runtime problems without reading code

---

## 31. Logging and Observability

- [ ] Add structured logger
- [ ] Add log levels
- [ ] Log daemon startup/shutdown
- [ ] Log IPC requests at safe level
- [ ] Log session lifecycle
- [ ] Log sync runs
- [ ] Log reconcile results
- [ ] Redact secrets
- [ ] Add log rotation or truncation policy
- [ ] Add `agentboard logs` command

Exit criteria:

- [ ] Production issues can be debugged from logs without leaking credentials

---

## 32. Testing Strategy

### Unit

- [ ] config parsing
- [ ] path resolution
- [ ] DB CRUD
- [ ] ordering logic
- [ ] filters
- [ ] saved views
- [ ] RPC envelopes
- [ ] session manager logic
- [ ] tmux command builders
- [ ] sync rules

### Integration

- [ ] daemon start/stop
- [ ] CLI to daemon RPC
- [ ] create task through CLI/TUI service layer
- [ ] open task session
- [ ] reattach from another terminal invocation
- [ ] restore UI state after restart
- [ ] sync updates task state

### Snapshot / Rendering

- [ ] board layout
- [ ] task cards
- [ ] filter bar
- [ ] status bar
- [ ] monochrome mode

### Failure Cases

- [ ] missing tmux
- [ ] missing repo path
- [ ] broken config
- [ ] socket stale
- [ ] DB locked
- [ ] GitHub rate limit
- [ ] manually killed session

Exit criteria:

- [ ] Core workstation workflows are covered by automated tests

---

## 33. Documentation

- [ ] Rewrite README with product overview
- [ ] Add installation instructions
- [ ] Add first-run instructions
- [ ] Add dependency requirements
- [ ] Add configuration reference
- [ ] Add keyboard reference
- [ ] Add session model explanation
- [ ] Add pillars / labels / saved views explanation
- [ ] Add recovery / gc / doctor docs
- [ ] Add troubleshooting section
- [ ] Add architecture doc
- [ ] Add developer contribution doc

Exit criteria:

- [ ] A new user can install, configure, and operate the tool without source diving

---

## 34. Demo Recording (vhs)

- [ ] Install `vhs` and verify it works locally
- [ ] Write `demo/demo.tape` covering the golden path:
  - [ ] `agentboard init`
  - [ ] create a task
  - [ ] move it to In Progress
  - [ ] open a session
  - [ ] sync GitHub status
  - [ ] show PR badge update
- [ ] Commit `demo/demo.gif` as a generated artifact
- [ ] Add CI step to regenerate the GIF on release tags
- [ ] Verify GIF renders correctly in GitHub README

Exit criteria:

- [ ] `vhs demo/demo.tape` produces `demo/demo.gif` without errors
- [ ] README embeds the GIF and it plays on GitHub

---

## 36. Packaging and Release

- [ ] Define release artifact strategy
- [ ] Decide package manager distribution path
- [ ] Ensure native dependencies are handled cleanly
- [ ] Add version command
- [ ] Add changelog process
- [ ] Add tagged release workflow
- [ ] Smoke test release install on clean machine

Exit criteria:

- [ ] A user can install the tool without cloning the repo if that is part of the distribution goal

---

## 37. Explicit v1 Non-Goals or Deferred Items

Every deferred item must remain documented so it does not get accidentally half-built.

- [ ] Remote execution over SSH / Mutagen
- [ ] Mobile / push notifications
- [ ] Webhooks instead of polling
- [ ] Windows durable backend support
- [ ] Rich drag-and-drop UI beyond keyboard-first baseline
- [ ] Full alternate-screen terminal parity
- [ ] Browser integration / open PR links directly
- [ ] AI-generated planning inside the app itself

Exit criteria:

- [ ] Deferred items are clearly marked and not mixed into core v1 work

---

## 38. Final Acceptance Checklist

- [ ] User can launch `agentboard` from any terminal on the machine
- [ ] User can see all registered repos in one workspace
- [ ] User can create a task for any repo
- [ ] User can assign a pillar / epic to that task
- [ ] User can add labels
- [ ] User can filter by pillar only
- [ ] User can save that filter as a view
- [ ] User can open a durable session for the task
- [ ] User can quit the TUI and later re-open it
- [ ] User can attach to the same task session from a different terminal
- [ ] User can see PR/CI state after sync
- [ ] User can understand the UI through icons, colors, text labels, and help legend
- [ ] User can recover after a daemon restart or stale session situation
- [ ] User can run `doctor` and get actionable diagnostics
- [ ] User can run `gc` safely to clean stale artifacts
- [ ] Core flows are covered by automated tests
- [ ] README and config docs are complete

If any box above is unchecked, v1 is not done.
