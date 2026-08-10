package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// leaderBoard is a board with two cards in one column, enough for navigation and
// for chords that need a selected card.
func leaderBoard() *Model {
	return &Model{
		width:              200,
		height:             40,
		focus:              FocusBoard,
		modal:              ModalNone,
		repos:              []RepoRecord{{ID: "repo-a", Label: "a"}, {ID: "repo-b", Label: "b"}},
		tracks:             []TrackRecord{{ID: "in-progress", SortOrder: 1}},
		selectedTrackIndex: 0,
		selectedTaskIndex:  0,
		tasks: []TaskRecord{
			{ID: "task-1", Title: "First", TrackID: "in-progress", SortKey: 1, RepoID: "repo-a"},
			{ID: "task-2", Title: "Second", TrackID: "in-progress", SortKey: 2, RepoID: "repo-a"},
		},
	}
}

func typeKeys(m *Model, keys string) {
	for _, r := range keys {
		m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
}

// withChords swaps the table for a predictable one, so engine behaviour is
// tested without depending on what any real action does.
func withChords(t *testing.T, chords []leaderChord) {
	t.Helper()
	original := leaderChords
	leaderChords = chords
	t.Cleanup(func() { leaderChords = original })
}

// The whole point of the leader: hjkl can mean movement only, because actions
// moved to a namespace that does not compete with it.
func TestJMovesDownInsteadOfOpeningTheCommentModal(t *testing.T) {
	m := leaderBoard()

	typeKeys(m, "j")

	if m.modal != ModalNone {
		t.Fatalf("j opened modal %q; it must navigate", m.modal)
	}
	if m.selectedTaskIndex != 1 {
		t.Fatalf("selectedTaskIndex = %d, want 1", m.selectedTaskIndex)
	}

	typeKeys(m, "k")

	if m.selectedTaskIndex != 0 {
		t.Fatalf("k did not move back up: selectedTaskIndex = %d", m.selectedTaskIndex)
	}
}

func TestLeaderRunsTheChordItSpells(t *testing.T) {
	ran := ""
	withChords(t, []leaderChord{
		{Seq: "ga", Run: func(m *Model) tea.Cmd { ran = "ga"; return nil }},
		{Seq: "gr", Run: func(m *Model) tea.Cmd { ran = "gr"; return nil }},
	})
	m := leaderBoard()

	typeKeys(m, ",ga")

	if ran != "ga" {
		t.Fatalf("ran = %q, want the ,ga chord", ran)
	}
	if m.leaderPending {
		t.Fatalf("leader still pending after the chord completed")
	}
}

// A prefix must wait rather than firing something or falling through to the
// board, where "g" alone opens the layout modal.
func TestLeaderWaitsOnAnIncompletePrefix(t *testing.T) {
	ran := ""
	withChords(t, []leaderChord{
		{Seq: "ga", Run: func(m *Model) tea.Cmd { ran = "ga"; return nil }},
	})
	m := leaderBoard()

	typeKeys(m, ",g")

	if ran != "" {
		t.Fatalf("ran %q on an incomplete chord", ran)
	}
	if !m.leaderPending || m.leaderBuffer != "g" {
		t.Fatalf("pending = %v, buffer = %q, want a pending \"g\"", m.leaderPending, m.leaderBuffer)
	}
	if m.modal != ModalNone {
		t.Fatalf("the board saw the prefix key and opened %q", m.modal)
	}
	if got := m.leaderIndicator(); !strings.Contains(got, ",g") {
		t.Fatalf("indicator = %q, want it to show the pending prefix", got)
	}
}

func TestLeaderReportsAnUnknownChordAndStopsWaiting(t *testing.T) {
	withChords(t, []leaderChord{{Seq: "ga", Run: func(m *Model) tea.Cmd { return nil }}})
	m := leaderBoard()

	// One key is enough: nothing starts with "z", so the chord dies immediately
	// rather than collecting more keys that would never match.
	typeKeys(m, ",z")

	if m.leaderPending {
		t.Fatalf("leader latched on after an unknown chord")
	}
	if !strings.Contains(m.statusMessage, "No such chord") {
		t.Fatalf("statusMessage = %q, want it to name the miss", m.statusMessage)
	}

	// And the next key reaches the board as itself.
	typeKeys(m, "j")

	if m.selectedTaskIndex != 1 {
		t.Fatalf("the key after a failed chord was swallowed: selectedTaskIndex = %d", m.selectedTaskIndex)
	}
}

// A chord left half-typed must not swallow the keystroke after it.
func TestEscapeAbandonsAPendingChord(t *testing.T) {
	withChords(t, []leaderChord{{Seq: "ga", Run: func(m *Model) tea.Cmd { return nil }}})
	m := leaderBoard()

	typeKeys(m, ",g")
	m.handleKey(tea.KeyMsg{Type: tea.KeyEsc})

	if m.leaderPending {
		t.Fatalf("escape left the chord pending")
	}

	typeKeys(m, "j")

	if m.selectedTaskIndex != 1 {
		t.Fatalf("the key after escape was swallowed: selectedTaskIndex = %d", m.selectedTaskIndex)
	}
}

func TestAPendingChordLapsesOnItsOwn(t *testing.T) {
	withChords(t, []leaderChord{{Seq: "ga", Run: func(m *Model) tea.Cmd { return nil }}})
	m := leaderBoard()

	typeKeys(m, ",g")
	m.Update(leaderTimeoutMsg{Version: m.leaderVersion})

	if m.leaderPending {
		t.Fatalf("the chord outlived its timeout")
	}
}

// Each keystroke re-arms, so the timer the previous one scheduled must not
// cancel a chord the user is still typing.
func TestAStaleTimeoutDoesNotCancelALiveChord(t *testing.T) {
	withChords(t, []leaderChord{{Seq: "gab", Run: func(m *Model) tea.Cmd { return nil }}})
	m := leaderBoard()

	typeKeys(m, ",")
	stale := m.leaderVersion
	typeKeys(m, "g")

	m.Update(leaderTimeoutMsg{Version: stale})

	if !m.leaderPending || m.leaderBuffer != "g" {
		t.Fatalf("a stale timeout cancelled the chord: pending = %v, buffer = %q",
			m.leaderPending, m.leaderBuffer)
	}
}

// A chord that is a strict prefix of another could never fire: the engine would
// always still be waiting for the longer one.
func TestNoChordIsUnreachable(t *testing.T) {
	seen := map[string]bool{}
	for _, chord := range leaderChords {
		if chord.Seq == "" {
			t.Fatalf("chord %q has an empty sequence", chord.Desc)
		}
		if seen[chord.Seq] {
			t.Fatalf("duplicate chord %q%s", leaderKey, chord.Seq)
		}
		seen[chord.Seq] = true
	}

	for _, outer := range leaderChords {
		for _, inner := range leaderChords {
			if outer.Seq != inner.Seq && strings.HasPrefix(inner.Seq, outer.Seq) {
				t.Fatalf("%q%s can never fire: %q%s starts with it",
					leaderKey, outer.Seq, leaderKey, inner.Seq)
			}
		}
	}
}

// Every chord must describe itself, since the help screen is generated from it.
func TestEveryChordIsDocumented(t *testing.T) {
	for _, chord := range leaderChords {
		if strings.TrimSpace(chord.Desc) == "" || strings.TrimSpace(chord.Group) == "" {
			t.Fatalf("chord %q%s is missing a group or description", leaderKey, chord.Seq)
		}
		if chord.Run == nil {
			t.Fatalf("chord %q%s does nothing", leaderKey, chord.Seq)
		}
	}

	rendered := strings.Join(leaderChordsByGroup(), "\n")
	for _, want := range []string{",ga", ",pc", ",tn", ",rp"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("help listing is missing %q:\n%s", want, rendered)
		}
	}
}

