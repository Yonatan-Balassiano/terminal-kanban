package tui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
)

func (m *Model) applyMissions(
	missions []MissionSummaryRecord,
	detail *MissionDetail,
	selectedMissionID string,
	selectedMissionStepID string,
) {
	m.missions = missions

	if selectedMissionID != "" {
		m.activeMissionID = selectedMissionID
	}

	if m.activeMissionID == "" && len(missions) > 0 {
		m.activeMissionID = missions[0].ID
	}

	if m.activeMissionID != "" {
		found := false
		for index, mission := range missions {
			if mission.ID == m.activeMissionID {
				m.selectedMissionIndex = index
				found = true
				break
			}
		}
		if !found {
			if len(missions) > 0 {
				m.activeMissionID = missions[0].ID
				m.selectedMissionIndex = 0
			} else {
				m.activeMissionID = ""
				m.selectedMissionIndex = 0
			}
		}
	} else {
		m.selectedMissionIndex = 0
	}

	if detail != nil && detail.Mission.ID == m.activeMissionID {
		m.missionDetail = detail
	} else if m.activeMissionID == "" {
		m.missionDetail = nil
	}

	if m.missionDetail == nil {
		m.selectedMissionStepIndex = 0
		m.missionPaneFocus = missionPaneList
		return
	}

	if selectedMissionStepID != "" {
		for index, step := range m.missionDetail.Steps {
			if step.ID == selectedMissionStepID {
				m.selectedMissionStepIndex = index
				break
			}
		}
	}
	m.selectedMissionStepIndex = clamp(m.selectedMissionStepIndex, 0, max(0, len(m.missionDetail.Steps)-1))
	if len(m.missionDetail.Steps) == 0 {
		m.missionPaneFocus = missionPaneList
	}
}

func (m *Model) switchAppTab(direction int) {
	tabs := []AppTab{AppTabBoard, AppTabMissions}
	currentIndex := 0
	if m.activeTab == AppTabMissions {
		currentIndex = 1
	}
	m.activeTab = tabs[(currentIndex+direction+len(tabs))%len(tabs)]
}

func (m *Model) persistActiveTabCmd() tea.Cmd {
	return m.setUIStateCmd(map[string]interface{}{
		"activeTab": m.activeTab,
	})
}

func (m *Model) selectedMission() *MissionSummaryRecord {
	if len(m.missions) == 0 || m.selectedMissionIndex < 0 || m.selectedMissionIndex >= len(m.missions) {
		return nil
	}
	return &m.missions[m.selectedMissionIndex]
}

func (m *Model) selectedMissionStep() *MissionStepRecord {
	if m.missionDetail == nil || len(m.missionDetail.Steps) == 0 {
		return nil
	}
	index := clamp(m.selectedMissionStepIndex, 0, len(m.missionDetail.Steps)-1)
	return &m.missionDetail.Steps[index]
}

func (m *Model) missionTask(step *MissionStepRecord) *TaskRecord {
	if step == nil || step.LinkedTaskID == "" {
		return nil
	}
	return m.taskByID(step.LinkedTaskID)
}

