package tui

import (
	"fmt"
	"slices"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

type createTaskLine string
type filterColumn string

const (
	createTaskTitleLine  createTaskLine = "title"
	createTaskRepoLine   createTaskLine = "repo"
	createTaskPillarLine createTaskLine = "pillar"

	filterRepoColumn   filterColumn = "repo"
	filterPillarColumn filterColumn = "pillar"
)

type createTaskModalState struct {
	Value       string
	RepoIndex   int
	PillarIndex int
	ActiveLine  createTaskLine
}

type renameTaskModalState struct {
	TaskID string
	Value  string
}

type taskDescriptionModalState struct {
	TaskID string
	Value  string
}

type prCommentModalState struct {
	TaskID string
	Value  string
}

type archiveConfirmModalState struct {
	TaskID string
}

type deleteConfirmModalState struct {
	TaskID string
}

type createPillarModalState struct {
	Value        string
	AssignTaskID string
}

type deletePillarConfirmModalState struct {
	PillarID     string
	TaskCount    int
	ReturnTaskID string
}

type pillarPickerModalState struct {
	TaskID string
	Index  int
}

type filterModalState struct {
	ActiveColumn      filterColumn
	RepoIndex         int
	PillarIndex       int
	SelectedRepoIDs   []string
	SelectedPillarIDs []string
}

type viewModalState struct {
	Index int
}

type commandPaletteModalState struct {
	Query string
	Index int
}

type createTaskPillarOption struct {
	ID    string
	Label string
}

type filterOption struct {
	ID    string
	Label string
}

func (m *Model) closeModal() {
	m.modal = ModalNone
	m.focus = FocusBoard
	m.createTaskModal = nil
	m.renameTaskModal = nil
	m.taskDescriptionModal = nil
	m.prCommentModal = nil
	m.archiveConfirmModal = nil
	m.deleteConfirmModal = nil
	m.createPillarModal = nil
	m.deletePillarConfirmModal = nil
	m.pillarPickerModal = nil
	m.filterModal = nil
	m.viewModal = nil
	m.commandPaletteModal = nil
}

func (m *Model) openHelpModal() {
	m.closeModal()
	m.modal = ModalHelp
	m.focus = FocusModal
}

func (m *Model) openCreateTaskModal() {
	initialRepoIndex := 0
	if m.activeRepoID != "" {
		for index, repo := range m.repos {
			if repo.ID == m.activeRepoID {
				initialRepoIndex = index
				break
			}
		}
	}

	pillarOptions := m.createTaskPillarOptions()
	initialPillarIndex := 0
	if len(m.repos) > 0 {
		defaultPillarID := m.repos[initialRepoIndex].DefaultPillarID
		if defaultPillarID != "" {
			for index, option := range pillarOptions {
				if option.ID == defaultPillarID {
					initialPillarIndex = index
					break
				}
			}
		}
	}

	m.closeModal()
	m.modal = ModalCreateTask
	m.focus = FocusModal
	m.createTaskModal = &createTaskModalState{
		RepoIndex:   initialRepoIndex,
		PillarIndex: initialPillarIndex,
		ActiveLine:  createTaskTitleLine,
	}
}

func (m *Model) openRenameTaskModal(task *TaskRecord) {
	if task == nil {
		m.statusMessage = "Select a task to rename it."
		return
	}
	m.closeModal()
	m.modal = ModalRenameTask
	m.focus = FocusModal
	m.renameTaskModal = &renameTaskModalState{
		TaskID: task.ID,
		Value:  task.Title,
	}
}

func (m *Model) openTaskDescriptionModal(task *TaskRecord) {
	if task == nil {
		m.statusMessage = "Select a task to edit its description."
		return
	}
	m.closeModal()
	m.modal = ModalTaskDescription
	m.focus = FocusModal
	m.taskDescriptionModal = &taskDescriptionModalState{
		TaskID: task.ID,
		Value:  task.Description,
	}
}

func (m *Model) openPRCommentModal(task *TaskRecord) {
	if task == nil {
		m.statusMessage = "Select a task to comment on its PR."
		return
	}
	if blocker := getPRCommentBlockerReason(*task); blocker != "" {
		m.statusMessage = blocker
		return
	}
	m.closeModal()
	m.modal = ModalPRComment
	m.focus = FocusModal
	m.prCommentModal = &prCommentModalState{TaskID: task.ID}
}

func (m *Model) openArchiveConfirmModal(task *TaskRecord) {
	if task == nil {
		m.statusMessage = "Select a task to archive it."
		return
	}
	m.closeModal()
	m.modal = ModalArchiveConfirm
	m.focus = FocusModal
	m.archiveConfirmModal = &archiveConfirmModalState{TaskID: task.ID}
}

func (m *Model) openDeleteConfirmModal(task *TaskRecord) {
	if task == nil {
		m.statusMessage = "Select a task to delete it."
		return
	}
	m.closeModal()
	m.modal = ModalDeleteConfirm
	m.focus = FocusModal
	m.deleteConfirmModal = &deleteConfirmModalState{TaskID: task.ID}
}

func (m *Model) openCreatePillarModal(assignTaskID string) {
	m.closeModal()
	m.modal = ModalCreatePillar
	m.focus = FocusModal
	m.createPillarModal = &createPillarModalState{AssignTaskID: assignTaskID}
}

func (m *Model) openDeletePillarConfirmModal(pillarID string, returnTaskID string) {
	if pillarID == "" {
		m.statusMessage = "Selected task has no pillar to delete."
		return
	}
	pillar := m.pillarByID(pillarID)
	if pillar == nil {
		m.statusMessage = "Selected task pillar no longer exists."
		return
	}
	taskCount := 0
	for _, candidate := range m.tasks {
		if candidate.PillarID == pillar.ID {
			taskCount++
		}
	}

	m.closeModal()
	m.modal = ModalDeletePillar
	m.focus = FocusModal
	m.deletePillarConfirmModal = &deletePillarConfirmModalState{
		PillarID:     pillar.ID,
		TaskCount:    taskCount,
		ReturnTaskID: returnTaskID,
	}
}

func (m *Model) openPillarPickerModal(task *TaskRecord) {
	if task == nil {
		m.statusMessage = "Select a task to assign a pillar."
		return
	}
	options := m.pillarPickerOptions()
	initialIndex := 0
	if task.PillarID != "" {
		for index, option := range options {
			if option.ID == task.PillarID {
				initialIndex = index
				break
			}
		}
	}

	m.closeModal()
	m.modal = ModalPillarPicker
	m.focus = FocusModal
	m.pillarPickerModal = &pillarPickerModalState{
		TaskID: task.ID,
		Index:  initialIndex,
	}
}

func (m *Model) openFilterModal() {
	repoOptions := m.filterRepoOptions()
	pillarOptions := m.filterPillarOptions()

	repoIndex := 0
	if len(m.filters.RepoIDs) > 0 {
		for index, option := range repoOptions {
			if option.ID == m.filters.RepoIDs[0] {
				repoIndex = index
				break
			}
		}
	}

	pillarIndex := 0
	if len(m.filters.PillarIDs) > 0 {
		for index, option := range pillarOptions {
			if option.ID == m.filters.PillarIDs[0] {
				pillarIndex = index
				break
			}
		}
	}

	m.closeModal()
	m.modal = ModalFilterPicker
	m.focus = FocusModal
	m.filterModal = &filterModalState{
		ActiveColumn:      filterRepoColumn,
		RepoIndex:         repoIndex,
		PillarIndex:       pillarIndex,
		SelectedRepoIDs:   append([]string{}, m.filters.RepoIDs...),
		SelectedPillarIDs: append([]string{}, m.filters.PillarIDs...),
	}
}

func (m *Model) openViewModal() {
	index := 0
	if m.terminalLayoutMode == TerminalLayoutMode("top-bottom") {
		index = 1
	}
	m.closeModal()
	m.modal = ModalViewPicker
	m.focus = FocusModal
	m.viewModal = &viewModalState{Index: index}
}

func (m *Model) openCommandPaletteModal() {
	m.closeModal()
	m.modal = ModalCommandPalette
	m.focus = FocusModal
	m.commandPaletteModal = &commandPaletteModalState{}
}

func (m *Model) handleModalKey(key tea.KeyMsg) tea.Cmd {
	switch m.modal {
	case ModalHelp:
		if key.Type == tea.KeyEsc || key.String() == "?" || key.String() == "q" {
			m.closeModal()
		}
		return nil
	case ModalCreateTask:
		return m.handleCreateTaskModalKey(key)
	case ModalRenameTask:
		return m.handleRenameTaskModalKey(key)
	case ModalTaskDescription:
		return m.handleTaskDescriptionModalKey(key)
	case ModalPRComment:
		return m.handlePRCommentModalKey(key)
	case ModalArchiveConfirm:
		return m.handleArchiveConfirmModalKey(key)
	case ModalDeleteConfirm:
		return m.handleDeleteConfirmModalKey(key)
	case ModalCreatePillar:
		return m.handleCreatePillarModalKey(key)
	case ModalDeletePillar:
		return m.handleDeletePillarConfirmModalKey(key)
	case ModalPillarPicker:
		return m.handlePillarPickerModalKey(key)
	case ModalFilterPicker:
		return m.handleFilterModalKey(key)
	case ModalViewPicker:
		return m.handleViewModalKey(key)
	case ModalCommandPalette:
		return m.handleCommandPaletteModalKey(key)
	default:
		if key.Type == tea.KeyEsc {
			m.closeModal()
		}
		return nil
	}
}

func (m *Model) handleCreateTaskModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.createTaskModal
	if state == nil {
		m.closeModal()
		return nil
	}

	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		title := strings.TrimSpace(state.Value)
		if title == "" {
			return nil
		}
		repoID := ""
		if len(m.repos) > 0 {
			repoID = m.repos[clamp(state.RepoIndex, 0, len(m.repos)-1)].ID
		}
		pillarID := ""
		options := m.createTaskPillarOptions()
		if len(options) > 0 {
			pillarID = options[clamp(state.PillarIndex, 0, len(options)-1)].ID
		}
		if repoID == "" {
			m.statusMessage = "Add a repo before creating tasks."
			return nil
		}
		m.closeModal()
		backlogIndex := indexTrack(m.sortedTracks(), "backlog")
		if backlogIndex >= 0 {
			m.selectedTrackIndex = backlogIndex
			m.selectedTaskIndex = 0
		}
		return m.createTaskCmd(title, repoID, pillarID)
	case tea.KeyUp:
		switch state.ActiveLine {
		case createTaskPillarLine:
			state.ActiveLine = createTaskRepoLine
		case createTaskRepoLine:
			state.ActiveLine = createTaskTitleLine
		}
		return nil
	case tea.KeyDown:
		switch state.ActiveLine {
		case createTaskTitleLine:
			state.ActiveLine = createTaskRepoLine
		case createTaskRepoLine:
			state.ActiveLine = createTaskPillarLine
		}
		return nil
	case tea.KeyLeft:
		switch state.ActiveLine {
		case createTaskRepoLine:
			if len(m.repos) > 1 {
				state.RepoIndex = wrapIndex(state.RepoIndex, len(m.repos), -1)
			}
		case createTaskPillarLine:
			options := m.createTaskPillarOptions()
			if len(options) > 1 {
				state.PillarIndex = wrapIndex(state.PillarIndex, len(options), -1)
			}
		}
		return nil
	case tea.KeyRight:
		switch state.ActiveLine {
		case createTaskRepoLine:
			if len(m.repos) > 1 {
				state.RepoIndex = wrapIndex(state.RepoIndex, len(m.repos), 1)
			}
		case createTaskPillarLine:
			options := m.createTaskPillarOptions()
			if len(options) > 1 {
				state.PillarIndex = wrapIndex(state.PillarIndex, len(options), 1)
			}
		}
		return nil
	case tea.KeyBackspace, tea.KeyDelete:
		if state.ActiveLine == createTaskTitleLine && state.Value != "" {
			state.Value = trimLastRune(state.Value)
		}
		return nil
	}

	switch key.String() {
	case ",":
		if state.ActiveLine == createTaskRepoLine && len(m.repos) > 1 {
			state.RepoIndex = wrapIndex(state.RepoIndex, len(m.repos), -1)
		}
	case "<":
		if state.ActiveLine == createTaskRepoLine && len(m.repos) > 1 {
			state.RepoIndex = wrapIndex(state.RepoIndex, len(m.repos), -1)
		}
	case ".":
		if state.ActiveLine == createTaskRepoLine && len(m.repos) > 1 {
			state.RepoIndex = wrapIndex(state.RepoIndex, len(m.repos), 1)
		}
	case ">":
		if state.ActiveLine == createTaskRepoLine && len(m.repos) > 1 {
			state.RepoIndex = wrapIndex(state.RepoIndex, len(m.repos), 1)
		}
	case "[":
		if state.ActiveLine == createTaskPillarLine {
			options := m.createTaskPillarOptions()
			if len(options) > 1 {
				state.PillarIndex = wrapIndex(state.PillarIndex, len(options), -1)
			}
		}
	case "]":
		if state.ActiveLine == createTaskPillarLine {
			options := m.createTaskPillarOptions()
			if len(options) > 1 {
				state.PillarIndex = wrapIndex(state.PillarIndex, len(options), 1)
			}
		}
	default:
		if state.ActiveLine == createTaskTitleLine {
			if next, changed := appendPrintableInput(state.Value, key); changed {
				state.Value = next
			}
		}
	}

	return nil
}

