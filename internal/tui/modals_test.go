package tui

import (
	"errors"
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

func TestHandleCreateTaskModalKeyNavigatesToLocationLine(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo", RemotePath: "/home/coder/project/monorepo"},
		},
		createTaskModal: &createTaskModalState{
			Value:      "Ship it",
			ActiveLine: createTaskAgentLine,
		},
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyDown})

	if model.createTaskModal.ActiveLine != createTaskLocationLine {
		t.Fatalf("active line = %q, want %q", model.createTaskModal.ActiveLine, createTaskLocationLine)
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyDown})

	if model.createTaskModal.ActiveLine != createTaskLocationLine {
		t.Fatalf("active line = %q, want it to stay on the last line", model.createTaskModal.ActiveLine)
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyUp})

	if model.createTaskModal.ActiveLine != createTaskAgentLine {
		t.Fatalf("active line = %q, want %q", model.createTaskModal.ActiveLine, createTaskAgentLine)
	}
}

func TestHandleCreateTaskModalKeyCyclesLocationWhenRepoHasRemote(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo", RemotePath: "/home/coder/project/monorepo"},
		},
		createTaskModal: &createTaskModalState{
			Value:      "Ship it",
			ActiveLine: createTaskLocationLine,
		},
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyRight})

	if got := model.createTaskLocationAt(0, model.createTaskModal.LocationIndex).Value; got != TaskLocationRemote {
		t.Fatalf("location = %q, want %q", got, TaskLocationRemote)
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyLeft})

	if got := model.createTaskLocationAt(0, model.createTaskModal.LocationIndex).Value; got != TaskLocationLocal {
		t.Fatalf("location = %q, want %q", got, TaskLocationLocal)
	}
}

func TestHandleCreateTaskModalKeyLocksLocationWhenRepoHasNoRemote(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo"},
		},
		createTaskModal: &createTaskModalState{
			Value:      "Ship it",
			ActiveLine: createTaskLocationLine,
		},
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyRight})

	if model.createTaskModal.LocationIndex != 0 {
		t.Fatalf("location index = %d, want 0", model.createTaskModal.LocationIndex)
	}
	if got := model.createTaskLocationAt(0, model.createTaskModal.LocationIndex).Value; got != TaskLocationLocal {
		t.Fatalf("location = %q, want %q", got, TaskLocationLocal)
	}
}

func TestCreateTaskLocationFollowsSelectedRepo(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Remote repo", RemotePath: "/home/coder/project/monorepo"},
			{ID: "repo-2", Label: "Local only repo"},
		},
		createTaskModal: &createTaskModalState{
			Value:         "Ship it",
			LocationIndex: 1,
			ActiveLine:    createTaskRepoLine,
		},
	}

	if got := model.createTaskLocationAt(0, model.createTaskModal.LocationIndex).Value; got != TaskLocationRemote {
		t.Fatalf("location for remote-capable repo = %q, want %q", got, TaskLocationRemote)
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyRight})

	if model.createTaskModal.RepoIndex != 1 {
		t.Fatalf("repo index = %d, want 1", model.createTaskModal.RepoIndex)
	}
	if got := model.createTaskLocationAt(model.createTaskModal.RepoIndex, model.createTaskModal.LocationIndex).Value; got != TaskLocationLocal {
		t.Fatalf("location for local-only repo = %q, want %q", got, TaskLocationLocal)
	}
}

