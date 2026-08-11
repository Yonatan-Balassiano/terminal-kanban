package tui

import (
	"fmt"
	"slices"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

const (
	commandPaletteWidth = 86
	commandVisibleRows  = 8
	branchPRListWidth   = 86
	branchPRVisibleRows = 6
	filterColumnWidth   = 28
	filterVisibleRows   = 8
	aiChatModalWidth    = 96
	aiChatVisibleRows   = 10
)

func renderModal(m *Model) string {
	switch m.modal {
	case ModalHelp:
		return renderHelpModal()
	case ModalCreateTask:
		return renderCreateTaskModal(m)
	case ModalCreateMission:
		return renderCreateMissionModal(m)
	case ModalAddMissionTask:
		return renderAddMissionTaskModal(m)
	case ModalRenameTask:
		return renderRenameTaskModal(m)
	case ModalSetBranch:
		return renderSetBranchModal(m)
	case ModalTaskDescription:
		return renderTaskDescriptionModal(m)
	case ModalPRComment:
		return renderPRCommentModal(m)
	case ModalDeleteMission:
		return renderDeleteMissionConfirmModal(m)
	case ModalDeleteConfirm:
		return renderDeleteConfirmModal(m)
	case ModalCreatePillar:
		return renderCreatePillarModal(m)
	case ModalDeletePillar:
		return renderDeletePillarConfirmModal(m)
	case ModalPillarPicker:
		return renderPillarPickerModal(m)
	case ModalFilterPicker:
		return renderFilterModal(m)
	case ModalViewPicker:
		return renderViewModal(m)
	case ModalCommandPalette:
		return renderCommandPaletteModal(m)
	case ModalAIChat:
		return renderAIChatModal(m)
	case ModalMissionDeps:
		return renderMissionDependenciesModal(m)
	case ModalArtifactList:
		return renderArtifactListModal(m)
	case ModalArtifactRollout:
		return renderArtifactRolloutModal(m)
	case ModalBranchPRList:
		return renderBranchPRListModal(m)
	default:
		return lipgloss.NewStyle().
			Border(lipgloss.DoubleBorder()).
			BorderForeground(lipgloss.Color(uiChrome.Accent)).
			Padding(1).
			Render("Go TUI modal is not implemented yet.")
	}
}

func renderCreateTaskModal(m *Model) string {
	state := m.createTaskModal
	if state == nil {
		return ""
	}

	options := m.createTaskPillarOptions()
	selectedRepo := m.createTaskRepoOptionAt(state.RepoIndex).Label
	if selectedRepo == "" {
		selectedRepo = "None"
	}

	selectedPillar := "None"
	if len(options) > 0 {
		selectedPillar = options[clamp(state.PillarIndex, 0, len(options)-1)].Label
	}
	selectedAgent := createTaskAgentOptionAt(state.AgentIndex).Label
	selectedLocation := m.createTaskLocationLabelAt(state.RepoIndex, state.LocationIndex)

	linePrefix := func(line createTaskLine) string {
		if state.ActiveLine == line {
			return "▸"
		}
		return " "
	}

	lineColor := func(line createTaskLine) lipgloss.Style {
		if state.ActiveLine == line {
			return lipgloss.NewStyle().Foreground(lipgloss.Color("cyan"))
		}
		return lipgloss.NewStyle()
	}

	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Create Task"),
		"",
		lineColor(createTaskTitleLine).Render(fmt.Sprintf("%s Title: %s%s", linePrefix(createTaskTitleLine), state.Value, ternaryString(state.ActiveLine == createTaskTitleLine, "|", ""))),
		lineColor(createTaskRepoLine).Render(fmt.Sprintf("%s Repo: %s", linePrefix(createTaskRepoLine), selectedRepo)),
		lineColor(createTaskPillarLine).Render(fmt.Sprintf("%s Pillar: %s", linePrefix(createTaskPillarLine), selectedPillar)),
		lineColor(createTaskAgentLine).Render(fmt.Sprintf("%s Agent: %s", linePrefix(createTaskAgentLine), selectedAgent)),
		lineColor(createTaskLocationLine).Render(fmt.Sprintf("%s Runs on: %s", linePrefix(createTaskLocationLine), selectedLocation)),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[↑/↓ lines]  [←/→ change current field]"),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[Enter] create  [Esc] cancel"),
	}

	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderCreateMissionModal(m *Model) string {
	state := m.createMissionModal
	if state == nil {
		return ""
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Create Mission"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color("cyan")).Render("Title: ") + state.Value + "|",
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[Enter] create  [Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderAddMissionTaskModal(m *Model) string {
	state := m.addMissionTaskModal
	if state == nil {
		return ""
	}
	if state.Stage == addMissionTaskStageBlockers {
		return renderAddMissionTaskBlockerModal(m)
	}

	selectedRepo := "None"
	if len(m.repos) > 0 {
		selectedRepo = m.repos[clamp(state.RepoIndex, 0, len(m.repos)-1)].Label
	}

	selectedPillar := "None"
	options := m.createTaskPillarOptions()
	if len(options) > 0 {
		selectedPillar = options[clamp(state.PillarIndex, 0, len(options)-1)].Label
	}
	selectedAgent := createTaskAgentOptionAt(state.AgentIndex).Label
	missionTitle := state.MissionID
	if mission := m.selectedMission(); mission != nil && mission.ID == state.MissionID {
		missionTitle = mission.Title
	}

	linePrefix := func(line createTaskLine) string {
		if state.ActiveLine == line {
			return "▸"
		}
		return " "
	}
	lineColor := func(line createTaskLine) lipgloss.Style {
		if state.ActiveLine == line {
			return lipgloss.NewStyle().Foreground(lipgloss.Color("cyan"))
		}
		return lipgloss.NewStyle()
	}
	blockedLabel := ternaryString(state.WantsBlocked, "Yes", "No")
	if state.WantsBlocked && len(state.SelectedBlockerTaskIDs) > 0 {
		blockedLabel = fmt.Sprintf("Yes (%d selected)", len(state.SelectedBlockerTaskIDs))
	}
	actionLabel := "add"
	if state.WantsBlocked {
		actionLabel = "next"
	}

	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Add Mission Task"),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(missionTitle, 48)),
		"",
		lineColor(createTaskTitleLine).Render(fmt.Sprintf("%s Title: %s%s", linePrefix(createTaskTitleLine), state.Value, ternaryString(state.ActiveLine == createTaskTitleLine, "|", ""))),
		lineColor(createTaskRepoLine).Render(fmt.Sprintf("%s Repo: %s", linePrefix(createTaskRepoLine), selectedRepo)),
		lineColor(createTaskPillarLine).Render(fmt.Sprintf("%s Pillar: %s", linePrefix(createTaskPillarLine), selectedPillar)),
		lineColor(createTaskAgentLine).Render(fmt.Sprintf("%s Agent: %s", linePrefix(createTaskAgentLine), selectedAgent)),
		lineColor(createTaskBlockedLine).Render(fmt.Sprintf("%s Blocked: %s", linePrefix(createTaskBlockedLine), blockedLabel)),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[↑/↓ lines]  [←/→ change current field]"),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(fmt.Sprintf("[Enter] %s  [Esc] cancel", actionLabel)),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderAddMissionTaskBlockerModal(m *Model) string {
	state := m.addMissionTaskModal
	if state == nil {
		return ""
	}

	options := m.missionDependencyOptions(state.MissionID, "")
	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Mission Blockers"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(state.Value, 52)),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Select blocker tasks before creating."),
		"",
	}
	if len(options) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("No other mission tasks available."))
	} else {
		for index, option := range options {
			selected := index == state.BlockerIndex
			checked := slices.Contains(state.SelectedBlockerTaskIDs, option.ID)
			style := lipgloss.NewStyle()
			if selected {
				style = style.Foreground(lipgloss.Color("cyan")).Bold(true)
			}
			lines = append(lines, style.Render(fmt.Sprintf("%s [%s] %s", ternaryString(selected, "▸", " "), ternaryString(checked, "x", " "), truncateText(option.Label, 48))))
		}
	}
	lines = append(lines, "", lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("↑↓ move  [space] toggle blocker  [Enter] create  [Esc] back"))
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderSetBranchModal(m *Model) string {
	state := m.setBranchModal
	if state == nil {
		return ""
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Change Tracked Branch"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color("cyan")).Render("Branch: ") + state.Value + "|",
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[Enter] confirm  [Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderRenameTaskModal(m *Model) string {
	state := m.renameTaskModal
	if state == nil {
		return ""
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Rename Task"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color("cyan")).Render("Title: ") + state.Value + "|",
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[Enter] rename  [Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderTaskDescriptionModal(m *Model) string {
	state := m.taskDescriptionModal
	if state == nil {
		return ""
	}
	task := m.taskByID(state.TaskID)
	taskTitle := ""
	if task != nil {
		taskTitle = task.Title
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Task Description"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(taskTitle, 48)),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color("cyan")).Render("Desc: ") + state.Value + "|",
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[Enter] save  [Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderPRCommentModal(m *Model) string {
	state := m.prCommentModal
	if state == nil {
		return ""
	}
	task := m.taskByID(state.TaskID)
	taskTitle := ""
	prLabel := ""
	if task != nil {
		taskTitle = task.Title
		if task.PRNumber != nil {
			prLabel = fmt.Sprintf("PR #%d", *task.PRNumber)
			if task.PRState == "draft" {
				prLabel = "Draft " + prLabel
			}
		}
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("PR Comment"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(taskTitle, 48)),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(prLabel),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color("cyan")).Render("Comment: ") + state.Value + "|",
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[Enter] post  [Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

// Everything that decides the blast radius — full artifact id, the exact
// version jump, and the graduality — is on screen before the field can be armed.
// renderArtifactListModal shows which artifacts the rail tracks, and lets the
// list be edited without leaving the board for config.json.
func renderArtifactListModal(m *Model) string {
	state := m.artifactListModal
	if state == nil {
		return ""
	}

	lines := []string{
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Text)).Render("TRACKED ARTIFACTS"),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).
			Render("A merged card only reports GA for artifacts listed here."),
		"",
	}

	// "Nothing tracked yet" is a claim about the config, so it must not be made
	// while the config is still on its way.
	if state.Loading {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).
			Render("  Loading tracked artifacts..."))
	} else if len(state.Names) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).
			Render("  Nothing tracked yet."))
	}
	for index, name := range state.Names {
		marker := "  "
		style := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text))
		if index == state.Selected && !state.Adding {
			marker = artifactSelectedMark + " "
			style = style.Bold(true).Background(lipgloss.Color(uiChrome.AccentMuted))
		}
		lines = append(lines, style.Render(marker+truncateText(name, 60)))
	}

	if state.Adding {
		lines = append(lines,
			"",
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Accent)).
				Render("New artifact id: "+state.Draft+"█"),
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).
				Render("e.g. com.wixpress.web5.ecom-integrations"),
		)
	}

	if state.Error != "" {
		lines = append(lines, "",
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Danger)).Render(state.Error))
	}

	hint := "a add   d remove   enter save   esc cancel"
	if state.Adding {
		hint = "enter add   esc cancel"
	}
	if state.Loading {
		hint = "esc cancel"
	}
	if state.Applying {
		hint = "saving..."
	}
	lines = append(lines, "",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(hint))

	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderArtifactRolloutModal(m *Model) string {
	state := m.artifactRolloutModal
	if state == nil {
		return ""
	}

	muted := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted))
	armed := state.Confirm == artifactRolloutConfirmWord
	confirmColor := ternaryString(armed, uiChrome.Success, uiChrome.Muted)

	lines := []string{
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Danger)).Render("ROLL OUT TO PRODUCTION"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render(state.Name),
		fmt.Sprintf("%s  →  %s", artifactVersionOrUnknown(state.CurrentVersion), artifactVersionOrUnknown(state.TargetVersion)),
	}

	// Opened from a card, so name what is being shipped. A bare version number
	// is a much weaker thing to confirm than "this ships my change".
	if state.ShippingCard != "" {
		lines = append(lines,
			muted.Render("ships: "+truncateText(state.ShippingCard, 52)))
	}

	if note := artifactOwnershipNote(state.PendingRcCount, state.MyPendingCount); note != "" {
		lines = append(lines, artifactOwnedStyle(false).Render(note))
	}

	lines = append(lines,
		fmt.Sprintf("graduality: ‹ %s ›", artifactGradualityAt(state.GradualityIndex)),
		muted.Render("comment: generated automatically"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(confirmColor)).
			Render(fmt.Sprintf("type %s to confirm: %s|", artifactRolloutConfirmWord, state.Confirm)),
		muted.Render("[←/→] graduality  [Enter] confirm  [Esc] cancel"),
	)
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