func (m *Model) handleRenameTaskModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.renameTaskModal
	if state == nil {
		m.closeModal()
		return nil
	}
	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		title := strings.TrimSpace(state.Value)
		if title == "" {
			return nil
		}
		taskID := state.TaskID
		m.closeModal()
		return m.renameTaskCmd(taskID, title)
	case tea.KeyBackspace, tea.KeyDelete:
		state.Value = trimLastRune(state.Value)
		return nil
	}
	if next, changed := appendPrintableInput(state.Value, key); changed {
		state.Value = next
	}
	return nil
}

func (m *Model) handleTaskDescriptionModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.taskDescriptionModal
	if state == nil {
		m.closeModal()
		return nil
	}
	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		taskID := state.TaskID
		description := strings.TrimSpace(state.Value)
		m.closeModal()
		return m.updateTaskDescriptionCmd(taskID, description)
	case tea.KeyBackspace, tea.KeyDelete:
		state.Value = trimLastRune(state.Value)
		return nil
	}
	if next, changed := appendPrintableInput(state.Value, key); changed {
		state.Value = next
	}
	return nil
}

func (m *Model) handlePRCommentModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.prCommentModal
	if state == nil {
		m.closeModal()
		return nil
	}
	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		taskID := state.TaskID
		body := strings.TrimSpace(state.Value)
		if body == "" {
			return nil
		}
		task := m.taskByID(taskID)
		m.closeModal()
		return m.commentTaskPRCmd(task, body)
	case tea.KeyBackspace, tea.KeyDelete:
		state.Value = trimLastRune(state.Value)
		return nil
	}
	if next, changed := appendPrintableInput(state.Value, key); changed {
		state.Value = next
	}
	return nil
}

