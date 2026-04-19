package tui

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"
)

const (
	headerHeight    = 2
	statusBarHeight = 1
)

var (
	spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	ansiPattern   = regexp.MustCompile(`\x1b\[[0-9;]*m`)
)

var uiChrome = struct {
	Accent      string
	AccentMuted string
	Blue        string
	Danger      string
	Line        string
	Muted       string
	Panel       string
	PanelAlt    string
	Purple      string
	Success     string
	Text        string
	Warning     string
}{
	Accent:      "#7dd3fc",
	AccentMuted: "#164e63",
	Blue:        "#93c5fd",
	Danger:      "#f87171",
	Line:        "#31384a",
	Muted:       "#94a3b8",
	Panel:       "#151827",
	PanelAlt:    "#202637",
	Purple:      "#d8b4fe",
	Success:     "#86efac",
	Text:        "#d7dde8",
	Warning:     "#fbbf24",
}

func renderView(m *Model) string {
	if m.modal != ModalNone {
		return lipgloss.Place(
			m.width,
			m.height,
			lipgloss.Center,
			lipgloss.Center,
			renderModal(m),
			lipgloss.WithWhitespaceBackground(lipgloss.Color("#111827")),
		)
	}

	parts := []string{
		fitHeight(renderHeader(m), headerHeight),
	}

	if shouldShowFilterBar(m.filters, m.focus) {
		parts = append(parts, fitHeight(renderFilterBar(m), 1))
	}

	parts = append(parts, fitHeight(renderContent(m), m.contentHeight()))
	parts = append(parts, fitHeight(renderStatusBar(m), statusBarHeight))

	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

func renderContent(m *Model) string {
	contentHeight := m.contentHeight()

	if m.terminalTakesOver() {
		return renderTerminalPane(m, contentHeight, true)
	}

	showSplitTerminal := m.terminalPaneShouldRender()
	stacked := showSplitTerminal && m.terminalLayoutMode == TerminalLayoutMode("top-bottom")

	if !showSplitTerminal {
		return renderBoard(m, contentHeight)
	}

	if stacked {
		dividerHeight := 0
		if contentHeight >= 3 {
			dividerHeight = 1
		}
		boardHeight := max(1, (contentHeight-dividerHeight+1)/2)
		terminalHeight := max(1, contentHeight-boardHeight-dividerHeight)
		chunks := []string{
			fitHeight(renderBoard(m, boardHeight), boardHeight),
		}
		if dividerHeight > 0 {
			chunks = append(chunks, fitHeight(lipgloss.NewStyle().Foreground(lipgloss.Color("cyan")).Render(strings.Repeat("─", max(1, m.width))), 1))
		}
		chunks = append(chunks, fitHeight(renderTerminalPane(m, terminalHeight, true), terminalHeight))
		return lipgloss.JoinVertical(lipgloss.Left, chunks...)
	}

	boardView := fitHeight(renderBoard(m, contentHeight), contentHeight)
	terminalView := fitHeight(renderTerminalPane(m, contentHeight, false), contentHeight)
	divider := renderVerticalDivider(contentHeight)
	return lipgloss.JoinHorizontal(lipgloss.Top, boardView, divider, terminalView)
}

func renderHeader(m *Model) string {
	activeRepo := m.repoByID(m.activeRepoID)
	var activeView *SavedViewRecord
	for _, view := range m.savedViews {
		if view.ID == m.activeViewID {
			activeView = &view
			break
		}
	}

	contextTask := m.contextTask()
	var contextTrack *TrackRecord
	if contextTask != nil {
		for _, track := range m.tracks {
			if track.ID == contextTask.TrackID {
				contextTrack = &track
				break
			}
		}
	}

	var contextPillar *PillarRecord
	if contextTask != nil && contextTask.PillarID != "" {
		for _, pillar := range m.pillars {
			if pillar.ID == contextTask.PillarID {
				contextPillar = &pillar
				break
			}
		}
	}

	contextRepo := (*RepoRecord)(nil)
	if contextTask != nil {
		contextRepo = m.repoByID(contextTask.RepoID)
	}

	busySessions := 0
	attentionTasks := 0
	for _, task := range m.tasks {
		if task.SessionAttentionNeeded {
			attentionTasks++
		}
		if task.SessionID != "" || task.SecondarySessionID != "" {
			if activity := m.sessionActivityByTaskID[task.ID]; activity != nil && activity.IsBusy {
				busySessions++
			}
		}
	}

	row1Left := []string{
		badge("agentboard", "accent", "", false),
		badge(truncateText(valueOrAllRepos(activeRepo), 18), "muted", "◈", false),
	}
	if activeView != nil {
		row1Left = append(row1Left, badge(truncateText(activeView.Label, 16), "purple", "⌘", false))
	}

	activeFilters := countActiveFilters(m.filters)
	if activeFilters > 0 {
		row1Left = append(row1Left, badge(fmt.Sprintf("%d", activeFilters), "muted", "⚲", false))
	}

	row1Right := []string{}
	if attentionTasks > 0 {
		label := "1 attention"
		if attentionTasks != 1 {
			label = fmt.Sprintf("%d attention", attentionTasks)
		}
		row1Right = append(row1Right, badge(label, "info", "!", false))
	}
	if busySessions > 0 {
		label := "1 running"
		if busySessions != 1 {
			label = fmt.Sprintf("%d running", busySessions)
		}
		row1Right = append(row1Right, badge(label, "warning", "◌", false))
	}
	if m.syncInProgress {
		row1Right = append(row1Right, badge("syncing", "warning", "↻", false))
	}
	if m.daemonConnected {
		row1Right = append(row1Right, badge("daemon", "success", "●", false))
	} else {
		row1Right = append(row1Right, badge("offline", "danger", "○", false))
	}

	row1 := joinSpaceBetween(strings.Join(row1Left, " "), strings.Join(row1Right, " "), m.width)

	row2Left := ""
	if contextTask != nil {
		parts := []string{
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render(truncateText(contextTask.Title, 48)),
			headerText("≡", valueOrTrack(contextTrack, contextTask.TrackID), uiChrome.Accent),
			headerText("◈", valueOrRepo(contextRepo, contextTask.RepoID), uiChrome.Blue),
			headerText("⌂", workspaceKind(contextTask), workspaceColor(contextTask)),
		}
		if contextPillar != nil {
			color := contextPillar.Color
			if color == "" {
				color = uiChrome.Purple
			}
			icon := contextPillar.Icon
			if icon == "" {
				icon = "⬢"
			}
			parts = append(parts, headerText(icon, contextPillar.Label, color))
		}
		row2Left = strings.Join(parts, " ")
	} else {
		row2Left = lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("No task selected")
	}

	row2Right := []string{}
	if contextTask != nil {
		branchLabel := contextTask.BranchName
		if m.activeTaskID == contextTask.ID && m.terminalBranchForSlot(m.focusedTerminalSlot) != "" {
			branchLabel = m.terminalBranchForSlot(m.focusedTerminalSlot)
		}
		if branchLabel != "" {
			row2Right = append(row2Right, badge(truncateText(branchLabel, 20), "muted", "⎇", false))
		}
		if contextTask.SecondarySessionID != "" {
			row2Right = append(row2Right, badge("dual", "info", "⇵", false))
		}
		row2Right = append(row2Right, renderSessionActivityBadge(m, contextTask, true))
	}

	row2 := joinSpaceBetween(row2Left, strings.Join(row2Right, " "), m.width)
	return fitHeight(row1+"\n"+row2, headerHeight)
}

func renderFilterBar(m *Model) string {
	chips := []string{
		badge(fmt.Sprintf("%d", countActiveFilters(m.filters)), "muted", "⚲", false),
	}
	for _, id := range m.filters.RepoIDs {
		label := id
		if repo := m.repoByID(id); repo != nil {
			label = repo.Label
		}
		chips = append(chips, badge(label, "accent", "◈", false))
	}
	for _, id := range m.filters.PillarIDs {
		label := id
		icon := "⬢"
		for _, pillar := range m.pillars {
			if pillar.ID == id {
				label = pillar.Label
				if pillar.Icon != "" {
					icon = pillar.Icon
				}
				break
			}
		}
		chips = append(chips, badge(label, "purple", icon, false))
	}
	if m.filters.SearchText != "" {
		chips = append(chips, badge(m.filters.SearchText, "success", "/", false))
	}

	right := "Filtered board"
	if m.focus == FocusFilterBar || m.focus == FocusSearch {
		right = "[f] edit  [/] search  [:] commands  [Esc] clear"
	}

	return joinSpaceBetween(
		strings.Join(chips, " "),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(right),
		m.width,
	)
}

func renderBoard(m *Model, height int) string {
	rail := renderMissionRail(m, height)

	if len(m.repos) == 0 {
		board := fitHeight(
			lipgloss.NewStyle().
				Padding(1, 2).
				Foreground(lipgloss.Color(uiChrome.Muted)).
				Render("No repos registered. Run: agentboard repos add <path>"),
			height,
		)
		return fitHeight(lipgloss.JoinHorizontal(lipgloss.Top, rail, board), height)
	}

	repoLabels := map[string]string{}
	for _, repo := range m.repos {
		repoLabels[repo.ID] = repo.Label
	}

	columns := []string{}
	tasksByTrack := m.tasksByTrack()
	sortedTracks := m.sortedTracks()
	for trackIndex, track := range sortedTracks {
		tasks := tasksByTrack[track.ID]
		columns = append(columns, renderTrack(
			m,
			track,
			tasks,
			trackIndex == m.selectedTrackIndex,
			height,
			repoLabels,
		))
	}

	board := fitHeight(lipgloss.JoinHorizontal(lipgloss.Top, columns...), height)
	return fitHeight(lipgloss.JoinHorizontal(lipgloss.Top, rail, board), height)
}

func renderMissionRail(m *Model, height int) string {
	width := m.missionRailWidth()
	contentWidth := max(1, width-4)
	title := "MISSIONS"
	if !m.missionsPaneExpanded && m.focus != FocusMissions {
		title = "MISS"
	}
	header := joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(m.focus == FocusMissions, uiChrome.Accent, uiChrome.Text))).Render(title),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(fmt.Sprintf("%d", len(m.missions))),
		contentWidth,
	)

	rows := m.missionRows()
	lines := []string{}
	if len(rows) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("No missions"))
	} else {
		selectionIndex := 0
		for index, row := range rows {
			if row.MissionIndex == m.selectedMissionIndex && row.TaskIndex == m.selectedMissionTaskIndex {
				selectionIndex = index
				break
			}
		}
		itemHeights := make([]int, len(rows))
		for index := range itemHeights {
			itemHeights[index] = 1
		}
		windowStart, windowEnd := visibleWindow(itemHeights, selectionIndex, max(1, height-3))
		for _, row := range rows[windowStart:windowEnd] {
			if row.TaskIndex == missionSummaryRowTaskIndex {
				lines = append(lines, renderMissionSummaryRow(m, row.MissionIndex, contentWidth))
				continue
			}
			if row.TaskIndex == missionEmptyRowTaskIndex {
				lines = append(lines, renderMissionEmptyRow(m, row.MissionIndex, contentWidth))
				continue
			}
			lines = append(lines, renderMissionTaskRow(m, row.MissionIndex, row.TaskIndex, contentWidth))
		}
	}

	border := lipgloss.NormalBorder()
	if m.focus == FocusMissions {
		border = lipgloss.RoundedBorder()
	}

	return fitHeight(
		lipgloss.NewStyle().
			Width(width).
			Height(height).
			Border(border).
			BorderForeground(lipgloss.Color(ternaryString(m.focus == FocusMissions, uiChrome.Accent, uiChrome.Line))).
			Render(header+"\n"+strings.Join(lines, "\n")),
		height,
	)
}

