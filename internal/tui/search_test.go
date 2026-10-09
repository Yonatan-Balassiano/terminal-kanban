package tui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func newCardSearchModel() *Model {
	return &Model{
		focus: FocusBoard,
		tracks: []TrackRecord{
			{ID: "backlog", Label: "Backlog", SortOrder: 0},
			{ID: "in-progress", Label: "In Progress", SortOrder: 1},
		},
		tasks: []TaskRecord{
			{ID: "plain", TrackID: "backlog", Title: "Fix login", SortKey: 1},
			{ID: "img-1", TrackID: "backlog", Title: "Image upload", SortKey: 2},
			{ID: "img-2", TrackID: "in-progress", Title: "Resize IMAGES", SortKey: 1},
			{ID: "img-3", TrackID: "in-progress", Title: "image cache", SortKey: 2},
		},
	}
}

func typeCardSearch(model *Model, query string) {
	model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	for _, r := range query {
		model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	model.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
}

func pressRune(model *Model, r rune) {
	model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
}

func selectedID(t *testing.T, model *Model) string {
	t.Helper()
	task := model.selectedTask()
	if task == nil {
		t.Fatal("no card selected")
	}
	return task.ID
}

func TestCardSearchEnterJumpsToFirstMatchInReadingOrder(t *testing.T) {
	model := newCardSearchModel()
	model.selectTaskByID("img-3")

	typeCardSearch(model, "image")

	if got := selectedID(t, model); got != "img-1" {
		t.Fatalf("selected = %q, want the first match on the board, img-1", got)
	}
	if model.searchInputActive {
		t.Fatal("prompt still open after Enter")
	}
}

func TestCardSearchNAndPStepThroughMatchesAndWrap(t *testing.T) {
	model := newCardSearchModel()
	typeCardSearch(model, "image")

	steps := []struct {
		key  rune
		want string
	}{
		{'N', "img-2"},
		{'N', "img-3"},
		{'N', "img-1"}, // wraps forward
		{'P', "img-3"}, // wraps back
		{'P', "img-2"},
	}
	for i, step := range steps {
		pressRune(model, step.key)
		if got := selectedID(t, model); got != step.want {
			t.Fatalf("step %d (%c): selected = %q, want %q", i, step.key, got, step.want)
		}
	}
}

// Typing into the prompt must never fire the board's own keys — "n" is
// "new task" on the board.
func TestCardSearchPromptSwallowsBoardKeys(t *testing.T) {
	model := newCardSearchModel()
	pressRune(model, '/')
	pressRune(model, 'n')

	if model.modal != ModalNone {
		t.Fatalf("modal = %q, want none while typing a query", model.modal)
	}
	if model.searchInput != "n" {
		t.Fatalf("searchInput = %q, want %q", model.searchInput, "n")
	}
}

func TestCardSearchPKeepsCreatePillarWithoutASearch(t *testing.T) {
	model := newCardSearchModel()
	pressRune(model, 'P')
	if model.modal == ModalNone {
		t.Fatal("P with no live search should still open create-pillar")
	}
}

func TestCardSearchEscClearsTheSearch(t *testing.T) {
	model := newCardSearchModel()
	typeCardSearch(model, "image")
	model.handleKey(tea.KeyMsg{Type: tea.KeyEsc})

	if model.searchQuery != "" {
		t.Fatalf("searchQuery = %q after Esc, want empty", model.searchQuery)
	}
	pressRune(model, 'P')
	if model.modal == ModalNone {
		t.Fatal("P after clearing the search should open create-pillar again")
	}
}

func TestCardSearchWithNoMatchKeepsSelection(t *testing.T) {
	model := newCardSearchModel()
	model.selectTaskByID("img-2")
	typeCardSearch(model, "nothing-like-this")

	if got := selectedID(t, model); got != "img-2" {
		t.Fatalf("selected = %q, want unchanged img-2", got)
	}
	if model.statusMessage == "" {
		t.Fatal("expected a no-match status message")
	}
}