func (m *Model) handleArchiveConfirmModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.archiveConfirmModal
	if state == nil {
		m.closeModal()
		return nil
	}
	if key.Type == tea.KeyEsc || key.String() == "n" || key.String() == "N" {
		m.closeModal()
		return nil
	}
	if key.String() == "y" || key.String() == "Y" {
		taskID := state.TaskID
		m.closeModal()
		return m.archiveTaskCmd(taskID)
	}
	return nil
}

func (m *Model) handleDeleteConfirmModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.deleteConfirmModal
	if state == nil {
		m.closeModal()
		return nil
	}
	if key.Type == tea.KeyEsc || key.String() == "n" || key.String() == "N" {
		m.closeModal()
		return nil
	}
	if key.String() == "y" || key.String() == "Y" {
		taskID := state.TaskID
		m.closeModal()
		return m.deleteTaskCmd(taskID)
	}
	return nil
}

func (m *Model) handleCreatePillarModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.createPillarModal
	if state == nil {
		m.closeModal()
		return nil
	}
	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		label := strings.TrimSpace(state.Value)
		if label == "" {
			return nil
		}
		assignTaskID := state.AssignTaskID
		m.closeModal()
		return m.createPillarCmd(label, assignTaskID)
	case tea.KeyBackspace, tea.KeyDelete:
		state.Value = trimLastRune(state.Value)
		return nil
	}
	if next, changed := appendPrintableInput(state.Value, key); changed {
		state.Value = next
	}
	return nil
}

func (m *Model) handleDeletePillarConfirmModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.deletePillarConfirmModal
	if state == nil {
		m.closeModal()
		return nil
	}
	if key.Type == tea.KeyEsc || key.String() == "n" || key.String() == "N" {
		returnTaskID := state.ReturnTaskID
		m.closeModal()
		if returnTaskID != "" {
			if task := m.taskByID(returnTaskID); task != nil {
				m.openPillarPickerModal(task)
			}
		}
		return nil
	}
	if key.String() == "y" || key.String() == "Y" {
		pillarID := state.PillarID
		m.closeModal()
		return m.deletePillarCmd(pillarID)
	}
	return nil
}

func (m *Model) handlePillarPickerModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.pillarPickerModal
	if state == nil {
		m.closeModal()
		return nil
	}
	options := m.pillarPickerOptions()
	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		if len(options) == 0 {
			m.closeModal()
			return nil
		}
		taskID := state.TaskID
		selected := options[clamp(state.Index, 0, len(options)-1)]
		m.closeModal()
		return m.assignPillarCmd(taskID, selected.ID)
	case tea.KeyUp:
		state.Index = clamp(state.Index-1, 0, max(0, len(options)-1))
		return nil
	case tea.KeyDown:
		state.Index = clamp(state.Index+1, 0, max(0, len(options)-1))
		return nil
	}
	switch key.String() {
	case "c", "C":
		assignTaskID := state.TaskID
		m.openCreatePillarModal(assignTaskID)
	case "d", "D":
		if len(options) == 0 {
			return nil
		}
		selected := options[clamp(state.Index, 0, len(options)-1)]
		if selected.ID == "" {
			return nil
		}
		m.openDeletePillarConfirmModal(selected.ID, state.TaskID)
	}
	return nil
}

func (m *Model) handleFilterModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.filterModal
	if state == nil {
		m.closeModal()
		return nil
	}
	repoOptions := m.filterRepoOptions()
	pillarOptions := m.filterPillarOptions()

	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		nextFilters := m.filters
		nextFilters.RepoIDs = copyNonEmptyIDs(state.SelectedRepoIDs)
		nextFilters.PillarIDs = copyNonEmptyIDs(state.SelectedPillarIDs)
		m.filters = nextFilters
		m.activeViewID = ""
		m.selectedTrackIndex = 0
		m.selectedTaskIndex = 0
		m.closeModal()
		return m.setUIStateCmd(map[string]interface{}{
			"filters": nextFilters,
		})
	case tea.KeyLeft:
		state.ActiveColumn = filterRepoColumn
		return nil
	case tea.KeyRight:
		state.ActiveColumn = filterPillarColumn
		return nil
	case tea.KeyUp:
		if state.ActiveColumn == filterRepoColumn {
			state.RepoIndex = clamp(state.RepoIndex-1, 0, max(0, len(repoOptions)-1))
		} else {
			state.PillarIndex = clamp(state.PillarIndex-1, 0, max(0, len(pillarOptions)-1))
		}
		return nil
	case tea.KeyDown:
		if state.ActiveColumn == filterRepoColumn {
			state.RepoIndex = clamp(state.RepoIndex+1, 0, max(0, len(repoOptions)-1))
		} else {
			state.PillarIndex = clamp(state.PillarIndex+1, 0, max(0, len(pillarOptions)-1))
		}
		return nil
	case tea.KeySpace:
		m.toggleFilterSelection()
		return nil
	}

	switch key.String() {
	case " ":
		m.toggleFilterSelection()
	case "c", "C":
		state.SelectedRepoIDs = nil
		state.SelectedPillarIDs = nil
	}
	return nil
}

