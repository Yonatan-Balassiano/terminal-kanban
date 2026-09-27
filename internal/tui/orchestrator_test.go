package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// An orchestrator card coordinates the others, so it is the one you look for
// first — it sits at the top of its column regardless of where its sort key
// would put it, while every other card keeps its usual order.
func TestTasksByTrackPinsOrchestratorsToTheTop(t *testing.T) {
	model := &Model{
		tracks: []TrackRecord{{ID: "in-progress", Label: "In Progress"}},
		tasks: []TaskRecord{
			{ID: "a", TrackID: "in-progress", SortKey: 1},
			{ID: "orch-late", TrackID: "in-progress", SortKey: 9, IsOrchestrator: true},
			{ID: "b", TrackID: "in-progress", SortKey: 2},
			{ID: "orch-early", TrackID: "in-progress", SortKey: 5, IsOrchestrator: true},
		},
	}

	got := []string{}
	for _, task := range model.tasksByTrack()["in-progress"] {
		got = append(got, task.ID)
	}

	want := []string{"orch-early", "orch-late", "a", "b"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("tasksByTrack() order = %v, want %v", got, want)
	}
}

func TestRenderTaskCardPaintsAnOrchestratorsBackground(t *testing.T) {
	// Tests run without a tty, where lipgloss drops every colour it is handed —
	// so ask for a profile that actually emits them, or this asserts nothing.
	previous := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	defer lipgloss.SetColorProfile(previous)

	background := termenv.TrueColor.Color(orchestratorCardBackground).Sequence(true)
	plainTask := TaskRecord{ID: "task-1", Title: "Worker", UpdatedAt: 1}
	orchestratorTask := TaskRecord{ID: "task-2", Title: "Lead", UpdatedAt: 1, IsOrchestrator: true}

	plain := renderTaskCard(&Model{}, plainTask, false, false, nil, "web5-poc")
	orchestrator := renderTaskCard(&Model{}, orchestratorTask, false, false, nil, "web5-poc")

	if strings.Contains(plain, background) {
		t.Fatalf("plain card carries the orchestrator background: %q", plain)
	}
	if !strings.Contains(orchestrator, background) {
		t.Fatalf("orchestrator card = %q, want background %q", orchestrator, background)
	}
	// Every inner segment ends in a full reset, which would drop the card's
	// background for the rest of that line — so it must be re-applied after
	// each one, or only the padding ends up tinted.
	for _, line := range strings.Split(orchestrator, "\n") {
		for _, segment := range strings.Split(line, "\x1b[0m")[1:] {
			if segment == "" || ansiPattern.ReplaceAllString(segment, "") == "" {
				continue
			}
			if !strings.Contains(segment, background) {
				t.Fatalf("text after a reset lost the background: line %q", line)
			}
		}
	}
	// Adding a background must not change the card's layout.
	if lipgloss.Height(plain) != lipgloss.Height(orchestrator) || lipgloss.Width(plain) != lipgloss.Width(orchestrator) {
		t.Fatalf("orchestrator card is %dx%d, plain card is %dx%d",
			lipgloss.Width(orchestrator), lipgloss.Height(orchestrator),
			lipgloss.Width(plain), lipgloss.Height(plain))
	}
}