func TestRenderCreateTaskModalShowsLocation(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Remote repo", RemotePath: "/home/coder/project/monorepo"},
			{ID: "repo-2", Label: "Local only repo"},
		},
		createTaskModal: &createTaskModalState{
			Value:         "Ship it",
			LocationIndex: 1,
			ActiveLine:    createTaskLocationLine,
		},
	}

	rendered := ansiPattern.ReplaceAllString(renderCreateTaskModal(model), "")
	if !strings.Contains(rendered, "Runs on: Remote") {
		t.Fatalf("rendered modal missing remote location line:\n%s", rendered)
	}

	model.createTaskModal.RepoIndex = 1
	rendered = ansiPattern.ReplaceAllString(renderCreateTaskModal(model), "")
	if !strings.Contains(rendered, "Runs on: Local (no remote configured)") {
		t.Fatalf("rendered modal missing locked location line:\n%s", rendered)
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
			LastError:  "old error",
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
	if model.aiChatModal.LastError != "" {
		t.Fatalf("LastError = %q, want empty", model.aiChatModal.LastError)
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

func TestChatTurnErrorKeepsAIChatModalOpenAndStoresError(t *testing.T) {
	model := &Model{
		modal: ModalAIChat,
		focus: FocusModal,
		aiChatModal: &aiChatModalState{
			Pending:       true,
			PendingPrompt: "hello",
		},
	}

	nextModel, cmd := model.Update(chatTurnMsg{
		err: errors.New("Ollama request failed with 500: model requires more system memory"),
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
	if updated.aiChatModal.Input != "hello" {
		t.Fatalf("Input = %q, want %q", updated.aiChatModal.Input, "hello")
	}
	if updated.aiChatModal.LastError != "Ollama request failed with 500: model requires more system memory" {
		t.Fatalf("LastError = %q, want stored error", updated.aiChatModal.LastError)
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
			LastError: "Ollama request failed with 500: model requires more system memory",
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
	if !strings.Contains(rendered, "REQUEST FAILED") {
		t.Fatalf("rendered modal missing error section:\n%s", rendered)
	}
	if !strings.Contains(rendered, "model requires more system memory") {
		t.Fatalf("rendered modal missing error detail:\n%s", rendered)
	}
}

func artifactRolloutTestModel(artifacts []ArtifactRecord) *Model {
	return &Model{
		focus: FocusBoard,
		artifacts: ArtifactsSnapshot{
			RefreshedAt: 1785100000000,
			Artifacts:   artifacts,
		},
	}
}

func TestOpenArtifactRolloutModalSnapshotsTheDisplayedVersions(t *testing.T) {
	model := artifactRolloutTestModel([]ArtifactRecord{{
		Name:            "com.wixpress.enterpise.web5.ecom-integrations",
		ShortName:       "ecom-integrations",
		Status:          ArtifactStatusDrift,
		GAVersion:       "1.258.0",
		LatestRCVersion: "1.269.0",
	}})

	model.openArtifactRolloutModal()

	if model.modal != ModalArtifactRollout {
		t.Fatalf("modal = %q, want %q", model.modal, ModalArtifactRollout)
	}
	state := model.artifactRolloutModal
	if state.Name != "com.wixpress.enterpise.web5.ecom-integrations" {
		t.Fatalf("Name = %q, want the full artifact id", state.Name)
	}
	if state.CurrentVersion != "1.258.0" || state.TargetVersion != "1.269.0" {
		t.Fatalf("versions = %q → %q, want 1.258.0 → 1.269.0", state.CurrentVersion, state.TargetVersion)
	}
	if artifactGradualityAt(state.GradualityIndex) != "gradual_safer" {
		t.Fatalf("graduality = %q, want gradual_safer by default", artifactGradualityAt(state.GradualityIndex))
	}
}

func TestRenderArtifactRolloutModalShowsOwnershipContext(t *testing.T) {
	model := artifactRolloutTestModel([]ArtifactRecord{{
		Name:            "com.wixpress.wix-assistant-web5",
		ShortName:       "wix-assistant-web5",
		Status:          ArtifactStatusDrift,
		GAVersion:       "1.3301.0",
		LatestRCVersion: "1.3311.0",
		PendingRcCount:  intPtr(11),
		MyPendingCount:  intPtr(6),
	}})

	model.openArtifactRolloutModal()

	rendered := stripANSI(renderArtifactRolloutModal(model))
	if !strings.Contains(rendered, "6 of 11 pending RCs are yours") {
		t.Fatalf("rendered modal missing the ownership line:\n%s", rendered)
	}
	if !strings.Contains(rendered, "type "+artifactRolloutConfirmWord+" to confirm") {
		t.Fatalf("rendered modal missing the arming field:\n%s", rendered)
	}
	if !strings.Contains(rendered, "1.3311.0") {
		t.Fatalf("rendered modal missing the frozen target version:\n%s", rendered)
	}
}

func TestRenderArtifactRolloutModalOmitsOwnershipWhenItIsUnknown(t *testing.T) {
	model := artifactRolloutTestModel([]ArtifactRecord{{
		Name:            "com.wixpress.wix-assistant-web5",
		ShortName:       "wix-assistant-web5",
		Status:          ArtifactStatusDrift,
		GAVersion:       "1.3301.0",
		LatestRCVersion: "1.3311.0",
		PendingRcCount:  intPtr(11),
	}})

	model.openArtifactRolloutModal()

	rendered := stripANSI(renderArtifactRolloutModal(model))
	if strings.Contains(rendered, "pending RCs are yours") {
		t.Fatalf("rendered modal claims ownership it could not resolve:\n%s", rendered)
	}
}

func TestOpenArtifactRolloutModalRefusesNonDriftingArtifacts(t *testing.T) {
	cases := []struct {
		name     string
		artifact ArtifactRecord
		want     string
	}{
		{"in sync", ArtifactRecord{ShortName: "prompt-manager", Status: ArtifactStatusInSync, GAVersion: "1.0.0"}, "prompt-manager is already in sync."},
		{"no GA", ArtifactRecord{ShortName: "web5-protos", Status: ArtifactStatusNoGA, LatestRCVersion: "1.0.5"}, "web5-protos never goes GA, so there is nothing to roll out."},
		{"unknown", ArtifactRecord{ShortName: "mystery-lib", Status: ArtifactStatusUnknown}, "mystery-lib has an unknown release state, so it cannot be rolled out."},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			model := artifactRolloutTestModel([]ArtifactRecord{testCase.artifact})

			model.openArtifactRolloutModal()

			if model.modal != ModalNone {
				t.Fatalf("modal = %q, want no rollout modal for %s", model.modal, testCase.name)
			}
			if model.statusMessage != testCase.want {
				t.Fatalf("statusMessage = %q, want %q", model.statusMessage, testCase.want)
			}
		})
	}
}

func TestHandleArtifactRolloutModalKeyTogglesGraduality(t *testing.T) {
	model := &Model{artifactRolloutModal: &artifactRolloutModalState{}}

	model.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyRight})
	if got := artifactGradualityAt(model.artifactRolloutModal.GradualityIndex); got != "gradual_quicker" {
		t.Fatalf("graduality = %q, want gradual_quicker after →", got)
	}

	model.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyLeft})
	if got := artifactGradualityAt(model.artifactRolloutModal.GradualityIndex); got != "gradual_safer" {
		t.Fatalf("graduality = %q, want gradual_safer after ←", got)
	}
}