// Confirmation context, not a gate: silent when ownership could not be resolved,
// because guessing here would misattribute somebody else's pending work.
func artifactOwnershipNote(pendingRcCount, myPendingCount *int) string {
	if pendingRcCount == nil || myPendingCount == nil {
		return ""
	}
	return fmt.Sprintf("%d of %d pending RCs are yours", *myPendingCount, *pendingRcCount)
}

func artifactVersionOrUnknown(version string) string {
	if version == "" {
		return artifactUnknownLabel
	}
	return version
}

func renderDeleteConfirmModal(m *Model) string {
	state := m.deleteConfirmModal
	if state == nil {
		return ""
	}
	task := m.taskByID(state.TaskID)
	title := ""
	if task != nil {
		title = task.Title
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("red")).Render("Delete Task"),
		"",
		fmt.Sprintf("Delete task '%s'?", title),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[y] confirm  [n/Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderDeleteMissionConfirmModal(m *Model) string {
	state := m.deleteMissionConfirmModal
	if state == nil {
		return ""
	}
	title := state.MissionID
	if mission := m.selectedMission(); mission != nil && mission.ID == state.MissionID {
		title = mission.Title
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("red")).Render("Delete Mission"),
		"",
		fmt.Sprintf("Delete mission '%s'?", title),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color("red")).Render(
			fmt.Sprintf("This will also delete %d task%s in this mission.", state.TaskCount, ternaryString(state.TaskCount == 1, "", "s")),
		),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[y] confirm  [n/Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderCreatePillarModal(m *Model) string {
	state := m.createPillarModal
	if state == nil {
		return ""
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Create Pillar"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color("cyan")).Render("Label: ") + state.Value + "|",
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[Enter] create  [Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderDeletePillarConfirmModal(m *Model) string {
	state := m.deletePillarConfirmModal
	if state == nil {
		return ""
	}
	pillar := m.pillarByID(state.PillarID)
	label := ""
	if pillar != nil {
		label = pillar.Label
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("red")).Render("Delete Pillar"),
		"",
		fmt.Sprintf("Delete pillar '%s'?", label),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color("red")).Render(
			fmt.Sprintf("This will also delete %d task%s in this pillar.", state.TaskCount, ternaryString(state.TaskCount == 1, "", "s")),
		),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[y] confirm  [n/Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderPillarPickerModal(m *Model) string {
	state := m.pillarPickerModal
	if state == nil {
		return ""
	}
	task := m.taskByID(state.TaskID)
	currentPillarID := ""
	if task != nil {
		currentPillarID = task.PillarID
	}
	options := m.pillarPickerOptions()
	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Assign Pillar"),
		"",
	}
	for index, option := range options {
		selected := index == state.Index
		label := option.Label
		row := ternaryString(selected, "▶ ", "  ") + label
		style := lipgloss.NewStyle()
		if selected {
			style = style.Foreground(lipgloss.Color("green"))
		}
		if option.ID == currentPillarID {
			row += " (current)"
		}
		lines = append(lines, style.Render(row))
	}
	lines = append(lines, "")
	lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("↑↓ navigate  [Enter] select  [c] create  [d] delete  [Esc] cancel"))
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderFilterModal(m *Model) string {
	state := m.filterModal
	if state == nil {
		return ""
	}

	left := renderFilterColumn("Repos", state.ActiveColumn == filterRepoColumn, m.filterRepoOptions(), state.SelectedRepoIDs, state.RepoIndex)
	right := renderFilterColumn("Pillars", state.ActiveColumn == filterPillarColumn, m.filterPillarOptions(), state.SelectedPillarIDs, state.PillarIndex)

	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Filters"),
		"",
		lipgloss.JoinHorizontal(lipgloss.Top, left, "  ", right),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("No checks means all. [←/→] switch list  [↑/↓] move  [space] toggle"),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[Enter] apply  [c] clear all  [Esc] cancel"),
	}
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderViewModal(m *Model) string {
	state := m.viewModal
	if state == nil {
		return ""
	}
	options := []struct {
		Label       string
		Description string
	}{
		{Label: "Side By Side", Description: "Board on the left, terminal on the right"},
		{Label: "Top / Bottom", Description: "Board on top, terminal on the bottom"},
	}
	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("View Layout"),
		"",
	}
	for index, option := range options {
		selected := index == state.Index
		style := lipgloss.NewStyle()
		if selected {
			style = style.Foreground(lipgloss.Color("cyan")).Bold(true)
		}
		lines = append(lines, style.Render(fmt.Sprintf("%s %s", ternaryString(selected, "▸", " "), option.Label)))
		lines = append(lines, lipgloss.NewStyle().MarginLeft(2).Foreground(lipgloss.Color(uiChrome.Muted)).Render(option.Description))
	}
	lines = append(lines, "", lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[↑/↓] choose  [Enter] apply  [Esc] cancel"))
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderCommandPaletteModal(m *Model) string {
	state := m.commandPaletteModal
	if state == nil {
		return ""
	}
	filtered := m.filteredCommandPaletteCommands(state.Query)
	lines := []string{
		joinSpaceBetween(strings.Join([]string{
			badge("COMMANDS", "accent", "", false),
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Search actions and workflows"),
		}, " "), lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Esc close"), commandPaletteWidth-4),
		"",
		lipgloss.NewStyle().
			Width(commandPaletteWidth-4).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(uiChrome.Line)).
			Padding(0, 1).
			Render(ternaryString(state.Query != "", ": "+state.Query, ": Type to filter commands")),
		"",
	}

	if len(filtered) == 0 {
		lines = append(lines, lipgloss.NewStyle().
			Width(commandPaletteWidth-4).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(uiChrome.Line)).
			Padding(1).
			Render(
				lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render("No matching commands")+"\n"+
					lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Try searching by action, workflow, or shortcut."),
			))
	} else {
		windowStart := commandWindowStart(state.Index, len(filtered), commandVisibleRows)
		visible := filtered[windowStart:min(len(filtered), windowStart+commandVisibleRows)]
		for offset, command := range visible {
			actualIndex := windowStart + offset
			selected := actualIndex == state.Index
			borderColor := uiChrome.Line
			if selected {
				borderColor = uiChrome.Accent
			}
			titleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text))
			if command.Disabled {
				titleStyle = lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted))
			}
			if selected {
				titleStyle = titleStyle.Bold(true)
			}
			detail := command.Detail
			detailColor := uiChrome.Muted
			if command.Disabled && command.DisabledReason != "" {
				detail = command.DisabledReason
				detailColor = uiChrome.Warning
			}
			lines = append(lines, lipgloss.NewStyle().
				Width(commandPaletteWidth-4).
				Border(lipgloss.RoundedBorder()).
				BorderForeground(lipgloss.Color(borderColor)).
				Padding(0, 1).
				Render(
					joinSpaceBetween(strings.Join([]string{
						lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(selected, uiChrome.Accent, uiChrome.Muted))).Render(ternaryString(selected, "▸", " ")),
						badge(strings.ToUpper(command.Section), "muted", "", false),
						titleStyle.Render(command.Title),
					}, " "), lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(command.Shortcut), commandPaletteWidth-8)+"\n"+
						lipgloss.NewStyle().Foreground(lipgloss.Color(detailColor)).Render(truncateText(detail, commandPaletteWidth-8)),
				))
			if offset < len(visible)-1 {
				lines = append(lines, "")
			}
		}
	}

	lines = append(lines, "")
	lines = append(lines, joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("↑↓ move  Enter run"),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(
			ternaryString(len(filtered) > 0, fmt.Sprintf("%d/%d", clamp(state.Index, 0, len(filtered)-1)+1, len(filtered)), "0 results"),
		),
		commandPaletteWidth-4,
	))

	return modalBox(lipgloss.DoubleBorder(), strings.Join(lines, "\n"))
}

