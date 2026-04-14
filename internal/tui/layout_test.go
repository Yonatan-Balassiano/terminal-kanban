package tui

import (
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestBoardRenderWidthMatchesRenderedTrackColumns(t *testing.T) {
	model := &Model{
		tracks: []TrackRecord{
			{ID: "backlog", SortOrder: 1},
			{ID: "in-progress", SortOrder: 2},
			{ID: "done", SortOrder: 3},
		},
	}

	got := model.boardRenderWidth()
	want := 3 * trackColumnRenderWidth
	if got != want {
		t.Fatalf("boardRenderWidth() = %d, want %d", got, want)
	}
}

func TestTerminalContentWidthUsesRenderedBoardWidth(t *testing.T) {
	model := &Model{
		width:               125,
		terminalPaneVisible: true,
		activeTaskID:        "task-1",
		tracks: []TrackRecord{
			{ID: "backlog", SortOrder: 1},
			{ID: "in-progress", SortOrder: 2},
			{ID: "done", SortOrder: 3},
		},
	}

	got := model.terminalContentWidth()
	want := 125 - (3 * trackColumnRenderWidth) - terminalDividerWidth
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

func TestGitHubStatusBadgeModelBuildPassApproved(t *testing.T) {
	prNumber := 39
	badge := githubStatusBadgeModel(TaskRecord{
		PRNumber:    &prNumber,
		PRState:     "open",
		CIState:     "passed",
		ReviewState: "approved",
	})

	if badge == nil {
		t.Fatal("githubStatusBadgeModel() = nil, want badge")
	}
	if badge.Label != "build pass·approved·#39" {
		t.Fatalf("githubStatusBadgeModel() label = %q", badge.Label)
	}
	if badge.Tone != "success" {
		t.Fatalf("githubStatusBadgeModel() tone = %q, want success", badge.Tone)
	}
}

func TestGitHubStatusBadgeModelBuildFailChangesRequested(t *testing.T) {
	prNumber := 41
	badge := githubStatusBadgeModel(TaskRecord{
		PRNumber:    &prNumber,
		PRState:     "open",
		CIState:     "failed",
		ReviewState: "changes_requested",
	})

	if badge == nil {
		t.Fatal("githubStatusBadgeModel() = nil, want badge")
	}
	if badge.Label != "build fail·changes req·#41" {
		t.Fatalf("githubStatusBadgeModel() label = %q", badge.Label)
	}
	if badge.Tone != "danger" {
		t.Fatalf("githubStatusBadgeModel() tone = %q, want danger", badge.Tone)
	}
}

func TestGitHubStatusBadgeModelDraftPending(t *testing.T) {
	prNumber := 52
	badge := githubStatusBadgeModel(TaskRecord{
		PRNumber: &prNumber,
		PRState:  "draft",
		PRDraft:  true,
		CIState:  "pending",
	})

	if badge == nil {
		t.Fatal("githubStatusBadgeModel() = nil, want badge")
	}
	if badge.Label != "build pending·draft·#52" {
		t.Fatalf("githubStatusBadgeModel() label = %q", badge.Label)
	}
	if badge.Tone != "warning" {
		t.Fatalf("githubStatusBadgeModel() tone = %q, want warning", badge.Tone)
	}
}

func TestTaskCardBorderColorTreatsChangesRequestedAsRed(t *testing.T) {
	color := taskCardBorderColor(TaskRecord{
		PRState:     "open",
		CIState:     "passed",
		ReviewState: "changes_requested",
	}, false)

	if color != "red" {
		t.Fatalf("taskCardBorderColor() = %q, want red", color)
	}
}