func TestHandleArtifactRolloutModalKeyEnterDoesNothingUntilArmed(t *testing.T) {
	for _, confirm := range []string{"", "g", "ga", "GAA", "Ga"} {
		model := &Model{
			modal:                ModalArtifactRollout,
			artifactRolloutModal: &artifactRolloutModalState{Name: "artifact", TargetVersion: "1.269.0", Confirm: confirm},
		}

		cmd := model.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyEnter})

		if cmd != nil {
			t.Fatalf("handleArtifactRolloutModalKey(enter) with confirm %q returned a cmd, want no rollout", confirm)
		}
		if model.modal != ModalArtifactRollout {
			t.Fatalf("modal = %q with confirm %q, want the modal to stay open", model.modal, confirm)
		}
	}
}

func TestHandleArtifactRolloutModalKeyEnterRollsOutWhenArmed(t *testing.T) {
	model := &Model{
		modal: ModalArtifactRollout,
		artifactRolloutModal: &artifactRolloutModalState{
			Name:            "com.wixpress.enterpise.web5.ecom-integrations",
			CurrentVersion:  "1.258.0",
			TargetVersion:   "1.269.0",
			GradualityIndex: 1,
			Confirm:         artifactRolloutConfirmWord,
		},
	}

	cmd := model.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyEnter})

	if cmd == nil {
		t.Fatal("handleArtifactRolloutModalKey(enter) returned nil cmd, want a rollout")
	}
	if model.modal != ModalNone {
		t.Fatalf("modal = %q, want the modal closed after confirming", model.modal)
	}
}

func TestArtifactRolloutParamsUseTheDisplayedTargetVersion(t *testing.T) {
	params := artifactRolloutParams(artifactRolloutModalState{
		Name:            "com.wixpress.enterpise.web5.ecom-integrations",
		CurrentVersion:  "1.258.0",
		TargetVersion:   "1.269.0",
		GradualityIndex: 1,
	})

	want := map[string]string{
		"name":          "com.wixpress.enterpise.web5.ecom-integrations",
		"targetVersion": "1.269.0",
		"graduality":    "gradual_quicker",
	}
	for key, value := range want {
		if params[key] != value {
			t.Fatalf("params[%q] = %q, want %q", key, params[key], value)
		}
	}
	if len(params) != len(want) {
		t.Fatalf("params = %#v, want exactly %#v", params, want)
	}
}

