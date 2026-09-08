package tui

import (
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
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

func TestTerminalContentWidthUsesMinimumWhenBoardCanCollapse(t *testing.T) {
	model := &Model{
		width:               170,
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
	want := minTerminalPaneWidth
	if got != want {
		t.Fatalf("terminalContentWidth() = %d, want %d", got, want)
	}
}

func TestTerminalContentWidthUsesPersistedPaneWidth(t *testing.T) {
	model := &Model{
		width:               220,
		terminalPaneVisible: true,
		activeTaskID:        "task-1",
		terminalPaneWidth:   72,
		tracks: []TrackRecord{
			{ID: "backlog", SortOrder: 1},
			{ID: "in-progress", SortOrder: 2},
			{ID: "pr", SortOrder: 3},
			{ID: "done", SortOrder: 4},
		},
	}

	if got := model.terminalContentWidth(); got != 72 {
		t.Fatalf("terminalContentWidth() = %d, want 72", got)
	}
}

func TestRenderBoardCollapsesDoneTrackWhenPaneIsNarrow(t *testing.T) {
	model := &Model{
		width: 180,
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo"},
		},
		tracks: []TrackRecord{
			{ID: "backlog", Label: "Backlog", SortOrder: 1},
			{ID: "in-progress", Label: "In Progress", SortOrder: 2},
			{ID: "pr", Label: "Review", SortOrder: 3},
			{ID: "done", Label: "Done", SortOrder: 4},
		},
		tasks: []TaskRecord{
			{ID: "task-1", Title: "Merged item", RepoID: "repo-1", TrackID: "done"},
		},
	}

	boardWidth := (3 * trackColumnRenderWidth) + collapsedTrackRenderWidth
	plain := ansiPattern.ReplaceAllString(renderBoard(model, 12, boardWidth), "")
	if !strings.Contains(plain, "hidden") {
		t.Fatalf("renderBoard() = %q, want collapsed marker", plain)
	}
	if strings.Contains(plain, "Merged item") {
		t.Fatalf("renderBoard() = %q, want merged task hidden in collapsed track", plain)
	}
}

func TestRenderBoardKeepsSelectedColumnVisibleAcrossWidths(t *testing.T) {
	model := &Model{
		focus:              FocusBoard,
		selectedTrackIndex: 3,
		selectedTaskIndex:  0,
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo"},
		},
		tracks: []TrackRecord{
			{ID: "backlog", Label: "Backlog", SortOrder: 1},
			{ID: "in-progress", Label: "In Progress", SortOrder: 2},
			{ID: "review", Label: "Review", SortOrder: 3},
			{ID: "verify", Label: "Verify", SortOrder: 4},
			{ID: "done", Label: "Done", SortOrder: 5},
		},
		tasks: []TaskRecord{
			{ID: "task-backlog", Title: "Backlog task", RepoID: "repo-1", TrackID: "backlog"},
			{ID: "task-progress", Title: "Progress task", RepoID: "repo-1", TrackID: "in-progress"},
			{ID: "task-review", Title: "Review task", RepoID: "repo-1", TrackID: "review"},
			{ID: "task-verify", Title: "Verify selected", RepoID: "repo-1", TrackID: "verify"},
			{ID: "task-done", Title: "Done task", RepoID: "repo-1", TrackID: "done"},
		},
	}

	wideWidth := len(model.tracks) * trackColumnRenderWidth
	wide := renderBoard(model, 14, wideWidth)
	assertRenderedLinesWithinWidth(t, wide, wideWidth)
	for _, want := range []string{"Backlog task", "Progress task", "Review task", "Verify selected", "Done task"} {
		if !strings.Contains(stripANSI(wide), want) {
			t.Fatalf("wide render missing %q: %q", want, stripANSI(wide))
		}
	}

	mediumWidth := 2 * trackColumnRenderWidth
	medium := renderBoard(model, 14, mediumWidth)
	assertRenderedLinesWithinWidth(t, medium, mediumWidth)
	if !strings.Contains(stripANSI(medium), "Verify selected") {
		t.Fatalf("medium render = %q, want selected column visible", stripANSI(medium))
	}

	narrowWidth := 30
	narrow := renderBoard(model, 14, narrowWidth)
	assertRenderedLinesWithinWidth(t, narrow, narrowWidth)
	plainNarrow := stripANSI(narrow)
	if !strings.Contains(plainNarrow, "Verify selected") {
		t.Fatalf("narrow render = %q, want selected task visible", plainNarrow)
	}
}

func assertRenderedLinesWithinWidth(t *testing.T, value string, width int) {
	t.Helper()
	for _, line := range strings.Split(value, "\n") {
		if got := plainWidth(line); got > width {
			t.Fatalf("rendered line width = %d, want <= %d: %q", got, width, stripANSI(line))
		}
	}
}

