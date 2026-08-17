package tui

import (
	"errors"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

var errTeleportProbe = errors.New("remote host went away")

func TestTeleportDirectionForFollowsTaskLocation(t *testing.T) {
	local := &TaskRecord{Location: TaskLocationLocal}
	if got := teleportDirectionFor(local); got != TeleportDirectionLocalToRemote {
		t.Fatalf("direction for local task = %q, want %q", got, TeleportDirectionLocalToRemote)
	}

	remote := &TaskRecord{Location: TaskLocationRemote}
	if got := teleportDirectionFor(remote); got != TeleportDirectionRemoteToLocal {
		t.Fatalf("direction for remote task = %q, want %q", got, TeleportDirectionRemoteToLocal)
	}
}

func TestTeleportBlockedOnlyOnFailingCheck(t *testing.T) {
	if teleportBlocked(nil) {
		t.Fatal("no checks should never block")
	}
	if teleportBlocked([]DoctorCheck{{Status: "pass"}, {Status: "warn"}}) {
		t.Fatal("pass/warn checks should not block")
	}
	if !teleportBlocked([]DoctorCheck{{Status: "pass"}, {Status: "fail"}}) {
		t.Fatal("a fail check should block")
	}
}

func TestOpenTeleportModalCapturesDirectionAndStartsLoading(t *testing.T) {
	model := &Model{
		tasks: []TaskRecord{{ID: "task-1", Title: "Ship it", Kind: TaskKindRepo, Location: TaskLocationLocal}},
	}

	cmd := model.openTeleportModal(model.taskByID("task-1"))

	if model.modal != ModalTeleportConfirm {
		t.Fatalf("modal = %q, want %q", model.modal, ModalTeleportConfirm)
	}
	if model.focus != FocusModal {
		t.Fatalf("focus = %q, want %q", model.focus, FocusModal)
	}
	state := model.teleportConfirmModal
	if state == nil {
		t.Fatal("teleportConfirmModal = nil, want state")
	}
	if state.TaskID != "task-1" || state.Direction != TeleportDirectionLocalToRemote || !state.Loading {
		t.Fatalf("state = %+v, want TaskID=task-1 Direction=%s Loading=true", state, TeleportDirectionLocalToRemote)
	}
	if cmd == nil {
		t.Fatal("openTeleportModal returned a nil cmd, want the preflight fetch")
	}
}

func TestOpenTeleportModalRefusesGeneralTasks(t *testing.T) {
	model := &Model{}
	task := &TaskRecord{ID: "task-1", Kind: TaskKindGeneral}

	if cmd := model.openTeleportModal(task); cmd != nil {
		t.Fatal("expected a nil cmd for a general task")
	}
	if model.modal == ModalTeleportConfirm {
		t.Fatal("a general task must not open the teleport modal")
	}
}

func TestHandleTeleportConfirmModalKeyEscCloses(t *testing.T) {
	model := &Model{
		modal:                ModalTeleportConfirm,
		focus:                FocusModal,
		teleportConfirmModal: &teleportConfirmModalState{TaskID: "task-1", Direction: TeleportDirectionLocalToRemote},
	}

	model.handleTeleportConfirmModalKey(tea.KeyMsg{Type: tea.KeyEsc})

	if model.modal != ModalNone {
		t.Fatalf("modal = %q, want closed", model.modal)
	}
	if model.teleportConfirmModal != nil {
		t.Fatal("teleportConfirmModal should be cleared after Esc")
	}
}

func TestHandleTeleportConfirmModalKeyRefusesYWhileLoading(t *testing.T) {
	model := &Model{
		modal: ModalTeleportConfirm,
		teleportConfirmModal: &teleportConfirmModalState{
			TaskID: "task-1", Direction: TeleportDirectionLocalToRemote, Loading: true,
		},
	}

	cmd := model.handleTeleportConfirmModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})

	if cmd != nil {
		t.Fatal("confirming while still loading must not fire the teleport")
	}
	if model.modal != ModalTeleportConfirm {
		t.Fatal("modal should stay open while loading")
	}
}

func TestHandleTeleportConfirmModalKeyRefusesYWhenBlocked(t *testing.T) {
	model := &Model{
		modal: ModalTeleportConfirm,
		teleportConfirmModal: &teleportConfirmModalState{
			TaskID: "task-1", Direction: TeleportDirectionLocalToRemote,
			Checks: []DoctorCheck{{Name: "remote:ssh", Status: "fail", Message: "unreachable"}},
		},
	}

	cmd := model.handleTeleportConfirmModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})

	if cmd != nil {
		t.Fatal("confirming a blocked teleport must not fire the RPC")
	}
	if model.modal != ModalTeleportConfirm {
		t.Fatal("modal should stay open so the user can read why it's blocked")
	}
}

func TestHandleTeleportConfirmModalKeyConfirmsWhenClear(t *testing.T) {
	model := &Model{
		modal: ModalTeleportConfirm,
		teleportConfirmModal: &teleportConfirmModalState{
			TaskID: "task-1", Direction: TeleportDirectionLocalToRemote,
			Checks: []DoctorCheck{{Name: "remote:ssh", Status: "pass", Message: "ok"}},
		},
	}

	cmd := model.handleTeleportConfirmModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})

	if cmd == nil {
		t.Fatal("a clear preflight should fire the teleport cmd")
	}
	if model.modal != ModalNone {
		t.Fatal("the modal should close immediately once confirmed")
	}
}