func TestHandleArtifactRolloutModalKeyEditsAndCancelsTheConfirmField(t *testing.T) {
	model := &Model{modal: ModalArtifactRollout, artifactRolloutModal: &artifactRolloutModalState{}}

	model.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'G'}})
	model.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'X'}})
	model.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyBackspace})
	model.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'A'}})

	if model.artifactRolloutModal.Confirm != artifactRolloutConfirmWord {
		t.Fatalf("Confirm = %q, want %q after backspace editing", model.artifactRolloutModal.Confirm, artifactRolloutConfirmWord)
	}

	model.handleArtifactRolloutModalKey(tea.KeyMsg{Type: tea.KeyEsc})
	if model.modal != ModalNone {
		t.Fatalf("modal = %q, want Esc to cancel", model.modal)
	}
}

func TestApplyArtifactRolloutSurfacesTheServerMessage(t *testing.T) {
	model := &Model{}

	if cmd := model.applyArtifactRollout(artifactRolloutMsg{result: ArtifactRolloutResult{OK: true, Message: "Rollout gr-42 started."}}); cmd == nil {
		t.Fatal("applyArtifactRollout() returned nil cmd on success, want an artifacts refresh")
	}
	if model.statusMessage != "Rollout gr-42 started." {
		t.Fatalf("statusMessage = %q, want the server message", model.statusMessage)
	}

	if cmd := model.applyArtifactRollout(artifactRolloutMsg{result: ArtifactRolloutResult{Message: "not authorised"}}); cmd != nil {
		t.Fatal("applyArtifactRollout() returned a cmd on failure, want no refresh")
	}
	if model.statusMessage != "Rollout failed: not authorised" {
		t.Fatalf("statusMessage = %q, want the failure surfaced", model.statusMessage)
	}
}

func TestRenderArtifactRolloutModalShowsTheProductionDetails(t *testing.T) {
	model := &Model{
		modal: ModalArtifactRollout,
		artifactRolloutModal: &artifactRolloutModalState{
			Name:           "com.wixpress.enterpise.web5.ecom-integrations",
			CurrentVersion: "1.258.0",
			TargetVersion:  "1.269.0",
		},
	}

	plain := stripANSI(renderArtifactRolloutModal(model))
	for _, want := range []string{
		"ROLL OUT TO PRODUCTION",
		"com.wixpress.enterpise.web5.ecom-integrations",
		"1.258.0  →  1.269.0",
		"gradual_safer",
		"comment: generated automatically",
		"type GA to confirm:",
	} {
		if !strings.Contains(plain, want) {
			t.Fatalf("renderArtifactRolloutModal() = %q, want %q", plain, want)
		}
	}
}

func findPaletteCommand(items []CommandPaletteItem, id string) *CommandPaletteItem {
	for i := range items {
		if items[i].ID == id {
			return &items[i]
		}
	}
	return nil
}

func TestCommandPaletteReconnectIsEnabledOnlyForRemoteTasks(t *testing.T) {
	remote := &Model{
		activeTaskID: "task-remote",
		tasks:        []TaskRecord{{ID: "task-remote", Location: TaskLocationRemote}},
	}
	item := findPaletteCommand(remote.commandPaletteCommands(), "reconnect-remote")
	if item == nil {
		t.Fatal("reconnect-remote command is missing from the palette")
	}
	if item.Disabled {
		t.Fatalf("reconnect should be enabled for a remote task, got disabled: %q", item.DisabledReason)
	}

	local := &Model{
		activeTaskID: "task-local",
		tasks:        []TaskRecord{{ID: "task-local", Location: TaskLocationLocal}},
	}
	item = findPaletteCommand(local.commandPaletteCommands(), "reconnect-remote")
	if item == nil {
		t.Fatal("reconnect-remote command is missing from the palette")
	}
	if !item.Disabled {
		t.Fatal("reconnect should be disabled for a local task")
	}
	if !strings.Contains(item.DisabledReason, "remote") {
		t.Fatalf("disabled reason = %q, want it to mention remote tasks", item.DisabledReason)
	}

	none := &Model{}
	item = findPaletteCommand(none.commandPaletteCommands(), "reconnect-remote")
	if item == nil || !item.Disabled {
		t.Fatal("reconnect should be disabled when no task is selected")
	}
}