func TestHandleKeyEnterOnActiveTmuxTaskAttachesWithoutOpeningSession(t *testing.T) {
	model := &Model{
		focus:                         FocusBoard,
		activeTaskID:                  "task-1",
		activeSessionBackendType:      SessionBackendTmux,
		activeSessionBackendSessionID: "ab_task_1_p",
		activeSessionAttachCommand:    "env -u TMUX tmux attach-session -t ab_task_1_p",
		tracks: []TrackRecord{
			{ID: "backlog", Label: "Backlog", SortOrder: 1},
		},
		tasks: []TaskRecord{
			{ID: "task-1", Title: "Selected", TrackID: "backlog", SessionID: "session-1"},
		},
	}

	cmd := model.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("handleKey(enter) returned nil cmd")
	}
	msg := cmd()
	if _, ok := msg.(tmuxPaneAttachedMsg); !ok {
		t.Fatalf("handleKey(enter) msg = %T, want tmuxPaneAttachedMsg", msg)
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

func TestRenderHorizontalDividerUsesRequestedWidth(t *testing.T) {
	divider := renderHorizontalDivider(18)

	if got := lipgloss.Width(divider); got != 18 {
		t.Fatalf("divider width = %d, want 18", got)
	}
	if got := lipgloss.Height(divider); got != 1 {
		t.Fatalf("divider height = %d, want 1", got)
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
		width:              180,
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

func TestCommentTaskPRCmdSetsProgressMessage(t *testing.T) {
	model := &Model{}
	prNumber := 42

	cmd := model.commentTaskPRCmd(&TaskRecord{
		ID:       "task-1",
		PRNumber: &prNumber,
		PRState:  "open",
	}, "Looks good")

	if cmd == nil {
		t.Fatal("commentTaskPRCmd() = nil, want command")
	}
	if model.statusMessage != "Posting PR comment..." {
		t.Fatalf("statusMessage = %q, want Posting PR comment...", model.statusMessage)
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

	if !strings.Contains(hints, "a/A ai chat") {
		t.Fatalf("kbdHints(FocusBoard) = %q, want ai chat hint", hints)
	}
	if !strings.Contains(hints, "B dual shell") {
		t.Fatalf("kbdHints(FocusBoard) = %q, want dual shell hint", hints)
	}
	if !strings.Contains(hints, "j comment") {
		t.Fatalf("kbdHints(FocusBoard) = %q, want PR comment hint", hints)
	}
	if !strings.Contains(hints, "c PR") {
		t.Fatalf("kbdHints(FocusBoard) = %q, want create PR hint", hints)
	}
	if !strings.Contains(hints, "C retry PR") {
		t.Fatalf("kbdHints(FocusBoard) = %q, want retry PR hint", hints)
	}
}

func TestTerminalKeyboardHintsIncludePaneSwitching(t *testing.T) {
	hints := kbdHints(FocusTerminal)

	if !strings.Contains(hints, "Shift+Tab pane") {
		t.Fatalf("kbdHints(FocusTerminal) = %q, want pane switching hint", hints)
	}
	if !strings.Contains(hints, "Tab+h/j/k/l switch shell") {
		t.Fatalf("kbdHints(FocusTerminal) = %q, want shell navigation hint", hints)
	}
}

func TestSplitTerminalSlotHeightsUsesSeventyFiveTwentyFiveLayout(t *testing.T) {
	top, bottom := splitTerminalSlotHeights(true, 20)
	if top != 15 || bottom != 4 {
		t.Fatalf("splitTerminalSlotHeights(true, 20) = (%d, %d), want (15, 4)", top, bottom)
	}
}

func TestSplitTerminalSlotHeightsClampsSmallDualPanes(t *testing.T) {
	top, bottom := splitTerminalSlotHeights(true, 8)
	if top != 4 || bottom != 3 {
		t.Fatalf("splitTerminalSlotHeights(true, 8) = (%d, %d), want (4, 3)", top, bottom)
	}
}

func TestDualTerminalDividerHeightRequiresRoomForTwoPanes(t *testing.T) {
	if got := dualTerminalDividerHeight(2); got != 0 {
		t.Fatalf("dualTerminalDividerHeight(2) = %d, want 0", got)
	}
	if got := dualTerminalDividerHeight(3); got != 1 {
		t.Fatalf("dualTerminalDividerHeight(3) = %d, want 1", got)
	}
}

func TestHandleKeyJOpensPRCommentModal(t *testing.T) {
	model := &Model{
		focus:              FocusBoard,
		selectedTrackIndex: 0,
		selectedTaskIndex:  0,
		tracks: []TrackRecord{
			{ID: "pr", SortOrder: 1},
		},
		tasks: []TaskRecord{
			func() TaskRecord {
				prNumber := 42
				return TaskRecord{
					ID:       "task-1",
					TrackID:  "pr",
					SortKey:  1,
					Title:    "Selected",
					PRNumber: &prNumber,
					PRState:  "open",
				}
			}(),
		},
	}

	cmd := model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})

	if cmd != nil {
		t.Fatal("handleKey(j) returned command, want nil")
	}
	if model.modal != ModalPRComment {
		t.Fatalf("modal = %q, want %q", model.modal, ModalPRComment)
	}
	if model.prCommentModal == nil || model.prCommentModal.TaskID != "task-1" {
		t.Fatalf("prCommentModal = %#v, want task-1", model.prCommentModal)
	}
}

func TestHandleTerminalKeyTabArmsBoardNavigation(t *testing.T) {
	model := &Model{
		focus:              FocusTerminal,
		activeTaskID:       "task-1",
		selectedTrackIndex: 0,
		selectedTaskIndex:  0,
		tracks: []TrackRecord{
			{ID: "backlog", SortOrder: 1},
			{ID: "in-progress", SortOrder: 2},
		},
		tasks: []TaskRecord{
			{ID: "task-1", TrackID: "in-progress", SortKey: 1, Title: "Active"},
			{ID: "task-2", TrackID: "backlog", SortKey: 1, Title: "Selected"},
		},
	}

	cmd := model.handleTerminalKey(tea.KeyMsg{Type: tea.KeyTab})

	if !model.terminalBoardNavPending {
		t.Fatal("terminal board navigation should be armed")
	}
	if model.terminalBoardNavTaskID != "task-1" {
		t.Fatalf("terminalBoardNavTaskID = %q, want task-1", model.terminalBoardNavTaskID)
	}
	if model.terminalBoardNavSlot != SessionSlotPrimary {
		t.Fatalf("terminalBoardNavSlot = %q, want %q", model.terminalBoardNavSlot, SessionSlotPrimary)
	}
	if model.selectedTrackIndex != 1 || model.selectedTaskIndex != 0 {
		t.Fatalf("selection = (%d,%d), want active task coordinates (1,0)", model.selectedTrackIndex, model.selectedTaskIndex)
	}
	if cmd == nil {
		t.Fatal("handleTerminalKey(tab) returned nil cmd")
	}
}

func TestHandleTerminalKeyShiftTabSwitchesFocusedPane(t *testing.T) {
	model := &Model{
		focus:               FocusTerminal,
		activeTaskID:        "task-1",
		terminalPaneVisible: true,
		width:               160,
		height:              40,
		focusedTerminalSlot: SessionSlotPrimary,
		tasks: []TaskRecord{
			{ID: "task-1", SessionID: "session-1", SecondarySessionID: "session-2"},
		},
	}

	cmd := model.handleTerminalKey(tea.KeyMsg{Type: tea.KeyShiftTab})

	if model.focusedTerminalSlot != SessionSlotSecondary {
		t.Fatalf("focusedTerminalSlot = %q, want %q", model.focusedTerminalSlot, SessionSlotSecondary)
	}
	if cmd == nil {
		t.Fatal("handleTerminalKey(shift+tab) returned nil cmd")
	}
}

func TestHandleTerminalKeyTabKeepsFocusedSecondarySlotForBoardNavigation(t *testing.T) {
	model := &Model{
		focus:               FocusTerminal,
		activeTaskID:        "task-1",
		focusedTerminalSlot: SessionSlotSecondary,
		selectedTrackIndex:  0,
		selectedTaskIndex:   0,
		tracks: []TrackRecord{
			{ID: "backlog", SortOrder: 1},
			{ID: "in-progress", SortOrder: 2},
		},
		tasks: []TaskRecord{
			{ID: "task-1", TrackID: "in-progress", SortKey: 1, Title: "Active", SessionID: "session-1", SecondarySessionID: "session-2"},
			{ID: "task-2", TrackID: "backlog", SortKey: 1, Title: "Selected", SessionID: "session-3"},
		},
	}

	cmd := model.handleTerminalKey(tea.KeyMsg{Type: tea.KeyTab})

	if !model.terminalBoardNavPending {
		t.Fatal("terminal board navigation should be armed")
	}
	if model.terminalBoardNavSlot != SessionSlotSecondary {
		t.Fatalf("terminalBoardNavSlot = %q, want %q", model.terminalBoardNavSlot, SessionSlotSecondary)
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
			{ID: "task-1", TrackID: "in-progress", SortKey: 1, Title: "First", SessionID: "session-1"},
			{ID: "task-2", TrackID: "in-progress", SortKey: 2, Title: "Second", SessionID: "session-2"},
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
	if model.activeTaskID != "task-2" {
		t.Fatalf("activeTaskID = %q, want task-2", model.activeTaskID)
	}
	selected := model.selectedTask()
	if selected == nil || selected.ID != "task-2" {
		t.Fatalf("selectedTask() = %#v, want task-2", selected)
	}
	if cmd == nil {
		t.Fatal("handleTerminalKey(tab+j) returned nil cmd")
	}
}

func TestHandleTerminalKeyTabDownArrowSwitchesToNeighborTaskShell(t *testing.T) {
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
			{ID: "task-1", TrackID: "in-progress", SortKey: 1, Title: "First", SessionID: "session-1"},
			{ID: "task-2", TrackID: "in-progress", SortKey: 2, Title: "Second", SessionID: "session-2"},
		},
	}

	cmd := model.handleTerminalKey(tea.KeyMsg{Type: tea.KeyDown})

	if model.activeTaskID != "task-2" {
		t.Fatalf("activeTaskID = %q, want task-2", model.activeTaskID)
	}
	if model.selectedTaskIndex != 1 {
		t.Fatalf("selectedTaskIndex = %d, want 1", model.selectedTaskIndex)
	}
	if cmd == nil {
		t.Fatal("handleTerminalKey(tab+down) returned nil cmd")
	}
}

func TestHandleBoardKeyTabDownArrowSwitchesToNeighborTaskShell(t *testing.T) {
	model := &Model{
		focus:               FocusBoard,
		activeTaskID:        "task-1",
		focusedTerminalSlot: SessionSlotPrimary,
		selectedTrackIndex:  0,
		selectedTaskIndex:   0,
		tracks: []TrackRecord{
			{ID: "in-progress", SortOrder: 1},
		},
		tasks: []TaskRecord{
			{ID: "task-1", TrackID: "in-progress", SortKey: 1, Title: "First", SessionID: "session-1"},
			{ID: "task-2", TrackID: "in-progress", SortKey: 2, Title: "Second", SessionID: "session-2"},
		},
	}

	armCmd := model.handleKey(tea.KeyMsg{Type: tea.KeyTab})
	switchCmd := model.handleKey(tea.KeyMsg{Type: tea.KeyDown})

	if !model.terminalBoardNavPending {
		t.Fatal("terminal board navigation should stay armed after switching")
	}
	if !model.terminalBoardNavConsumed {
		t.Fatal("terminal board navigation should be marked consumed after switching")
	}
	if model.activeTaskID != "task-2" {
		t.Fatalf("activeTaskID = %q, want task-2", model.activeTaskID)
	}
	if model.selectedTaskIndex != 1 {
		t.Fatalf("selectedTaskIndex = %d, want 1", model.selectedTaskIndex)
	}
	if armCmd == nil || switchCmd == nil {
		t.Fatal("handleKey(tab+down) should return cmds for both keys")
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

func artifactFooterTestModel(width int, artifacts []ArtifactRecord) *Model {
	return &Model{
		focus: FocusBoard,
		width: width,
		artifacts: ArtifactsSnapshot{
			RefreshedAt: 1785100000000,
			Artifacts:   artifacts,
		},
	}
}

func intPtr(value int) *int {
	return &value
}

func TestRenderArtifactFooterShowsAChipStateForEachStatus(t *testing.T) {
	model := artifactFooterTestModel(200, []ArtifactRecord{
		{ShortName: "ecom-integrations", Status: ArtifactStatusDrift, GAVersion: "1.1258.0", LatestRCVersion: "1.1259.0", Drift: intPtr(1)},
		{ShortName: "assistant-web5", Status: ArtifactStatusInSync, GAVersion: "1.3309.0", LatestRCVersion: "1.3309.0"},
		{ShortName: "web5-protos", Status: ArtifactStatusNoGA, LatestRCVersion: "1.0.5"},
		{ShortName: "mystery-lib", Status: ArtifactStatusUnknown},
	})

	footer := renderArtifactFooter(model)
	assertRenderedLinesWithinWidth(t, footer, 200)

	plain := stripANSI(footer)
	if lines := strings.Count(plain, "\n") + 1; lines > artifactFooterHeight {
		t.Fatalf("renderArtifactFooter() = %q, want at most %d rows", plain, artifactFooterHeight)
	}
	for _, want := range []string{
		artifactFooterLabel,
		"ecom-integrations 1.1258.0" + artifactDriftMarker + "1",
		"assistant-web5 1.3309.0" + artifactInSyncMarker,
		"web5-protos " + artifactNoGALabel,
		"mystery-lib " + artifactUnknownLabel,
	} {
		if !strings.Contains(plain, want) {
			t.Fatalf("renderArtifactFooter() = %q, want %q", plain, want)
		}
	}
}

func TestRenderArtifactFooterCountsDriftingArtifacts(t *testing.T) {
	model := artifactFooterTestModel(200, []ArtifactRecord{
		{ShortName: "one", Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"},
		{ShortName: "two", Status: ArtifactStatusDrift, GAVersion: "2.0.0", LatestRCVersion: "2.1.0"},
		{ShortName: "three", Status: ArtifactStatusDrift, GAVersion: "3.0.0", LatestRCVersion: "3.1.0"},
		{ShortName: "four", Status: ArtifactStatusInSync, GAVersion: "4.0.0", LatestRCVersion: "4.0.0"},
	})

	plain := stripANSI(renderArtifactFooter(model))
	if !strings.Contains(plain, artifactFooterLabel+" "+artifactDriftMarker+"3") {
		t.Fatalf("renderArtifactFooter() = %q, want drift count %q", plain, artifactDriftMarker+"3")
	}
}

func TestRenderArtifactFooterTagsNonLiveModeOnly(t *testing.T) {
	model := artifactFooterTestModel(120, []ArtifactRecord{
		{ShortName: "dev-thing", Mode: "DEV", Status: ArtifactStatusInSync, GAVersion: "1.0.0", LatestRCVersion: "1.0.0"},
		{ShortName: "live-thing", Mode: ArtifactModeLive, Status: ArtifactStatusInSync, GAVersion: "2.0.0", LatestRCVersion: "2.0.0"},
	})

	plain := stripANSI(renderArtifactFooter(model))
	if !strings.Contains(plain, "DEV") {
		t.Fatalf("renderArtifactFooter() = %q, want the DEV mode tag", plain)
	}
	if strings.Contains(plain, string(ArtifactModeLive)) {
		t.Fatalf("renderArtifactFooter() = %q, want no tag for LIVE artifacts", plain)
	}
}

func TestRenderArtifactFooterHighlightsTheSelectedChip(t *testing.T) {
	model := artifactFooterTestModel(120, []ArtifactRecord{
		{ShortName: "first", Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"},
		{ShortName: "second", Status: ArtifactStatusDrift, GAVersion: "2.0.0", LatestRCVersion: "2.1.0"},
	})
	model.selectedArtifactIndex = 1

	plain := stripANSI(renderArtifactFooter(model))
	if !strings.Contains(plain, artifactSelectedMark+"second") {
		t.Fatalf("renderArtifactFooter() = %q, want the selected chip marked", plain)
	}
	if strings.Contains(plain, artifactSelectedMark+"first") {
		t.Fatalf("renderArtifactFooter() = %q, want only the selected chip marked", plain)
	}
}

func TestRenderArtifactFooterCountsHiddenChipsInTheOverflowMarker(t *testing.T) {
	artifacts := []ArtifactRecord{}
	for _, name := range []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot"} {
		artifacts = append(artifacts, ArtifactRecord{ShortName: name, Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"})
	}
	model := artifactFooterTestModel(50, artifacts)

	footer := renderArtifactFooter(model)
	assertRenderedLinesWithinWidth(t, footer, 50)

	plain := stripANSI(footer)
	shown := 0
	for _, artifact := range artifacts {
		if strings.Contains(plain, artifact.ShortName) {
			shown++
		}
	}
	if shown == 0 || shown == len(artifacts) {
		t.Fatalf("renderArtifactFooter() = %q, want some chips dropped for width", plain)
	}
	if !strings.Contains(plain, artifactOverflowLabel(len(artifacts)-shown)) {
		t.Fatalf("renderArtifactFooter() = %q, want overflow marker %q", plain, artifactOverflowLabel(len(artifacts)-shown))
	}
}

func TestRenderArtifactFooterKeepsTheSelectedChipVisibleOnOverflow(t *testing.T) {
	artifacts := []ArtifactRecord{}
	for _, name := range []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot"} {
		artifacts = append(artifacts, ArtifactRecord{ShortName: name, Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"})
	}
	model := artifactFooterTestModel(50, artifacts)
	model.selectedArtifactIndex = len(artifacts) - 1

	plain := stripANSI(renderArtifactFooter(model))
	if !strings.Contains(plain, artifactSelectedMark+"foxtrot") {
		t.Fatalf("renderArtifactFooter() = %q, want the selected chip kept on the strip", plain)
	}
}

func TestRenderArtifactFooterMarksStaleSnapshot(t *testing.T) {
	model := artifactFooterTestModel(120, []ArtifactRecord{
		{ShortName: "ecom", Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"},
	})
	model.artifacts.Stale = true

	plain := stripANSI(renderArtifactFooter(model))
	if !strings.Contains(plain, "stale") {
		t.Fatalf("renderArtifactFooter() = %q, want the stale note", plain)
	}
	if !strings.Contains(plain, "ecom") {
		t.Fatalf("renderArtifactFooter() = %q, want stale chips to stay visible", plain)
	}
}

func TestRenderArtifactFooterShowsLoginHintWhenAuthIsNeeded(t *testing.T) {
	model := artifactFooterTestModel(120, []ArtifactRecord{
		{ShortName: "ecom", Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"},
	})
	model.artifacts.NeedsAuth = true

	footer := renderArtifactFooter(model)
	assertRenderedLinesWithinWidth(t, footer, 120)

	plain := stripANSI(footer)
	if !strings.Contains(plain, "agentboard mcp login") {
		t.Fatalf("renderArtifactFooter() = %q, want the mcp login hint", plain)
	}
	if strings.Contains(plain, "1.1.0") {
		t.Fatalf("renderArtifactFooter() = %q, want chips replaced by the auth hint", plain)
	}
}

func TestRenderArtifactFooterShowsLoadingBeforeFirstRefresh(t *testing.T) {
	model := &Model{focus: FocusBoard, width: 120}

	plain := stripANSI(renderArtifactFooter(model))
	if !strings.Contains(plain, "loading") {
		t.Fatalf("renderArtifactFooter() = %q, want the loading note", plain)
	}
}

// The catalog the footer was widened for: every entry drifts and five of them
// carry the user's own commits.
func web5CatalogArtifacts() []ArtifactRecord {
	return []ArtifactRecord{
		{ShortName: "web5.ecom-integrations", Status: ArtifactStatusDrift, GAVersion: "1.1258.0", LatestRCVersion: "1.1259.0", Drift: intPtr(1), PendingRcCount: intPtr(2), MyPendingCount: intPtr(0)},
		{ShortName: "bo-web5-history", Status: ArtifactStatusDrift, GAVersion: "1.465.0", LatestRCVersion: "1.470.0", Drift: intPtr(5), PendingRcCount: intPtr(6), MyPendingCount: intPtr(1)},
		{ShortName: "wix-assistant-web5", Status: ArtifactStatusDrift, GAVersion: "1.3301.0", LatestRCVersion: "1.3311.0", Drift: intPtr(10), PendingRcCount: intPtr(11), MyPendingCount: intPtr(6)},
		{ShortName: "enterprise.web5.evaluator", Mode: "DEV", Status: ArtifactStatusDrift, GAVersion: "1.282.0", LatestRCVersion: "1.286.0", Drift: intPtr(4), PendingRcCount: intPtr(5), MyPendingCount: intPtr(1)},
		{ShortName: "enterpise.web5.prompt-manager", Status: ArtifactStatusDrift, GAVersion: "1.258.0", LatestRCVersion: "1.269.0", Drift: intPtr(11), PendingRcCount: intPtr(12), MyPendingCount: intPtr(2)},
		{ShortName: "conversation-configuration", Status: ArtifactStatusDrift, GAVersion: "1.1756.0", LatestRCVersion: "1.1765.0", Drift: intPtr(9), PendingRcCount: intPtr(10), MyPendingCount: intPtr(2)},
	}
}

func TestRenderArtifactFooterFitsTheWholeCatalogOnTwoRows(t *testing.T) {
	artifacts := web5CatalogArtifacts()
	model := artifactFooterTestModel(200, artifacts)

	footer := renderArtifactFooter(model)
	assertRenderedLinesWithinWidth(t, footer, 200)

	rows := strings.Split(stripANSI(footer), "\n")
	if len(rows) != artifactFooterHeight {
		t.Fatalf("renderArtifactFooter() = %q, want %d rows", footer, artifactFooterHeight)
	}
	for _, artifact := range artifacts {
		if !strings.Contains(stripANSI(footer), artifact.ShortName) {
			t.Fatalf("renderArtifactFooter() = %q, want %q visible", footer, artifact.ShortName)
		}
	}
	if strings.Contains(stripANSI(footer), "+") {
		t.Fatalf("renderArtifactFooter() = %q, want no overflow marker when every chip fits", footer)
	}
	for index, row := range rows {
		if !strings.Contains(row, artifactDriftMarker) {
			t.Fatalf("row %d = %q, want chips balanced across both rows", index, row)
		}
	}
}

func TestRenderArtifactFooterHeadSummarisesDriftAndOwnership(t *testing.T) {
	model := artifactFooterTestModel(200, web5CatalogArtifacts())

	plain := stripANSI(renderArtifactFooter(model))
	want := artifactFooterLabel + " " + artifactDriftMarker + "6 " + artifactOwnedMarker + "5"
	if !strings.Contains(plain, want) {
		t.Fatalf("renderArtifactFooter() = %q, want head %q", plain, want)
	}
}

func TestRenderArtifactFooterMarksTheArtifactsYouAreHoldingUp(t *testing.T) {
	model := artifactFooterTestModel(200, web5CatalogArtifacts())

	plain := stripANSI(renderArtifactFooter(model))
	if !strings.Contains(plain, "wix-assistant-web5 1.3301.0"+artifactDriftMarker+"10 "+artifactOwnedMarker+"6") {
		t.Fatalf("renderArtifactFooter() = %q, want the owned pending count on the chip", plain)
	}
}

func TestRenderArtifactFooterShowsNoOwnershipMarkerWithoutOwnedChanges(t *testing.T) {
	cases := []struct {
		name           string
		myPendingCount *int
	}{
		{"ownership unknown", nil},
		{"confidently none", intPtr(0)},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			model := artifactFooterTestModel(120, []ArtifactRecord{{
				ShortName:       "ecom-integrations",
				Status:          ArtifactStatusDrift,
				GAVersion:       "1.1258.0",
				LatestRCVersion: "1.1259.0",
				Drift:           intPtr(1),
				PendingRcCount:  intPtr(2),
				MyPendingCount:  testCase.myPendingCount,
			}})

			plain := stripANSI(renderArtifactFooter(model))
			if strings.Contains(plain, artifactOwnedMarker) {
				t.Fatalf("renderArtifactFooter() = %q, want no ownership marker", plain)
			}
			if strings.Contains(plain, "0") && strings.Contains(plain, artifactOwnedMarker+"0") {
				t.Fatalf("renderArtifactFooter() = %q, want no zero ownership count", plain)
			}
		})
	}
}

func TestContentHeightLeavesRoomForBothFooterRows(t *testing.T) {
	model := &Model{focus: FocusBoard, width: 120, height: 40}

	if got, want := model.contentHeight(), 40-headerHeight-artifactFooterHeight-statusBarHeight; got != want {
		t.Fatalf("contentHeight() = %d, want %d", got, want)
	}
}

func TestHandleKeyShiftSRequestsArtifactRefresh(t *testing.T) {
	model := &Model{focus: FocusBoard}

	if cmd := model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'S'}}); cmd == nil {
		t.Fatal("handleKey(S) returned nil cmd, want an artifact refresh")
	}
}

func TestHandleKeySemicolonMovesTheFooterSelection(t *testing.T) {
	model := artifactFooterTestModel(120, []ArtifactRecord{
		{ShortName: "first", Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"},
		{ShortName: "second", Status: ArtifactStatusDrift, GAVersion: "2.0.0", LatestRCVersion: "2.1.0"},
	})

	model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{';'}})
	if model.selectedArtifactIndex != 1 {
		t.Fatalf("selectedArtifactIndex = %d, want 1", model.selectedArtifactIndex)
	}

	model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{';'}})
	if model.selectedArtifactIndex != 0 {
		t.Fatalf("selectedArtifactIndex = %d, want the selection to wrap to 0", model.selectedArtifactIndex)
	}
}

func TestApplyArtifactsClampsTheFooterSelectionToTheNewSnapshot(t *testing.T) {
	model := artifactFooterTestModel(120, []ArtifactRecord{
		{ShortName: "first", Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"},
		{ShortName: "second", Status: ArtifactStatusDrift, GAVersion: "2.0.0", LatestRCVersion: "2.1.0"},
	})
	model.selectedArtifactIndex = 1

	model.applyArtifacts(artifactsLoadedMsg{snapshot: ArtifactsSnapshot{
		RefreshedAt: 1785100000001,
		Artifacts:   []ArtifactRecord{{ShortName: "first", Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"}},
	}})

	if model.selectedArtifactIndex != 0 {
		t.Fatalf("selectedArtifactIndex = %d, want 0 after the list shrank", model.selectedArtifactIndex)
	}
}

func TestApplyArtifactsKeepsLastRowsAndMarksStaleOnError(t *testing.T) {
	model := artifactFooterTestModel(120, []ArtifactRecord{
		{ShortName: "ecom", Status: ArtifactStatusDrift, GAVersion: "1.0.0", LatestRCVersion: "1.1.0"},
	})

	model.applyArtifacts(artifactsLoadedMsg{err: errors.New("daemon unreachable")})

	if !model.artifacts.Stale {
		t.Fatal("artifacts.Stale = false, want true after a failed load")
	}
	if len(model.artifacts.Artifacts) != 1 {
		t.Fatalf("artifacts = %#v, want the previous rows kept", model.artifacts.Artifacts)
	}
	if model.statusMessage != "" {
		t.Fatalf("statusMessage = %q, want the background poll to stay silent", model.statusMessage)
	}

	model.applyArtifacts(artifactsLoadedMsg{manual: true, err: errors.New("daemon unreachable")})
	if model.statusMessage != "daemon unreachable" {
		t.Fatalf("statusMessage = %q, want the manual refresh error surfaced", model.statusMessage)
	}
}

func TestRenderTaskCardMarksGeneralTaskWithoutBranch(t *testing.T) {
	card := renderTaskCard(
		&Model{},
		TaskRecord{
			ID:        "task-1",
			Title:     "Read the MCP spec",
			Kind:      TaskKindGeneral,
			UpdatedAt: 1,
		},
		false,
		false,
		nil,
		"",
	)

	plain := ansiPattern.ReplaceAllString(card, "")
	if !strings.Contains(plain, "general") {
		t.Fatalf("renderTaskCard() = %q, want a general marker", plain)
	}
	if strings.Contains(plain, "⎇") {
		t.Fatalf("renderTaskCard() = %q, want no branch chip on a general task", plain)
	}
}

func TestRenderTaskCardKeepsBranchChipForRepoTasks(t *testing.T) {
	card := renderTaskCard(
		&Model{},
		TaskRecord{
			ID:         "task-1",
			Title:      "Ship follow-up",
			RepoID:     "repo-1",
			BranchName: "feat/ship-follow-up",
			UpdatedAt:  1,
		},
		false,
		false,
		nil,
		"web5.0-poc",
	)

	plain := ansiPattern.ReplaceAllString(card, "")
	if !strings.Contains(plain, "⎇") {
		t.Fatalf("renderTaskCard() = %q, want a branch chip", plain)
	}
}

// Two different parents' subtasks must read as distinct at a glance — a bare
// An attention card's border used to alternate amber/red on m.spinnerIndex. That
// clock only advances while *something else* is busy, so one state rendered three
// different ways: a fast flicker, a frozen amber, or a frozen red.
func TestRenderTaskCardAttentionBorderDoesNotAnimate(t *testing.T) {
	task := TaskRecord{ID: "task-1", Title: "Needs you", SessionAttentionNeeded: true, UpdatedAt: 1}

	// Tests run without a tty, where lipgloss drops every colour it is handed —
	// so ask for a profile that actually emits them, or this asserts nothing.
	previous := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	defer lipgloss.SetColorProfile(previous)

	first := renderTaskCard(&Model{spinnerIndex: 0}, task, false, false, nil, "web5-poc")
	second := renderTaskCard(&Model{spinnerIndex: 1}, task, false, false, nil, "web5-poc")

	if first != second {
		t.Fatalf("attention card changed with the spinner:\n%q\n%q", first, second)
	}
	want := termenv.TrueColor.Color(taskCardBorderColor(task, false)).Sequence(false)
	if !strings.Contains(first, want) {
		t.Fatalf("attention card = %q, want the static attention border colour %q", first, want)
	}
}

// "Subtask" badge cannot tell you which is which once there is more than one.
func TestRenderTaskCardNamesTheSubtasksParent(t *testing.T) {
	model := &Model{
		tasks: []TaskRecord{
			{ID: "parent-1", Title: "Rate limiting", UpdatedAt: 1},
			{ID: "parent-2", Title: "Onboarding", UpdatedAt: 1},
		},
	}

	cardOne := renderTaskCard(
		model,
		TaskRecord{ID: "sub-1", Title: "Extract the limiter", ParentTaskID: "parent-1", UpdatedAt: 1},
		false, false, nil, "",
	)
	cardTwo := renderTaskCard(
		model,
		TaskRecord{ID: "sub-2", Title: "Rewrite the welcome screen", ParentTaskID: "parent-2", UpdatedAt: 1},
		false, false, nil, "",
	)

	plainOne := ansiPattern.ReplaceAllString(cardOne, "")
	plainTwo := ansiPattern.ReplaceAllString(cardTwo, "")

	if !strings.Contains(plainOne, "Rate limiting") {
		t.Fatalf("card one = %q, want it to name parent-1's title", plainOne)
	}
	if !strings.Contains(plainTwo, "Onboarding") {
		t.Fatalf("card two = %q, want it to name parent-2's title", plainTwo)
	}
	if strings.Contains(plainOne, "Onboarding") || strings.Contains(plainTwo, "Rate limiting") {
		t.Fatalf("cards named the wrong parent: card one = %q, card two = %q", plainOne, plainTwo)
	}
}

func TestRenderOverviewBoardListsGeneralScope(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{{ID: "repo-1", Label: "web5-poc"}},
		tasks: []TaskRecord{
			{ID: "task-1", Title: "Fix login", RepoID: "repo-1", TrackID: "backlog"},
			{ID: "task-2", Title: "Read the MCP spec", Kind: TaskKindGeneral, TrackID: "done"},
		},
	}

	plain := ansiPattern.ReplaceAllString(renderOverviewBoard(model, 20, 80), "")

	if !strings.Contains(plain, "General") {
		t.Fatalf("overview = %q, want a General row", plain)
	}
	// The general row counts its own cards, not the repo's.
	if !strings.Contains(plain, "✓1") {
		t.Fatalf("overview = %q, want the general row to count its done card", plain)
	}
}

func TestRenderOverviewBoardWithoutReposOrGeneralTasksAsksForARepo(t *testing.T) {
	plain := ansiPattern.ReplaceAllString(renderOverviewBoard(&Model{}, 20, 80), "")

	if !strings.Contains(plain, "No repos registered") {
		t.Fatalf("overview = %q, want the register-a-repo hint", plain)
	}
}

// taskCardHeightForWidth is a hand-maintained mirror of renderTaskCardWithWidth
// and feeds visibleWindow. When the two disagree, column scrolling drifts with
// no error anywhere — so the mirror is pinned at every branch count that changes
// the card's shape.
func TestTaskCardHeightMatchesRenderedCardForEveryBranchCount(t *testing.T) {
	branchesFor := func(count int) []TaskBranchRecord {
		branches := []TaskBranchRecord{}
		for index := 0; index < count; index++ {
			branches = append(branches, TaskBranchRecord{
				ID:         string(rune('a' + index)),
				RepoID:     "repo-1",
				BranchName: "feat/part-" + string(rune('a'+index)),
				PRNumber:   intPtr(index + 1),
				PRState:    "open",
			})
		}
		return branches
	}

	// Every field that adds a line to the card, in the combinations that
	// actually change its shape. A single fixture would pin one arithmetic path
	// and leave the others free to drift.
	shapes := []struct {
		name        string
		title       string
		description string
		attention   bool
		prState     PRState
	}{
		{name: "short title, no description", title: "Ship it"},
		{name: "wrapping title", title: "Split the assistant across every repository it touches"},
		{name: "with description", title: "Ship it", description: "Three services and a proto package"},
		{
			name:        "wrapping title and wrapping description",
			title:       "Split the assistant across every repository it touches",
			description: "Three services, a proto package, and the back office page that reads them",
		},
		{name: "attention needed", title: "Ship it", attention: true},
		{name: "merged card", title: "Ship it", prState: "merged"},
		{name: "no pull request yet", title: "Ship it", prState: "none"},
	}

	for _, branchCount := range []int{1, 2, 3, 5, 7} {
		for _, shape := range shapes {
			prState := shape.prState
			if prState == "" {
				prState = "open"
			}
			task := TaskRecord{
				ID:                     "task-1",
				Title:                  shape.title,
				Description:            shape.description,
				RepoID:                 "repo-1",
				BranchName:             "feat/part-a",
				PRNumber:               intPtr(1),
				PRState:                prState,
				SessionAttentionNeeded: shape.attention,
				UpdatedAt:              1,
				Branches:               branchesFor(branchCount),
			}

			model := &Model{}
			want := lipgloss.Height(renderTaskCard(model, task, false, false, nil, "web5-poc"))
			got := taskCardHeightForWidth(model, task, taskCardContentWidth, false)
			if got != want {
				t.Fatalf(
					"%d branches / %s: taskCardHeightForWidth() = %d, rendered card is %d lines",
					branchCount, shape.name, got, want,
				)
			}
		}
	}
}

// One branch is the old card. Adding the branch table must not have moved a
// single pixel of it, or every existing board looks subtly different.
func TestSingleBranchCardRendersExactlyAsACardWithNoBranchTable(t *testing.T) {
	task := TaskRecord{
		ID:         "task-1",
		Title:      "Ship follow-up",
		RepoID:     "repo-1",
		BranchName: "feat/ship-follow-up",
		PRNumber:   intPtr(4),
		PRState:    "open",
		UpdatedAt:  1,
	}
	withBranch := task
	withBranch.Branches = []TaskBranchRecord{{
		ID:         "branch-1",
		RepoID:     "repo-1",
		BranchName: "feat/ship-follow-up",
		PRNumber:   intPtr(4),
		PRState:    "open",
	}}

	model := &Model{}
	before := renderTaskCard(model, task, false, false, nil, "web5-poc")
	after := renderTaskCard(model, withBranch, false, false, nil, "web5-poc")

	if before != after {
		t.Fatalf("single-branch card changed:\n%q\nwant\n%q", after, before)
	}
	if got, want := taskCardHeight(model, withBranch), taskCardHeight(model, task); got != want {
		t.Fatalf("single-branch card height = %d, want %d", got, want)
	}
}

func TestMultiBranchCardShowsTheRollupAndTheGlyphStrip(t *testing.T) {
	task := TaskRecord{
		ID:         "task-1",
		Title:      "Cross-repo feature",
		RepoID:     "repo-1",
		BranchName: "feat/a",
		UpdatedAt:  1,
		Release:    &TaskReleaseSummary{Stage: "ga", GaCount: 1},
		Branches: []TaskBranchRecord{
			{ID: "a", RepoID: "repo-1", BranchName: "feat/a", PRNumber: intPtr(1), PRState: "merged"},
			{ID: "b", RepoID: "repo-2", BranchName: "feat/b", PRNumber: intPtr(2), PRState: "open"},
			{ID: "c", RepoID: "repo-3", BranchName: "feat/c", PRNumber: intPtr(3), PRState: "open", CIState: "failed"},
		},
	}

	plain := ansiPattern.ReplaceAllString(renderTaskCard(&Model{}, task, false, false, nil, "web5-poc"), "")

	if !strings.Contains(plain, "1/3 merged") {
		t.Fatalf("card = %q, want the merged rollup", plain)
	}
	if !strings.Contains(plain, "1 GA") {
		t.Fatalf("card = %q, want the GA count", plain)
	}
	if !strings.Contains(plain, branchGlyphShipped) {
		t.Fatalf("card = %q, want a shipped glyph in the strip", plain)
	}
}

// The card is 28 columns of content and the strip is the widest line on it.
func TestMultiBranchCardStaysWithinTheTrackColumn(t *testing.T) {
	branches := []TaskBranchRecord{}
	for index := 0; index < 5; index++ {
		branches = append(branches, TaskBranchRecord{
			ID:         string(rune('a' + index)),
			RepoID:     "repo-1",
			BranchName: "feat/part-" + string(rune('a'+index)),
			PRNumber:   intPtr(index + 1),
			PRState:    "open",
		})
	}
	card := renderTaskCard(&Model{}, TaskRecord{
		ID:        "task-1",
		Title:     "Cross-repo feature",
		RepoID:    "repo-1",
		UpdatedAt: 1,
		Branches:  branches,
	}, false, false, nil, "web5-poc")

	if got := lipgloss.Width(card); got != trackColumnStyleWidth {
		t.Fatalf("task card width = %d, want %d", got, trackColumnStyleWidth)
	}
}