func renderMissionSummaryRow(m *Model, missionIndex int, width int) string {
	if missionIndex < 0 || missionIndex >= len(m.missions) {
		return ""
	}
	mission := m.missions[missionIndex]
	selected := m.focus == FocusMissions && m.selectedMissionIndex == missionIndex && m.selectedMissionTaskIndex == missionSummaryRowTaskIndex
	prefix := ternaryString(selected, "▸ ", "  ")
	title := truncateText(mission.Title, max(1, width-12))
	counts := fmt.Sprintf("%d/%d/%d/%d", mission.Counts.Backlog, mission.Counts.InProgress, mission.Counts.PR, mission.Counts.Merged)
	row := joinSpaceBetween(prefix+title, counts, width)
	style := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text))
	if mission.CompletedAt != nil {
		style = lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Success))
	}
	if selected {
		style = style.Bold(true).Foreground(lipgloss.Color(uiChrome.Accent))
	}
	return style.Render(row)
}

func renderMissionEmptyRow(m *Model, missionIndex int, width int) string {
	if missionIndex < 0 || missionIndex >= len(m.missions) {
		return ""
	}
	selected := m.focus == FocusMissions && m.selectedMissionIndex == missionIndex && m.selectedMissionTaskIndex == missionEmptyRowTaskIndex
	label := "No tasks yet"
	right := "n add"
	style := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted))
	if selected {
		style = lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Accent))
	}
	return style.Render(joinSpaceBetween("    "+label, right, width))
}