func TestCreateTaskRepoOptionsEndWithGeneral(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo One"},
			{ID: "repo-2", Label: "Repo Two"},
		},
	}

	options := model.createTaskRepoOptions()

	if len(options) != 3 {
		t.Fatalf("repo option count = %d, want 3", len(options))
	}
	last := options[len(options)-1]
	if !last.IsGeneral || last.ID != "" {
		t.Fatalf("last option = %+v, want the repo-less general option", last)
	}
}

func TestHandleCreateTaskModalKeyCyclesToGeneralOption(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo One"},
		},
		createTaskModal: &createTaskModalState{
			Value:      "Read the spec",
			ActiveLine: createTaskRepoLine,
		},
	}

	model.handleCreateTaskModalKey(tea.KeyMsg{Type: tea.KeyRight})

	if got := model.createTaskRepoOptionAt(model.createTaskModal.RepoIndex); !got.IsGeneral {
		t.Fatalf("selected repo option = %+v, want the general option", got)
	}
}

func TestRenderCreateTaskModalShowsGeneralRepoOption(t *testing.T) {
	model := &Model{
		repos: []RepoRecord{
			{ID: "repo-1", Label: "Repo One"},
		},
		createTaskModal: &createTaskModalState{
			Value:      "Read the spec",
			RepoIndex:  1,
			ActiveLine: createTaskRepoLine,
		},
	}

	rendered := renderCreateTaskModal(model)

	if !strings.Contains(rendered, "Repo: General (no repo)") {
		t.Fatalf("rendered modal missing the general repo option:\n%s", rendered)
	}
	if !strings.Contains(rendered, "general tasks are local") {
		t.Fatalf("rendered modal should lock a general task to local:\n%s", rendered)
	}
}

func TestCreateTaskParamsOmitsRepoIDForGeneralTasks(t *testing.T) {
	params := createTaskParams("Read the spec", TaskKindGeneral, "", "", "claude", TaskLocationLocal)

	if _, ok := params["repoId"]; ok {
		t.Fatalf("general task params should carry no repoId: %+v", params)
	}
	if params["kind"] != TaskKindGeneral {
		t.Fatalf("kind = %v, want %q", params["kind"], TaskKindGeneral)
	}
}

func TestCreateTaskParamsKeepsRepoIDForRepoTasks(t *testing.T) {
	params := createTaskParams("Ship it", TaskKindRepo, "repo-1", "pillar-1", "codex", TaskLocationRemote)

	if params["repoId"] != "repo-1" {
		t.Fatalf("repoId = %v, want repo-1", params["repoId"])
	}
	if params["kind"] != TaskKindRepo {
		t.Fatalf("kind = %v, want %q", params["kind"], TaskKindRepo)
	}
}

func TestOpenSetBranchModalRejectsGeneralTasks(t *testing.T) {
	model := &Model{}

	model.openSetBranchModal(&TaskRecord{ID: "task-1", Kind: TaskKindGeneral})

	if model.modal == ModalSetBranch {
		t.Fatal("set-branch modal should not open for a general task")
	}
	if !strings.Contains(model.statusMessage, "no repo") {
		t.Fatalf("status message = %q, want an explanation about the missing repo", model.statusMessage)
	}
}

func TestVisibleTasksInGeneralScopeShowsOnlyGeneralTasks(t *testing.T) {
	model := &Model{
		activeRepoID: GeneralScopeID,
		tasks: []TaskRecord{
			{ID: "task-1", Title: "Repo card", RepoID: "repo-1"},
			{ID: "task-2", Title: "General card", Kind: TaskKindGeneral},
		},
	}

	visible := model.visibleTasks()

	if len(visible) != 1 || visible[0].ID != "task-2" {
		t.Fatalf("visible tasks = %+v, want only the general card", visible)
	}
}

func TestVisibleTasksInAllReposScopeIncludesGeneralTasks(t *testing.T) {
	model := &Model{
		tasks: []TaskRecord{
			{ID: "task-1", Title: "Repo card", RepoID: "repo-1"},
			{ID: "task-2", Title: "General card", Kind: TaskKindGeneral},
		},
	}

	if got := len(model.visibleTasks()); got != 2 {
		t.Fatalf("visible task count = %d, want 2", got)
	}
}

