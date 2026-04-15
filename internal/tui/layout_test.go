package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

func TestBoardRenderWidthMatchesRenderedTrackColumns(t *testing.T) {
	model := &Model{
		tracks: []TrackRecord{
			{ID: "backlog", SortOrder: 1},
			{ID: "in-progress", SortOrder: 2},
			{ID: "pr", SortOrder: 3},
			{ID: "done", SortOrder: 4},
		},
	}

	got := model.boardRenderWidth()
	want := 4 * trackColumnRenderWidth
	if got != want {
		t.Fatalf("boardRenderWidth() = %d, want %d", got, want)
	}
}

func TestTerminalContentWidthUsesRenderedBoardWidth(t *testing.T) {
	model := &Model{
		width:               180,
		terminalPaneVisible: true,
		activeTaskID:        "task-1",
		tracks: []TrackRecord{
			{ID: "backlog", SortOrder: 1},
			{ID: "in-progress", SortOrder: 2},
			{ID: "pr", SortOrder: 3},
			{ID: "done", SortOrder: 4},
		},
	}

	got := model.terminalContentWidth()
	want := 180 - (4 * trackColumnRenderWidth) - terminalDividerWidth
	if got != want {
		t.Fatalf("terminalContentWidth() = %d, want %d", got, want)
	}
}

func TestRenderVerticalDividerStaysSingleColumn(t *testing.T) {
	divider := renderVerticalDivider(6)

	if got := lipgloss.Width(divider); got != 1 {
		t.Fatalf("divider width = %d, want 1", got)
	}
	if got := lipgloss.Height(divider); got != 6 {
		t.Fatalf("divider height = %d, want 6", got)
	}
}

func TestTaskCardFitsTrackContentWidth(t *testing.T) {
	card := renderTaskCard(
		&Model{},
		TaskRecord{
			ID:          "3895d59d",
			Title:       "things that we needed to do with the current situation",
			Description: "Need to have a chat with the team",
			UpdatedAt:   1,
		},
		true,
		false,
		nil,
		"web5.0-poc",
	)

	if got := lipgloss.Width(card); got != trackColumnStyleWidth {
		t.Fatalf("task card width = %d, want %d", got, trackColumnStyleWidth)
	}
}

func TestSelectedTaskIgnoresActiveSessionContext(t *testing.T) {
	model := &Model{
		activeTaskID:       "active-task",
		selectedTrackIndex: 0,
		selectedTaskIndex:  1,
		tracks: []TrackRecord{
			{ID: "in-progress", SortOrder: 1},
		},
		tasks: []TaskRecord{
			{ID: "active-task", TrackID: "in-progress", SortKey: 1, Title: "Active"},
			{ID: "selected-task", TrackID: "in-progress", SortKey: 2, Title: "Selected"},
		},
	}

	selected := model.selectedTask()
	if selected == nil || selected.ID != "selected-task" {
		t.Fatalf("selectedTask() = %#v, want selected-task", selected)
	}

	context := model.contextTask()
	if context == nil || context.ID != "active-task" {
		t.Fatalf("contextTask() = %#v, want active-task", context)
	}
}

func TestHeaderStatusModelUsesSpinnerForBusySession(t *testing.T) {
	model := &Model{spinnerIndex: 3}

	status := headerStatusModel(
		model,
		TaskRecord{ID: "task-1", SessionID: "session-1"},
		&SessionActivitySnapshot{
			TaskID: "task-1",
			IsBusy: true,
			Label:  "syncing",
		},
		true,
	)

	if status.Icon != spinnerFrames[3] {
		t.Fatalf("headerStatusModel() icon = %q, want %q", status.Icon, spinnerFrames[3])
	}
	if status.Color != uiChrome.Warning {
		t.Fatalf("headerStatusModel() color = %q, want %q", status.Color, uiChrome.Warning)
	}
}

