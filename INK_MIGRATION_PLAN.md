# AgentBoard Ink Replacement Plan

Date: 2026-04-14

## Goal

Replace the current Ink + React TUI with a faster and more resilient terminal UI stack while keeping:

- the current product behavior
- the current visual design
- the current keyboard model
- the current daemon, DB, session, git, and sync logic

## Recommendation

Use Go with:

- `bubbletea` for the app event loop
- `lipgloss` for styling and layout
- `bubbles` only where it helps without changing the design

Do not do a full backend rewrite in the same phase.

The repo already has a clean migration seam:

- Ink is concentrated in the TUI layer
- core behavior lives in the daemon, services, DB, and RPC contract
- the terminal pane already depends on daemon-provided buffer snapshots, not on Ink internals

That means the lowest-risk path is:

1. keep the current TypeScript daemon and services
2. build a new Go Bubble Tea client against the existing socket RPC
3. cut over the default TUI
4. remove Ink
5. only then decide whether a Go backend rewrite is worth it

## Why Bubble Tea

Bubble Tea is the best fit here because it maps well to the app that already exists:

- explicit update loop instead of many React hooks and re-render paths
- strong control over key routing, resize handling, and redraw cadence
- good fit for long-lived event streams and background RPC subscriptions
- static binary for the TUI path
- Go concurrency is a clean fit for socket events, polling, and terminal input batching

## Why Not Rewrite Everything To Go First

That would mix two different migrations:

- replace the TUI framework
- replace the application backend

Doing both together makes parity much harder to verify and makes design drift more likely.

The current codebase already separates UI from core logic well enough:

- TUI bootstrap: `src/cli/index.ts`
- Ink UI layer: `src/ui/**`
- state reducer: `src/store/index.ts`
- backend/controller seam: `src/controller/index.ts`, `src/cli/rpc.ts`
- daemon + RPC server: `src/daemon/**`
- business logic: `src/services/**`
- shared domain contract: `src/types/index.ts`

Use that seam.

## What Must Stay The Same

These are the parity constraints for the migration.

### Behavior

- Task CRUD, task movement, repo switching, filters, saved views, archive/delete flows
- Session open/recreate/input/resize behavior
- Sync behavior, PR actions, merge gating, workspace actions
- Terminal focus, board focus, modal focus, filter/search behavior

### Design

- color palette and badge tones from `src/ui/chrome.tsx`
- card widths, title wrapping, and card height rules from `src/ui/TaskCard.tsx`
- track framing and board column layout from `src/ui/Track.tsx`
- terminal split math from `src/ui/terminal-layout.ts`
- status bar/header/filter bar visual hierarchy
- modal look, copy, and shortcut hints

### Logic

- DB schema and migrations in `src/db/**`
- daemon RPC semantics in `src/daemon/server.ts`
- session, git, sync, and board logic in `src/services/**`
- shared entities and payload shapes in `src/types/index.ts`
- terminal snapshot generation in `src/services/terminal-render.ts`

## Current Ink Footprint

Ink is currently concentrated in roughly 25 files:

- root app and layout shell
- board, track, task card, terminal pane
- header, filter bar, status bar, modal overlay
- 13 modal components
- terminal size hook

The default TUI entry path is still wired through:

- `src/cli/index.ts`
- `src/bin/agentboard.tsx`

This is large enough that a piecemeal file-by-file React refactor is not worth it. A parallel Go client is the cleaner cut.

## Target Architecture

Phase 1 target:

```text
Go Bubble Tea client
  -> Unix socket RPC client
  -> existing TypeScript daemon
  -> existing services / DB / session backends
```

Recommended Go layout:

```text
cmd/agentboard/main.go
internal/app/model.go
internal/app/update.go
internal/app/view.go
internal/app/keymap.go
internal/app/effects.go
internal/rpc/client.go
internal/rpc/messages.go
internal/theme/theme.go
internal/layout/layout.go
internal/widgets/header.go
internal/widgets/filterbar.go
internal/widgets/board.go
internal/widgets/track.go
internal/widgets/taskcard.go
internal/widgets/terminal.go
internal/widgets/statusbar.go
internal/widgets/modal_*.go
```

Important rule: Bubble Tea should replace Ink, not re-create a React-like component architecture in Go. Keep the Go code centered on:

- one model tree
- one update loop
- a small set of pure view helpers
- explicit commands for RPC and side effects

## Bubble Tea Design Rules

To preserve the current design and logic:

- Use custom renderers for board, track, task card, and terminal pane.
- Do not force the board into a generic list or table widget.
- Use `bubbles` only for things like text input or simple viewports if they do not change the rendered output.
- Keep key routing centralized, matching the current `useInput` logic in `src/ui/App.tsx`.
- Keep terminal pane rendering custom, because it has app-specific cursor injection, ANSI truncation, scrollback, and footer rules.

