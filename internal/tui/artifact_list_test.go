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

// openEditor opens the editor and hands it the configured list, standing in for
// the getTrackedArtifacts round trip the daemon would answer.
func openEditor(m *Model, configured ...string) {
	m.openArtifactListModal()
	m.Update(trackedArtifactsLoadedMsg{names: configured})
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
	if !m.artifactListModal.Loading {
		t.Fatalf("editor opened already populated; it must wait for the configured list")
	}

	m.Update(trackedArtifactsLoadedMsg{names: []string{"com.wixpress.web5.ecom-integrations"}})

	if got := m.artifactListModal.Names; len(got) != 1 || got[0] != "com.wixpress.web5.ecom-integrations" {
		t.Fatalf("editor seeded with %v", got)
	}
}

// The rail carries what devex resolved; the config carries what is tracked. They
// differ whenever a lookup fails, and for the moment after every save while the
// refresh is still in flight. Seeding from the rail dropped the difference, and
// the next save wrote the shortened list to disk — deleting artifacts the user
// never touched.
func TestEditorOpensOnTheConfiguredListNotTheRail(t *testing.T) {
	// One artifact resolved; three are configured.
	m := artifactListModel("com.wixpress.resolved")
	configured := []string{"com.wixpress.resolved", "com.wixpress.unreachable", "com.wixpress.new"}

	openEditor(m, configured...)

	if got := strings.Join(m.artifactListModal.Names, ","); got != strings.Join(configured, ",") {
		t.Fatalf("editor seeded with %q, want the configured list %q", got, strings.Join(configured, ","))
	}
}

// A save fired before the list landed would write a list the user never saw —
// which is exactly how the seeded artifacts were lost.
func TestEditorRefusesEditsUntilTheConfiguredListArrives(t *testing.T) {
	m := artifactListModel()
	m.openArtifactListModal()

	pressKeys(t, m, "a", "d", "enter")

	if m.artifactListModal == nil {
		t.Fatalf("editor closed while loading")
	}
	if m.artifactListModal.Adding || m.artifactListModal.Applying {
		t.Fatalf("editor accepted input while loading: %+v", m.artifactListModal)
	}

	m.Update(trackedArtifactsLoadedMsg{names: []string{"com.wixpress.a"}})

	if got := m.artifactListModal.Names; len(got) != 1 || got[0] != "com.wixpress.a" {
		t.Fatalf("names = %v, want the configured list intact", got)
	}
}

// "Nothing tracked yet" is a claim about the config, so it must not be made
// before the config has been read.
func TestEditorSaysItIsLoadingRatherThanClaimingNothingIsTracked(t *testing.T) {
	m := artifactListModel()
	m.openArtifactListModal()

	rendered := renderArtifactListModal(m)

	if strings.Contains(rendered, "Nothing tracked yet") {
		t.Fatalf("editor claimed an empty config before reading it:\n%s", rendered)
	}
	if !strings.Contains(rendered, "Loading") {
		t.Fatalf("editor gave no sign it is still loading:\n%s", rendered)
	}
}

func TestAddingAnArtifactAppendsItToTheList(t *testing.T) {
	m := artifactListModel("com.wixpress.a")
	openEditor(m, "com.wixpress.a")

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
	openEditor(m, "com.wixpress.a")

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
	openEditor(m, "com.a", "com.b")

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
	openEditor(m, "com.a")

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
	openEditor(m, "com.wixpress.web5.ecom-integrations")

	rendered := renderArtifactListModal(m)

	for _, want := range []string{"TRACKED ARTIFACTS", "com.wixpress.web5.ecom-integrations", "a add", "d remove"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered modal is missing %q:\n%s", want, rendered)
		}
	}
}