func TestSessionBadgeModelUsesAttentionState(t *testing.T) {
	label, tone, spinning, icon := sessionBadgeModel(
		TaskRecord{ID: "task-1", SessionID: "session-1", SessionAttentionNeeded: true},
		nil,
		true,
	)

	if label != "attention" {
		t.Fatalf("sessionBadgeModel() label = %q, want attention", label)
	}
	if tone != "info" {
		t.Fatalf("sessionBadgeModel() tone = %q, want info", tone)
	}
	if spinning {
		t.Fatal("sessionBadgeModel() spinning = true, want false")
	}
	if icon != "!" {
		t.Fatalf("sessionBadgeModel() icon = %q, want !", icon)
	}
}

func TestRenderHeaderShowsAttentionCounter(t *testing.T) {
	model := &Model{
		width: 120,
		tasks: []TaskRecord{
			{ID: "task-1", SessionAttentionNeeded: true},
			{ID: "task-2"},
		},
		daemonConnected: true,
	}

	plain := ansiPattern.ReplaceAllString(renderHeader(model), "")
	if !strings.Contains(plain, "1 attention") {
		t.Fatalf("renderHeader() = %q, want attention counter", plain)
	}
}

func TestRenderStatusBarShowsAttentionBadge(t *testing.T) {
	model := &Model{
		width:              120,
		focus:              FocusBoard,
		selectedTrackIndex: 0,
		selectedTaskIndex:  0,
		tracks:             []TrackRecord{{ID: "in-progress", SortOrder: 1}},
		tasks: []TaskRecord{
			{
				ID:                     "task-1",
				TrackID:                "in-progress",
				SortKey:                1,
				Title:                  "Review output",
				SessionAttentionNeeded: true,
			},
		},
	}

	plain := ansiPattern.ReplaceAllString(renderStatusBar(model), "")
	if !strings.Contains(plain, "attention") {
		t.Fatalf("renderStatusBar() = %q, want attention badge", plain)
	}
}

func TestGitHubStatusBadgeModelBuildPassApproved(t *testing.T) {
	prNumber := 39
	badge := githubStatusBadgeModel(TaskRecord{
		PRNumber:         &prNumber,
		PRState:          "open",
		CIState:          "passed",
		CIRequiredTotal:  5,
		CIRequiredPassed: 5,
		ReviewState:      "approved",
	})

	if badge == nil {
		t.Fatal("githubStatusBadgeModel() = nil, want badge")
	}
	if badge.Label != "build 5/5·approved·#39" {
		t.Fatalf("githubStatusBadgeModel() label = %q", badge.Label)
	}
	if badge.Tone != "success" {
		t.Fatalf("githubStatusBadgeModel() tone = %q, want success", badge.Tone)
	}
}

func TestGitHubStatusBadgeModelBuildFailChangesRequested(t *testing.T) {
	prNumber := 41
	badge := githubStatusBadgeModel(TaskRecord{
		PRNumber:         &prNumber,
		PRState:          "open",
		CIState:          "failed",
		CIRequiredTotal:  5,
		CIRequiredPassed: 4,
		CIRequiredFailed: 1,
		ReviewState:      "changes_requested",
	})

	if badge == nil {
		t.Fatal("githubStatusBadgeModel() = nil, want badge")
	}
	if badge.Label != "build 4/5 fail·changes req·#41" {
		t.Fatalf("githubStatusBadgeModel() label = %q", badge.Label)
	}
	if badge.Tone != "danger" {
		t.Fatalf("githubStatusBadgeModel() tone = %q, want danger", badge.Tone)
	}
}