func (m *Model) handleMissionKey(key tea.KeyMsg) tea.Cmd {
	if key.String() == "ctrl+p" || key.String() == ":" {
		m.openCommandPaletteModal()
		return nil
	}

	if key.String() == "t" {
		if m.activeTaskID == "" {
			m.statusMessage = "No session open for the selected task."
			return nil
		}
		return m.focusActiveTerminalCmd(false)
	}
	if key.String() == "z" {
		if m.activeTaskID == "" {
			m.statusMessage = "No session open to expand."
			return nil
		}
		return m.focusActiveTerminalCmd(true)
	}

	switch key.String() {
	case "left", "h":
		m.missionPaneFocus = missionPaneList
		return nil
	case "right", "l":
		if m.missionDetail != nil && len(m.missionDetail.Steps) > 0 {
			m.missionPaneFocus = missionPaneSteps
		}
		return nil
	case "up", "k":
		if m.missionPaneFocus == missionPaneSteps {
			if m.missionDetail == nil {
				return nil
			}
			m.selectedMissionStepIndex = clamp(m.selectedMissionStepIndex-1, 0, max(0, len(m.missionDetail.Steps)-1))
			return nil
		}
		if len(m.missions) == 0 {
			return nil
		}
		m.selectedMissionIndex = clamp(m.selectedMissionIndex-1, 0, len(m.missions)-1)
		m.activeMissionID = m.missions[m.selectedMissionIndex].ID
		m.selectedMissionStepIndex = 0
		return m.loadAppStateCmd("", m.activeMissionID, "")
	case "down", "j":
		if m.missionPaneFocus == missionPaneSteps {
			if m.missionDetail == nil {
				return nil
			}
			m.selectedMissionStepIndex = clamp(m.selectedMissionStepIndex+1, 0, max(0, len(m.missionDetail.Steps)-1))
			return nil
		}
		if len(m.missions) == 0 {
			return nil
		}
		m.selectedMissionIndex = clamp(m.selectedMissionIndex+1, 0, len(m.missions)-1)
		m.activeMissionID = m.missions[m.selectedMissionIndex].ID
		m.selectedMissionStepIndex = 0
		return m.loadAppStateCmd("", m.activeMissionID, "")
	case "enter":
		if m.missionPaneFocus == missionPaneList {
			if m.missionDetail != nil && len(m.missionDetail.Steps) > 0 {
				m.missionPaneFocus = missionPaneSteps
			}
			return nil
		}
		step := m.selectedMissionStep()
		if step == nil {
			return nil
		}
		if step.LinkedTaskID != "" {
			return m.openSessionCmd(step.LinkedTaskID, false)
		}
		if step.Status != "ready" {
			m.statusMessage = fmt.Sprintf("Mission step '%s' is not ready.", step.Title)
			return nil
		}
		return m.startMissionStepCmd(step.ID, step.MissionID)
	case "n":
		m.openCreateMissionModal()
		return nil
	case "A":
		m.openAddMissionStepModal()
		return nil
	case "S":
		mission := m.selectedMission()
		if mission == nil {
			return nil
		}
		return m.startNextMissionStepCmd(mission.ID)
	case "G":
		mission := m.selectedMission()
		if mission == nil {
			return nil
		}
		return m.startAllReadyMissionStepsCmd(mission.ID)
	case "x":
		step := m.selectedMissionStep()
		if step == nil {
			return nil
		}
		if step.LinkedTaskID != "" {
			m.statusMessage = "Cannot skip a mission step with a linked task."
			return nil
		}
		if step.Status == "skipped" {
			m.statusMessage = "Mission step is already skipped."
			return nil
		}
		return m.setMissionStepStatusCmd(step.ID, "skipped", step.MissionID, step.ID, "Skipped mission step.")
	case "r":
		step := m.selectedMissionStep()
		if step == nil {
			return nil
		}
		if step.LinkedTaskID != "" {
			m.statusMessage = "Cannot reopen a mission step while it has a linked task."
			return nil
		}
		if step.Status != "skipped" && step.Status != "done" {
			m.statusMessage = "Mission step is already open."
			return nil
		}
		return m.setMissionStepStatusCmd(step.ID, "ready", step.MissionID, step.ID, "Reopened mission step.")
	case "o":
		step := m.selectedMissionStep()
		if task := m.missionTask(step); task != nil {
			m.activeTab = AppTabBoard
			m.activeRepoID = task.RepoID
			m.selectTaskByID(task.ID)
			return tea.Batch(m.persistActiveTabCmd(), m.persistActiveRepoCmd())
		}
		return nil
	case "?":
		m.openHelpModal()
		return nil
	case "q":
		return tea.Quit
	default:
		return nil
	}
}

func (m *Model) createMissionCmd(title string) tea.Cmd {
	return func() tea.Msg {
		var mission MissionRecord
		if err := m.client.Call("createMission", map[string]string{"title": title}, &mission); err != nil {
			return appStateLoadedMsg{err: err}
		}
		return m.loadAppState("Created mission.", mission.ID, "")
	}
}

func (m *Model) addMissionStepCmd(title, repoID, dependsOnStepID string) tea.Cmd {
	mission := m.selectedMission()
	if mission == nil {
		return nil
	}

	return func() tea.Msg {
		params := map[string]string{
			"missionId": mission.ID,
			"title":     title,
			"repoId":    repoID,
		}
		if dependsOnStepID != "" {
			params["dependsOnStepId"] = dependsOnStepID
		}

		var step MissionStepRecord
		if err := m.client.Call("addMissionStep", params, &step); err != nil {
			return appStateLoadedMsg{err: err}
		}
		return m.loadAppState("Added mission step.", step.MissionID, step.ID)
	}
}

func (m *Model) startMissionStepCmd(stepID, missionID string) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Call("startMissionStep", map[string]string{"id": stepID}, nil); err != nil {
			return appStateLoadedMsg{err: err}
		}
		return m.loadAppState("Started mission step.", missionID, stepID)
	}
}

func (m *Model) startNextMissionStepCmd(missionID string) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Call("startNextMissionStep", map[string]string{"missionId": missionID}, nil); err != nil {
			return appStateLoadedMsg{err: err}
		}
		return m.loadAppState("Started next mission step.", missionID, "")
	}
}

func (m *Model) startAllReadyMissionStepsCmd(missionID string) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Call("startAllReadyMissionSteps", map[string]string{"missionId": missionID}, nil); err != nil {
			return appStateLoadedMsg{err: err}
		}
		return m.loadAppState("Started all ready mission steps.", missionID, "")
	}
}

func (m *Model) setMissionStepStatusCmd(
	stepID string,
	status MissionStepStatus,
	missionID string,
	selectedStepID string,
	message string,
) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Call("setMissionStepStatus", map[string]string{
			"id":     stepID,
			"status": string(status),
		}, nil); err != nil {
			return appStateLoadedMsg{err: err}
		}
		return m.loadAppState(message, missionID, selectedStepID)
	}
}
