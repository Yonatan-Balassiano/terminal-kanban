package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

const (
	missionListStyleWidth    = 34
	missionListRenderWidth   = missionListStyleWidth + 2
	missionDetailStyleWidth  = 58
	missionDetailRenderWidth = missionDetailStyleWidth + 2
)

func missionPaneRenderWidth(totalWidth int) int {
	target := missionListRenderWidth + terminalDividerWidth + missionDetailRenderWidth
	if totalWidth <= 0 {
		return target
	}
	return min(totalWidth, target)
}

func renderPrimaryPane(m *Model, height int) string {
	if m.activeTab == AppTabMissions {
		return renderMissions(m, height)
	}
	return renderBoard(m, height)
}

func renderMissions(m *Model, height int) string {
	if len(m.missions) == 0 {
		return fitHeight(
			lipgloss.NewStyle().
				Width(max(1, missionPaneRenderWidth(m.width))).
				Padding(1, 2).
				Foreground(lipgloss.Color(uiChrome.Muted)).
				Render("No missions yet. Press n to create the first mission."),
			height,
		)
	}

	listView := fitHeight(renderMissionListPane(m, height), height)
	detailView := fitHeight(renderMissionDetailPane(m, height), height)
	return lipgloss.JoinHorizontal(lipgloss.Top, listView, renderVerticalDivider(height), detailView)
}

func renderMissionListPane(m *Model, height int) string {
	header := joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Accent)).Render("MISSIONS"),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(fmt.Sprintf("%d", len(m.missions))),
		missionListStyleWidth-2,
	)

	rowHeights := make([]int, 0, len(m.missions))
	for range m.missions {
		rowHeights = append(rowHeights, 4)
	}
	listHeight := max(1, height-3)
	windowStart, windowEnd := visibleWindow(rowHeights, m.selectedMissionIndex, listHeight)
	visible := m.missions[windowStart:windowEnd]

	lines := []string{header, ""}
	for offset, mission := range visible {
		actualIndex := windowStart + offset
		lines = append(lines, renderMissionListItem(m, mission, actualIndex == m.selectedMissionIndex))
	}
	if len(visible) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("No missions"))
	}

	return lipgloss.NewStyle().
		Width(missionListStyleWidth).
		Height(height).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(ternaryString(m.missionPaneFocus == missionPaneList, uiChrome.Accent, uiChrome.Line))).
		Padding(0, 1).
		Render(strings.Join(lines, "\n"))
}

func renderMissionListItem(m *Model, mission MissionSummaryRecord, selected bool) string {
	borderColor := uiChrome.Line
	if selected {
		borderColor = uiChrome.Accent
	}

	repoLabel := "no repo"
	switch len(mission.RepoIDs) {
	case 0:
	case 1:
		repoLabel = missionRepoLabel(m, mission.RepoIDs[0])
	default:
		repoLabel = fmt.Sprintf("%d repos", len(mission.RepoIDs))
	}

	line1 := joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Bold(selected).Render(truncateText(mission.Title, missionListStyleWidth-10)),
		badge(fmt.Sprintf("%d/%d", mission.CompletedSteps+mission.SkippedSteps, mission.TotalSteps), missionStatusTone(mission.Status), "", false),
		missionListStyleWidth-2,
	)
	counts := []string{}
	if mission.ReadySteps > 0 {
		counts = append(counts, badge(fmt.Sprintf("%d ready", mission.ReadySteps), "accent", "", false))
	}
	if mission.ActiveSteps > 0 {
		counts = append(counts, badge(fmt.Sprintf("%d active", mission.ActiveSteps), "warning", "", false))
	}
	if mission.BlockedSteps > 0 {
		counts = append(counts, badge(fmt.Sprintf("%d blocked", mission.BlockedSteps), "muted", "", false))
	}
	if len(counts) == 0 {
		counts = append(counts, badge("aligned", "success", "", false))
	}

	content := strings.Join([]string{
		line1,
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Blue)).Render("◈ " + truncateText(repoLabel, missionListStyleWidth-4)),
		strings.Join(counts, " "),
	}, "\n")

	return lipgloss.NewStyle().
		Width(missionListStyleWidth-2).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(borderColor)).
		Padding(0, 1).
		Render(content)
}