func TestGitHubStatusBadgeModelDraftPending(t *testing.T) {
	prNumber := 52
	badge := githubStatusBadgeModel(TaskRecord{
		PRNumber:          &prNumber,
		PRState:           "draft",
		PRDraft:           true,
		CIState:           "pending",
		CIRequiredTotal:   5,
		CIRequiredPassed:  4,
		CIRequiredPending: 1,
	})

	if badge == nil {
		t.Fatal("githubStatusBadgeModel() = nil, want badge")
	}
	if badge.Label != "build 4/5·draft·#52" {
		t.Fatalf("githubStatusBadgeModel() label = %q", badge.Label)
	}
	if badge.Tone != "warning" {
		t.Fatalf("githubStatusBadgeModel() tone = %q, want warning", badge.Tone)
	}
}

func TestGitHubStatusBadgeModelSyncErrorWithoutPR(t *testing.T) {
	badge := githubStatusBadgeModel(TaskRecord{
		GitHubSyncStatus: "error",
	})

	if badge == nil {
		t.Fatal("githubStatusBadgeModel() = nil, want badge")
	}
	if badge.Label != "sync error" {
		t.Fatalf("githubStatusBadgeModel() label = %q", badge.Label)
	}
	if badge.Tone != "danger" {
		t.Fatalf("githubStatusBadgeModel() tone = %q, want danger", badge.Tone)
	}
}

func TestCreateTaskPRCmdSetsProgressMessage(t *testing.T) {
	model := &Model{}

	cmd := model.createTaskPRCmd(&TaskRecord{ID: "task-1"})

	if cmd == nil {
		t.Fatal("createTaskPRCmd() = nil, want command")
	}
	if model.statusMessage != "PR creation in progress..." {
		t.Fatalf("statusMessage = %q, want PR creation in progress...", model.statusMessage)
	}
}

func TestRetryPushedBranchPRCreationCmdRequiresBranch(t *testing.T) {
	model := &Model{}

	cmd := model.retryPushedBranchPRCreationCmd(&TaskRecord{ID: "task-1"})

	if cmd != nil {
		t.Fatal("retryPushedBranchPRCreationCmd() returned command without a branch")
	}
	if model.statusMessage != "Selected task has no branch to watch for PR creation." {
		t.Fatalf("statusMessage = %q", model.statusMessage)
	}
}

func TestRetryPushedBranchPRCreationCmdSetsProgressMessage(t *testing.T) {
	model := &Model{}

	cmd := model.retryPushedBranchPRCreationCmd(&TaskRecord{ID: "task-1", BranchName: "feature/task-1"})

	if cmd == nil {
		t.Fatal("retryPushedBranchPRCreationCmd() = nil, want command")
	}
	if model.statusMessage != "PR creation in progress..." {
		t.Fatalf("statusMessage = %q, want PR creation in progress...", model.statusMessage)
	}
}

func TestMergeTaskPRCmdSetsProgressMessage(t *testing.T) {
	model := &Model{}
	prNumber := 24

	cmd := model.mergeTaskPRCmd(&TaskRecord{
		ID:          "task-1",
		PRNumber:    &prNumber,
		PRState:     "open",
		CIState:     "passed",
		ReviewState: "approved",
	})

	if cmd == nil {
		t.Fatal("mergeTaskPRCmd() = nil, want command")
	}
	if model.statusMessage != "Merge in progress..." {
		t.Fatalf("statusMessage = %q, want Merge in progress...", model.statusMessage)
	}
}

func TestTaskCardBorderColorTreatsChangesRequestedAsRed(t *testing.T) {
	color := taskCardBorderColor(TaskRecord{
		PRState:     "open",
		CIState:     "passed",
		ReviewState: "changes_requested",
	}, false)

	if color != "#ef4444" {
		t.Fatalf("taskCardBorderColor() = %q, want #ef4444", color)
	}
}

func TestTaskCardBorderColorUsesBlueForAttention(t *testing.T) {
	if color := taskCardBorderColor(TaskRecord{
		SessionAttentionNeeded: true,
	}, false); color != "#3b82f6" {
		t.Fatalf("taskCardBorderColor() = %q, want #3b82f6", color)
	}
	if color := taskCardBorderColor(TaskRecord{
		SessionAttentionNeeded: true,
	}, true); color != uiChrome.Blue {
		t.Fatalf("taskCardBorderColor() = %q, want %q", color, uiChrome.Blue)
	}
}