func (m *Model) handleViewModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.viewModal
	if state == nil {
		m.closeModal()
		return nil
	}
	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		mode := TerminalLayoutMode("side-by-side")
		if state.Index == 1 {
			mode = TerminalLayoutMode("top-bottom")
		}
		m.terminalLayoutMode = mode
		m.closeModal()
		return tea.Batch(
			m.setUIStateCmd(map[string]interface{}{
				"terminalLayoutMode": mode,
			}),
			m.resizeActiveSessionCmd(),
		)
	case tea.KeyUp, tea.KeyLeft:
		state.Index = clamp(state.Index-1, 0, 1)
		return nil
	case tea.KeyDown, tea.KeyRight:
		state.Index = clamp(state.Index+1, 0, 1)
		return nil
	}
	return nil
}

func (m *Model) handleCommandPaletteModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.commandPaletteModal
	if state == nil {
		m.closeModal()
		return nil
	}
	filtered := m.filteredCommandPaletteCommands(state.Query)
	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		if len(filtered) == 0 {
			return nil
		}
		command := filtered[clamp(state.Index, 0, len(filtered)-1)]
		if command.Disabled {
			return nil
		}
		return m.executeCommandPaletteAction(command.ID)
	case tea.KeyUp:
		state.Index = clamp(state.Index-1, 0, max(0, len(filtered)-1))
		return nil
	case tea.KeyDown:
		state.Index = clamp(state.Index+1, 0, max(0, len(filtered)-1))
		return nil
	case tea.KeyBackspace, tea.KeyDelete:
		state.Query = trimLastRune(state.Query)
		state.Index = 0
		return nil
	}
	if next, changed := appendPrintableInput(state.Query, key); changed {
		state.Query = next
		state.Index = 0
	}
	return nil
}

func (m *Model) toggleFilterSelection() {
	state := m.filterModal
	if state == nil {
		return
	}
	if state.ActiveColumn == filterRepoColumn {
		options := m.filterRepoOptions()
		if len(options) == 0 {
			return
		}
		option := options[clamp(state.RepoIndex, 0, len(options)-1)]
		state.SelectedRepoIDs = toggleID(state.SelectedRepoIDs, option.ID)
		return
	}
	options := m.filterPillarOptions()
	if len(options) == 0 {
		return
	}
	option := options[clamp(state.PillarIndex, 0, len(options)-1)]
	state.SelectedPillarIDs = toggleID(state.SelectedPillarIDs, option.ID)
}

func (m *Model) executeCommandPaletteAction(commandID string) tea.Cmd {
	contextTask := m.contextTask()
	contextTrackIndex := -1
	if contextTask != nil {
		contextTrackIndex = indexTrack(m.sortedTracks(), contextTask.TrackID)
	}

	switch commandID {
	case "create-task":
		m.openCreateTaskModal()
		return nil
	case "rename-task":
		m.openRenameTaskModal(contextTask)
		return nil
	case "edit-description":
		m.openTaskDescriptionModal(contextTask)
		return nil
	case "comment-pr":
		m.openPRCommentModal(contextTask)
		return nil
	case "delete-task":
		m.openDeleteConfirmModal(contextTask)
		return nil
	case "archive-task":
		m.openArchiveConfirmModal(contextTask)
		return nil
	case "assign-pillar":
		m.openPillarPickerModal(contextTask)
		return nil
	case "create-pillar":
		assignTaskID := ""
		if contextTask != nil {
			assignTaskID = contextTask.ID
		}
		m.openCreatePillarModal(assignTaskID)
		return nil
	case "delete-pillar":
		if contextTask != nil {
			m.openDeletePillarConfirmModal(contextTask.PillarID, contextTask.ID)
		}
		return nil
	case "move-task-left":
		m.closeModal()
		if contextTask != nil && contextTrackIndex > 0 {
			return m.moveContextTaskCmd(contextTask, -1)
		}
		return nil
	case "move-task-right":
		m.closeModal()
		if contextTask != nil && contextTrackIndex >= 0 && contextTrackIndex < len(m.sortedTracks())-1 {
			return m.moveContextTaskCmd(contextTask, 1)
		}
		return nil
	case "open-shell":
		m.closeModal()
		if contextTask != nil {
			return m.openSessionCmd(contextTask.ID, false)
		}
		return nil
	case "recreate-shell":
		m.closeModal()
		if contextTask != nil {
			return m.openSessionCmd(contextTask.ID, true)
		}
		return nil
	case "focus-terminal":
		m.closeModal()
		if m.activeTaskID == "" {
			m.statusMessage = "Open a task shell before focusing the terminal pane."
			return nil
		}
		return m.focusActiveTerminalCmd(false)
	case "fullscreen-terminal":
		m.closeModal()
		if m.activeTaskID == "" {
			m.statusMessage = "Open a task shell before expanding the terminal."
			return nil
		}
		return m.focusActiveTerminalCmd(true)
	case "open-ide":
		m.closeModal()
		if contextTask != nil {
			return m.openTaskInIDECmd(contextTask)
		}
		return nil
	case "open-workspace":
		m.closeModal()
		if contextTask != nil {
			return m.revealTaskWorkspaceCmd(contextTask)
		}
		return nil
	case "create-pr":
		m.closeModal()
		if contextTask != nil {
			return m.createTaskPRCmd(contextTask)
		}
		return nil
	case "retry-pushed-pr-creation":
		m.closeModal()
		if contextTask != nil {
			return m.retryPushedBranchPRCreationCmd(contextTask)
		}
		return nil
	case "open-pr":
		m.closeModal()
		if contextTask != nil {
			return m.openPRCmd(contextTask, false)
		}
		return nil
	case "open-checks":
		m.closeModal()
		if contextTask != nil {
			return m.openPRCmd(contextTask, true)
		}
		return nil
	case "merge-pr":
		m.closeModal()
		if contextTask != nil {
			return m.mergeTaskPRCmd(contextTask)
		}
		return nil
	case "filters":
		m.openFilterModal()
		return nil
	case "layout":
		m.openViewModal()
		return nil
	case "repo-prev":
		m.closeModal()
		m.switchRepo(-1)
		return m.persistActiveRepoCmd()
	case "repo-next":
		m.closeModal()
		m.switchRepo(1)
		return m.persistActiveRepoCmd()
	case "sync":
		m.closeModal()
		return m.syncCmd()
	case "help":
		m.openHelpModal()
		return nil
	case "quit":
		m.closeModal()
		return tea.Quit
	default:
		return nil
	}
}