// renderBranchPRListModal is the acting counterpart of the detail pane: the same
// rows, but over the board, where a keypress lands on the PR under the cursor
// rather than on whichever one the card's rollup happened to pick.
func renderBranchPRListModal(m *Model) string {
	state := m.branchPRListModal
	if state == nil {
		return ""
	}
	task := m.taskByID(state.TaskID)
	if task == nil {
		return ""
	}
	branches := task.Branches

	lines := []string{
		joinSpaceBetween(strings.Join([]string{
			badge("PULL REQUESTS", "accent", "", false),
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render(truncateText(task.Title, 40)),
		}, " "), lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Esc close"), branchPRListWidth-4),
		lipgloss.NewStyle().Foreground(lipgloss.Color(toneColor(releaseStageTone(task.Release)))).
			Render(truncateText("release "+releaseStageLabel(task.Release), branchPRListWidth-4)),
		"",
	}

	if len(branches) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).
			Render("This card has no tracked branch yet."))
		return modalBox(lipgloss.DoubleBorder(), strings.Join(lines, "\n"))
	}

	selected := clamp(state.Index, 0, len(branches)-1)
	windowStart := commandWindowStart(selected, len(branches), branchPRVisibleRows)
	visible := branches[windowStart:min(len(branches), windowStart+branchPRVisibleRows)]
	for offset, branch := range visible {
		lines = append(lines, renderBranchPRRow(m, *task, branch, windowStart+offset == selected))
		if offset < len(visible)-1 {
			lines = append(lines, "")
		}
	}

	lines = append(lines, "")
	lines = append(lines, joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("↑/k ↓ move  o open  v checks  j comment  m merge"),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(fmt.Sprintf("%d/%d", selected+1, len(branches))),
		branchPRListWidth-4,
	))

	return modalBox(lipgloss.DoubleBorder(), strings.Join(lines, "\n"))
}