func TestTaskCardBorderColorKeepsCIStateWhenSelected(t *testing.T) {
	color := taskCardBorderColor(TaskRecord{
		PRState: "open",
		CIState: "pending",
	}, true)

	if color != uiChrome.Warning {
		t.Fatalf("taskCardBorderColor() = %q, want %q", color, uiChrome.Warning)
	}
}

func TestTaskCardBorderColorUsesStrongGreenForPassingBuild(t *testing.T) {
	color := taskCardBorderColor(TaskRecord{
		PRState: "open",
		CIState: "passed",
	}, false)

	if color != "#22c55e" {
		t.Fatalf("taskCardBorderColor() = %q, want #22c55e", color)
	}
}

func TestTaskCardBorderColorUsesBrighterNeutralWhenNoStatusApplies(t *testing.T) {
	color := taskCardBorderColor(TaskRecord{}, false)

	if color != "#475569" {
		t.Fatalf("taskCardBorderColor() = %q, want #475569", color)
	}
}

func TestTaskCardBorderColorUsesAccentForSelectedNeutralCard(t *testing.T) {
	color := taskCardBorderColor(TaskRecord{}, true)

	if color != uiChrome.Accent {
		t.Fatalf("taskCardBorderColor() = %q, want %q", color, uiChrome.Accent)
	}
}

func TestBoardKeyboardHintsIncludeManualPRRetry(t *testing.T) {
	hints := kbdHints(FocusBoard)

	if !strings.Contains(hints, "c PR") {
		t.Fatalf("kbdHints(FocusBoard) = %q, want create PR hint", hints)
	}
	if !strings.Contains(hints, "C retry PR") {
		t.Fatalf("kbdHints(FocusBoard) = %q, want retry PR hint", hints)
	}
}

func TestHandleTerminalKeyTabArmsBoardNavigation(t *testing.T) {
	model := &Model{
		focus:        FocusTerminal,
		activeTaskID: "task-1",
	}

	cmd := model.handleTerminalKey(tea.KeyMsg{Type: tea.KeyTab})

	if !model.terminalBoardNavPending {
		t.Fatal("terminal board navigation should be armed")
	}
	if model.terminalBoardNavTaskID != "task-1" {
		t.Fatalf("terminalBoardNavTaskID = %q, want task-1", model.terminalBoardNavTaskID)
	}
	if cmd == nil {
		t.Fatal("handleTerminalKey(tab) returned nil cmd")
	}
}

func TestHandleTerminalKeyTabDownSwitchesToNeighborTaskShell(t *testing.T) {
	model := &Model{
		focus:                   FocusTerminal,
		activeTaskID:            "task-1",
		terminalBoardNavPending: true,
		terminalBoardNavTaskID:  "task-1",
		selectedTrackIndex:      0,
		selectedTaskIndex:       0,
		tracks: []TrackRecord{
			{ID: "in-progress", SortOrder: 1},
		},
		tasks: []TaskRecord{
			{ID: "task-1", TrackID: "in-progress", SortKey: 1, Title: "First"},
			{ID: "task-2", TrackID: "in-progress", SortKey: 2, Title: "Second"},
		},
	}

	cmd := model.handleTerminalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})

	if !model.terminalBoardNavPending {
		t.Fatal("terminal board navigation should stay armed after switching")
	}
	if !model.terminalBoardNavConsumed {
		t.Fatal("terminal board navigation should be marked consumed after switching")
	}
	if model.terminalBoardNavTaskID != "task-2" {
		t.Fatalf("terminalBoardNavTaskID = %q, want task-2", model.terminalBoardNavTaskID)
	}
	if model.selectedTaskIndex != 1 {
		t.Fatalf("selectedTaskIndex = %d, want 1", model.selectedTaskIndex)
	}
	selected := model.selectedTask()
	if selected == nil || selected.ID != "task-2" {
		t.Fatalf("selectedTask() = %#v, want task-2", selected)
	}
	if cmd == nil {
		t.Fatal("handleTerminalKey(tab+j) returned nil cmd")
	}
}