func (m *Model) commandPaletteCommands() []CommandPaletteItem {
	contextTask := m.contextTask()
	contextTrackIndex := -1
	if contextTask != nil {
		contextTrackIndex = indexTrack(m.sortedTracks(), contextTask.TrackID)
	}
	return []CommandPaletteItem{
		{ID: "create-task", Title: "Create task", Section: "Task", Detail: "Add a new task into the backlog track.", Shortcut: "n", Keywords: []string{"new", "backlog", "add"}},
		{ID: "rename-task", Title: "Rename current task", Section: "Task", Detail: detailOrFallback(contextTask, "Rename %s", "Rename the current task."), Shortcut: "r", Keywords: []string{"title", "edit"}, Disabled: contextTask == nil, DisabledReason: "Select a task to rename it."},
		{ID: "edit-description", Title: "Edit task description", Section: "Task", Detail: "Open the long-form task description editor.", Shortcut: "Ctrl+D", Keywords: []string{"notes", "description"}, Disabled: contextTask == nil, DisabledReason: "Select a task to edit its description."},
		{ID: "delete-task", Title: "Delete current task", Section: "Task", Detail: "Delete the selected task after confirmation.", Shortcut: "d", Keywords: []string{"remove"}, Disabled: contextTask == nil, DisabledReason: "Select a task to delete it."},
		{ID: "archive-task", Title: "Archive current task", Section: "Task", Detail: "Archive the selected task.", Shortcut: "a", Keywords: []string{"done", "hide"}, Disabled: contextTask == nil, DisabledReason: "Select a task to archive it."},
		{ID: "assign-pillar", Title: "Assign pillar", Section: "Task", Detail: "Attach or change the pillar for the current task.", Shortcut: "p", Keywords: []string{"label", "pillar"}, Disabled: contextTask == nil, DisabledReason: "Select a task to assign a pillar."},
		{ID: "create-pillar", Title: "Create pillar", Section: "Task", Detail: "Create a new pillar and optionally assign it to the current task.", Shortcut: "P", Keywords: []string{"new pillar"}},
		{ID: "delete-pillar", Title: "Delete current pillar", Section: "Task", Detail: "Delete the current pillar and every task attached to it.", Shortcut: "D", Keywords: []string{"remove pillar"}, Disabled: contextTask == nil || contextTask.PillarID == "", DisabledReason: "The current task does not have a pillar to delete."},
		{ID: "move-task-left", Title: "Move task left", Section: "Task", Detail: "Move the current task to the previous track.", Shortcut: "[", Keywords: []string{"previous track", "kanban"}, Disabled: contextTask == nil || contextTrackIndex <= 0, DisabledReason: "The current task is already in the first track."},
		{ID: "move-task-right", Title: "Move task right", Section: "Task", Detail: "Move the current task to the next track.", Shortcut: "]", Keywords: []string{"next track", "kanban"}, Disabled: contextTask == nil || contextTrackIndex < 0 || contextTrackIndex >= len(m.sortedTracks())-1, DisabledReason: "The current task is already in the last track."},
		{ID: "open-shell", Title: "Open task shell", Section: "Session", Detail: "Start or attach the session for the current task.", Shortcut: "Enter", Keywords: []string{"terminal", "session", "shell"}, Disabled: contextTask == nil, DisabledReason: "Select a task to open its shell."},
		{ID: "recreate-shell", Title: "Recreate task shell", Section: "Session", Detail: "Recreate the current task shell with the native backend.", Shortcut: "R", Keywords: []string{"terminal", "session", "restart"}, Disabled: contextTask == nil, DisabledReason: "Select a task to recreate its shell."},
		{ID: "focus-terminal", Title: "Focus terminal pane", Section: "Session", Detail: "Jump into the embedded terminal pane.", Shortcut: "t", Keywords: []string{"terminal", "pane"}, Disabled: m.activeTaskID == "", DisabledReason: "Open a task shell before focusing the terminal pane."},
		{ID: "fullscreen-terminal", Title: "Expand terminal workspace", Section: "Session", Detail: "Make the terminal take over the workspace.", Shortcut: "z", Keywords: []string{"terminal", "fullscreen", "expand"}, Disabled: m.activeTaskID == "", DisabledReason: "Open a task shell before expanding the terminal."},
		{ID: "open-ide", Title: "Open workspace in IDE", Section: "Workspace", Detail: "Open the current task workspace in the configured IDE.", Shortcut: "i", Keywords: []string{"editor", "workspace"}, Disabled: contextTask == nil, DisabledReason: "Select a task to open its workspace."},
		{ID: "open-workspace", Title: "Reveal workspace", Section: "Workspace", Detail: "Open the current task workspace in Finder or Explorer.", Shortcut: "x", Keywords: []string{"finder", "explorer", "folder"}, Disabled: contextTask == nil, DisabledReason: "Select a task to reveal its workspace."},
		{ID: "create-pr", Title: "Create or ensure pull request", Section: "GitHub", Detail: "Create the PR immediately for the current task branch.", Shortcut: "c", Keywords: []string{"github", "pull request"}, Disabled: contextTask == nil, DisabledReason: "Select a task to create a pull request."},
		{ID: "retry-pushed-pr-creation", Title: "Retry pushed-branch PR creation", Section: "GitHub", Detail: "Restart the background PR creation watcher after a branch push.", Shortcut: "C", Keywords: []string{"github", "pull request", "push", "retry"}, Disabled: contextTask == nil || contextTask.BranchName == "", DisabledReason: "Select a task with a branch to watch for PR creation."},
		{ID: "comment-pr", Title: "Comment on pull request", Section: "GitHub", Detail: "Open a composer and post a comment with gh CLI.", Shortcut: "j", Keywords: []string{"github", "pull request", "comment"}, Disabled: contextTask == nil || !canCommentOnTaskPR(*contextTask), DisabledReason: "The current task does not have an open or draft pull request."},
		{ID: "open-pr", Title: "Open pull request", Section: "GitHub", Detail: "Open the current task PR in the browser.", Shortcut: "o", Keywords: []string{"github", "browser", "pr"}, Disabled: contextTask == nil || !hasOpenPR(*contextTask), DisabledReason: "The current task does not have an open pull request."},
		{ID: "open-checks", Title: "Open pull request checks", Section: "GitHub", Detail: "Open CI checks for the current task PR.", Shortcut: "v", Keywords: []string{"github", "checks", "ci"}, Disabled: contextTask == nil || !hasOpenPR(*contextTask), DisabledReason: "The current task does not have an open pull request."},
		{ID: "merge-pr", Title: "Merge pull request", Section: "GitHub", Detail: "Squash merge the current task PR when it is ready.", Shortcut: "m", Keywords: []string{"github", "merge"}, Disabled: contextTask == nil || !canMergeTask(*contextTask), DisabledReason: "Open PR, approved review, and passing build are required."},
		{ID: "filters", Title: "Open filters", Section: "View", Detail: "Change repo and pillar filters.", Shortcut: "f", Keywords: []string{"filter", "repo", "pillar"}},
		{ID: "layout", Title: "Change layout", Section: "View", Detail: "Choose the board and terminal layout.", Shortcut: "g", Keywords: []string{"view", "split", "terminal"}},
		{ID: "repo-prev", Title: "Previous repo", Section: "View", Detail: "Switch to the previous repo filter.", Shortcut: ",", Keywords: []string{"repo", "left"}, Disabled: len(m.repos) == 0, DisabledReason: "Add a repo before switching repo scope."},
		{ID: "repo-next", Title: "Next repo", Section: "View", Detail: "Switch to the next repo filter.", Shortcut: ".", Keywords: []string{"repo", "right"}, Disabled: len(m.repos) == 0, DisabledReason: "Add a repo before switching repo scope."},
		{ID: "sync", Title: "Sync now", Section: "System", Detail: "Refresh PR, CI, and review state from GitHub.", Shortcut: "s", Keywords: []string{"refresh", "github"}},
		{ID: "help", Title: "Open help", Section: "System", Detail: "Show the keyboard reference.", Shortcut: "?", Keywords: []string{"shortcuts", "keys"}},
		{ID: "quit", Title: "Quit AgentBoard", Section: "System", Detail: "Exit the application.", Shortcut: "q", Keywords: []string{"exit", "close"}},
	}
}

