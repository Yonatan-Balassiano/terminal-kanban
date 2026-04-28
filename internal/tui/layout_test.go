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
	want := missionRailCollapsedWidth + (4 * trackColumnRenderWidth)
	if got != want {
		t.Fatalf("boardRenderWidth() = %d, want %d", got, want)
	}
}

func TestTerminalContentWidthUsesMinimumWhenBoardCanCollapse(t *testing.T) {
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

	boardWidth := missionRailCollapsedWidth + (3 * trackColumnRenderWidth) + collapsedTrackRenderWidth
	plain := ansiPattern.ReplaceAllString(renderBoard(model, 12, boardWidth), "")
	if !strings.Contains(plain, "hidden") {
		t.Fatalf("renderBoard() = %q, want collapsed marker", plain)
	}
	if strings.Contains(plain, "Merged item") {
		t.Fatalf("renderBoard() = %q, want merged task hidden in collapsed track", plain)
	}
}

func TestRenderMissionRailExpandedShowsTaskStates(t *testing.T) {
	model := &Model{
		height:                   20,
		focus:                    FocusMissions,
		missionsPaneExpanded:     true,
		selectedMissionIndex:     0,
		selectedMissionTaskIndex: 0,
		missions: []MissionSnapshot{
			{
				ID:    "mission-1",
				Title: "Cross-repo rollout",
				Counts: MissionStatusCounts{
					Backlog:    1,
					InProgress: 0,
					PR:         0,
					Merged:     1,
				},
				Tasks: []MissionTaskRecord{
					{
						MissionID:       "mission-1",
						TaskID:          "task-1",
						ReleasedToBoard: false,
						Status:          "backlog",
						Task:            TaskRecord{ID: "task-1", Title: "Prepare follow-up"},
					},
					{
						MissionID:       "mission-1",
						TaskID:          "task-2",
						ReleasedToBoard: true,
						Status:          "merged",
						Task:            TaskRecord{ID: "task-2", Title: "Land base PR"},
					},
				},
			},
		},
	}

	plain := ansiPattern.ReplaceAllString(renderMissionRail(model, 10), "")
	if !strings.Contains(plain, "Cross-repo rollout") {
		t.Fatalf("renderMissionRail() = %q, want mission title", plain)
	}
	if !strings.Contains(plain, "hold") {
		t.Fatalf("renderMissionRail() = %q, want unreleased marker", plain)
	}
	if !strings.Contains(plain, "done") {
		t.Fatalf("renderMissionRail() = %q, want done marker", plain)
	}
}

func TestRenderMissionRailExpandedShowsEmptyMissionPlaceholder(t *testing.T) {
	model := &Model{
		height:                   20,
		focus:                    FocusMissions,
		missionsPaneExpanded:     true,
		selectedMissionIndex:     0,
		selectedMissionTaskIndex: missionSummaryRowTaskIndex,
		missions: []MissionSnapshot{
			{
				ID:    "mission-1",
				Title: "Empty mission",
			},
		},
	}

	plain := ansiPattern.ReplaceAllString(renderMissionRail(model, 10), "")
	if !strings.Contains(plain, "Empty mission") {
		t.Fatalf("renderMissionRail() = %q, want mission title", plain)
	}
	if !strings.Contains(plain, "No tasks yet") {
		t.Fatalf("renderMissionRail() = %q, want empty placeholder", plain)
	}
	if !strings.Contains(plain, "n add") {
		t.Fatalf("renderMissionRail() = %q, want add hint", plain)
	}
}

func TestHandleKeyUTogglesMissionRail(t *testing.T) {
	model := &Model{
		focus: FocusBoard,
	}

	cmd := model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'u'}})
	if !model.missionsPaneExpanded {
		t.Fatal("missionsPaneExpanded = false, want true")
	}
	if model.focus != FocusMissions {
		t.Fatalf("focus = %q, want %q", model.focus, FocusMissions)
	}
	if cmd == nil {
		t.Fatal("handleKey(u) returned nil cmd")
	}
}

func TestHandleMissionKeyNWithNoMissionsOpensCreateMissionModal(t *testing.T) {
	model := &Model{
		focus:                FocusMissions,
		missionsPaneExpanded: true,
	}

	cmd := model.handleMissionKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	if cmd != nil {
		t.Fatal("handleMissionKey(n) returned cmd, want nil")
	}
	if model.modal != ModalCreateMission {
		t.Fatalf("modal = %q, want %q", model.modal, ModalCreateMission)
	}
	if model.createMissionModal == nil {
		t.Fatal("createMissionModal = nil, want state")
	}
	if model.focus != FocusModal {
		t.Fatalf("focus = %q, want %q", model.focus, FocusModal)
	}
}

func TestBoardActionMsgKeepsMissionPaneOpenAfterMissionCreate(t *testing.T) {
	model := &Model{
		focus:                FocusBoard,
		missionsPaneExpanded: false,
	}

	board := BoardSnapshot{
		Missions: []MissionSnapshot{
			{
				ID:    "mission-1",
				Title: "New mission",
			},
		},
		UIState: UIStateRecord{},
	}

	updatedModel, cmd := model.Update(boardActionMsg{
		board:            &board,
		status:           "Created mission.",
		selectMissionID:  "mission-1",
		openMissionsPane: true,
	})
	if cmd != nil {
		t.Fatal("Update(boardActionMsg) returned cmd, want nil")
	}

	next := updatedModel.(*Model)
	if !next.missionsPaneExpanded {
		t.Fatal("missionsPaneExpanded = false, want true")
	}
	if next.focus != FocusMissions {
		t.Fatalf("focus = %q, want %q", next.focus, FocusMissions)
	}
	if next.selectedMission() == nil || next.selectedMission().ID != "mission-1" {
		t.Fatalf("selectedMission() = %#v, want mission-1", next.selectedMission())
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

func TestRenderTaskCardShowsMissionContext(t *testing.T) {
	model := &Model{
		missions: []MissionSnapshot{
			{
				ID:    "mission-1",
				Title: "Cross-repo rollout",
				Tasks: []MissionTaskRecord{
					{
						MissionID:       "mission-1",
						TaskID:          "task-1",
						ReleasedToBoard: true,
						Task:            TaskRecord{ID: "task-1", Title: "Ship follow-up"},
					},
				},
			},
		},
	}

	card := renderTaskCard(
		model,
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
	if !strings.Contains(plain, "Mission: Cross-repo rollout") {
		t.Fatalf("renderTaskCard() = %q, want mission context", plain)
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
