package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestHandleCreateTaskModalKeyNavigatesToAgentLine(t *testing.T) {
	model := &Model{
		createTaskModal: &createTaskModalState{
			Value:       "Ship it",
			RepoIndex:   0,
			PillarIndex: 0,
			AgentIndex:  0,
			ActiveLine:  createTaskPillarLine,
		},
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyDown})

	if model.createTaskModal.ActiveLine != createTaskAgentLine {
		t.Fatalf("active line = %q, want %q", model.createTaskModal.ActiveLine, createTaskAgentLine)
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyRight})

	if model.createTaskModal.AgentIndex != 1 {
		t.Fatalf("agent index = %d, want 1", model.createTaskModal.AgentIndex)
	}
}

func TestRenderCreateTaskModalShowsSelectedAgent(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo"},
		},
		createTaskModal: &createTaskModalState{
			Value:       "Ship it",
			RepoIndex:   0,
			PillarIndex: 0,
			AgentIndex:  1,
			ActiveLine:  createTaskAgentLine,
		},
	}

	rendered := renderCreateTaskModal(model)

	if !strings.Contains(rendered, "Agent: Codex") {
		t.Fatalf("rendered modal missing codex agent line:\n%s", rendered)
	}
}