func renderMissionDetailPane(m *Model, height int) string {
	if m.missionDetail == nil {
		return lipgloss.NewStyle().
			Width(missionDetailStyleWidth).
			Height(height).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(ternaryString(m.missionPaneFocus == missionPaneSteps, uiChrome.Accent, uiChrome.Line))).
			Padding(1).
			Render(lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Select a mission to inspect its steps."))
	}

	mission := m.missionDetail.Mission
	header := joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Bold(true).Render(truncateText(mission.Title, missionDetailStyleWidth-18)),
		badge(fmt.Sprintf("%d/%d", mission.CompletedSteps+mission.SkippedSteps, mission.TotalSteps), missionStatusTone(mission.Status), "", false),
		missionDetailStyleWidth-2,
	)

	metaLine := strings.Join([]string{
		badge(fmt.Sprintf("%d ready", mission.ReadySteps), "accent", "", false),
		badge(fmt.Sprintf("%d active", mission.ActiveSteps), "warning", "", false),
		badge(fmt.Sprintf("%d blocked", mission.BlockedSteps), "muted", "", false),
	}, " ")

	rowHeights := make([]int, 0, len(m.missionDetail.Steps))
	for _, step := range m.missionDetail.Steps {
		rowHeights = append(rowHeights, missionStepCardHeight(step))
	}
	listHeight := max(1, height-5)
	windowStart, windowEnd := visibleWindow(rowHeights, m.selectedMissionStepIndex, listHeight)
	visible := m.missionDetail.Steps[windowStart:windowEnd]

	lines := []string{
		header,
		metaLine,
		"",
	}
	if len(visible) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("No steps yet. Press A to add a mission step."))
	} else {
		for offset, step := range visible {
			actualIndex := windowStart + offset
			lines = append(lines, renderMissionStepCard(m, step, actualIndex == m.selectedMissionStepIndex))
		}
	}

	return lipgloss.NewStyle().
		Width(missionDetailStyleWidth).
		Height(height).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(ternaryString(m.missionPaneFocus == missionPaneSteps, uiChrome.Accent, uiChrome.Line))).
		Padding(0, 1).
		Render(strings.Join(lines, "\n"))
}

func renderMissionStepCard(m *Model, step MissionStepRecord, selected bool) string {
	borderColor := uiChrome.Line
	if selected {
		borderColor = uiChrome.Accent
	}

	title := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Bold(selected).Render(truncateText(step.Title, missionDetailStyleWidth-8))
	repoLine := badge("REPO "+truncateText(missionRepoLabel(m, step.RepoID), 18), "info", "", false)
	statusLine := badge(strings.ToUpper(string(step.Status)), missionStepStatusTone(step.Status), "", false)

	secondary := []string{repoLine, statusLine}
	if step.LinkedTaskID != "" {
		label := step.LinkedTaskID
		if task := m.taskByID(step.LinkedTaskID); task != nil {
			label = truncateText(task.Title, 22)
		}
		secondary = append(secondary, badge("TASK "+label, "accent", "", false))
	} else if step.DependsOnStepID != "" && step.Status == "planned" {
		if dependency := missionDependencyLabel(m.missionDetail, step.DependsOnStepID); dependency != "" {
			secondary = append(secondary, badge("WAIT "+truncateText(dependency, 18), "muted", "", false))
		}
	}

	lines := []string{
		title,
		strings.Join(secondary, " "),
	}
	if description := normalizeSingleLine(step.Description); description != "" {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(description, missionDetailStyleWidth-8)))
	}

	return lipgloss.NewStyle().
		Width(missionDetailStyleWidth-2).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(borderColor)).
		Padding(0, 1).
		Render(strings.Join(lines, "\n"))
}

func missionRepoLabel(m *Model, repoID string) string {
	if repo := m.repoByID(repoID); repo != nil {
		return repo.Label
	}
	return repoID
}

func missionRepoHeaderLabel(m *Model, mission *MissionSummaryRecord) string {
	if mission == nil || len(mission.RepoIDs) == 0 {
		return "no repo"
	}
	if len(mission.RepoIDs) == 1 {
		return missionRepoLabel(m, mission.RepoIDs[0])
	}
	return fmt.Sprintf("%d repos", len(mission.RepoIDs))
}

func missionStatusTone(status MissionStatus) string {
	if status == "done" {
		return "success"
	}
	return "accent"
}

func missionStepStatusTone(status MissionStepStatus) string {
	switch status {
	case "ready":
		return "accent"
	case "active":
		return "warning"
	case "done":
		return "success"
	case "skipped":
		return "purple"
	default:
		return "muted"
	}
}

func missionDependencyLabel(detail *MissionDetail, stepID string) string {
	if detail == nil {
		return ""
	}
	for _, step := range detail.Steps {
		if step.ID == stepID {
			return step.Title
		}
	}
	return ""
}

func missionStepCardHeight(step MissionStepRecord) int {
	height := 4
	if normalizeSingleLine(step.Description) != "" {
		height++
	}
	return height
}