func (m *Model) filteredCommandPaletteCommands(query string) []CommandPaletteItem {
	commands := m.commandPaletteCommands()
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return commands
	}
	filtered := make([]CommandPaletteItem, 0, len(commands))
	for _, command := range commands {
		haystack := strings.ToLower(strings.Join(append([]string{command.Title, command.Section, command.Detail}, command.Keywords...), " "))
		if strings.Contains(haystack, needle) {
			filtered = append(filtered, command)
		}
	}
	return filtered
}

func (m *Model) createTaskCmd(title, repoID, pillarID string) tea.Cmd {
	params := map[string]interface{}{
		"title":  title,
		"repoId": repoID,
	}
	if pillarID != "" {
		params["pillarId"] = pillarID
	}
	return m.boardActionCmd("createTask", params, "Created task.")
}

func (m *Model) renameTaskCmd(taskID, title string) tea.Cmd {
	return m.boardActionCmd("renameTask", map[string]string{"id": taskID, "title": title}, "Renamed task.")
}

func (m *Model) updateTaskDescriptionCmd(taskID, description string) tea.Cmd {
	return m.boardActionCmd("updateTaskDescription", map[string]string{"id": taskID, "description": description}, "Saved task description.")
}

func (m *Model) archiveTaskCmd(taskID string) tea.Cmd {
	return m.boardActionCmd("archiveTask", map[string]string{"id": taskID}, "Archived task.")
}