func renderBranchPRRow(m *Model, task TaskRecord, branch TaskBranchRecord, selected bool) string {
	borderColor := uiChrome.Line
	if selected {
		borderColor = uiChrome.Accent
	}
	titleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text))
	if selected {
		titleStyle = titleStyle.Bold(true)
	}

	// The reason a merge would be refused is shown on the row itself, so the
	// answer to "why can't I merge this one" never needs a second keypress.
	detail := taskBranchChecksLabel(branch)
	detailColor := uiChrome.Muted
	if blocker := getBranchMergeBlockerReason(branch); blocker != "" && branch.PRState != "merged" {
		detail = detail + "  ·  " + blocker
		detailColor = uiChrome.Warning
	}

	return lipgloss.NewStyle().
		Width(branchPRListWidth-4).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(borderColor)).
		Padding(0, 1).
		Render(
			joinSpaceBetween(strings.Join([]string{
				lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(selected, uiChrome.Accent, uiChrome.Muted))).Render(ternaryString(selected, "▸", " ")),
				badge(strings.ToUpper(truncateText(m.taskBranchRepoLabel(branch), 16)), "muted", "", false),
				titleStyle.Render(truncateText(compactBranchLabel(branch.BranchName), 32)),
			}, " "), lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(
				taskBranchGlyph(branch, task.Release)+"  "+taskBranchPRLabel(branch),
			), branchPRListWidth-8) + "\n" +
				lipgloss.NewStyle().Foreground(lipgloss.Color(detailColor)).Render(truncateText(detail, branchPRListWidth-8)),
		)
}