func TestVisibleTasksScopedToRepoHidesGeneralTasks(t *testing.T) {
	model := &Model{
		activeRepoID: "repo-1",
		tasks: []TaskRecord{
			{ID: "task-1", Title: "Repo card", RepoID: "repo-1"},
			{ID: "task-2", Title: "General card", Kind: TaskKindGeneral},
		},
	}

	visible := model.visibleTasks()

	if len(visible) != 1 || visible[0].ID != "task-1" {
		t.Fatalf("visible tasks = %+v, want only the repo card", visible)
	}
}

func TestSwitchRepoCyclesThroughGeneralScope(t *testing.T) {
	model := &Model{repos: []RepoRecord{{ID: "repo-1", Label: "Repo One"}}}

	model.switchRepo(1)
	if model.activeRepoID != "repo-1" {
		t.Fatalf("after one step activeRepoID = %q, want repo-1", model.activeRepoID)
	}

	model.switchRepo(1)
	if !model.isGeneralScope() {
		t.Fatalf("after two steps activeRepoID = %q, want the general scope", model.activeRepoID)
	}

	model.switchRepo(1)
	if model.activeRepoID != "" {
		t.Fatalf("after three steps activeRepoID = %q, want all repos", model.activeRepoID)
	}
}

func TestOverviewScopesEndWithGeneral(t *testing.T) {
	model := &Model{repos: []RepoRecord{{ID: "repo-1", Label: "Repo One"}}}

	scopes := model.overviewScopes()

	if len(scopes) != 2 {
		t.Fatalf("scope count = %d, want 2", len(scopes))
	}
	if scopes[1].ID != GeneralScopeID || scopes[1].Label != "General" {
		t.Fatalf("last scope = %+v, want the general scope", scopes[1])
	}
}

func TestOverviewScopesEmptyWithoutReposOrGeneralTasks(t *testing.T) {
	if scopes := (&Model{}).overviewScopes(); len(scopes) != 0 {
		t.Fatalf("scopes = %+v, want none", scopes)
	}
}

func TestOverviewScopesKeepGeneralWithoutRepos(t *testing.T) {
	model := &Model{tasks: []TaskRecord{{ID: "task-1", Kind: TaskKindGeneral}}}

	scopes := model.overviewScopes()

	if len(scopes) != 1 || scopes[0].ID != GeneralScopeID {
		t.Fatalf("scopes = %+v, want only the general scope", scopes)
	}
}

func TestOpenCreateTaskModalDefaultsToGeneralInGeneralScope(t *testing.T) {
	model := &Model{
		repos:        []RepoRecord{{ID: "repo-1", Label: "Repo One"}},
		activeRepoID: GeneralScopeID,
	}

	model.openCreateTaskModal()

	if got := model.createTaskRepoOptionAt(model.createTaskModal.RepoIndex); !got.IsGeneral {
		t.Fatalf("preselected repo option = %+v, want the general option", got)
	}
}

func branchPRModel(branches []TaskBranchRecord) *Model {
	// Real branch rows always carry the id of the task they belong to
	// (task_branches.task_id is NOT NULL); fixtures must too, since the PR
	// picker tells a subtask's row apart from the card's own by comparing it.
	stampBranchTaskID(branches, "task-1")
	return &Model{
		width:              200,
		height:             40,
		focus:              FocusBoard,
		modal:              ModalNone,
		repos:              []RepoRecord{{ID: "repo-a", Label: "web5-poc"}, {ID: "repo-b", Label: "assistant"}},
		tracks:             []TrackRecord{{ID: "in-progress", SortOrder: 1}},
		selectedTrackIndex: 0,
		selectedTaskIndex:  0,
		tasks: []TaskRecord{{
			ID:       "task-1",
			Title:    "Cross-repo feature",
			TrackID:  "in-progress",
			SortKey:  1,
			RepoID:   "repo-a",
			Branches: branches,
		}},
	}
}

func stampBranchTaskID(branches []TaskBranchRecord, taskID string) {
	for index := range branches {
		branches[index].TaskID = taskID
	}
}

func twoOpenBranches() []TaskBranchRecord {
	return []TaskBranchRecord{
		{ID: "branch-a", RepoID: "repo-a", BranchName: "feat/a", PRNumber: intPtr(11), PRState: "open", CIState: "passed", ReviewState: "approved"},
		{ID: "branch-b", RepoID: "repo-b", BranchName: "feat/b", PRNumber: intPtr(22), PRState: "open", CIState: "pending"},
	}
}