func renderMissionTaskRow(m *Model, missionIndex, taskIndex, width int) string {
	if missionIndex < 0 || missionIndex >= len(m.missions) {
		return ""
	}
	mission := m.missions[missionIndex]
	if taskIndex < 0 || taskIndex >= len(mission.Tasks) {
		return ""
	}
	missionTask := mission.Tasks[taskIndex]
	selected := m.focus == FocusMissions && m.selectedMissionIndex == missionIndex && m.selectedMissionTaskIndex == taskIndex
	statusIcon := "○"
	statusColor := uiChrome.Muted
	switch missionTask.Status {
	case "in-progress":
		statusIcon = "●"
		statusColor = uiChrome.Accent
	case "pr":
		statusIcon = "↗"
		statusColor = uiChrome.Warning
	case "merged":
		statusIcon = "✓"
		statusColor = uiChrome.Success
	}
	if missionTask.IsBlocked && missionTask.Status != "merged" {
		statusIcon = "×"
		statusColor = uiChrome.Danger
	}

	label := truncateText(missionTask.Task.Title, max(1, width-12))
	right := ""
	switch {
	case !missionTask.ReleasedToBoard:
		right = "hold"
	case missionTask.IsBlocked && missionTask.Status != "merged":
		right = "blk"
	case missionTask.Status == "merged":
		right = "done"
	}
	left := ternaryString(selected, "▸ ", "  ") + statusIcon + " " + label
	style := lipgloss.NewStyle().Foreground(lipgloss.Color(statusColor))
	if missionTask.Status != "merged" {
		style = lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted))
	}
	if selected {
		style = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Accent))
	}
	if missionTask.Status == "merged" {
		style = lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Success))
	}
	return style.Render(joinSpaceBetween(left, right, width))
}

func renderTrack(m *Model, track TrackRecord, tasks []TaskRecord, isSelected bool, height int, repoLabels map[string]string) string {
	taskHeights := make([]int, 0, len(tasks))
	for _, task := range tasks {
		taskHeights = append(taskHeights, taskCardHeight(m, task))
	}
	listHeight := max(1, height-3)
	windowStart, windowEnd := visibleWindow(taskHeights, ternaryInt(isSelected, m.selectedTaskIndex, 0), listHeight)
	visibleTasks := tasks[windowStart:windowEnd]

	header := joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(isSelected, uiChrome.Accent, uiChrome.Text))).Render(strings.ToUpper(track.Label)),
		lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(isSelected, uiChrome.Accent, uiChrome.Muted))).Render(fmt.Sprintf("%d", len(tasks))),
		trackHeaderWidth,
	)

	bodyLines := []string{}
	if len(tasks) == 0 {
		bodyLines = append(bodyLines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("No tasks"))
	} else {
		for offset, task := range visibleTasks {
			actualIndex := windowStart + offset
			bodyLines = append(bodyLines, renderTaskCard(
				m,
				task,
				isSelected && actualIndex == m.selectedTaskIndex,
				m.activeTaskID == task.ID,
				m.sessionActivityByTaskID[task.ID],
				repoLabels[task.RepoID],
			))
		}
	}

	border := lipgloss.NormalBorder()
	if isSelected {
		border = lipgloss.RoundedBorder()
	}

	return fitHeight(
		lipgloss.NewStyle().
			Width(trackColumnStyleWidth).
			Height(height).
			Border(border).
			BorderForeground(lipgloss.Color(ternaryString(isSelected, uiChrome.Accent, uiChrome.Line))).
			Render(header+"\n"+strings.Join(bodyLines, "\n")),
		height,
	)
}

func renderTaskCard(m *Model, task TaskRecord, isSelected, isActiveSession bool, activity *SessionActivitySnapshot, repoLabel string) string {
	borderColor := taskCardBorderColor(task, isSelected)
	headerStatus := headerStatusModel(m, task, activity, isActiveSession)
	activeSessionIcon := headerStatus.Icon
	descriptionPreview := descriptionLine(task.Description)
	missionPreview := taskMissionLine(m, task.ID)
	titleLines := taskTitleLines(task.Title)
	branchLabel := truncateText(compactBranchLabel(task.BranchName), 16)
	workspaceLabel := "root"
	if task.WorktreePath != "" {
		workspaceLabel = "worktree"
	}
	headerLabel := truncateText(fmt.Sprintf("%s > %s", repoLabel, workspaceLabel), taskCardContentWidth)

	lines := []string{
		lipgloss.NewStyle().Foreground(lipgloss.Color(headerStatus.Color)).Render(activeSessionIcon) + " " +
			lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(isSelected, uiChrome.Accent, uiChrome.Blue))).Render(headerLabel),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Line)).Render(strings.Repeat("─", taskCardContentWidth)),
	}
	for index, line := range titleLines {
		style := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text))
		if isActiveSession && index == 0 {
			style = style.Bold(true)
		}
		lines = append(lines, style.Render(line))
	}
	if descriptionPreview != "" {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(descriptionPreview, taskCardContentWidth)))
	}
	if missionPreview != "" {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Accent)).Render(truncateText(missionPreview, taskCardContentWidth)))
	}
	lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Line)).Render(strings.Repeat("─", taskCardContentWidth)))

	metaParts := []string{}
	if pillar := pillarLabel(m.pillars, task.PillarID); pillar != "" {
		metaParts = append(metaParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(pillar))
	}
	if task.SecondarySessionID != "" {
		metaParts = append(metaParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Warning)).Render("⇵ dual"))
	}
	metaParts = append(metaParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("⎇ "+branchLabel))
	lines = append(lines, strings.Join(metaParts, " "))

	gitStatus := gitStatus(task)
	rightMeta := formatRelativeAge(task.UpdatedAt)
	if gitStatus != "" {
		rightMeta = gitStatus + " " + rightMeta
	}
	lines = append(lines, joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("#"+truncateText(task.ID, 8)),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(rightMeta),
		taskCardContentWidth,
	))

	githubStatus := githubStatusBadgeModel(task)
	if githubStatus != nil {
		lines = append(lines, badge(
			truncateText(githubStatus.Label, taskCardContentWidth-2),
			githubStatus.Tone,
			"",
			true,
		))
	} else {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(" "))
	}

	border := lipgloss.RoundedBorder()
	if isSelected || isActiveSession {
		border = lipgloss.DoubleBorder()
	}

	return lipgloss.NewStyle().
		Width(taskCardStyleWidth).
		Border(border).
		BorderForeground(lipgloss.Color(borderColor)).
		Padding(0, 1).
		Render(strings.Join(lines, "\n"))
}

