package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func portalBoard(artifacts ...ArtifactRecord) *Model {
	return &Model{
		width:     200,
		height:    40,
		focus:     FocusBoard,
		modal:     ModalNone,
		tracks:    []TrackRecord{{ID: "in-progress", SortOrder: 1}},
		artifacts: ArtifactsSnapshot{Artifacts: artifacts},
	}
}

// The portal keys on the full project id; the rail chip shows only its tail, so
// building the URL from the label would 404.
func TestDevPortalURLUsesTheFullProjectID(t *testing.T) {
	got := artifactDevPortalURL(ArtifactRecord{
		Name:      "com.wixpress.enterprise.web5.conversation-configuration",
		ShortName: "enterprise.web5.conversation-configuration",
	})

	want := "https://wix-bo.com/dev/project/com.wixpress.enterprise.web5.conversation-configuration"
	if got != want {
		t.Fatalf("url = %q, want %q", got, want)
	}
}

func TestDevPortalURLIsEmptyWithoutAProjectID(t *testing.T) {
	if got := artifactDevPortalURL(ArtifactRecord{ShortName: "orphan"}); got != "" {
		t.Fatalf("url = %q, want empty so the caller can say why", got)
	}
}

// A rollout is refused for an in-sync artifact; opening a page is not, because
// the portal is also where you go to look.
func TestLowercaseGOpensThePortalForAnyArtifact(t *testing.T) {
	for _, status := range []ArtifactStatus{ArtifactStatusInSync, ArtifactStatusDrift, ArtifactStatusNoGA} {
		m := portalBoard(ArtifactRecord{Name: "com.wixpress.a", ShortName: "a", Status: status})

		cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("g")})

		if cmd == nil {
			t.Fatalf("status %q: g produced no command; status line said %q", status, m.statusMessage)
		}
		if m.modal != ModalNone {
			t.Fatalf("status %q: g opened modal %q instead of the browser", status, m.modal)
		}
	}
}

// Pressing G with an empty rail must say what to do rather than doing nothing.
func TestGWithNoArtifactSelectedSaysSo(t *testing.T) {
	m := portalBoard()

	if cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("g")}); cmd != nil {
		t.Fatalf("G returned a command with nothing selected")
	}
	if !strings.Contains(m.statusMessage, "No artifact selected") {
		t.Fatalf("statusMessage = %q, want it to name the problem", m.statusMessage)
	}
}

// Uppercase G keeps the gradual rollout it always had.
func TestUppercaseGStillOpensTheGradualRolloutConfirm(t *testing.T) {
	m := portalBoard(ArtifactRecord{
		Name: "com.wixpress.a", ShortName: "a", Status: ArtifactStatusDrift,
		GAVersion: "1.1.0", LatestRCVersion: "1.2.0",
	})

	m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("G")})

	if m.modal != ModalArtifactRollout {
		t.Fatalf("modal = %q, want %q; status = %q", m.modal, ModalArtifactRollout, m.statusMessage)
	}
}

// Lowercase g used to open the view/layout modal, which moved to V rather than
// losing its key entirely.
func TestVOpensTheViewModal(t *testing.T) {
	m := portalBoard()

	m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("V")})

	if m.modal != ModalViewPicker {
		t.Fatalf("modal = %q, want %q", m.modal, ModalViewPicker)
	}
}