// The user's own example, checked against the real table. ",ga" means "GA it",
// which is the portal — the API can only roll out gradually.
func TestGaOpensTheDevPortal(t *testing.T) {
	chord, _ := leaderChordFor("ga")
	if chord == nil {
		t.Fatalf(",ga is not bound")
	}

	m := leaderBoard()
	m.artifacts = ArtifactsSnapshot{Artifacts: []ArtifactRecord{{
		Name: "com.wixpress.a", ShortName: "a", Status: ArtifactStatusDrift,
		GAVersion: "1.1.0", LatestRCVersion: "1.2.0",
	}}}

	typeKeys(m, ",ga")

	if m.modal != ModalNone {
		t.Fatalf("modal = %q, want the browser rather than a modal", m.modal)
	}
	if strings.Contains(m.statusMessage, "No artifact") {
		t.Fatalf(",ga could not find the selected artifact: %q", m.statusMessage)
	}
}

// The gradual rollout keeps a home of its own, so taking ",ga" for the portal
// does not strand it.
func TestGdStillOpensTheGradualRolloutConfirm(t *testing.T) {
	m := leaderBoard()
	m.artifacts = ArtifactsSnapshot{Artifacts: []ArtifactRecord{{
		Name: "com.wixpress.a", ShortName: "a", Status: ArtifactStatusDrift,
		GAVersion: "1.1.0", LatestRCVersion: "1.2.0",
	}}}

	typeKeys(m, ",gd")

	if m.modal != ModalArtifactRollout {
		t.Fatalf("modal = %q, want %q; status = %q", m.modal, ModalArtifactRollout, m.statusMessage)
	}
}

// The leader took `,` from previous-repo, so both directions must have a home.
func TestRepoSwitchingSurvivedLosingItsKey(t *testing.T) {
	for _, seq := range []string{"rn", "rp"} {
		if chord, _ := leaderChordFor(seq); chord == nil {
			t.Fatalf("%q%s is not bound", leaderKey, seq)
		}
	}
}