func renderTerminalPane(m *Model, height int, fullWidth bool) string {
	width := m.width
	if !fullWidth {
		width = m.terminalContentWidth()
	}

	contentWidth := max(1, width)

	if m.activeTaskID == "" {
		viewportHeight := terminalSlotViewportHeight(height)
		footerVisible := height > 2
		lines := []string{
			joinSpaceBetween(badge("TERMINAL", "accent", "", false), badge("NO SESSION", "muted", "", false), contentWidth),
		}
		for index := 0; index < viewportHeight; index++ {
			value := " "
			if index == 0 {
				value = "No session open. Press Enter on a task to start one."
			}
			lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(value, contentWidth)))
		}
		if footerVisible {
			lines = append(lines, joinSpaceBetween(
				lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Open a task shell to attach the live pane."),
				lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Enter shell"),
				contentWidth,
			))
		}
		return fitHeight(strings.Join(lines, "\n"), height)
	}

	activeTask := (*TaskRecord)(nil)
	for _, task := range m.tasks {
		if task.ID == m.activeTaskID {
			activeTask = &task
			break
		}
	}
	if activeTask == nil {
		return fitHeight("", height)
	}

	if !m.activeTaskUsesDualTerminal() {
		return fitHeight(renderTerminalSlotPane(m, *activeTask, SessionSlotPrimary, height, contentWidth), height)
	}

	primaryHeight, secondaryHeight := splitTerminalSlotHeights(true, height)
	parts := []string{
		fitHeight(renderTerminalSlotPane(m, *activeTask, SessionSlotPrimary, primaryHeight, contentWidth), primaryHeight),
	}
	if secondaryHeight > 0 {
		parts = append(parts, fitHeight(renderTerminalSlotPane(m, *activeTask, SessionSlotSecondary, secondaryHeight, contentWidth), secondaryHeight))
	}
	return fitHeight(lipgloss.JoinVertical(lipgloss.Left, parts...), height)
}

func renderTerminalSlotPane(m *Model, activeTask TaskRecord, slot SessionSlot, height, contentWidth int) string {
	activeRepo := m.repoByID(activeTask.RepoID)
	viewportHeight := terminalSlotViewportHeight(height)
	footerVisible := height > 2
	normalizedSlot := normalizeSessionSlot(slot)
	slotLabel := "MAIN"
	slotTone := "muted"
	if normalizedSlot == SessionSlotSecondary {
		slotLabel = "DEV"
		slotTone = "warning"
	}
	if m.focus == FocusTerminal && normalizedSlot == normalizeSessionSlot(m.focusedTerminalSlot) {
		slotTone = "accent"
	}

	activity := m.sessionActivity(activeTask.ID, normalizedSlot)
	label, tone, spinning, icon := sessionBadgeModel(activeTask, activity, m.focus == FocusTerminal && normalizedSlot == normalizeSessionSlot(m.focusedTerminalSlot))
	if spinning {
		icon = spinnerFrames[m.spinnerIndex]
	}

	headerBadges := []string{
		badge("TERMINAL", "accent", "", false),
		badge(slotLabel, slotTone, "", false),
	}
	if activeTask.SecondarySessionID != "" {
		headerBadges = append(headerBadges, badge("DUAL", "info", "", false))
	}
	if backend := m.terminalBackendTypeForSlot(normalizedSlot); backend != "" {
		headerBadges = append(headerBadges, badge(strings.ToUpper(string(backend)), "muted", "", false))
	}

	rightBadges := []string{
		badge("REPO "+truncateText(valueOrRepo(activeRepo, activeTask.RepoID), 12), "info", "", false),
		badge(label, tone, icon, false),
	}

	lines := []string{
		joinSpaceBetween(
			strings.Join(append(headerBadges,
				lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Text)).Render(truncateText(activeTask.Title, 26)),
			), " "),
			strings.Join(rightBadges, " "),
			contentWidth,
		),
	}

	rawPlainViewportLines, rawStyledViewportLines := terminalViewport(m, normalizedSlot, viewportHeight, contentWidth)
	for index := range rawStyledViewportLines {
		line := rawStyledViewportLines[index]
		plain := rawPlainViewportLines[index]
		rendered := truncateANSI(line, contentWidth)
		padding := strings.Repeat(" ", max(0, contentWidth-plainWidth(truncatePlain(plain, contentWidth))))
		lines = append(lines, rendered+padding)
	}

	branchLabel := m.terminalBranchForSlot(normalizedSlot)
	if branchLabel == "" {
		branchLabel = activeTask.BranchName
	}
	if branchLabel == "" {
		branchLabel = "branch pending"
	}

	if footerVisible {
		buffer := m.terminalBufferForSlot(normalizedSlot)
		historyLabel := fmt.Sprintf("live tail %d", max(0, len(buffer.Lines)))
		if scrollOffset := m.terminalScrollOffsetForSlot(normalizedSlot); scrollOffset > 0 {
			historyLabel = fmt.Sprintf("history -%d", scrollOffset)
		}
		footerHint := "branch " + truncateText(branchLabel, 18) + "  Tab nav  Esc board"
		if activeTask.SecondarySessionID != "" {
			footerHint = "branch " + truncateText(branchLabel, 16) + "  Shift+Tab focus  Tab nav"
		}
		lines = append(lines, joinSpaceBetween(
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(historyLabel),
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(footerHint),
			contentWidth,
		))
	}

	return fitHeight(strings.Join(lines, "\n"), height)
}

func renderVerticalDivider(height int) string {
	dividerStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Accent))
	lines := make([]string, max(1, height))
	for index := range lines {
		lines[index] = dividerStyle.Render("│")
	}
	return strings.Join(lines, "\n")
}