func (m *Model) deleteTaskCmd(taskID string) tea.Cmd {
	if taskID == m.activeTaskID {
		m.activeTaskID = ""
		m.activeSessionBranch = ""
		m.activeSessionBackendType = ""
		m.terminalPaneVisible = false
	}
	return m.boardActionCmd("deleteTask", map[string]string{"id": taskID}, "Deleted task.")
}

func (m *Model) createPillarCmd(label, assignTaskID string) tea.Cmd {
	return func() tea.Msg {
		var pillar PillarRecord
		if err := m.client.Call("createPillar", map[string]string{"label": label}, &pillar); err != nil {
			return boardActionMsg{err: err}
		}
		if assignTaskID != "" {
			if err := m.client.Call("assignPillar", map[string]interface{}{"id": assignTaskID, "pillarId": pillar.ID}, nil); err != nil {
				return boardActionMsg{err: err}
			}
		}
		var board BoardSnapshot
		if err := m.client.Call("getBoard", nil, &board); err != nil {
			return boardActionMsg{err: err}
		}
		status := "Created pillar."
		if assignTaskID != "" {
			status = "Created pillar and assigned it."
		}
		return boardActionMsg{board: &board, status: status}
	}
}

func (m *Model) deletePillarCmd(pillarID string) tea.Cmd {
	return m.boardActionCmd("deletePillar", map[string]string{"id": pillarID}, "Deleted pillar.")
}

func (m *Model) assignPillarCmd(taskID, pillarID string) tea.Cmd {
	params := map[string]interface{}{
		"id":       taskID,
		"pillarId": nil,
	}
	status := "Cleared pillar."
	if pillarID != "" {
		params["pillarId"] = pillarID
		status = "Assigned pillar."
	}
	return m.boardActionCmd("assignPillar", params, status)
}

func (m *Model) persistActiveRepoCmd() tea.Cmd {
	if m.activeRepoID == "" {
		return nil
	}
	return m.setUIStateCmd(map[string]interface{}{
		"activeRepoId": m.activeRepoID,
	})
}

func (m *Model) createTaskPillarOptions() []createTaskPillarOption {
	options := []createTaskPillarOption{{ID: "", Label: "None"}}
	for _, pillar := range m.pillars {
		label := pillar.Label
		if pillar.Icon != "" {
			label = pillar.Icon + " " + label
		}
		options = append(options, createTaskPillarOption{ID: pillar.ID, Label: label})
	}
	return options
}

func (m *Model) pillarPickerOptions() []createTaskPillarOption {
	return m.createTaskPillarOptions()
}

func (m *Model) filterRepoOptions() []filterOption {
	options := make([]filterOption, 0, len(m.repos))
	for _, repo := range m.repos {
		options = append(options, filterOption{ID: repo.ID, Label: repo.Label})
	}
	return options
}

func (m *Model) filterPillarOptions() []filterOption {
	options := make([]filterOption, 0, len(m.pillars))
	for _, pillar := range m.pillars {
		label := pillar.Label
		if pillar.Icon != "" {
			label = pillar.Icon + " " + label
		}
		options = append(options, filterOption{ID: pillar.ID, Label: label})
	}
	return options
}

func (m *Model) taskByID(taskID string) *TaskRecord {
	for index := range m.tasks {
		if m.tasks[index].ID == taskID {
			return &m.tasks[index]
		}
	}
	return nil
}

func (m *Model) pillarByID(pillarID string) *PillarRecord {
	for index := range m.pillars {
		if m.pillars[index].ID == pillarID {
			return &m.pillars[index]
		}
	}
	return nil
}

func hasOpenPR(task TaskRecord) bool {
	return task.PRState == "open" || task.PRState == "draft"
}

func canCommentOnTaskPR(task TaskRecord) bool {
	return task.PRNumber != nil && hasOpenPR(task)
}

func detailOrFallback(task *TaskRecord, format string, fallback string) string {
	if task == nil {
		return fallback
	}
	return fmt.Sprintf(format, task.Title)
}

func appendPrintableInput(current string, key tea.KeyMsg) (string, bool) {
	if key.Type != tea.KeyRunes || key.Alt {
		return current, false
	}
	return current + string(key.Runes), true
}

func trimLastRune(value string) string {
	if value == "" {
		return ""
	}
	runes := []rune(value)
	return string(runes[:len(runes)-1])
}

func wrapIndex(currentIndex, optionCount, delta int) int {
	if optionCount <= 1 {
		return 0
	}
	nextIndex := currentIndex + delta
	if nextIndex < 0 {
		return optionCount - 1
	}
	if nextIndex >= optionCount {
		return 0
	}
	return nextIndex
}

func toggleID(ids []string, id string) []string {
	if slices.Contains(ids, id) {
		next := make([]string, 0, len(ids)-1)
		for _, current := range ids {
			if current != id {
				next = append(next, current)
			}
		}
		return next
	}
	return append(append([]string{}, ids...), id)
}

func copyNonEmptyIDs(ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	return append([]string{}, ids...)
}
