package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func artifactListModel(names ...string) *Model {
	records := make([]ArtifactRecord, 0, len(names))
	for _, name := range names {
		records = append(records, ArtifactRecord{Name: name, ShortName: name})
	}
	return &Model{artifacts: ArtifactsSnapshot{Artifacts: records}}
}

func pressKeys(t *testing.T, m *Model, keys ...string) {
	t.Helper()
	for _, key := range keys {
		var msg tea.KeyMsg
		switch key {
		case "esc":
			msg = tea.KeyMsg{Type: tea.KeyEsc}
		case "enter":
			msg = tea.KeyMsg{Type: tea.KeyEnter}
		case "up":
			msg = tea.KeyMsg{Type: tea.KeyUp}
		case "down":
			msg = tea.KeyMsg{Type: tea.KeyDown}
		case "backspace":
			msg = tea.KeyMsg{Type: tea.KeyBackspace}
		default:
			msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)}
		}
		m.handleArtifactListModalKey(msg)
	}
}

// The list used to live only in config.json, so adding one meant a text editor
// and a daemon restart — and until then a merged card touching that artifact
// reported "nothing to ship".
func TestTOpensTheTrackedArtifactEditor(t *testing.T) {
	m := artifactListModel("com.wixpress.web5.ecom-integrations")

	m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("T")})

	if m.modal != ModalArtifactList {
		t.Fatalf("modal = %q, want %q", m.modal, ModalArtifactList)
	}
	if got := m.artifactListModal.Names; len(got) != 1 || got[0] != "com.wixpress.web5.ecom-integrations" {
		t.Fatalf("editor seeded with %v", got)
	}
}

func TestAddingAnArtifactAppendsItToTheList(t *testing.T) {
	m := artifactListModel("com.wixpress.a")
	m.openArtifactListModal()

	pressKeys(t, m, "a")
	pressKeys(t, m, "c", "o", "m", ".", "b")
	pressKeys(t, m, "enter")

	want := []string{"com.wixpress.a", "com.b"}
	if got := m.artifactListModal.Names; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("names = %v, want %v", got, want)
	}
}

func TestAddingAnArtifactAlreadyTrackedSaysSoInsteadOfDuplicating(t *testing.T) {
	m := artifactListModel("com.wixpress.a")
	m.openArtifactListModal()

	pressKeys(t, m, "a")
	pressKeys(t, m, "c", "o", "m", ".", "w", "i", "x", "p", "r", "e", "s", "s", ".", "a")
	pressKeys(t, m, "enter")

	if len(m.artifactListModal.Names) != 1 {
		t.Fatalf("names = %v, want the list unchanged", m.artifactListModal.Names)
	}
	if !strings.Contains(m.artifactListModal.Error, "Already tracked") {
		t.Fatalf("error = %q, want it to say the artifact is already tracked", m.artifactListModal.Error)
	}
}

func TestRemovingAnArtifactKeepsTheSelectionInRange(t *testing.T) {
	m := artifactListModel("com.a", "com.b")
	m.openArtifactListModal()

	pressKeys(t, m, "down", "d")

	if got := m.artifactListModal.Names; len(got) != 1 || got[0] != "com.a" {
		t.Fatalf("names = %v", got)
	}
	// A selection left past the end would index out of range on the next render.
	if m.artifactListModal.Selected != 0 {
		t.Fatalf("selected = %d, want 0", m.artifactListModal.Selected)
	}
}

// Nothing may reach the running rail until the user confirms, or a stray
// keystroke would silently change what the board tracks.
func TestEscapeDiscardsEditsWithoutApplyingThem(t *testing.T) {
	m := artifactListModel("com.a")
	m.openArtifactListModal()

	pressKeys(t, m, "d", "esc")

	if m.modal != ModalNone {
		t.Fatalf("modal = %q, want it closed", m.modal)
	}
	if len(m.artifacts.Artifacts) != 1 {
		t.Fatalf("the rail changed on cancel: %v", m.artifacts.Artifacts)
	}
}

func TestArtifactListModalShowsWhatTheListIsFor(t *testing.T) {
	m := artifactListModel("com.wixpress.web5.ecom-integrations")
	m.openArtifactListModal()

	rendered := renderArtifactListModal(m)

	for _, want := range []string{"TRACKED ARTIFACTS", "com.wixpress.web5.ecom-integrations", "a add", "d remove"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered modal is missing %q:\n%s", want, rendered)
		}
	}
}