func renderStatusBar(m *Model) string {
	contextTask := m.contextTask()
	contextActivity := (*SessionActivitySnapshot)(nil)
	if contextTask != nil {
		contextActivity = m.sessionActivityByTaskID[contextTask.ID]
	}

	activityLabel := ""
	if contextActivity != nil && contextActivity.IsBusy {
		label := contextActivity.Label
		if label == "" {
			label = contextActivity.Command
		}
		if label == "" {
			label = "Working"
		}
		activityLabel = spinnerFrames[m.spinnerIndex] + " " + label
	}

	leftParts := []string{badge(strings.ToUpper(string(m.focus)), ternaryString(m.focus == FocusTerminal, "accent", "neutral"), "", false)}
	if activityLabel != "" {
		leftParts = append(leftParts, badge(activityLabel, "warning", "", false))
	} else if contextTask != nil && contextTask.SessionAttentionNeeded {
		leftParts = append(leftParts, badge("attention", "info", "!", false))
	}
	if m.statusMessage != "" {
		leftParts = append(leftParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render(truncateText(m.statusMessage, max(1, m.width/2))))
	} else if m.focus == FocusMissions {
		if missionTask := m.selectedMissionTask(); missionTask != nil {
			leftParts = append(leftParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Mission task: "+missionTask.Task.Title))
		} else if mission := m.selectedMission(); mission != nil {
			leftParts = append(leftParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Mission: "+mission.Title))
		} else {
			leftParts = append(leftParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Ready"))
		}
	} else if contextTask != nil {
		leftParts = append(leftParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Selected: "+contextTask.Title))
	} else {
		leftParts = append(leftParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Ready"))
	}

	return joinSpaceBetween(strings.Join(leftParts, " "), lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(kbdHints(m.focus)), m.width)
}

func renderHelpModal() string {
	sections := [][]string{
		{"Navigation", "Arrow keys move between columns and tasks, h/k/l mirror left/up/right", ": or Ctrl+P opens the command palette", "a or A opens the local AI chat modal", "Enter opens the selected task shell", "t focuses the terminal pane", "z expands the terminal workspace"},
		{"Missions", "u opens the mission rail and closes it when you are done", "Inside the mission rail: j/k or arrows move and Enter jumps to a released task on the board", "u releases the selected hidden mission task into backlog", "N creates a mission, n adds a task, b edits blockers, d deletes the selected mission"},
		{"Task", "n new task, r rename, Ctrl+D edit description, d delete", "p assign pillar, P create pillar, D delete pillar and its tasks", "B toggles the dual shell layout for the selected task", "[ and ] move the selected task between tracks", "i opens IDE, x reveals workspace, R recreates the task shell"},
		{"GitHub", "c create PR now, C retry pushed-branch PR creation", "j comment on the selected open or draft PR", "o open PR, v open checks, m merge approved passing PR", "s runs a sync for PR, CI, and review status"},
		{"Views", "f opens filters, g changes board / terminal layout", ", and . switch active repo, ? toggles this help"},
		{"Terminal", "Shift+Tab switches focus between the main and dev panes", "Tab then hjkl or arrows switches to the neighboring task shell", "Ctrl+C interrupts the running command inside the focused terminal", "PgUp/PgDn or Shift+Up/Down scroll terminal history", "Esc returns focus to the board"},
		{"Setup", "If worktree setup fails because the repo uses master, run:", "agentboard repos set-default-base-branch <repo-id> master"},
	}

	lines := []string{
		joinSpaceBetween(badge("KEYBOARD", "accent", "", false), lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Esc close"), 68),
		"",
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Text)).Render("AgentBoard shortcuts and setup"),
		"",
	}
	for _, section := range sections {
		lines = append(lines, badge(strings.ToUpper(section[0]), "muted", "", false))
		for _, item := range section[1:] {
			lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render("- "+item))
		}
		lines = append(lines, "")
	}

	return lipgloss.NewStyle().
		Width(72).
		Border(lipgloss.DoubleBorder()).
		BorderForeground(lipgloss.Color(uiChrome.Accent)).
		Padding(1).
		Render(strings.TrimRight(strings.Join(lines, "\n"), "\n"))
}

func renderSessionActivityBadge(m *Model, task *TaskRecord, isActiveSession bool) string {
	label, tone, spinning, icon := sessionBadgeModel(*task, m.sessionActivityByTaskID[task.ID], isActiveSession)
	if spinning {
		icon = spinnerFrames[m.spinnerIndex]
	}
	return badge(label, tone, icon, false)
}

func sessionBadgeModel(task TaskRecord, activity *SessionActivitySnapshot, isActiveSession bool) (string, string, bool, string) {
	if activity != nil && activity.SessionStatus == "orphaned" {
		return "orphaned", "danger", false, "!"
	}
	if activity != nil && activity.SessionStatus == "terminated" {
		return "ended", "muted", false, "×"
	}
	if task.SessionAttentionNeeded {
		return "attention", "info", false, "!"
	}
	if activity != nil && activity.IsBusy {
		label := strings.TrimSpace(strings.TrimSpace(activity.Label + " " + activity.Command))
		if activity.Label != "" {
			label = activity.Label
		} else if activity.Command != "" {
			label = activity.Command
		} else {
			label = "work"
		}
		return label, "warning", true, ""
	}
	if isActiveSession {
		return "live", "accent", false, "●"
	}
	if task.SessionID != "" || task.SecondarySessionID != "" || (activity != nil && activity.SessionStatus == "idle") {
		return "idle", "success", false, "◦"
	}
	return "shell", "muted", false, "○"
}

func headerStatusModel(m *Model, task TaskRecord, activity *SessionActivitySnapshot, isActiveSession bool) struct {
	Color string
	Icon  string
	Label string
} {
	label, tone, spinning, icon := sessionBadgeModel(task, activity, isActiveSession)
	if spinning {
		icon = spinnerFrames[m.spinnerIndex]
	}
	return struct {
		Color string
		Icon  string
		Label string
	}{
		Color: toneColor(tone),
		Icon:  icon,
		Label: label,
	}
}

func badge(label, tone, icon string, strong bool) string {
	background, foreground := tonePalette(tone)
	text := label
	if icon != "" {
		text = icon + " " + label
	}
	style := lipgloss.NewStyle().
		Background(lipgloss.Color(background)).
		Foreground(lipgloss.Color(foreground)).
		Padding(0, 1)
	if strong {
		style = style.Bold(true)
	}
	return style.Render(text)
}

func tonePalette(tone string) (string, string) {
	switch tone {
	case "accent":
		return "#182536", uiChrome.Accent
	case "danger":
		return "#2b1d26", uiChrome.Danger
	case "info":
		return "#1e2636", uiChrome.Blue
	case "muted":
		return uiChrome.PanelAlt, uiChrome.Muted
	case "purple":
		return "#261f36", uiChrome.Purple
	case "success":
		return "#18261c", uiChrome.Success
	case "warning":
		return "#2a2416", uiChrome.Warning
	default:
		return "#252b3a", uiChrome.Text
	}
}

func toneColor(tone string) string {
	switch tone {
	case "accent":
		return uiChrome.Accent
	case "danger":
		return uiChrome.Danger
	case "info":
		return uiChrome.Blue
	case "purple":
		return uiChrome.Purple
	case "success":
		return uiChrome.Success
	case "warning":
		return uiChrome.Warning
	default:
		return uiChrome.Muted
	}
}

func taskCardBorderColor(task TaskRecord, isSelected bool) string {
	if task.SessionAttentionNeeded {
		if isSelected {
			return uiChrome.Blue
		}
		return "#3b82f6"
	}
	if task.PRState == "merged" {
		if isSelected {
			return uiChrome.Purple
		}
		return "#a855f7"
	}
	if task.CIState == "failed" || task.ReviewState == "changes_requested" || task.PRState == "closed" {
		if isSelected {
			return uiChrome.Danger
		}
		return "#ef4444"
	}
	if canMergeTask(task) || task.CIState == "passed" || task.ReviewState == "approved" {
		if isSelected {
			return uiChrome.Success
		}
		return "#22c55e"
	}
	if task.PRState == "open" || task.PRState == "draft" || task.CIState == "pending" {
		if isSelected {
			return uiChrome.Warning
		}
		return "#f59e0b"
	}
	if isSelected {
		return uiChrome.Accent
	}
	return "#475569"
}

func taskCardHeight(m *Model, task TaskRecord) int {
	height := 8 + len(taskTitleLines(task.Title))
	if descriptionLine(task.Description) != "" {
		height++
	}
	if taskMissionLine(m, task.ID) != "" {
		height++
	}
	return height
}

func taskMissionLine(m *Model, taskID string) string {
	if m == nil {
		return ""
	}
	mission, missionTask := m.missionForTask(taskID)
	if mission == nil || missionTask == nil {
		return ""
	}

	label := "Mission: " + mission.Title
	switch {
	case !missionTask.ReleasedToBoard:
		return label + " | hold"
	case missionTask.IsBlocked && missionTask.Status != "merged":
		return label + " | blocked"
	default:
		return label
	}
}

func taskTitleLines(title string) []string {
	normalized := normalizeSingleLine(title)
	if normalized == "" {
		normalized = "Untitled task"
	}
	words := strings.Fields(normalized)
	lines := []string{}
	current := ""
	for index, word := range words {
		candidate := strings.TrimSpace(current + " " + word)
		if plainWidth(candidate) <= taskCardContentWidth {
			current = candidate
			continue
		}
		if len(lines) == 1 {
			remainder := strings.Join(words[index:], " ")
			tail := strings.TrimSpace(current + " " + remainder)
			lines = append(lines, truncateText(tail, taskCardContentWidth))
			return lines
		}
		if current == "" {
			lines = append(lines, truncateText(word, taskCardContentWidth))
			continue
		}
		lines = append(lines, current)
		current = word
	}
	if current != "" {
		lines = append(lines, truncateText(current, taskCardContentWidth))
	}
	if len(lines) > 2 {
		return lines[:2]
	}
	return lines
}

func normalizeSingleLine(value string) string {
	if value == "" {
		return ""
	}
	for _, line := range strings.Split(value, "\n") {
		line = strings.Join(strings.Fields(strings.TrimSpace(line)), " ")
		if line != "" {
			return line
		}
	}
	return ""
}

func descriptionLine(description string) string {
	return normalizeSingleLine(description)
}

func compactBranchLabel(branchName string) string {
	if branchName == "" {
		return "branch"
	}
	prefix := ""
	slug := branchName
	if strings.Contains(branchName, "/") {
		parts := strings.SplitN(branchName, "/", 2)
		prefix = parts[0]
		slug = parts[1]
	}
	parts := []string{}
	for _, part := range strings.Split(slug, "-") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return branchName
	}
	suffix := ""
	last := parts[len(parts)-1]
	if numericString(last) {
		suffix = last
		parts = parts[:len(parts)-1]
	}
	head := parts
	if len(head) > 3 {
		head = head[:3]
	}
	compact := strings.Join(head, "-")
	if len(parts) > len(head) {
		compact += "…"
	}
	if suffix != "" {
		if compact != "" {
			compact += "-"
		}
		compact += suffix
	}
	if prefix != "" {
		return prefix + "/" + compact
	}
	return compact
}

func numericString(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return value != ""
}

func formatRelativeAge(timestamp int64) string {
	elapsed := time.Since(time.UnixMilli(timestamp))
	if elapsed < time.Minute {
		return "just now"
	}
	if elapsed < time.Hour {
		return fmt.Sprintf("%dm ago", int(elapsed/time.Minute))
	}
	if elapsed < 24*time.Hour {
		return fmt.Sprintf("%dh ago", int(elapsed/time.Hour))
	}
	return fmt.Sprintf("%dd ago", int(elapsed/(24*time.Hour)))
}

func pillarLabel(pillars []PillarRecord, pillarID string) string {
	if pillarID == "" {
		return ""
	}
	for _, pillar := range pillars {
		if pillar.ID == pillarID {
			icon := pillar.Icon
			if icon == "" {
				icon = "⬢"
			}
			return icon + " " + truncateText(pillar.Label, 9)
		}
	}
	return ""
}

func gitStatus(task TaskRecord) string {
	switch task.GitState {
	case "conflicted":
		return "! conflict"
	case "dirty":
		return "~ dirty"
	case "untracked":
		return "? untracked"
	case "detached":
		return "× detached"
	default:
		return ""
	}
}

type githubStatusBadge struct {
	Label string
	Tone  string
}

func githubStatusBadgeModel(task TaskRecord) *githubStatusBadge {
	segments := []string{}
	syncStatus := githubSyncStatusLabel(task)

	switch {
	case task.PRState == "merged":
		segments = append(segments, "merged")
	case task.PRState == "closed":
		segments = append(segments, "closed")
	default:
		if build := githubBuildStatusLabel(task); build != "" {
			segments = append(segments, build)
		}
		if review := githubReviewStatusLabel(task); review != "" {
			segments = append(segments, review)
		}
		if prState := githubPRStateLabel(task); prState != "" {
			segments = append(segments, prState)
		}
	}
	if len(segments) == 0 && syncStatus != "" {
		segments = append(segments, syncStatus)
	}

	if task.PRNumber != nil && task.PRState != "none" {
		segments = append(segments, fmt.Sprintf("#%d", *task.PRNumber))
	}

	if len(segments) == 0 {
		return nil
	}

	return &githubStatusBadge{
		Label: strings.Join(segments, "·"),
		Tone:  githubStatusTone(task),
	}
}

func githubBuildStatusLabel(task TaskRecord) string {
	if task.CIRequiredTotal > 0 {
		switch task.CIState {
		case "failed":
			return fmt.Sprintf("build %d/%d fail", task.CIRequiredPassed, task.CIRequiredTotal)
		case "pending", "passed":
			return fmt.Sprintf("build %d/%d", task.CIRequiredPassed, task.CIRequiredTotal)
		}
	}

	switch task.CIState {
	case "pending":
		return "build pending"
	case "passed":
		return "build pass"
	case "failed":
		return "build fail"
	default:
		return ""
	}
}

func githubSyncStatusLabel(task TaskRecord) string {
	switch task.GitHubSyncStatus {
	case "syncing":
		return "syncing"
	case "error":
		return "sync error"
	default:
		return ""
	}
}

func githubReviewStatusLabel(task TaskRecord) string {
	switch task.ReviewState {
	case "approved":
		return "approved"
	case "changes_requested":
		return "changes req"
	default:
		return ""
	}
}

func githubPRStateLabel(task TaskRecord) string {
	switch {
	case task.PRDraft || task.PRState == "draft":
		return "draft"
	case task.PRState == "open" && task.CIState == "none" && task.ReviewState != "approved" && task.ReviewState != "changes_requested":
		return "pr open"
	default:
		return ""
	}
}

func githubStatusTone(task TaskRecord) string {
	switch {
	case task.GitHubSyncStatus == "error" && (task.PRState == "" || task.PRState == "none"):
		return "danger"
	case task.PRState == "merged":
		return "purple"
	case task.CIState == "failed" || task.ReviewState == "changes_requested" || task.PRState == "closed":
		return "danger"
	case task.GitHubSyncStatus == "syncing":
		return "info"
	case task.PRDraft || task.PRState == "draft" || task.CIState == "pending":
		return "warning"
	case canMergeTask(task) || task.CIState == "passed" || task.ReviewState == "approved":
		return "success"
	case task.PRState == "open":
		return "info"
	default:
		return "muted"
	}
}

func renderTaskViewport(line string, width int) string {
	return padWidth(truncateText(line, width), width)
}

func terminalViewport(m *Model, slot SessionSlot, viewportHeight, contentWidth int) ([]string, []string) {
	buffer := m.terminalBufferForSlot(slot)
	bufferLines := buffer.Lines
	bufferANSILines := buffer.ANSILines
	maxScrollOffset := max(0, len(bufferLines)-viewportHeight)
	scrollOffset := min(m.terminalScrollOffsetForSlot(slot), maxScrollOffset)
	viewportStart := max(0, len(bufferLines)-viewportHeight-scrollOffset)
	viewportEnd := min(len(bufferLines), viewportStart+viewportHeight)
	hasStyledLines := len(bufferANSILines) == len(bufferLines)

	rawPlain := []string{}
	rawStyled := []string{}

	for index := viewportStart; index < viewportEnd; index++ {
		plainLine := bufferLines[index]
		if !hasStyledLines && index == buffer.CursorY {
			plainLine = injectCursor(plainLine, buffer.CursorX)
		}
		rawPlain = append(rawPlain, plainLine)
		if hasStyledLines {
			rawStyled = append(rawStyled, bufferANSILines[index])
		} else {
			rawStyled = append(rawStyled, plainLine)
		}
	}

	for len(rawPlain) < viewportHeight {
		rawPlain = append(rawPlain, strings.Repeat(" ", contentWidth))
		rawStyled = append(rawStyled, strings.Repeat(" ", contentWidth))
	}
	return rawPlain, rawStyled
}

func injectCursor(line string, col int) string {
	if col < 0 {
		return line
	}
	if plainWidth(line) <= col {
		return line + strings.Repeat(" ", col-plainWidth(line)) + "█"
	}
	runes := []rune(line)
	if col >= len(runes) {
		return line + "█"
	}
	runes[col] = '█'
	return string(runes)
}

func terminalViewportHeight(height int) int {
	if height <= 2 {
		return max(1, height-terminalHeaderHeight)
	}
	return max(1, height-terminalHeaderHeight-terminalFooterHeight)
}

func shouldShowFilterBar(filters FilterModel, focus AppFocus) bool {
	return focus == FocusFilterBar || focus == FocusSearch || countActiveFilters(filters) > 0
}

func countActiveFilters(filters FilterModel) int {
	count := 0
	count += len(filters.RepoIDs)
	count += len(filters.PillarIDs)
	count += len(filters.LabelIDs)
	count += len(filters.TrackIDs)
	count += len(filters.PRState)
	count += len(filters.CIState)
	count += len(filters.SessionState)
	if filters.SearchText != "" {
		count++
	}
	if filters.IncludeArchived {
		count++
	}
	return count
}

func visibleWindow(itemHeights []int, selectedIndex, availableHeight int) (int, int) {
	if len(itemHeights) == 0 {
		return 0, 0
	}
	maxHeight := max(1, availableHeight)
	selectedIndex = clamp(selectedIndex, 0, len(itemHeights)-1)
	start, end, used := 0, 0, 0

	for end < len(itemHeights) {
		nextHeight := itemHeights[end]
		if end > start && used+nextHeight > maxHeight {
			break
		}
		used += nextHeight
		end++
	}

	for selectedIndex >= end && end < len(itemHeights) {
		used += itemHeights[end]
		end++
		for start < end-1 && used > maxHeight {
			used -= itemHeights[start]
			start++
		}
	}
	return start, end
}

func getTaskPRURL(task *TaskRecord, repo *RepoRecord) string {
	if task.PRURL != "" {
		return task.PRURL
	}
	if task.PRNumber == nil || repo == nil {
		return ""
	}
	repoURL := repo.GitHubURL
	if repoURL == "" && repo.GitHubOwner != "" && repo.GitHubRepo != "" {
		repoURL = "https://github.com/" + repo.GitHubOwner + "/" + repo.GitHubRepo
	}
	if repoURL == "" {
		return ""
	}
	return fmt.Sprintf("%s/pull/%d", repoURL, *task.PRNumber)
}

func canMergeTask(task TaskRecord) bool {
	return task.PRState == "open" && !task.PRDraft && task.CIState == "passed" && task.ReviewState == "approved"
}

func getPRCommentBlockerReason(task TaskRecord) string {
	prRef := "The PR"
	if task.PRNumber != nil {
		prRef = fmt.Sprintf("PR #%d", *task.PRNumber)
	}
	if task.PRNumber == nil || task.PRState == "none" {
		return "Selected task has no pull request."
	}
	if task.PRState == "merged" {
		return prRef + " is already merged."
	}
	if task.PRState == "closed" {
		return prRef + " is closed."
	}
	if !hasOpenPR(task) {
		return prRef + " is not open."
	}
	return ""
}

func getMergeBlockerReason(task TaskRecord) string {
	prRef := "The PR"
	if task.PRNumber != nil {
		prRef = fmt.Sprintf("PR #%d", *task.PRNumber)
	}
	if task.PRNumber == nil || task.PRState == "none" {
		return "Selected task has no pull request."
	}
	if task.PRDraft || task.PRState == "draft" {
		return prRef + " is still draft."
	}
	if task.PRState == "merged" {
		return prRef + " is already merged."
	}
	if task.PRState == "closed" {
		return prRef + " is closed."
	}
	if task.PRState != "open" {
		return prRef + " is not open."
	}
	if task.ReviewState == "changes_requested" {
		return prRef + " still has requested changes."
	}
	if task.ReviewState != "approved" {
		return prRef + " is not approved yet."
	}
	if task.CIState == "failed" {
		return prRef + " has failing checks."
	}
	if task.CIState == "pending" {
		return prRef + " checks are still pending."
	}
	if task.CIState != "passed" {
		return prRef + " does not have a passing build yet."
	}
	return ""
}

func workspaceKind(task *TaskRecord) string {
	if task != nil && task.WorktreePath != "" {
		return "worktree"
	}
	return "repo"
}

func workspaceColor(task *TaskRecord) string {
	if task != nil && task.WorktreePath != "" {
		return uiChrome.Success
	}
	return uiChrome.Muted
}

func valueOrAllRepos(repo *RepoRecord) string {
	if repo == nil {
		return "all repos"
	}
	return repo.Label
}

func valueOrTrack(track *TrackRecord, fallback string) string {
	if track == nil {
		return fallback
	}
	return track.Label
}

func valueOrRepo(repo *RepoRecord, fallback string) string {
	if repo == nil {
		return fallback
	}
	return repo.Label
}

func headerText(icon, value, color string) string {
	return lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(icon+" ") +
		lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Render(value)
}

func kbdHints(focus AppFocus) string {
	switch focus {
	case FocusBoard:
		return "move  a/A ai chat  B dual shell  u missions  : cmds  Enter shell  j comment  c PR  C retry PR  m merge  n new  f filters  s sync"
	case FocusMissions:
		return "j/k move  a/A ai chat  u release-or-close  n add task  N new mission  b blockers  d delete mission  Enter board  Esc close"
	case FocusTerminal:
		return "Shift+Tab pane  Tab+h/j/k/l switch shell  Ctrl+C interrupt  PgUp/PgDn scroll  Esc board"
	case FocusModal:
		return "Enter confirm  Esc cancel"
	case FocusFilterBar, FocusSearch:
		return "f edit  / search  Esc clear"
	default:
		return ""
	}
}

func joinSpaceBetween(left, right string, width int) string {
	leftWidth := lipgloss.Width(left)
	rightWidth := lipgloss.Width(right)
	if leftWidth+rightWidth >= width {
		return truncateText(left, max(1, width-rightWidth-1)) + " " + right
	}
	return left + strings.Repeat(" ", width-leftWidth-rightWidth) + right
}

func fitHeight(value string, height int) string {
	lines := strings.Split(value, "\n")
	switch {
	case len(lines) == height:
		return value
	case len(lines) > height:
		return strings.Join(lines[:height], "\n")
	default:
		padding := make([]string, height-len(lines))
		for index := range padding {
			padding[index] = ""
		}
		return strings.Join(append(lines, padding...), "\n")
	}
}

func truncateText(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if plainWidth(value) <= width {
		return value
	}
	if width == 1 {
		return "…"
	}

	result := ""
	used := 0
	for _, r := range value {
		charWidth := runewidth.RuneWidth(r)
		if used+charWidth > width-1 {
			break
		}
		result += string(r)
		used += charWidth
	}
	return result + "…"
}

func padWidth(value string, width int) string {
	padding := max(0, width-plainWidth(value))
	return value + strings.Repeat(" ", padding)
}

func truncatePlain(line string, maxWidth int) string {
	if maxWidth <= 0 || plainWidth(line) <= maxWidth {
		return line
	}
	return truncateText(line, maxWidth)
}

func truncateANSI(line string, maxWidth int) string {
	if maxWidth <= 0 || plainWidth(stripANSI(line)) <= maxWidth {
		return line
	}

	builder := strings.Builder{}
	width := 0
	sawANSI := false

	for len(line) > 0 && width < maxWidth {
		if strings.HasPrefix(line, "\x1b[") {
			end := strings.IndexByte(line, 'm')
			if end < 0 {
				break
			}
			builder.WriteString(line[:end+1])
			line = line[end+1:]
			sawANSI = true
			continue
		}

		r, size := utf8.DecodeRuneInString(line)
		if r == utf8.RuneError && size == 1 {
			break
		}
		runeWidth := runewidth.RuneWidth(r)
		if width+runeWidth > maxWidth {
			break
		}
		builder.WriteRune(r)
		width += runeWidth
		line = line[size:]
	}

	result := builder.String()
	if sawANSI && !strings.HasSuffix(result, "\x1b[0m") {
		result += "\x1b[0m"
	}
	return result
}

func stripANSI(value string) string {
	return ansiPattern.ReplaceAllString(value, "")
}

func plainWidth(value string) int {
	return runewidth.StringWidth(stripANSI(value))
}

func ternaryString(condition bool, left, right string) string {
	if condition {
		return left
	}
	return right
}

func ternaryInt(condition bool, left, right int) int {
	if condition {
		return left
	}
	return right
}
