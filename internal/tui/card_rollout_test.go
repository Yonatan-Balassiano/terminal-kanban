package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func cardRolloutModel(release *TaskReleaseSummary, artifacts ...ArtifactRecord) *Model {
	task := TaskRecord{
		ID:      "task-1",
		Title:   "Ecom catalog e2e feature",
		TrackID: "shipping",
		PRState: "merged",
		Release: release,
	}
	return &Model{
		tasks:     []TaskRecord{task},
		tracks:    []TrackRecord{{ID: "shipping", Label: "Shipping"}},
		artifacts: ArtifactsSnapshot{Artifacts: artifacts},
	}
}

func builtNotShipped() *TaskReleaseSummary {
	return &TaskReleaseSummary{
		Stage:                "rc-built",
		Confidence:           "confirmed",
		BlockingArtifact:     "web5.svc",
		BlockingArtifactName: "com.wixpress.web5.svc",
		BlockingRcVersion:    "1.292.0",
		BlockingGaVersion:    "1.279.0",
		GatingCount:          1,
	}
}

// The card already knows the artifact and the version carrying its change.
// Making the user find that artifact in the footer and work the version out by
// hand was the missing half of answering "has it shipped yet".
func TestRollingOutFromACardTargetsTheVersionCarryingItsChange(t *testing.T) {
	m := cardRolloutModel(builtNotShipped())

	m.openArtifactRolloutModal()

	if m.modal != ModalArtifactRollout {
		t.Fatalf("modal = %q, want the rollout modal", m.modal)
	}
	state := m.artifactRolloutModal
	if state.Name != "com.wixpress.web5.svc" {
		t.Fatalf("artifact = %q, want the card's blocking artifact", state.Name)
	}
	// Not the newest candidate: rolling further would ship work the user never
	// looked at.
	if state.TargetVersion != "1.292.0" || state.CurrentVersion != "1.279.0" {
		t.Fatalf("versions = %s -> %s, want 1.279.0 -> 1.292.0", state.CurrentVersion, state.TargetVersion)
	}
	if state.ShippingCard != "Ecom catalog e2e feature" {
		t.Fatalf("shipping = %q, want the card title", state.ShippingCard)
	}
}

func TestCardRolloutStillNeedsTheTypedConfirmation(t *testing.T) {
	// A production deploy must never be one keypress, however it was opened.
	m := cardRolloutModel(builtNotShipped())
	m.openArtifactRolloutModal()

	if cmd := m.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyEnter}); cmd != nil {
		t.Fatal("Enter shipped to production without the typed confirmation")
	}
}

func TestCardRolloutIsOfferedOnlyForWorkThatCanShip(t *testing.T) {
	cases := []struct {
		name    string
		release *TaskReleaseSummary
	}{
		{name: "already shipped", release: &TaskReleaseSummary{Stage: "ga"}},
		{name: "already rolling out", release: &TaskReleaseSummary{
			Stage: "rolling-out", BlockingArtifactName: "com.a", BlockingRcVersion: "1.0.0",
		}},
		{name: "no candidate built yet", release: &TaskReleaseSummary{Stage: "awaiting-build"}},
		{name: "nothing tracked ships it", release: &TaskReleaseSummary{Stage: "no-artifact"}},
		{name: "could not tell", release: &TaskReleaseSummary{Stage: "unknown"}},
		{name: "not resolved yet", release: nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := cardRolloutModel(tc.release)
			if state := m.cardRolloutState(); state != nil {
				t.Fatalf("offered a rollout for %q: %+v", tc.name, state)
			}
		})
	}
}

// G keeps meaning "roll out the artifact I selected" everywhere it always did,
// so the card path adds a capability rather than replacing one.
func TestRollingOutFallsBackToTheFooterArtifact(t *testing.T) {
	m := cardRolloutModel(&TaskReleaseSummary{Stage: "ga"}, ArtifactRecord{
		Name:            "com.wixpress.other",
		ShortName:       "other",
		Status:          ArtifactStatusDrift,
		GAVersion:       "1.0.0",
		LatestRCVersion: "1.4.0",
	})

	m.openArtifactRolloutModal()

	state := m.artifactRolloutModal
	if state == nil || state.Name != "com.wixpress.other" {
		t.Fatalf("expected the footer artifact, got %+v", state)
	}
	if state.ShippingCard != "" {
		t.Fatalf("footer rollout claimed to ship a card: %q", state.ShippingCard)
	}
}

func TestCardRolloutCarriesOwnershipFromTheCatalog(t *testing.T) {
	// The card summary does not carry these, so the modal has to read them from
	// the catalog or it would look different depending on how it was opened.
	pending, mine := 13, 2
	m := cardRolloutModel(builtNotShipped(), ArtifactRecord{
		Name:           "com.wixpress.web5.svc",
		ShortName:      "web5.svc",
		Status:         ArtifactStatusDrift,
		PendingRcCount: &pending,
		MyPendingCount: &mine,
	})

	m.openArtifactRolloutModal()

	state := m.artifactRolloutModal
	if state.PendingRcCount == nil || *state.PendingRcCount != 13 {
		t.Fatalf("pending count = %v, want 13", state.PendingRcCount)
	}
	if state.MyPendingCount == nil || *state.MyPendingCount != 2 {
		t.Fatalf("my pending count = %v, want 2", state.MyPendingCount)
	}
}

func TestCardRolloutModalNamesWhatItShips(t *testing.T) {
	m := cardRolloutModel(builtNotShipped())
	m.openArtifactRolloutModal()

	rendered := renderArtifactRolloutModal(m)

	for _, want := range []string{"com.wixpress.web5.svc", "1.279.0", "1.292.0", "Ecom catalog e2e feature"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("modal is missing %q:\n%s", want, rendered)
		}
	}
}
