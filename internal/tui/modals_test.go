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

func TestHandleCreateMissionModalKeyAllowsSpace(t *testing.T) {
	model := &Model{
		createMissionModal: &createMissionModalState{
			Value: "Ship",
		},
	}

	model.handleCreateMissionModalKey(tea.KeyMsg{Type: tea.KeySpace})
	model.handleCreateMissionModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'i', 't'}})

	if model.createMissionModal.Value != "Ship it" {
		t.Fatalf("value = %q, want %q", model.createMissionModal.Value, "Ship it")
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

func TestOpenDeleteMissionConfirmModalCapturesMissionState(t *testing.T) {
	model := &Model{
		focus:                FocusMissions,
		missionsPaneExpanded: true,
		selectedMissionIndex: 0,
		missions: []MissionSnapshot{
			{
				ID:    "mission-1",
				Title: "Rollout",
				Tasks: []MissionTaskRecord{
					{MissionID: "mission-1", TaskID: "task-1"},
					{MissionID: "mission-1", TaskID: "task-2"},
				},
			},
		},
	}

	model.openDeleteMissionConfirmModal(model.selectedMission())

	if model.modal != ModalDeleteMission {
		t.Fatalf("modal = %q, want %q", model.modal, ModalDeleteMission)
	}
	if model.deleteMissionConfirmModal == nil {
		t.Fatal("deleteMissionConfirmModal = nil, want state")
	}
	if model.deleteMissionConfirmModal.MissionID != "mission-1" {
		t.Fatalf("MissionID = %q, want mission-1", model.deleteMissionConfirmModal.MissionID)
	}
	if model.deleteMissionConfirmModal.TaskCount != 2 {
		t.Fatalf("TaskCount = %d, want 2", model.deleteMissionConfirmModal.TaskCount)
	}
	if !model.deleteMissionConfirmModal.KeepOpen {
		t.Fatal("KeepOpen = false, want true")
	}
}

func TestRenderDeleteMissionConfirmModalShowsTaskWarning(t *testing.T) {
	model := &Model{
		selectedMissionIndex: 0,
		missions: []MissionSnapshot{
			{
				ID:    "mission-1",
				Title: "Rollout",
			},
		},
		deleteMissionConfirmModal: &deleteMissionConfirmModalState{
			MissionID: "mission-1",
			TaskCount: 2,
		},
	}

	rendered := ansiPattern.ReplaceAllString(renderDeleteMissionConfirmModal(model), "")

	if !strings.Contains(rendered, "Delete Mission") {
		t.Fatalf("rendered modal missing title:\n%s", rendered)
	}
	if !strings.Contains(rendered, "Delete mission 'Rollout'?") {
		t.Fatalf("rendered modal missing mission prompt:\n%s", rendered)
	}
	if !strings.Contains(rendered, "This will also delete 2 tasks in this mission.") {
		t.Fatalf("rendered modal missing task warning:\n%s", rendered)
	}
}

func TestHandleKeyAIChatShortcutsOpenModal(t *testing.T) {
	for _, key := range []rune{'a', 'A'} {
		model := &Model{
			focus: FocusBoard,
		}

		cmd := model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{key}})

		if cmd != nil {
			t.Fatalf("handleKey(%q) returned cmd, want nil", string(key))
		}
		if model.modal != ModalAIChat {
			t.Fatalf("modal = %q, want %q", model.modal, ModalAIChat)
		}
		if model.aiChatModal == nil {
			t.Fatal("aiChatModal = nil, want state")
		}
		if model.focus != FocusModal {
			t.Fatalf("focus = %q, want %q", model.focus, FocusModal)
		}
	}
}

func TestOpenAIChatModalResetsContext(t *testing.T) {
	model := &Model{
		aiChatModal: &aiChatModalState{
			Input:      "stale",
			Transcript: []ChatMessage{{Role: "assistant", Content: "old"}},
			Executions: []ChatToolExecution{{ToolName: "create_task", Status: "completed"}},
		},
	}

	model.openAIChatModal()

	if model.aiChatModal == nil {
		t.Fatal("aiChatModal = nil, want fresh state")
	}
	if model.aiChatModal.Input != "" {
		t.Fatalf("Input = %q, want empty", model.aiChatModal.Input)
	}
	if len(model.aiChatModal.Transcript) != 0 {
		t.Fatalf("Transcript length = %d, want 0", len(model.aiChatModal.Transcript))
	}
	if len(model.aiChatModal.Executions) != 0 {
		t.Fatalf("Executions length = %d, want 0", len(model.aiChatModal.Executions))
	}
}