func TestHandleTerminalKeyTabDownContinuesSwitchingWhileArmed(t *testing.T) {
	model := &Model{
		focus:                   FocusTerminal,
		activeTaskID:            "task-1",
		terminalBoardNavPending: true,
		terminalBoardNavTaskID:  "task-1",
		selectedTrackIndex:      0,
		selectedTaskIndex:       0,
		tracks: []TrackRecord{
			{ID: "in-progress", SortOrder: 1},
		},
		tasks: []TaskRecord{
			{ID: "task-1", TrackID: "in-progress", SortKey: 1, Title: "First"},
			{ID: "task-2", TrackID: "in-progress", SortKey: 2, Title: "Second"},
			{ID: "task-3", TrackID: "in-progress", SortKey: 3, Title: "Third"},
		},
	}

	firstCmd := model.handleTerminalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	secondCmd := model.handleTerminalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})

	if !model.terminalBoardNavPending {
		t.Fatal("terminal board navigation should stay armed for another move")
	}
	if model.selectedTaskIndex != 2 {
		t.Fatalf("selectedTaskIndex = %d, want 2", model.selectedTaskIndex)
	}
	selected := model.selectedTask()
	if selected == nil || selected.ID != "task-3" {
		t.Fatalf("selectedTask() = %#v, want task-3", selected)
	}
	if model.terminalBoardNavTaskID != "task-3" {
		t.Fatalf("terminalBoardNavTaskID = %q, want task-3", model.terminalBoardNavTaskID)
	}
	if firstCmd == nil || secondCmd == nil {
		t.Fatal("handleTerminalKey(tab+j+j) should return cmds for both moves")
	}
}

func TestHandleTerminalKeyTabRuneFallsBackToLiteralTabInput(t *testing.T) {
	model := &Model{
		focus:                   FocusTerminal,
		activeTaskID:            "task-1",
		terminalBoardNavPending: true,
		terminalBoardNavTaskID:  "task-1",
		terminalCommand:         "gi",
	}

	cmd := model.handleTerminalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'t'}})

	if model.terminalBoardNavPending {
		t.Fatal("terminal board navigation should clear after fallback input")
	}
	if model.pendingTerminalInputTaskID != "task-1" {
		t.Fatalf("pendingTerminalInputTaskID = %q, want task-1", model.pendingTerminalInputTaskID)
	}
	if model.pendingTerminalInput != "\tt" {
		t.Fatalf("pendingTerminalInput = %q, want %q", model.pendingTerminalInput, "\\tt")
	}
	if model.terminalCommand != "git" {
		t.Fatalf("terminalCommand = %q, want git", model.terminalCommand)
	}
	if cmd == nil {
		t.Fatal("handleTerminalKey(tab+t) returned nil cmd")
	}
}

func TestFlushPendingTerminalBoardNavCmdSkipsLiteralTabAfterNavigation(t *testing.T) {
	model := &Model{
		terminalBoardNavPending:  true,
		terminalBoardNavTaskID:   "task-2",
		terminalBoardNavConsumed: true,
	}

	cmd := model.flushPendingTerminalBoardNavCmd()

	if model.terminalBoardNavPending {
		t.Fatal("terminal board navigation should clear after timeout")
	}
	if model.terminalBoardNavTaskID != "" {
		t.Fatalf("terminalBoardNavTaskID = %q, want empty", model.terminalBoardNavTaskID)
	}
	if cmd != nil {
		t.Fatal("flushPendingTerminalBoardNavCmd() should not send a literal tab after navigation")
	}
}
