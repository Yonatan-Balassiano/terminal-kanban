package tui

import (
	"errors"
	"fmt"
	"testing"
)

func doneCardModel(sessionID string, backendSessionID string) *Model {
	return &Model{
		activeTaskID: "task-1",
		tasks: []TaskRecord{
			{ID: "task-1", Title: "Merged card", RepoID: "repo-1", TrackID: "done", SessionID: sessionID},
		},
		tracks: []TrackRecord{
			{ID: "backlog", SortOrder: 1},
			{ID: "done", SortOrder: 2},
		},
		activeSessionBackendType:      SessionBackendTmux,
		activeSessionBackendSessionID: backendSessionID,
	}
}

func TestTerminalReattachSessionIDReturnsLiveTmuxSession(t *testing.T) {
	model := doneCardModel("session-1", "agentboard-task-1")

	got := model.terminalReattachSessionID(&model.tasks[0], SessionSlotPrimary)

	if got != "agentboard-task-1" {
		t.Fatalf("terminalReattachSessionID() = %q, want the live backend session", got)
	}
}

// Reaching done releases the session and its worktree, but the backend id stays
// in the model. Attaching to it fails only after tearing the visible pane down,
// which is what leaves a closed card with no shell and no way back to one.
func TestTerminalReattachSessionIDRefusesAReleasedSession(t *testing.T) {
	model := doneCardModel("", "agentboard-task-1")

	got := model.terminalReattachSessionID(&model.tasks[0], SessionSlotPrimary)

	if got != "" {
		t.Fatalf("terminalReattachSessionID() = %q, want no re-attach for a released session", got)
	}
}

func TestTerminalReattachSessionIDRefusesACardThatIsNotActive(t *testing.T) {
	model := doneCardModel("session-1", "agentboard-task-1")
	model.activeTaskID = "task-2"

	got := model.terminalReattachSessionID(&model.tasks[0], SessionSlotPrimary)

	if got != "" {
		t.Fatalf("terminalReattachSessionID() = %q, want no re-attach for an inactive card", got)
	}
}

func TestTerminalReattachSessionIDRefusesAnEmbeddedBackend(t *testing.T) {
	model := doneCardModel("session-1", "agentboard-task-1")
	model.activeSessionBackendType = SessionBackendPty

	got := model.terminalReattachSessionID(&model.tasks[0], SessionSlotPrimary)

	if got != "" {
		t.Fatalf("terminalReattachSessionID() = %q, want no tmux re-attach for a PTY session", got)
	}
}

// The board is the authority on whether a session still exists, so a patch that
// drops it has to drop the pane metadata with it — otherwise the next attach
// chases a pane that is already gone.
func TestApplyBoardDropsTerminalStateOfAReleasedSession(t *testing.T) {
	model := doneCardModel("session-1", "agentboard-task-1")
	model.setTerminalBuffer(SessionSlotPrimary, GetBufferResult{Lines: []string{"old output"}})

	model.applyBoard(BoardSnapshot{
		Tracks: model.tracks,
		Tasks: []TaskRecord{
			{ID: "task-1", Title: "Merged card", RepoID: "repo-1", TrackID: "done"},
		},
	})

	if got := model.terminalBackendSessionIDForSlot(SessionSlotPrimary); got != "" {
		t.Fatalf("backend session id = %q, want it cleared once the board released the session", got)
	}
	if lines := model.terminalBufferForSlot(SessionSlotPrimary).Lines; len(lines) != 0 {
		t.Fatalf("buffer = %v, want the released session's output cleared", lines)
	}
	if model.activeTaskID != "task-1" {
		t.Fatalf("activeTaskID = %q, want the card to stay active so it can be reopened", model.activeTaskID)
	}
}

func TestApplyBoardKeepsTerminalStateOfALiveSession(t *testing.T) {
	model := doneCardModel("session-1", "agentboard-task-1")

	model.applyBoard(BoardSnapshot{
		Tracks: model.tracks,
		Tasks:  model.tasks,
	})

	if got := model.terminalBackendSessionIDForSlot(SessionSlotPrimary); got != "agentboard-task-1" {
		t.Fatalf("backend session id = %q, want the live session kept", got)
	}
}

// A pane can also vanish under the TUI without the board noticing — a tmux
// session killed by hand. Reopening beats leaving the card unreachable.
func TestTmuxAttachFailureReopensTheSession(t *testing.T) {
	model := doneCardModel("session-1", "agentboard-task-1")

	updated, cmd := model.Update(tmuxPaneAttachedMsg{
		taskID: "task-1",
		slot:   SessionSlotPrimary,
		err:    fmt.Errorf("%w: agentboard-task-1", errTmuxTaskPaneNotFound),
	})

	next := updated.(*Model)
	if cmd == nil {
		t.Fatal("Update() returned no command, want the session reopened")
	}
	if got := next.terminalBackendSessionIDForSlot(SessionSlotPrimary); got != "" {
		t.Fatalf("backend session id = %q, want the dead pane's id cleared", got)
	}
	if next.statusMessage == "" {
		t.Fatal("statusMessage is empty, want the reopen explained")
	}
}

func TestTmuxAttachFailureOutsideTmuxIsReported(t *testing.T) {
	model := doneCardModel("session-1", "agentboard-task-1")
	failure := errors.New("not inside tmux; run agentboard from its managed tmux layout")

	updated, cmd := model.Update(tmuxPaneAttachedMsg{taskID: "task-1", slot: SessionSlotPrimary, err: failure})

	next := updated.(*Model)
	if cmd != nil {
		t.Fatal("Update() returned a command, want no reopen when tmux itself is unavailable")
	}
	if next.statusMessage != failure.Error() {
		t.Fatalf("statusMessage = %q, want %q", next.statusMessage, failure.Error())
	}
}