## Migration Phases

### Phase 0: Freeze Parity

Before writing Go UI code, freeze the current UI contract.

Work:

- write a feature parity checklist from the current TUI
- document every keybinding and focus mode
- capture reference screenshots or text snapshots for:
  - wide layout
  - narrow layout
  - stacked terminal layout
  - terminal fullscreen
  - every modal
  - empty states
  - busy session states
- record current startup time, idle CPU, and visible redraw issues so the migration is measured, not assumed

Exit criteria:

- there is a canonical parity doc
- there are baseline fixtures for visual and interaction comparison

### Phase 1: Freeze The RPC Contract

The main migration risk is TS/Go contract drift.

Work:

- document the request/response/event protocol used by `src/cli/rpc.ts` and `src/daemon/server.ts`
- freeze the payloads the Go client needs first:
  - `getBoard`
  - `setUIState`
  - task mutations
  - session open/recreate/send/resize
  - sync trigger
  - `inspectSession`
  - `prepareTaskWorkspace`
  - board patch events
  - session update events
  - sync status events
- add contract tests or JSON fixtures for representative daemon responses
- make reconnect and socket-close behavior explicit

Exit criteria:

- Go structs can be written against stable payloads
- daemon event behavior is documented and testable

### Phase 2: Build The Go Shell

Create a minimal Bubble Tea client that can:

- connect to the daemon
- fetch the board
- subscribe to events
- handle window resize
- quit cleanly
- display a placeholder shell with the same screen regions as the current app

Work:

- create the Go module and binary entrypoint
- add a socket RPC client with request/response and event subscription support
- model root app state:
  - board snapshot
  - UI focus
  - modal state
  - terminal buffer state
  - status message
  - current window size
  - spinner ticks
  - reconnect status

Exit criteria:

- the Go app can launch and stay connected to the existing daemon
- window size changes are reflected without breaking layout

### Phase 3: Port The Design System

Port the current visual system before porting every interaction.

Work:

- port `UI_CHROME` colors and badge tones from `src/ui/chrome.tsx`
- port layout constants from `src/ui/terminal-layout.ts`
- port task card sizing and title wrapping from `src/ui/TaskCard.tsx`
- port track border/selection treatment from `src/ui/Track.tsx`
- port header, filter bar, and status bar visual hierarchy

Implementation note:

- prefer pure functions that render strings from state
- keep all width math explicit
- do not rely on framework auto-layout where exact current widths matter

Exit criteria:

- board, cards, badges, and shell framing look materially identical to the current design

### Phase 4: Port Input And Focus Routing

The current app is mostly defined by its input model. Port that next.

Work:

- convert `src/ui/App.tsx` key routing into a Go keymap and state machine
- keep the same focus modes:
  - board
  - terminal
  - modal
  - filterbar
  - search if retained
- keep the same board navigation and action shortcuts
- keep the same terminal escape behavior
- keep the same quit, help, sync, repo switch, and command palette shortcuts

Implementation note:

- model this as reducer-style update functions, not ad hoc per-widget handlers

Exit criteria:

- board navigation and major shortcuts behave the same as the current app

### Phase 5: Port Modals One By One

Modals are small enough to port incrementally but numerous enough to drift if done casually.

Port in this order:

1. help
2. command palette
3. create task
4. rename task
5. task description
6. archive confirm
7. delete confirm
8. create pillar
9. delete pillar confirm
10. pillar picker
11. filter options
12. view options
13. saved view picker / macro picker if still active in product scope

Rules:

- keep modal copy identical unless intentionally changed
- keep key hints identical
- keep submit/cancel behavior identical
- keep modal stacking rules explicit

Exit criteria:

- all current modal flows work from the Go client

### Phase 6: Port The Terminal Pane Carefully

This is the part most likely to regress.

Keep these current semantics:

- daemon remains the source of truth for terminal buffer snapshots
- cursor injection behavior remains consistent
- ANSI and plain line truncation behavior remains consistent
- scrollback behavior remains consistent
- resize calls still flow to the daemon
- terminal input batching and sync-after-push behavior remain consistent

Work:

- port the pane shell from `src/ui/TerminalPane.tsx`
- port scroll math and footer behavior
- port the input batching logic currently in `src/ui/App.tsx`
- isolate terminal repaint logic so polling or session inspection does not visibly redraw unrelated board regions

Implementation note:

- do not embed a brand-new terminal emulator in the Go client in phase 1
- keep the current daemon snapshot model and only replace the front-end renderer