func renderMissionDependenciesModal(m *Model) string {
	state := m.missionDependenciesModal
	if state == nil {
		return ""
	}

	taskTitle := state.TaskID
	if missionTask := m.selectedMissionTask(); missionTask != nil && missionTask.TaskID == state.TaskID {
		taskTitle = missionTask.Task.Title
	}
	options := m.missionDependencyOptions(state.MissionID, state.TaskID)

	lines := []string{
		lipgloss.NewStyle().Bold(true).Render("Mission Blockers"),
		"",
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(taskTitle, 52)),
		"",
	}
	if len(options) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("No other mission tasks available."))
	} else {
		for index, option := range options {
			selected := index == state.Index
			checked := slices.Contains(state.SelectedBlockerTaskIDs, option.ID)
			style := lipgloss.NewStyle()
			if selected {
				style = style.Foreground(lipgloss.Color("cyan")).Bold(true)
			}
			lines = append(lines, style.Render(fmt.Sprintf("%s [%s] %s", ternaryString(selected, "▸", " "), ternaryString(checked, "x", " "), truncateText(option.Label, 48))))
		}
	}
	lines = append(lines, "", lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("↑↓ move  [space] toggle blocker  [Enter] save  [Esc] cancel"))
	return modalBox(lipgloss.RoundedBorder(), strings.Join(lines, "\n"))
}