func TestChatTurnBoardMutationClosesAIChatModal(t *testing.T) {
	model := &Model{
		modal: ModalAIChat,
		focus: FocusModal,
		aiChatModal: &aiChatModalState{
			Pending:       true,
			PendingPrompt: "create a task",
		},
	}

	nextModel, cmd := model.Update(chatTurnMsg{
		result: ChatTurnResult{
			Executions: []ChatToolExecution{
				{ToolName: "create_task", Status: "completed", Summary: "Created task"},
			},
		},
	})

	if cmd != nil {
		t.Fatal("Update(chatTurnMsg) returned cmd, want nil")
	}

	updated := nextModel.(*Model)
	if updated.modal != ModalNone {
		t.Fatalf("modal = %q, want %q", updated.modal, ModalNone)
	}
	if updated.aiChatModal != nil {
		t.Fatal("aiChatModal != nil, want modal state cleared")
	}
	if updated.focus != FocusBoard {
		t.Fatalf("focus = %q, want %q", updated.focus, FocusBoard)
	}
	if updated.statusMessage != "AI changes applied." {
		t.Fatalf("statusMessage = %q, want AI changes applied.", updated.statusMessage)
	}
}

func TestChatTurnReadOnlyResultKeepsAIChatModalOpen(t *testing.T) {
	model := &Model{
		modal: ModalAIChat,
		focus: FocusModal,
		aiChatModal: &aiChatModalState{
			Pending:       true,
			PendingPrompt: "what is the current context?",
		},
	}

	nextModel, cmd := model.Update(chatTurnMsg{
		result: ChatTurnResult{
			Transcript: []ChatMessage{
				{Role: "user", Content: "what is the current context?"},
				{Role: "assistant", Content: "You are on task API."},
			},
			Executions: []ChatToolExecution{
				{ToolName: "get_current_context", Status: "completed", Summary: "Loaded the current board context."},
			},
		},
	})

	if cmd != nil {
		t.Fatal("Update(chatTurnMsg) returned cmd, want nil")
	}

	updated := nextModel.(*Model)
	if updated.modal != ModalAIChat {
		t.Fatalf("modal = %q, want %q", updated.modal, ModalAIChat)
	}
	if updated.aiChatModal == nil {
		t.Fatal("aiChatModal = nil, want state")
	}
	if updated.aiChatModal.Pending {
		t.Fatal("Pending = true, want false")
	}
	if updated.aiChatModal.PendingPrompt != "" {
		t.Fatalf("PendingPrompt = %q, want empty", updated.aiChatModal.PendingPrompt)
	}
	if len(updated.aiChatModal.Transcript) != 2 {
		t.Fatalf("Transcript length = %d, want 2", len(updated.aiChatModal.Transcript))
	}
	if len(updated.aiChatModal.Executions) != 1 {
		t.Fatalf("Executions length = %d, want 1", len(updated.aiChatModal.Executions))
	}
	if updated.statusMessage != "AI chat completed." {
		t.Fatalf("statusMessage = %q, want AI chat completed.", updated.statusMessage)
	}
}

func TestRenderAIChatModalShowsTranscriptAndExecution(t *testing.T) {
	model := &Model{
		aiChatModal: &aiChatModalState{
			Transcript: []ChatMessage{
				{Role: "user", Content: "create a task"},
				{Role: "assistant", Content: "Created it."},
			},
			Executions: []ChatToolExecution{
				{ToolName: "create_task", Status: "completed", Summary: "Created task API"},
			},
		},
	}

	rendered := ansiPattern.ReplaceAllString(renderAIChatModal(model), "")

	if !strings.Contains(rendered, "AI CHAT") {
		t.Fatalf("rendered modal missing title:\n%s", rendered)
	}
	if !strings.Contains(rendered, "Created it.") {
		t.Fatalf("rendered modal missing assistant transcript:\n%s", rendered)
	}
	if !strings.Contains(rendered, "create_task") {
		t.Fatalf("rendered modal missing tool execution:\n%s", rendered)
	}
}