Exit criteria:

- open session, send input, resize, scroll, and return-to-board flows match the current app

### Phase 7: Shadow Mode And Parity Testing

Run both UIs against the same daemon until parity is credible.

Work:

- add a temporary selector such as `--ui=ink|go` or `AGENTBOARD_UI=go`
- run the same manual checklist against both UIs
- compare reference states and screen fixtures
- add integration tests for:
  - create task
  - rename task
  - open session
  - terminal focus and escape
  - filter changes
  - sync trigger
  - PR open and merge actions
  - modal cancel/confirm flows

Exit criteria:

- the Go UI is feature-complete for the current daily workflow
- parity gaps are explicitly accepted or fixed

### Phase 8: Cut Over And Remove Ink

Once the Go client is proven:

- switch the default `agentboard` TUI path to the Go binary
- keep the existing TypeScript daemon and non-TUI CLI commands
- remove the Ink render path from `src/cli/index.ts`
- delete `src/ui/**` after the fallback window closes
- remove `ink` and `react` from runtime dependencies if they are no longer needed elsewhere

Exit criteria:

- there is no production Ink dependency on the TUI path
- the default UI is Bubble Tea

### Phase 9: Optional Backend Consolidation

Only do this after the UI replacement is stable.

Possible goal:

- move daemon, RPC server, DB access, git integration, and session management to Go for a fully Go product

This is optional. The UI migration should not depend on it.

## File Mapping

Suggested mapping from current code to new Go code:

| Current file(s) | New ownership |
| --- | --- |
| `src/cli/index.ts` TUI action | `cmd/agentboard/main.go` |
| `src/controller/index.ts` | `internal/app/effects.go` plus `internal/rpc/client.go` |
| `src/store/index.ts`, `src/store/terminal-buffer.ts` | `internal/app/model.go` and reducer-style update helpers |
| `src/ui/App.tsx` | `internal/app/model.go`, `update.go`, `view.go`, `keymap.go` |
| `src/ui/chrome.tsx` | `internal/theme/theme.go` |
| `src/ui/Board.tsx`, `Track.tsx`, `TaskCard.tsx` | `internal/widgets/board.go`, `track.go`, `taskcard.go` |
| `src/ui/TerminalPane.tsx`, `src/ui/terminal-layout.ts` | `internal/widgets/terminal.go`, `internal/layout/layout.go` |
| `src/ui/Header.tsx`, `FilterBar.tsx`, `StatusBar.tsx` | `internal/widgets/header.go`, `filterbar.go`, `statusbar.go` |
| `src/ui/modals/*` | `internal/widgets/modal_*.go` |
| `src/ui/use-terminal-size.ts` | Bubble Tea `WindowSizeMsg` handling |
| `src/cli/rpc.ts` | `internal/rpc/client.go` |
| `src/services/terminal-render.ts` | stays in TypeScript in phase 1 |

## Risks And Mitigations

### Risk: Contract drift between TypeScript and Go

Mitigation:

- freeze payloads early
- add fixture-based contract tests
- keep the Go client focused on the existing RPC contract first

### Risk: terminal rendering looks almost right but not actually identical

Mitigation:

- capture golden terminal states
- test ANSI truncation, cursor injection, narrow widths, and scroll offsets explicitly

### Risk: key handling regresses in terminal mode

Mitigation:

- port the current mapping literally first
- verify control keys, arrows, page up/down, tab, enter, and escape before refactoring

### Risk: packaging becomes messy because the UI is Go and the daemon is Node

Mitigation:

- accept this temporarily
- keep the cutover focused on the UI
- decide later whether to ship a standalone Go binary, an npm wrapper with embedded binaries, or a full Go product

### Risk: Bubble Tea still does not eliminate enough flicker for the terminal pane

Mitigation:

- keep app logic and rendering separated
- if needed later, swap only the render layer for a lower-level Go terminal renderer without redoing the app model

## Acceptance Criteria

The migration is done when:

- the default TUI no longer uses Ink
- the current design language is preserved
- the current keybindings and modal flows are preserved
- the current daemon and service logic remain unchanged in phase 1
- session and terminal behavior match current behavior
- measured startup and idle behavior are at least as good as the current app, and visible redraw issues are reduced

## Practical Recommendation

If the goal is "replace all Ink but keep the product the same", the correct order is:

1. freeze parity
2. keep the TypeScript daemon
3. build a Go Bubble Tea client over the existing RPC seam
4. cut over only after parity testing
5. remove Ink

Do not start with a full Go rewrite of services, DB, sync, and session backends. That will slow the migration down and make "keep design and logic" much harder to achieve.