func renderAIChatModal(m *Model) string {
	state := m.aiChatModal
	if state == nil {
		return ""
	}

	lines := []string{
		joinSpaceBetween(strings.Join([]string{
			badge("AI CHAT", "accent", "", false),
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Local Ollama tool-calling assistant"),
		}, " "), lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Esc close"), aiChatModalWidth-4),
		"",
	}

	transcript := state.Transcript
	windowStart := max(0, len(transcript)-aiChatVisibleRows)
	if len(transcript) == 0 && state.PendingPrompt == "" {
		lines = append(lines, lipgloss.NewStyle().
			Width(aiChatModalWidth-4).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(uiChrome.Line)).
			Padding(1).
			Render(
				lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render("Ask AgentBoard to create or operate on tasks.")+"\n"+
					lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Example: create a mission with tasks api, ui, qa"),
			),
		)
	} else {
		for _, message := range transcript[windowStart:] {
			role := strings.ToUpper(message.Role)
			color := uiChrome.Text
			if message.Role == "user" {
				color = uiChrome.Accent
			} else if message.Role == "assistant" {
				color = uiChrome.Success
			}
			lines = append(lines, lipgloss.NewStyle().
				Width(aiChatModalWidth-4).
				Border(lipgloss.RoundedBorder()).
				BorderForeground(lipgloss.Color(uiChrome.Line)).
				Padding(0, 1).
				Render(
					lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Bold(true).Render(role)+"\n"+
						lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render(wrapText(message.Content, aiChatModalWidth-8)),
				),
			)
			lines = append(lines, "")
		}
	}

	if state.PendingPrompt != "" {
		lines = append(lines, lipgloss.NewStyle().
			Width(aiChatModalWidth-4).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(uiChrome.Warning)).
			Padding(0, 1).
			Render(
				lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Accent)).Bold(true).Render("USER")+"\n"+
					lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render(wrapText(state.PendingPrompt, aiChatModalWidth-8)),
			),
		)
		lines = append(lines, "")
	}

	if len(state.Executions) > 0 {
		lines = append(lines, lipgloss.NewStyle().Bold(true).Render("Last Tool Runs"))
		for _, execution := range state.Executions {
			statusColor := uiChrome.Muted
			switch execution.Status {
			case "completed":
				statusColor = uiChrome.Success
			case "failed":
				statusColor = uiChrome.Warning
			case "started":
				statusColor = uiChrome.Accent
			}
			detail := execution.Summary
			if detail == "" {
				detail = execution.Error
			}
			lines = append(lines, lipgloss.NewStyle().
				Width(aiChatModalWidth-4).
				Border(lipgloss.RoundedBorder()).
				BorderForeground(lipgloss.Color(uiChrome.Line)).
				Padding(0, 1).
				Render(
					joinSpaceBetween(
						lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Bold(true).Render(execution.ToolName),
						lipgloss.NewStyle().Foreground(lipgloss.Color(statusColor)).Render(strings.ToUpper(execution.Status)),
						aiChatModalWidth-8,
					)+"\n"+
						lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(detail, aiChatModalWidth-8)),
				),
			)
		}
		lines = append(lines, "")
	}

	if state.LastError != "" {
		lines = append(lines, lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Warning)).Render("Last Error"))
		lines = append(lines, lipgloss.NewStyle().
			Width(aiChatModalWidth-4).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(uiChrome.Danger)).
			Padding(0, 1).
			Render(
				lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Danger)).Bold(true).Render("REQUEST FAILED")+"\n"+
					lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render(wrapText(state.LastError, aiChatModalWidth-8)),
			),
		)
		lines = append(lines, "")
	}

	inputLabel := ": " + state.Input
	if state.Pending {
		inputLabel = ": waiting for response..."
	} else {
		inputLabel += "|"
	}
	lines = append(lines, lipgloss.NewStyle().
		Width(aiChatModalWidth-4).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(ternaryString(state.Pending, uiChrome.Line, uiChrome.Accent))).
		Padding(0, 1).
		Render(inputLabel),
	)
	lines = append(lines, "")
	lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("[Enter] send  [Esc] close"))

	return modalBox(lipgloss.DoubleBorder(), strings.Join(lines, "\n"))
}

