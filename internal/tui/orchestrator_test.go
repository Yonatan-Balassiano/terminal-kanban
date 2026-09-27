package tui

import (
	"math"
	"strconv"
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

	background := termenv.TrueColor.Color(orchestratorPalette[0].Solid).Sequence(true)
	plainTask := TaskRecord{ID: "task-1", Title: "Worker", UpdatedAt: 1}
	orchestratorTask := TaskRecord{ID: "task-2", Title: "Lead", UpdatedAt: 1, IsOrchestrator: true}
	model := &Model{tasks: []TaskRecord{plainTask, orchestratorTask}}

	plain := renderTaskCard(model, plainTask, false, false, nil, "web5-poc")
	orchestrator := renderTaskCard(model, orchestratorTask, false, false, nil, "web5-poc")

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
			visible := ansiPattern.ReplaceAllString(segment, "")
			if visible == "" || isBorderOnly(visible) {
				continue
			}
			if !strings.Contains(segment, background) {
				t.Fatalf("text after a reset lost the background: line %q", line)
			}
		}
		// Only the inside of the card is filled. A border glyph sits mid-cell,
		// so painting its cell spills colour outside the card's outline.
		for _, segment := range strings.Split(line, "\x1b[0m") {
			if isBorderOnly(ansiPattern.ReplaceAllString(segment, "")) && strings.Contains(segment, background) {
				t.Fatalf("border is painted with the card's background: line %q", line)
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

// Two orchestrators side by side must be told apart at a glance, and the
// colour must not reshuffle between redraws — so it follows creation order.
func TestEachOrchestratorGetsItsOwnStableColour(t *testing.T) {
	model := &Model{tasks: []TaskRecord{
		{ID: "late", IsOrchestrator: true, CreatedAt: 20},
		{ID: "plain", CreatedAt: 5},
		{ID: "early", IsOrchestrator: true, CreatedAt: 10},
	}}

	early, okEarly := model.orchestratorColourFor(model.tasks[2])
	late, okLate := model.orchestratorColourFor(model.tasks[0])
	_, okPlain := model.orchestratorColourFor(model.tasks[1])

	if !okEarly || !okLate || okPlain {
		t.Fatalf("ok flags = early %v, late %v, plain %v; want true, true, false", okEarly, okLate, okPlain)
	}
	if early != orchestratorPalette[0] || late != orchestratorPalette[1] {
		t.Fatalf("colours = %v, %v; want palette[0], palette[1] in creation order", early, late)
	}
}

// A subtask — or a subtask's subtask — belongs to the nearest orchestrator
// above it, so its whole family reads as one colour.
func TestSubtasksTakeTheirOrchestratorsColour(t *testing.T) {
	model := &Model{tasks: []TaskRecord{
		{ID: "other", IsOrchestrator: true, CreatedAt: 1},
		{ID: "lead", IsOrchestrator: true, CreatedAt: 2},
		{ID: "child", ParentTaskID: "lead", CreatedAt: 3},
		{ID: "grandchild", ParentTaskID: "child", CreatedAt: 4},
		{ID: "orphan", ParentTaskID: "gone", CreatedAt: 5},
		// A parent cycle must not hang the render loop.
		{ID: "loop-a", ParentTaskID: "loop-b", CreatedAt: 6},
		{ID: "loop-b", ParentTaskID: "loop-a", CreatedAt: 7},
	}}

	for _, id := range []string{"child", "grandchild"} {
		colour, ok := model.orchestratorColourFor(taskByID(model, id))
		if !ok || colour != orchestratorPalette[1] {
			t.Fatalf("%s colour = %v (ok %v), want the lead's palette[1]", id, colour, ok)
		}
	}
	for _, id := range []string{"orphan", "loop-a"} {
		if _, ok := model.orchestratorColourFor(taskByID(model, id)); ok {
			t.Fatalf("%s has an orchestrator colour, want none", id)
		}
	}
}

func TestRenderTaskCardTintsASubtasksTitle(t *testing.T) {
	previous := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	defer lipgloss.SetColorProfile(previous)

	lead := TaskRecord{ID: "lead", Title: "Lead", IsOrchestrator: true, UpdatedAt: 1}
	child := TaskRecord{ID: "child", Title: "Child work", ParentTaskID: "lead", UpdatedAt: 1}
	model := &Model{tasks: []TaskRecord{lead, child}}
	tint := termenv.TrueColor.Color(orchestratorPalette[0].Tint).Sequence(true)
	solid := termenv.TrueColor.Color(orchestratorPalette[0].Solid).Sequence(true)

	card := renderTaskCard(model, child, false, false, nil, "web5-poc")

	titleLine := ""
	for _, line := range strings.Split(card, "\n") {
		if strings.Contains(ansiPattern.ReplaceAllString(line, ""), "Child work") {
			titleLine = line
		}
	}
	if !strings.Contains(titleLine, tint) {
		t.Fatalf("subtask title line = %q, want tint %q", titleLine, tint)
	}
	// Only the title is tinted; the card itself is not filled like its lead.
	if strings.Contains(card, solid) {
		t.Fatalf("subtask card carries the orchestrator's solid fill: %q", card)
	}
}

func taskByID(m *Model, id string) TaskRecord {
	for _, task := range m.tasks {
		if task.ID == id {
			return task
		}
	}
	return TaskRecord{}
}

// The first palette was dark shades a step or two above the board's own
// background, and on a dark terminal they could not be seen at all. Every
// colour has to stand off the board, and still carry the card's text.
func TestOrchestratorPaletteIsVisible(t *testing.T) {
	const (
		minSolidAgainstBoard = 2.4
		minTintAgainstBoard  = 1.7
		minTextContrast      = 3.5
	)
	for index, colour := range orchestratorPalette {
		checks := []struct {
			name     string
			a, b     string
			minRatio float64
		}{
			{"solid vs board", colour.Solid, uiChrome.Panel, minSolidAgainstBoard},
			{"tint vs board", colour.Tint, uiChrome.Panel, minTintAgainstBoard},
			{"text on solid", uiChrome.Text, colour.Solid, minTextContrast},
			{"text on tint", uiChrome.Text, colour.Tint, minTextContrast},
		}
		for _, check := range checks {
			if got := contrastRatio(check.a, check.b); got < check.minRatio {
				t.Errorf("palette[%d] %s = %.2f, want >= %.1f", index, check.name, got, check.minRatio)
			}
		}
	}
}

// contrastRatio is the WCAG contrast ratio between two #rrggbb colours.
func contrastRatio(a, b string) float64 {
	la, lb := relativeLuminance(a), relativeLuminance(b)
	return (math.Max(la, lb) + 0.05) / (math.Min(la, lb) + 0.05)
}

func relativeLuminance(hex string) float64 {
	weights := []float64{0.2126, 0.7152, 0.0722}
	luminance := 0.0
	for index, weight := range weights {
		value, _ := strconv.ParseUint(hex[1+2*index:3+2*index], 16, 8)
		channel := float64(value) / 255
		if channel <= 0.03928 {
			channel /= 12.92
		} else {
			channel = math.Pow((channel+0.055)/1.055, 2.4)
		}
		luminance += weight * channel
	}
	return luminance
}

// isBorderOnly reports whether text is made only of card border glyphs.
func isBorderOnly(text string) bool {
	return text != "" && strings.Trim(text, "─│╭╮╰╯═║╔╗╚╝") == ""
}