func TestShiftEOpensThePRPicker(t *testing.T) {
	model := branchPRModel(twoOpenBranches())

	model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("E")})

	if model.modal != ModalBranchPRList {
		t.Fatalf("modal = %q, want %q", model.modal, ModalBranchPRList)
	}
	if model.branchPRListModal == nil || model.branchPRListModal.TaskID != "task-1" {
		t.Fatalf("branchPRListModal = %+v, want it aimed at task-1", model.branchPRListModal)
	}
	if model.focus != FocusModal {
		t.Fatalf("focus = %q, want %q", model.focus, FocusModal)
	}
}

func TestPRPickerRefusesACardWithNoTrackedBranch(t *testing.T) {
	model := branchPRModel(nil)

	model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("E")})

	if model.modal != ModalNone {
		t.Fatalf("modal = %q, want no modal", model.modal)
	}
	if model.statusMessage == "" {
		t.Fatal("statusMessage is empty; the refusal must say why")
	}
}

func TestPRPickerListsEveryBranchWithItsRepoAndPR(t *testing.T) {
	model := branchPRModel(twoOpenBranches())
	model.openBranchPRListModal(&model.tasks[0])

	plain := ansiPattern.ReplaceAllString(renderBranchPRListModal(model), "")

	for _, want := range []string{"WEB5-POC", "ASSISTANT", "#11 open", "#22 open"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("PR picker = %q, want it to contain %q", plain, want)
		}
	}
}

func TestPRPickerMovesBetweenPRsAndClamps(t *testing.T) {
	model := branchPRModel(twoOpenBranches())
	model.openBranchPRListModal(&model.tasks[0])

	model.handleModalKey(tea.KeyMsg{Type: tea.KeyDown})
	if model.branchPRListModal.Index != 1 {
		t.Fatalf("index = %d, want 1", model.branchPRListModal.Index)
	}

	model.handleModalKey(tea.KeyMsg{Type: tea.KeyDown})
	if model.branchPRListModal.Index != 1 {
		t.Fatalf("index = %d, want it clamped to the last PR", model.branchPRListModal.Index)
	}

	model.handleModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("k")})
	if model.branchPRListModal.Index != 0 {
		t.Fatalf("index = %d, want 0", model.branchPRListModal.Index)
	}
}

// A refused merge must leave the list up with the reason attached, so the user
// can pick another PR instead of guessing why nothing happened.
func TestPRPickerMergeRefusalKeepsTheListOpen(t *testing.T) {
	model := branchPRModel(twoOpenBranches())
	model.openBranchPRListModal(&model.tasks[0])
	model.handleModalKey(tea.KeyMsg{Type: tea.KeyDown})

	cmd := model.handleModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("m")})

	if cmd != nil {
		t.Fatal("merge command returned for a PR with pending checks")
	}
	if model.modal != ModalBranchPRList {
		t.Fatalf("modal = %q, want the picker to stay open", model.modal)
	}
	if !strings.Contains(model.statusMessage, "#22") {
		t.Fatalf("statusMessage = %q, want it to name the refused PR", model.statusMessage)
	}
}

// The composer must remember which PR it was opened for; the card-level comment
// path has no PR to fall back on once there are several.
func TestPRPickerCommentComposerRemembersItsBranch(t *testing.T) {
	model := branchPRModel(twoOpenBranches())
	model.openBranchPRListModal(&model.tasks[0])
	model.handleModalKey(tea.KeyMsg{Type: tea.KeyDown})

	model.handleModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")})

	if model.modal != ModalPRComment {
		t.Fatalf("modal = %q, want the PR comment composer", model.modal)
	}
	if model.prCommentModal == nil || model.prCommentModal.BranchID != "branch-b" {
		t.Fatalf("prCommentModal = %+v, want it aimed at branch-b", model.prCommentModal)
	}
}

// branchPRModelWithSubtask is a parent card and one subtask spawned from it,
// each carrying its own branch — the shape the PR picker rolls up.
func branchPRModelWithSubtask(parentBranches, subtaskBranches []TaskBranchRecord) *Model {
	model := branchPRModel(parentBranches)
	stampBranchTaskID(subtaskBranches, "task-2")
	model.tasks = append(model.tasks, TaskRecord{
		ID:           "task-2",
		Title:        "Extracted helper",
		TrackID:      "in-progress",
		SortKey:      2,
		RepoID:       "repo-a",
		ParentTaskID: "task-1",
		Branches:     subtaskBranches,
	})
	return model
}

