package tui

import "testing"

func TestMovedCardKeepsTheSelection(t *testing.T) {
	model := &Model{
		focus: FocusBoard,
		tracks: []TrackRecord{
			{ID: "in-progress", Label: "In Progress", SortOrder: 0},
			{ID: "review", Label: "Review", SortOrder: 1},
			{ID: "shipping", Label: "Shipping", SortOrder: 2},
			{ID: "done", Label: "Done", SortOrder: 3},
		},
		tasks: []TaskRecord{
			{ID: "moving", TrackID: "in-progress", Title: "Moving", SortKey: 1},
			{ID: "staying", TrackID: "in-progress", Title: "Staying", SortKey: 2},
			{ID: "done-1", TrackID: "done", Title: "Done one", SortKey: 1},
		},
	}
	model.selectTaskByID("moving")

	moved := BoardSnapshot{Tracks: model.tracks, Tasks: []TaskRecord{
		{ID: "moving", TrackID: "done", Title: "Moving", SortKey: 2},
		{ID: "staying", TrackID: "in-progress", Title: "Staying", SortKey: 2},
		{ID: "done-1", TrackID: "done", Title: "Done one", SortKey: 1},
	}}
	model.Update(boardActionMsg{board: &moved, selectTaskID: "moving"})

	if got := selectedID(t, model); got != "moving" {
		t.Fatalf("selected = %q, want the moved card", got)
	}
	// Narrow enough that only one column fits: the visible one must be Done.
	plan := planBoardRender(model, 1, model.sortedTracks())
	if model.selectedTrackIndex < plan.trackStart || model.selectedTrackIndex >= plan.trackEnd {
		t.Fatalf("selected column %d outside visible range [%d,%d)", model.selectedTrackIndex, plan.trackStart, plan.trackEnd)
	}
}

func TestSyncMovingTheSelectedCardKeepsItSelected(t *testing.T) {
	model := &Model{
		focus:  FocusBoard,
		tracks: []TrackRecord{{ID: "in-progress", SortOrder: 0}, {ID: "pr", SortOrder: 1}},
		tasks: []TaskRecord{
			{ID: "a", TrackID: "in-progress", SortKey: 1},
			{ID: "b", TrackID: "in-progress", SortKey: 2},
		},
	}
	model.selectTaskByID("b")

	// The sync loop advances the selected card to PR on its own.
	synced := BoardSnapshot{Tracks: model.tracks, Tasks: []TaskRecord{
		{ID: "a", TrackID: "in-progress", SortKey: 1},
		{ID: "b", TrackID: "pr", SortKey: 2},
	}}
	model.Update(boardLoadedMsg{board: synced})

	if got := selectedID(t, model); got != "b" {
		t.Fatalf("selected = %q, want the card the sync loop moved", got)
	}
	if model.selectedTrackIndex != 1 {
		t.Fatalf("selected column = %d, want the PR column", model.selectedTrackIndex)
	}
}

func TestSyncMovingAnotherCardLeavesTheSelectionOnItsCard(t *testing.T) {
	model := &Model{
		focus:  FocusBoard,
		tracks: []TrackRecord{{ID: "in-progress", SortOrder: 0}, {ID: "pr", SortOrder: 1}},
		tasks: []TaskRecord{
			{ID: "a", TrackID: "in-progress", SortKey: 1},
			{ID: "b", TrackID: "in-progress", SortKey: 2},
		},
	}
	model.selectTaskByID("b")

	// A card above the selection leaves the column, so "b" shifts up a row.
	synced := BoardSnapshot{Tracks: model.tracks, Tasks: []TaskRecord{
		{ID: "a", TrackID: "pr", SortKey: 1},
		{ID: "b", TrackID: "in-progress", SortKey: 2},
	}}
	model.Update(boardLoadedMsg{board: synced})

	if got := selectedID(t, model); got != "b" {
		t.Fatalf("selected = %q, want the selection to stay on its card", got)
	}
	if model.selectedTrackIndex != 0 {
		t.Fatalf("selected column = %d, want the user's column to stay put", model.selectedTrackIndex)
	}
}

func TestRemovedSelectedCardFallsBackToTheNearestSlot(t *testing.T) {
	model := &Model{
		focus:  FocusBoard,
		tracks: []TrackRecord{{ID: "in-progress", SortOrder: 0}},
		tasks: []TaskRecord{
			{ID: "a", TrackID: "in-progress", SortKey: 1},
			{ID: "b", TrackID: "in-progress", SortKey: 2},
		},
	}
	model.selectTaskByID("b")

	model.Update(boardLoadedMsg{board: BoardSnapshot{Tracks: model.tracks, Tasks: []TaskRecord{
		{ID: "a", TrackID: "in-progress", SortKey: 1},
	}}})

	if got := selectedID(t, model); got != "a" {
		t.Fatalf("selected = %q, want the remaining card", got)
	}
}