func TestUpdateTeleportPreflightLoadedMsgIgnoresStaleReply(t *testing.T) {
	model := &Model{
		teleportConfirmModal: &teleportConfirmModalState{
			TaskID: "task-1", Direction: TeleportDirectionLocalToRemote, Loading: true,
		},
	}

	// A reply for a different task/direction than what is currently open — the
	// user moved to another card, or reopened for the other direction, while
	// the first fetch was still in flight.
	model.Update(teleportPreflightLoadedMsg{taskID: "task-2", direction: TeleportDirectionLocalToRemote})

	if !model.teleportConfirmModal.Loading {
		t.Fatal("a stale reply must not clear Loading for the still-open modal")
	}
}

func TestUpdateTeleportPreflightLoadedMsgAppliesMatchingReply(t *testing.T) {
	model := &Model{
		teleportConfirmModal: &teleportConfirmModalState{
			TaskID: "task-1", Direction: TeleportDirectionLocalToRemote, Loading: true,
		},
	}

	checks := []DoctorCheck{{Name: "remote:ssh", Status: "pass", Message: "ok"}}
	model.Update(teleportPreflightLoadedMsg{taskID: "task-1", direction: TeleportDirectionLocalToRemote, checks: checks})

	if model.teleportConfirmModal.Loading {
		t.Fatal("a matching reply should clear Loading")
	}
	if len(model.teleportConfirmModal.Checks) != 1 {
		t.Fatalf("Checks = %v, want the fetched checks", model.teleportConfirmModal.Checks)
	}
}

func TestTeleportedMsgReattachesTheOpenTerminalPane(t *testing.T) {
	// Regression: a teleport that succeeds but never reattaches leaves the
	// terminal pane pointed at the backend session teleport just killed — the
	// board card updates, but "the session" on screen never does.
	model := &Model{
		activeTaskID: "task-1",
		tasks:        []TaskRecord{{ID: "task-1", Title: "Ship it"}},
	}

	board := &BoardSnapshot{Tasks: []TaskRecord{{ID: "task-1", Title: "Ship it", Location: TaskLocationRemote}}}
	_, cmd := model.Update(teleportedMsg{taskID: "task-1", direction: TeleportDirectionLocalToRemote, board: board})

	if cmd == nil {
		t.Fatal("expected a batched cmd that reattaches the terminal pane")
	}
	if model.statusMessage != "Teleported to remote." {
		t.Fatalf("statusMessage = %q, want %q", model.statusMessage, "Teleported to remote.")
	}
	if len(model.tasks) != 1 || model.tasks[0].Location != TaskLocationRemote {
		t.Fatalf("board was not applied: tasks = %+v", model.tasks)
	}
}

func TestTeleportedMsgLeavesAnUnopenedCardAlone(t *testing.T) {
	model := &Model{
		activeTaskID: "task-other",
		tasks:        []TaskRecord{{ID: "task-1", Title: "Ship it"}, {ID: "task-other", Title: "Unrelated"}},
	}

	// task-other stays in the board too — otherwise applyBoard's own "active
	// task vanished" pruning would clear activeTaskID for an unrelated reason,
	// and this test would pass without ever exercising the teleport guard.
	board := &BoardSnapshot{Tasks: []TaskRecord{
		{ID: "task-1", Title: "Ship it", Location: TaskLocationRemote},
		{ID: "task-other", Title: "Unrelated"},
	}}
	model.Update(teleportedMsg{taskID: "task-1", direction: TeleportDirectionLocalToRemote, board: board})

	if model.activeTaskID != "task-other" {
		t.Fatalf("activeTaskID changed to %q, want it left alone at task-other", model.activeTaskID)
	}
}

func TestTeleportedMsgSurfacesErrorWithoutTouchingTheBoard(t *testing.T) {
	model := &Model{
		activeTaskID: "task-1",
		tasks:        []TaskRecord{{ID: "task-1", Title: "Ship it", Location: TaskLocationLocal}},
	}

	model.Update(teleportedMsg{taskID: "task-1", direction: TeleportDirectionLocalToRemote, err: errTeleportProbe})

	if model.statusMessage != errTeleportProbe.Error() {
		t.Fatalf("statusMessage = %q, want the error text", model.statusMessage)
	}
	if model.tasks[0].Location != TaskLocationLocal {
		t.Fatal("a failed teleport must not touch the board")
	}
}

func TestRPCTimeoutForTeleport(t *testing.T) {
	if got := rpcTimeout("teleportTask"); got != 120*time.Second {
		t.Fatalf("teleportTask timeout = %v, want %v", got, 120*time.Second)
	}
	if got := rpcTimeout("teleportTaskPreflight"); got != 20*time.Second {
		t.Fatalf("teleportTaskPreflight timeout = %v, want %v", got, 20*time.Second)
	}
}