func oneOpenBranch(id, repoID string, prNumber int) []TaskBranchRecord {
	return []TaskBranchRecord{
		{ID: id, RepoID: repoID, BranchName: "feat/" + id, PRNumber: intPtr(prNumber), PRState: "open", CIState: "passed", ReviewState: "approved"},
	}
}

// The point of the feature: reviewing a card's PRs should not require opening
// every subtask separately to notice it also has one open.
func TestPRPickerIncludesSubtaskPRsMarkedAsSuch(t *testing.T) {
	model := branchPRModelWithSubtask(twoOpenBranches(), oneOpenBranch("branch-c", "repo-a", 33))
	model.openBranchPRListModal(&model.tasks[0])

	plain := ansiPattern.ReplaceAllString(renderBranchPRListModal(model), "")

	if !strings.Contains(plain, "#33 open") {
		t.Fatalf("PR picker = %q, want it to list the subtask's PR", plain)
	}
	// Named, not just flagged: with more than one subtask a bare "SUBTASK"
	// tag would not say which one this row belongs to.
	if !strings.Contains(plain, "Extracted helper") {
		t.Fatalf("PR picker = %q, want the subtask's row to name its own task", plain)
	}
}

// A subtask's own row must not carry the mark — only rows that are not the
// modal's own task should.
func TestPRPickerDoesNotMarkTheParentsOwnBranches(t *testing.T) {
	model := branchPRModel(twoOpenBranches())
	model.openBranchPRListModal(&model.tasks[0])

	plain := ansiPattern.ReplaceAllString(renderBranchPRListModal(model), "")

	if strings.Contains(plain, "↳") {
		t.Fatalf("PR picker = %q, a card's own PRs must not carry the owning-task mark", plain)
	}
}

// A parent card with no branch of its own but a subtask that has one must
// still open the picker — the point is "does this card's work have any open
// PR", not "does this exact task row have a branch".
func TestPRPickerOpensForAParentWithOnlySubtaskPRs(t *testing.T) {
	model := branchPRModelWithSubtask(nil, oneOpenBranch("branch-c", "repo-a", 33))

	model.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("E")})

	if model.modal != ModalBranchPRList {
		t.Fatalf("modal = %q, want %q", model.modal, ModalBranchPRList)
	}
}

// Commenting on a subtask's PR from the parent's picker must resolve back to
// the subtask, not the parent, or the composer's lookup finds nothing.
func TestPRPickerCommentOnASubtaskPRTargetsTheSubtask(t *testing.T) {
	model := branchPRModelWithSubtask(twoOpenBranches(), oneOpenBranch("branch-c", "repo-a", 33))
	model.openBranchPRListModal(&model.tasks[0])
	model.handleModalKey(tea.KeyMsg{Type: tea.KeyDown})
	model.handleModalKey(tea.KeyMsg{Type: tea.KeyDown})

	model.handleModalKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")})

	if model.modal != ModalPRComment {
		t.Fatalf("modal = %q, want the PR comment composer", model.modal)
	}
	if model.prCommentModal == nil || model.prCommentModal.TaskID != "task-2" {
		t.Fatalf("prCommentModal = %+v, want it aimed at task-2 (the subtask)", model.prCommentModal)
	}
	if model.prCommentModal.BranchID != "branch-c" {
		t.Fatalf("prCommentModal = %+v, want it aimed at branch-c", model.prCommentModal)
	}
}

// Card-level PR commands cannot pick between several PRs, so the palette has to
// send the user to the picker rather than claim there is no PR.
func TestPaletteSendsMultiPRCardsToThePicker(t *testing.T) {
	model := branchPRModel(twoOpenBranches())

	for _, id := range []string{"merge-pr", "comment-pr", "open-pr"} {
		command := findPaletteCommand(model.commandPaletteCommands(), id)
		if command == nil {
			t.Fatalf("palette command %q is missing", id)
		}
		if !command.Disabled {
			t.Fatalf("palette command %q is enabled on a card with two PRs", id)
		}
		if !strings.Contains(command.DisabledReason, "choose a PR") {
			t.Fatalf("palette command %q reason = %q, want it to point at the picker", id, command.DisabledReason)
		}
	}
}
