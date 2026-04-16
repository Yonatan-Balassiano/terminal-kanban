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

func TestOpenAddMissionTaskModalPreselectsSelectedMissionTaskAsBlocker(t *testing.T) {
	model := &Model{
		selectedMissionIndex:     0,
		selectedMissionTaskIndex: 0,
		missions: []MissionSnapshot{
			{
				ID:    "mission-1",
				Title: "Rollout",
				Tasks: []MissionTaskRecord{
					{
						MissionID: "mission-1",
						TaskID:    "task-1",
						Task:      TaskRecord{ID: "task-1", Title: "Base PR"},
					},
				},
			},
		},
	}

	model.openAddMissionTaskModal(model.selectedMission())

	if model.addMissionTaskModal == nil {
		t.Fatal("addMissionTaskModal = nil, want state")
	}
	if got := model.addMissionTaskModal.SelectedBlockerTaskIDs; len(got) != 1 || got[0] != "task-1" {
		t.Fatalf("SelectedBlockerTaskIDs = %#v, want [task-1]", got)
	}
}

func TestHandleAddMissionTaskModalKeyNavigatesToBlockedLine(t *testing.T) {
	model := &Model{
		addMissionTaskModal: &addMissionTaskModalState{
			Value:       "Ship follow-up",
			RepoIndex:   0,
			PillarIndex: 0,
			AgentIndex:  0,
			ActiveLine:  createTaskAgentLine,
			Stage:       addMissionTaskStageDetails,
		},
	}

	model.handleAddMissionTaskModalKey(tea.KeyMsg{Type: tea.KeyDown})

	if model.addMissionTaskModal.ActiveLine != createTaskBlockedLine {
		t.Fatalf("active line = %q, want %q", model.addMissionTaskModal.ActiveLine, createTaskBlockedLine)
	}

	model.handleAddMissionTaskModalKey(tea.KeyMsg{Type: tea.KeyRight})

	if !model.addMissionTaskModal.WantsBlocked {
		t.Fatal("WantsBlocked = false, want true")
	}
}

func TestHandleAddMissionTaskModalBlockedEnterOpensBlockerSelection(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo"},
		},
		missions: []MissionSnapshot{
			{
				ID:    "mission-1",
				Title: "Rollout",
				Tasks: []MissionTaskRecord{
					{
						MissionID: "mission-1",
						TaskID:    "task-1",
						Task: TaskRecord{
							ID:     "task-1",
							Title:  "Base PR",
							RepoID: "repo-1",
						},
					},
				},
			},
		},
		addMissionTaskModal: &addMissionTaskModalState{
			MissionID:              "mission-1",
			Value:                  "Follow-up PR",
			RepoIndex:              0,
			AgentIndex:             0,
			Stage:                  addMissionTaskStageDetails,
			WantsBlocked:           true,
			SelectedBlockerTaskIDs: []string{"task-1"},
		},
	}

	cmd := model.handleAddMissionTaskModalKey(tea.KeyMsg{Type: tea.KeyEnter})

	if cmd != nil {
		t.Fatal("handleAddMissionTaskModalKey(enter) returned cmd, want nil")
	}
	if model.addMissionTaskModal.Stage != addMissionTaskStageBlockers {
		t.Fatalf("stage = %q, want %q", model.addMissionTaskModal.Stage, addMissionTaskStageBlockers)
	}
}

func TestRenderAddMissionTaskModalBlockerSelectionShowsOptions(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo"},
		},
		missions: []MissionSnapshot{
			{
				ID:    "mission-1",
				Title: "Rollout",
				Tasks: []MissionTaskRecord{
					{
						MissionID: "mission-1",
						TaskID:    "task-1",
						Task: TaskRecord{
							ID:     "task-1",
							Title:  "Base PR",
							RepoID: "repo-1",
						},
					},
				},
			},
		},
		addMissionTaskModal: &addMissionTaskModalState{
			MissionID:              "mission-1",
			Value:                  "Follow-up PR",
			Stage:                  addMissionTaskStageBlockers,
			BlockerIndex:           0,
			SelectedBlockerTaskIDs: []string{"task-1"},
		},
	}

	rendered := ansiPattern.ReplaceAllString(renderAddMissionTaskModal(model), "")

	if !strings.Contains(rendered, "Mission Blockers") {
		t.Fatalf("rendered modal missing blocker title:\n%s", rendered)
	}
	if !strings.Contains(rendered, "[x] Repo · Base PR") {
		t.Fatalf("rendered modal missing selected blocker option:\n%s", rendered)
	}
}