func renderFilterColumn(title string, active bool, options []filterOption, selectedIDs []string, selectedIndex int) string {
	windowStart := commandWindowStart(selectedIndex, len(options), filterVisibleRows)
	visible := options[windowStart:min(len(options), windowStart+filterVisibleRows)]

	lines := []string{
		lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(active, "cyan", uiChrome.Text))).Bold(true).Render(title),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(
			ternaryString(len(selectedIDs) == 0, "all selected", fmt.Sprintf("%d checked", len(selectedIDs))),
		),
	}

	for offset, option := range visible {
		actualIndex := windowStart + offset
		selected := active && actualIndex == selectedIndex
		checked := slices.Contains(selectedIDs, option.ID)
		style := lipgloss.NewStyle()
		if selected {
			style = style.Foreground(lipgloss.Color("cyan")).Bold(true)
		}
		lines = append(lines, style.Render(fmt.Sprintf("%s [%s] %s", ternaryString(selected, "▸", " "), ternaryString(checked, "x", " "), padFilterLabel(option.Label, filterColumnWidth-9))))
	}
	for len(visible) < filterVisibleRows {
		lines = append(lines, " ")
		visible = append(visible, filterOption{})
	}

	borderColor := "gray"
	if active {
		borderColor = "cyan"
	}

	return lipgloss.NewStyle().
		Width(filterColumnWidth).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(borderColor)).
		Padding(0, 1).
		Render(strings.Join(lines, "\n"))
}

func modalBox(border lipgloss.Border, content string) string {
	return lipgloss.NewStyle().
		Border(border).
		BorderForeground(lipgloss.Color(uiChrome.Accent)).
		Padding(1).
		Render(content)
}

func commandWindowStart(index, length, visibleRows int) int {
	if length <= visibleRows {
		return 0
	}
	centered := index - visibleRows/2
	return clamp(centered, 0, length-visibleRows)
}

func padFilterLabel(label string, width int) string {
	if plainWidth(label) >= width {
		return truncateText(label, width)
	}
	return label + strings.Repeat(" ", width-plainWidth(label))
}

func wrapText(value string, width int) string {
	if width <= 0 {
		return value
	}
	words := strings.Fields(value)
	if len(words) == 0 {
		return value
	}

	lines := []string{}
	current := words[0]
	for _, word := range words[1:] {
		if plainWidth(current)+1+plainWidth(word) <= width {
			current += " " + word
			continue
		}
		lines = append(lines, current)
		current = word
	}
	lines = append(lines, current)
	return strings.Join(lines, "\n")
}
