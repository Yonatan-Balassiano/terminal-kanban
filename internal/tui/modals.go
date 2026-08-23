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
	createTaskTitleLine    createTaskLine = "title"
	createTaskRepoLine     createTaskLine = "repo"
	createTaskPillarLine   createTaskLine = "pillar"
	createTaskAgentLine    createTaskLine = "agent"
	createTaskLocationLine createTaskLine = "location"
	createTaskBlockedLine  createTaskLine = "blocked"

	filterRepoColumn   filterColumn = "repo"
	filterPillarColumn filterColumn = "pillar"

	// Typed in full before Enter does anything, so no single keypress can ship
	// an artifact to production.
	artifactRolloutConfirmWord = "GA"
)

// ModalBranchPRList is declared here rather than with the other ModalType values
// because types.go is a frozen contract shared with the daemon; a modal is TUI
// state that never crosses the socket.
const ModalBranchPRList ModalType = "branch-pr-list"

// gradual_safer leads because it is the slower, more reversible rollout.
var artifactGradualityOptions = []string{"gradual_safer", "gradual_quicker"}

func artifactGradualityAt(index int) string {
	return artifactGradualityOptions[clamp(index, 0, len(artifactGradualityOptions)-1)]
}

// Built from the modal's own snapshot rather than the live catalog: the version
// the user read and confirmed is the only version allowed to reach production.
func artifactRolloutParams(state artifactRolloutModalState) map[string]string {
	return map[string]string{
		"name":          state.Name,
		"targetVersion": state.TargetVersion,
		"graduality":    artifactGradualityAt(state.GradualityIndex),
	}
}

type createTaskModalState struct {
	Value         string
	RepoIndex     int
	PillarIndex   int
	AgentIndex    int
	LocationIndex int
	ActiveLine    createTaskLine
}

type renameTaskModalState struct {
	TaskID string
	Value  string
}

type setBranchModalState struct {
	TaskID string
	Value  string
}

type taskDescriptionModalState struct {
	TaskID string
	Value  string
}

type prCommentModalState struct {
	TaskID string
	// Set when the composer was opened from the PR picker. Empty means the old
	// card-level path, which only a single-branch card can still take.
	BranchID string
	Value    string
}

// branchPRListModalState is the PR picker: which card's PRs, and which one the
// next action lands on.
type branchPRListModalState struct {
	TaskID string
	Index  int
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

type aiChatModalState struct {
	Input         string
	Transcript    []ChatMessage
	Executions    []ChatToolExecution
	LastError     string
	Pending       bool
	PendingPrompt string
}

type artifactRolloutModalState struct {
	Name string
	// Snapshotted at open time so a newly landed RC can never be shipped by
	// surprise between reading the modal and confirming it.
	CurrentVersion string
	TargetVersion  string
	// Informational only — ownership never gates the confirmation.
	PendingRcCount  *int
	MyPendingCount  *int
	GradualityIndex int
	Confirm         string
	// Set when the rollout was opened from a card, naming what it ships so the
	// confirmation is about the user's own change rather than a bare version.
	ShippingCard string
}

type teleportConfirmModalState struct {
	TaskID    string
	TaskTitle string
	Direction string
	// True until the preflight reply arrives; y is refused meanwhile so a fast
	// double-press cannot confirm a teleport before its checks are even read.
	Loading bool
	Checks  []DoctorCheck
	// Set only when the preflight call itself failed — a dead daemon, say —
	// as opposed to a normal check reporting fail in Checks.
	Error string
}

type createTaskPillarOption struct {
	ID    string
	Label string
}

type createTaskAgentOption struct {
	Value AgentCLI
	Label string
}

type createTaskLocationOption struct {
	Value string
	Label string
}

type filterOption struct {
	ID    string
	Label string
}

var createTaskAgentOptions = []createTaskAgentOption{
	{Value: AgentCLI("claude"), Label: "Claude"},
	{Value: AgentCLI("codex"), Label: "Codex"},
}

func createTaskAgentOptionAt(index int) createTaskAgentOption {
	return createTaskAgentOptions[clamp(index, 0, len(createTaskAgentOptions)-1)]
}

var createTaskLocationOptions = []createTaskLocationOption{
	{Value: TaskLocationLocal, Label: "Local"},
	{Value: TaskLocationRemote, Label: "Remote"},
}

// createTaskRepoOption is one entry on the create-task modal's Repo line. The
// last entry is always the repo-less "General" choice, which is why the modal
// counts these instead of m.repos.
type createTaskRepoOption struct {
	// Empty for the General option.
	ID              string
	Label           string
	DefaultPillarID string
	RemotePath      string
	IsGeneral       bool
}

// createTaskRepoOptions lists every repo plus the standalone "General" card,
// which needs no repo, branch, or worktree.
func (m *Model) createTaskRepoOptions() []createTaskRepoOption {
	options := make([]createTaskRepoOption, 0, len(m.repos)+1)
	for _, repo := range m.repos {
		options = append(options, createTaskRepoOption{
			ID:              repo.ID,
			Label:           repo.Label,
			DefaultPillarID: repo.DefaultPillarID,
			RemotePath:      repo.RemotePath,
		})
	}
	return append(options, createTaskRepoOption{Label: "General (no repo)", IsGeneral: true})
}

func (m *Model) createTaskRepoOptionAt(index int) createTaskRepoOption {
	options := m.createTaskRepoOptions()
	return options[clamp(index, 0, len(options)-1)]
}

func createTaskLocationOptionAt(index int) createTaskLocationOption {
	return createTaskLocationOptions[clamp(index, 0, len(createTaskLocationOptions)-1)]
}

// repoSupportsRemote reports whether the repo at repoIndex has a checkout on the
// remote host. Without one there is nowhere for a remote task to run. A general
// task has no checkout anywhere, so it always runs locally.
func (m *Model) repoSupportsRemote(repoIndex int) bool {
	if len(m.repos) == 0 {
		return false
	}
	option := m.createTaskRepoOptionAt(repoIndex)
	return !option.IsGeneral && option.RemotePath != ""
}

// createTaskLocationAt resolves the effective location for the modal. It is derived
// rather than stored so that switching repos re-evaluates the choice on its own.
func (m *Model) createTaskLocationAt(repoIndex, locationIndex int) createTaskLocationOption {
	if !m.repoSupportsRemote(repoIndex) {
		return createTaskLocationOptions[0]
	}
	return createTaskLocationOptionAt(locationIndex)
}

func (m *Model) createTaskLocationLabelAt(repoIndex, locationIndex int) string {
	if m.createTaskRepoOptionAt(repoIndex).IsGeneral {
		return createTaskLocationOptions[0].Label + " (general tasks are local)"
	}
	if !m.repoSupportsRemote(repoIndex) {
		return createTaskLocationOptions[0].Label + " (no remote configured)"
	}
	return createTaskLocationOptionAt(locationIndex).Label
}

func (m *Model) closeModal() {
	m.modal = ModalNone
	m.focus = FocusBoard
	m.createTaskModal = nil
	m.renameTaskModal = nil
	m.setBranchModal = nil
	m.taskDescriptionModal = nil
	m.prCommentModal = nil
	m.deleteConfirmModal = nil
	m.createPillarModal = nil
	m.deletePillarConfirmModal = nil
	m.pillarPickerModal = nil
	m.filterModal = nil
	m.viewModal = nil
	m.commandPaletteModal = nil
	m.aiChatModal = nil
	m.artifactRolloutModal = nil
	m.artifactListModal = nil
	m.branchPRListModal = nil
	m.teleportConfirmModal = nil
}

func (m *Model) openHelpModal() {
	m.closeModal()
	m.modal = ModalHelp
	m.focus = FocusModal
}

func (m *Model) openCreateTaskModal() {
	// Follow the board's current scope, including the general one — creating a
	// card while looking at general tasks should default to a general card.
	initialRepoIndex := 0
	if m.isGeneralScope() {
		initialRepoIndex = len(m.repos)
	} else if m.activeRepoID != "" {
		for index, repo := range m.repos {
			if repo.ID == m.activeRepoID {
				initialRepoIndex = index
				break
			}
		}
	}

	pillarOptions := m.createTaskPillarOptions()
	initialPillarIndex := 0
	if defaultPillarID := m.createTaskRepoOptionAt(initialRepoIndex).DefaultPillarID; defaultPillarID != "" {
		for index, option := range pillarOptions {
			if option.ID == defaultPillarID {
				initialPillarIndex = index
				break
			}
		}
	}

	m.closeModal()
	m.modal = ModalCreateTask
	m.focus = FocusModal
	m.createTaskModal = &createTaskModalState{
		RepoIndex:     initialRepoIndex,
		PillarIndex:   initialPillarIndex,
		AgentIndex:    0,
		LocationIndex: 0,
		ActiveLine:    createTaskTitleLine,
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

func (m *Model) openSetBranchModal(task *TaskRecord) {
	if task == nil {
		m.statusMessage = "Select a task to change its branch."
		return
	}
	if task.IsGeneral() {
		m.statusMessage = "General tasks have no repo, so there is no branch to set."
		return
	}
	m.closeModal()
	m.modal = ModalSetBranch
	m.focus = FocusModal
	m.setBranchModal = &setBranchModalState{
		TaskID: task.ID,
		Value:  task.BranchName,
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

// openBranchPRCommentModal composes a comment aimed at one branch's PR, so the
// picker can offer 'j' on a card whose card-level PR is deliberately nil.
func (m *Model) openBranchPRCommentModal(taskID string, branch TaskBranchRecord) {
	if blocker := getBranchPRCommentBlockerReason(branch); blocker != "" {
		m.statusMessage = blocker
		return
	}
	m.closeModal()
	m.modal = ModalPRComment
	m.focus = FocusModal
	m.prCommentModal = &prCommentModalState{TaskID: taskID, BranchID: branch.ID}
}

// openBranchPRListModal opens the PR picker. It opens for a single-branch card
// too: the point is one place that always answers "which PRs does this card
// have", not a screen that only appears once things are complicated.
func (m *Model) openBranchPRListModal(task *TaskRecord) {
	if task == nil {
		m.statusMessage = "Select a card to list its PRs."
		return
	}
	if len(task.Branches) == 0 {
		m.statusMessage = "This card has no tracked branch yet."
		return
	}
	m.closeModal()
	m.modal = ModalBranchPRList
	m.focus = FocusModal
	m.branchPRListModal = &branchPRListModalState{TaskID: task.ID}
}

// ModalArtifactList is the editor for which artifacts the rail tracks. Declared
// here rather than in types.go so the whole feature stays in one file.
const ModalArtifactList ModalType = "artifact-list"

// artifactListModalState edits the tracked-artifact list.
//
// Holds its own copy of the names so an accidental keystroke is not applied to
// the running rail — nothing leaves here until the user confirms.
type artifactListModalState struct {
	Names    []string
	Selected int
	// Non-empty while typing a new artifact id.
	Draft    string
	Adding   bool
	Error    string
	Applying bool
	// True until the configured list arrives; edits are refused meanwhile so
	// the reply cannot overwrite something the user has already typed.
	Loading bool
}

// openArtifactListModal edits which artifacts the rail tracks.
//
// The list lives in config.json, which meant adding one needed a text editor and
// a daemon restart — and until then a merged card touching that artifact read as
// "nothing to ship".
//
// It opens on the configured list rather than the rail's rows. Those are not the
// same list: the rail carries only what devex resolved, and it is empty outright
// for the moment after a save while the refresh is still in flight. Seeding from
// it silently dropped artifacts the editor then deleted from the config on the
// next save.
func (m *Model) openArtifactListModal() tea.Cmd {
	m.closeModal()
	m.artifactListModal = &artifactListModalState{Loading: true}
	m.modal = ModalArtifactList
	m.focus = FocusModal
	return m.fetchTrackedArtifactsCmd()
}

func (m *Model) handleArtifactListModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.artifactListModal
	if state == nil {
		m.closeModal()
		return nil
	}

	// Nothing may be edited or saved before the real list lands, or a save would
	// write a list the user never saw.
	if state.Loading {
		if key.String() == "esc" || key.String() == "q" {
			m.closeModal()
		}
		return nil
	}

	if state.Adding {
		switch key.String() {
		case "esc":
			state.Adding = false
			state.Draft = ""
			return nil
		case "enter":
			name := strings.TrimSpace(state.Draft)
			if name == "" {
				state.Adding = false
				return nil
			}
			for _, existing := range state.Names {
				if existing == name {
					state.Error = "Already tracked: " + name
					state.Adding = false
					state.Draft = ""
					return nil
				}
			}
			state.Names = append(state.Names, name)
			state.Selected = len(state.Names) - 1
			state.Adding = false
			state.Draft = ""
			state.Error = ""
			return nil
		case "backspace":
			state.Draft = trimLastRune(state.Draft)
			return nil
		default:
			if next, ok := appendPrintableInput(state.Draft, key); ok {
				state.Draft = next
			}
			return nil
		}
	}

	switch key.String() {
	case "esc", "q":
		m.closeModal()
		return nil
	case "up", "k":
		if state.Selected > 0 {
			state.Selected--
		}
		return nil
	case "down", "j":
		if state.Selected < len(state.Names)-1 {
			state.Selected++
		}
		return nil
	case "a", "n":
		state.Adding = true
		state.Draft = ""
		state.Error = ""
		return nil
	case "d", "x":
		if len(state.Names) == 0 {
			return nil
		}
		state.Names = append(state.Names[:state.Selected], state.Names[state.Selected+1:]...)
		if state.Selected >= len(state.Names) && state.Selected > 0 {
			state.Selected--
		}
		state.Error = ""
		return nil
	case "enter":
		state.Applying = true
		return m.setTrackedArtifactsCmd(state.Names)
	}

	return nil
}

// openArtifactRolloutModal ships the selected card's change if it has one to
// ship, and otherwise falls back to the artifact selected in the footer.
//
// A card in `rc-built` already knows the exact artifact and version that carry
// its change; making the user find that artifact in the footer and work out the
// version by hand was the missing half of answering "has it shipped yet".
func (m *Model) openArtifactRolloutModal() {
	if state := m.cardRolloutState(); state != nil {
		m.closeModal()
		m.modal = ModalArtifactRollout
		m.focus = FocusModal
		m.artifactRolloutModal = state
		return
	}

	artifact := m.selectedArtifact()
	if artifact == nil {
		m.statusMessage = "No artifact to roll out."
		return
	}
	if blocker := artifactRolloutBlockerReason(*artifact); blocker != "" {
		m.statusMessage = blocker
		return
	}
	m.closeModal()
	m.modal = ModalArtifactRollout
	m.focus = FocusModal
	m.artifactRolloutModal = &artifactRolloutModalState{
		Name:           artifact.Name,
		CurrentVersion: artifact.GAVersion,
		TargetVersion:  artifact.LatestRCVersion,
		PendingRcCount: artifact.PendingRcCount,
		MyPendingCount: artifact.MyPendingCount,
	}
}

// cardRolloutState describes the rollout that would ship the selected card.
//
// Returns nil whenever the card has nothing to ship, so `G` keeps its original
// meaning everywhere else rather than becoming context-dependent guesswork.
//
// The target is the release candidate that carries this card's change, not the
// newest one: rolling out further would ship work the user never looked at.
func (m *Model) cardRolloutState() *artifactRolloutModalState {
	task := m.selectedTask()
	if task == nil || task.Release == nil {
		return nil
	}

	release := task.Release
	// Only a built-but-unshipped candidate can be promoted. `rolling-out` is
	// already on its way, and the earlier stages have no version yet.
	if release.Stage != "rc-built" {
		return nil
	}
	if release.BlockingArtifactName == "" || release.BlockingRcVersion == "" {
		return nil
	}

	state := &artifactRolloutModalState{
		Name: release.BlockingArtifactName,
		// Snapshotted, like the footer path: the version shipped is the one the
		// user read, even if a newer candidate lands while the modal is open.
		CurrentVersion: release.BlockingGaVersion,
		TargetVersion:  release.BlockingRcVersion,
		ShippingCard:   task.Title,
	}

	// Ownership counts come from the catalog, which the card summary does not
	// carry; showing them keeps the modal identical either way it was opened.
	for _, artifact := range m.artifacts.Artifacts {
		if artifact.Name == release.BlockingArtifactName {
			state.PendingRcCount = artifact.PendingRcCount
			state.MyPendingCount = artifact.MyPendingCount
			break
		}
	}

	return state
}

// Only a drifting artifact has an RC ahead of GA to promote; anything else would
// be a production deploy with nothing to deploy.
func artifactRolloutBlockerReason(artifact ArtifactRecord) string {
	name := artifactDisplayName(artifact)
	switch artifact.Status {
	case ArtifactStatusDrift:
		if artifact.LatestRCVersion == "" {
			return name + " has no RC version to roll out."
		}
		return ""
	case ArtifactStatusInSync:
		return name + " is already in sync."
	case ArtifactStatusNoGA:
		return name + " never goes GA, so there is nothing to roll out."
	default:
		return name + " has an unknown release state, so it cannot be rolled out."
	}
}

// teleportDirectionFor is which way a teleport would move task — the direction
// follows entirely from where it already is, never a choice offered here.
func teleportDirectionFor(task *TaskRecord) string {
	if task.Location == TaskLocationRemote {
		return TeleportDirectionRemoteToLocal
	}
	return TeleportDirectionLocalToRemote
}

func (m *Model) openTeleportModal(task *TaskRecord) tea.Cmd {
	if task == nil || task.IsGeneral() {
		return nil
	}
	direction := teleportDirectionFor(task)
	m.closeModal()
	m.modal = ModalTeleportConfirm
	m.focus = FocusModal
	m.teleportConfirmModal = &teleportConfirmModalState{
		TaskID:    task.ID,
		TaskTitle: task.Title,
		Direction: direction,
		Loading:   true,
	}
	return m.fetchTeleportPreflightCmd(task.ID, direction)
}

// teleportBlocked reports whether any preflight check failed outright — the
// same bar teleportTask itself gates on, so confirming here can never race a
// call the daemon was always going to refuse.
func teleportBlocked(checks []DoctorCheck) bool {
	for _, check := range checks {
		if check.Status == "fail" {
			return true
		}
	}
	return false
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

func (m *Model) openAIChatModal() {
	m.closeModal()
	m.modal = ModalAIChat
	m.focus = FocusModal
	m.aiChatModal = &aiChatModalState{}
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
	case ModalSetBranch:
		return m.handleSetBranchModalKey(key)
	case ModalTaskDescription:
		return m.handleTaskDescriptionModalKey(key)
	case ModalPRComment:
		return m.handlePRCommentModalKey(key)
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
	case ModalAIChat:
		return m.handleAIChatModalKey(key)
	case ModalArtifactList:
		return m.handleArtifactListModalKey(key)
	case ModalArtifactRollout:
		return m.handleArtifactRolloutModalKey(key)
	case ModalTeleportConfirm:
		return m.handleTeleportConfirmModalKey(key)
	case ModalBranchPRList:
		return m.handleBranchPRListModalKey(key)
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
		repo := m.createTaskRepoOptionAt(state.RepoIndex)
		pillarID := ""
		options := m.createTaskPillarOptions()
		if len(options) > 0 {
			pillarID = options[clamp(state.PillarIndex, 0, len(options)-1)].ID
		}
		agentCLI := string(createTaskAgentOptionAt(state.AgentIndex).Value)
		location := m.createTaskLocationAt(state.RepoIndex, state.LocationIndex).Value
		if !repo.IsGeneral && repo.ID == "" {
			m.statusMessage = "Add a repo, or pick General, before creating tasks."
			return nil
		}
		kind := TaskKindRepo
		if repo.IsGeneral {
			kind = TaskKindGeneral
		}
		m.closeModal()
		backlogIndex := indexTrack(m.sortedTracks(), "backlog")
		if backlogIndex >= 0 {
			m.selectedTrackIndex = backlogIndex
			m.selectedTaskIndex = 0
		}
		return m.createTaskCmd(title, kind, repo.ID, pillarID, agentCLI, location)
	case tea.KeyUp:
		switch state.ActiveLine {
		case createTaskLocationLine:
			state.ActiveLine = createTaskAgentLine
		case createTaskAgentLine:
			state.ActiveLine = createTaskPillarLine
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
		case createTaskPillarLine:
			state.ActiveLine = createTaskAgentLine
		case createTaskAgentLine:
			state.ActiveLine = createTaskLocationLine
		}
		return nil
	case tea.KeyLeft:
		switch state.ActiveLine {
		case createTaskRepoLine:
			if repoOptionCount := len(m.createTaskRepoOptions()); repoOptionCount > 1 {
				state.RepoIndex = wrapIndex(state.RepoIndex, repoOptionCount, -1)
			}
		case createTaskPillarLine:
			options := m.createTaskPillarOptions()
			if len(options) > 1 {
				state.PillarIndex = wrapIndex(state.PillarIndex, len(options), -1)
			}
		case createTaskAgentLine:
			if len(createTaskAgentOptions) > 1 {
				state.AgentIndex = wrapIndex(state.AgentIndex, len(createTaskAgentOptions), -1)
			}
		case createTaskLocationLine:
			if m.repoSupportsRemote(state.RepoIndex) {
				state.LocationIndex = wrapIndex(state.LocationIndex, len(createTaskLocationOptions), -1)
			}
		}
		return nil
	case tea.KeyRight:
		switch state.ActiveLine {
		case createTaskRepoLine:
			if repoOptionCount := len(m.createTaskRepoOptions()); repoOptionCount > 1 {
				state.RepoIndex = wrapIndex(state.RepoIndex, repoOptionCount, 1)
			}
		case createTaskPillarLine:
			options := m.createTaskPillarOptions()
			if len(options) > 1 {
				state.PillarIndex = wrapIndex(state.PillarIndex, len(options), 1)
			}
		case createTaskAgentLine:
			if len(createTaskAgentOptions) > 1 {
				state.AgentIndex = wrapIndex(state.AgentIndex, len(createTaskAgentOptions), 1)
			}
		case createTaskLocationLine:
			if m.repoSupportsRemote(state.RepoIndex) {
				state.LocationIndex = wrapIndex(state.LocationIndex, len(createTaskLocationOptions), 1)
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
		if repoOptionCount := len(m.createTaskRepoOptions()); state.ActiveLine == createTaskRepoLine && repoOptionCount > 1 {
			state.RepoIndex = wrapIndex(state.RepoIndex, repoOptionCount, -1)
		}
	case "<":
		if repoOptionCount := len(m.createTaskRepoOptions()); state.ActiveLine == createTaskRepoLine && repoOptionCount > 1 {
			state.RepoIndex = wrapIndex(state.RepoIndex, repoOptionCount, -1)
		}
	case ".":
		if repoOptionCount := len(m.createTaskRepoOptions()); state.ActiveLine == createTaskRepoLine && repoOptionCount > 1 {
			state.RepoIndex = wrapIndex(state.RepoIndex, repoOptionCount, 1)
		}
	case ">":
		if repoOptionCount := len(m.createTaskRepoOptions()); state.ActiveLine == createTaskRepoLine && repoOptionCount > 1 {
			state.RepoIndex = wrapIndex(state.RepoIndex, repoOptionCount, 1)
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
		branchID := state.BranchID
		body := strings.TrimSpace(state.Value)
		if body == "" {
			return nil
		}
		task := m.taskByID(taskID)
		branch := m.taskBranchByID(taskID, branchID)
		m.closeModal()
		// A composer opened from the picker keeps its aim even if the board has
		// been resynced underneath it.
		if branchID != "" {
			if branch == nil {
				m.statusMessage = "That PR is no longer on this card."
				return nil
			}
			return m.commentTaskBranchPRCmd(*branch, body)
		}
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

// handleBranchPRListModalKey drives the PR picker. The action keys are the board's
// own — o open, v checks, j comment, m merge — so the picker adds a target rather
// than a new vocabulary.
func (m *Model) handleBranchPRListModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.branchPRListModal
	if state == nil {
		m.closeModal()
		return nil
	}
	branches := m.branchPRListBranches()
	if len(branches) == 0 {
		m.closeModal()
		m.statusMessage = "This card has no tracked branch yet."
		return nil
	}

	state.Index = clamp(state.Index, 0, len(branches)-1)
	selected := branches[state.Index]

	switch key.String() {
	case "esc", "E", "q":
		m.closeModal()
		return nil
	// 'k'/'j' rather than only the arrows: this list is read and acted on in one
	// pass, and 'j' means comment on the board, not "down".
	case "up", "k":
		state.Index = clamp(state.Index-1, 0, len(branches)-1)
		return nil
	case "down":
		state.Index = clamp(state.Index+1, 0, len(branches)-1)
		return nil
	case "o", "enter":
		m.closeModal()
		return m.openBranchPRCmd(selected, false)
	case "v":
		m.closeModal()
		return m.openBranchPRCmd(selected, true)
	case "j":
		m.openBranchPRCommentModal(state.TaskID, selected)
		return nil
	case "m":
		// Stay open when the merge is refused, so the reason can be read against
		// the row it belongs to and another PR picked without reopening.
		if blocker := getBranchMergeBlockerReason(selected); blocker != "" {
			m.statusMessage = blocker
			return nil
		}
		m.closeModal()
		return m.mergeTaskBranchPRCmd(selected)
	}
	return nil
}

// branchPRListBranches re-reads the card's branches on every keypress, so a board
// refresh that drops a branch cannot leave the picker acting on a stale row.
func (m *Model) branchPRListBranches() []TaskBranchRecord {
	if m.branchPRListModal == nil {
		return nil
	}
	task := m.taskByID(m.branchPRListModal.TaskID)
	if task == nil {
		return nil
	}
	return task.Branches
}

func (m *Model) taskBranchByID(taskID, branchID string) *TaskBranchRecord {
	task := m.taskByID(taskID)
	if task == nil || branchID == "" {
		return nil
	}
	for index := range task.Branches {
		if task.Branches[index].ID == branchID {
			return &task.Branches[index]
		}
	}
	return nil
}

func (m *Model) handleArtifactRolloutModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.artifactRolloutModal
	if state == nil {
		m.closeModal()
		return nil
	}

	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyLeft:
		state.GradualityIndex = wrapIndex(state.GradualityIndex, len(artifactGradualityOptions), -1)
		return nil
	case tea.KeyRight:
		state.GradualityIndex = wrapIndex(state.GradualityIndex, len(artifactGradualityOptions), 1)
		return nil
	case tea.KeyEnter:
		if state.Confirm != artifactRolloutConfirmWord {
			m.statusMessage = "Type " + artifactRolloutConfirmWord + " to confirm the production rollout."
			return nil
		}
		params := artifactRolloutParams(*state)
		m.closeModal()
		return m.rolloutArtifactCmd(params)
	case tea.KeyBackspace, tea.KeyDelete:
		state.Confirm = trimLastRune(state.Confirm)
		return nil
	}

	if next, changed := appendPrintableInput(state.Confirm, key); changed {
		state.Confirm = next
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

func (m *Model) handleTeleportConfirmModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.teleportConfirmModal
	if state == nil {
		m.closeModal()
		return nil
	}
	if key.Type == tea.KeyEsc || key.String() == "n" || key.String() == "N" {
		m.closeModal()
		return nil
	}
	if key.String() == "y" || key.String() == "Y" {
		if state.Loading {
			m.statusMessage = "Still checking — wait for the preflight to finish."
			return nil
		}
		if state.Error != "" {
			m.statusMessage = "Preflight failed: " + state.Error
			return nil
		}
		if teleportBlocked(state.Checks) {
			m.statusMessage = "Teleport is blocked — see the failing check above."
			return nil
		}
		taskID, direction := state.TaskID, state.Direction
		m.closeModal()
		m.statusMessage = "Teleporting…"
		return m.teleportTaskCmd(taskID, direction)
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

func (m *Model) handleAIChatModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.aiChatModal
	if state == nil {
		m.closeModal()
		return nil
	}

	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		if state.Pending {
			return nil
		}
		prompt := strings.TrimSpace(state.Input)
		if prompt == "" {
			return nil
		}
		state.LastError = ""
		state.Pending = true
		state.PendingPrompt = prompt
		state.Input = ""
		m.statusMessage = "AI chat is thinking..."
		chat := m.chatTurnCmd(prompt)
		if spin := m.startSpinnerChainCmd(); spin != nil {
			return tea.Batch(chat, spin)
		}
		return chat
	case tea.KeyBackspace, tea.KeyDelete:
		if state.Pending {
			return nil
		}
		state.Input = trimLastRune(state.Input)
		return nil
	}

	if state.Pending {
		return nil
	}

	if next, changed := appendPrintableInput(state.Input, key); changed {
		state.Input = next
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
	case "set-branch":
		m.openSetBranchModal(contextTask)
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
			return m.openSessionCmd(contextTask.ID, false, SessionSlotPrimary)
		}
		return nil
	case "recreate-shell":
		m.closeModal()
		if contextTask != nil {
			return m.openSessionCmd(contextTask.ID, true, SessionSlotPrimary)
		}
		return nil
	case "reconnect-remote":
		m.closeModal()
		if contextTask != nil {
			return m.reconnectSessionCmd(contextTask.ID, SessionSlotPrimary)
		}
		return nil
	case "teleport":
		return m.openTeleportModal(contextTask)
	case "toggle-dual-shell":
		m.closeModal()
		if contextTask != nil {
			return m.toggleDualSessionCmd(contextTask)
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
	case "ai-chat":
		m.openAIChatModal()
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
		{ID: "set-branch", Title: "Change tracked branch", Section: "Task", Detail: detailOrFallback(contextTask, "Change branch for %s", "Change the tracked branch for the current task."), Shortcut: "w", Keywords: []string{"branch", "pr", "switch"}, Disabled: contextTask == nil || contextTask.IsGeneral(), DisabledReason: "Select a repo task to change its branch."},
		{ID: "edit-description", Title: "Edit task description", Section: "Task", Detail: "Open the long-form task description editor.", Shortcut: "Ctrl+D", Keywords: []string{"notes", "description"}, Disabled: contextTask == nil, DisabledReason: "Select a task to edit its description."},
		{ID: "delete-task", Title: "Delete current task", Section: "Task", Detail: "Delete the selected task after confirmation.", Shortcut: "d", Keywords: []string{"remove"}, Disabled: contextTask == nil, DisabledReason: "Select a task to delete it."},
		{ID: "assign-pillar", Title: "Assign pillar", Section: "Task", Detail: "Attach or change the pillar for the current task.", Shortcut: "p", Keywords: []string{"label", "pillar"}, Disabled: contextTask == nil, DisabledReason: "Select a task to assign a pillar."},
		{ID: "create-pillar", Title: "Create pillar", Section: "Task", Detail: "Create a new pillar and optionally assign it to the current task.", Shortcut: "P", Keywords: []string{"new pillar"}},
		{ID: "delete-pillar", Title: "Delete current pillar", Section: "Task", Detail: "Delete the current pillar and every task attached to it.", Shortcut: "D", Keywords: []string{"remove pillar"}, Disabled: contextTask == nil || contextTask.PillarID == "", DisabledReason: "The current task does not have a pillar to delete."},
		{ID: "move-task-left", Title: "Move task left", Section: "Task", Detail: "Move the current task to the previous track.", Shortcut: "[", Keywords: []string{"previous track", "kanban"}, Disabled: contextTask == nil || contextTrackIndex <= 0, DisabledReason: "The current task is already in the first track."},
		{ID: "move-task-right", Title: "Move task right", Section: "Task", Detail: "Move the current task to the next track.", Shortcut: "]", Keywords: []string{"next track", "kanban"}, Disabled: contextTask == nil || contextTrackIndex < 0 || contextTrackIndex >= len(m.sortedTracks())-1, DisabledReason: "The current task is already in the last track."},
		{ID: "open-shell", Title: "Open task shell", Section: "Session", Detail: "Start or attach the session for the current task.", Shortcut: "Enter", Keywords: []string{"terminal", "session", "shell"}, Disabled: contextTask == nil, DisabledReason: "Select a task to open its shell."},
		{ID: "recreate-shell", Title: "Recreate task shell", Section: "Session", Detail: "Recreate the current task shell with the native backend.", Shortcut: "R", Keywords: []string{"terminal", "session", "restart"}, Disabled: contextTask == nil, DisabledReason: "Select a task to recreate its shell."},
		{ID: "reconnect-remote", Title: "Reconnect remote session", Section: "Session", Detail: "Re-link the current card to its remote machine, starting it if it is off.", Shortcut: "Ctrl+R", Keywords: []string{"remote", "ssh", "reattach", "reconnect", "workspace", "coder"}, Disabled: contextTask == nil || contextTask.Location != TaskLocationRemote, DisabledReason: "Reconnect applies to remote tasks."},
		{ID: "teleport", Title: ternaryString(contextTask != nil && contextTask.Location == TaskLocationRemote, "Teleport to local", "Teleport to remote"), Section: "Session", Detail: detailOrFallback(contextTask, "Move %s's live session and working tree to the other host", "Move the current card's live session and working tree to the other host."), Shortcut: "Ctrl+T", Keywords: []string{"remote", "ssh", "move", "teleport", "worktree"}, Disabled: contextTask == nil || contextTask.IsGeneral(), DisabledReason: "General tasks have no repo to teleport."},
		{ID: "toggle-dual-shell", Title: "Toggle dual shell", Section: "Session", Detail: detailOrFallback(contextTask, ternaryString(contextTask != nil && contextTask.SecondarySessionID != "", "Close the lower terminal for %s", "Open a lower dev terminal for %s"), "Open or close the secondary shell for the current task."), Shortcut: "B", Keywords: []string{"terminal", "dual", "secondary", "dev"}, Disabled: contextTask == nil, DisabledReason: "Select a task to toggle its dual shell."},
		{ID: "focus-terminal", Title: "Focus terminal pane", Section: "Session", Detail: "Jump into the embedded terminal pane.", Shortcut: "t", Keywords: []string{"terminal", "pane"}, Disabled: m.activeTaskID == "", DisabledReason: "Open a task shell before focusing the terminal pane."},
		{ID: "fullscreen-terminal", Title: "Expand terminal workspace", Section: "Session", Detail: "Make the terminal take over the workspace.", Shortcut: "z", Keywords: []string{"terminal", "fullscreen", "expand"}, Disabled: m.activeTaskID == "", DisabledReason: "Open a task shell before expanding the terminal."},
		{ID: "open-ide", Title: "Open workspace in IDE", Section: "Workspace", Detail: "Open the current task workspace in the configured IDE.", Shortcut: "i", Keywords: []string{"editor", "workspace"}, Disabled: contextTask == nil, DisabledReason: "Select a task to open its workspace."},
		{ID: "open-workspace", Title: "Reveal workspace", Section: "Workspace", Detail: "Open the current task workspace in Finder or Explorer.", Shortcut: "x", Keywords: []string{"finder", "explorer", "folder"}, Disabled: contextTask == nil, DisabledReason: "Select a task to reveal its workspace."},
		{ID: "create-pr", Title: "Create or ensure pull request", Section: "GitHub", Detail: "Create the PR immediately for the current task branch.", Shortcut: "c", Keywords: []string{"github", "pull request"}, Disabled: contextTask == nil || contextTask.IsGeneral(), DisabledReason: "Select a repo task to create a pull request."},
		{ID: "retry-pushed-pr-creation", Title: "Retry pushed-branch PR creation", Section: "GitHub", Detail: "Restart the background PR creation watcher after a branch push.", Shortcut: "C", Keywords: []string{"github", "pull request", "push", "retry"}, Disabled: contextTask == nil || contextTask.BranchName == "", DisabledReason: "Select a task with a branch to watch for PR creation."},
		{ID: "comment-pr", Title: "Comment on pull request", Section: "GitHub", Detail: "Open a composer and post a comment with gh CLI.", Shortcut: "j", Keywords: []string{"github", "pull request", "comment"}, Disabled: contextTask == nil || !canCommentOnTaskPR(*contextTask), DisabledReason: prActionDisabledReason(contextTask, "The current task does not have an open or draft pull request.")},
		{ID: "open-pr", Title: "Open pull request", Section: "GitHub", Detail: "Open the current task PR in the browser.", Shortcut: "o", Keywords: []string{"github", "browser", "pr"}, Disabled: contextTask == nil || !hasOpenPR(*contextTask), DisabledReason: prActionDisabledReason(contextTask, "The current task does not have an open pull request.")},
		{ID: "open-checks", Title: "Open pull request checks", Section: "GitHub", Detail: "Open CI checks for the current task PR.", Shortcut: "v", Keywords: []string{"github", "checks", "ci"}, Disabled: contextTask == nil || !hasOpenPR(*contextTask), DisabledReason: prActionDisabledReason(contextTask, "The current task does not have an open pull request.")},
		{ID: "merge-pr", Title: "Merge pull request", Section: "GitHub", Detail: "Squash merge the current task PR when it is ready.", Shortcut: "m", Keywords: []string{"github", "merge"}, Disabled: contextTask == nil || !canMergeTask(*contextTask), DisabledReason: prActionDisabledReason(contextTask, "Open PR, approved review, and passing build are required.")},
		{ID: "filters", Title: "Open filters", Section: "View", Detail: "Change repo and pillar filters.", Shortcut: "f", Keywords: []string{"filter", "repo", "pillar"}},
		{ID: "layout", Title: "Change layout", Section: "View", Detail: "Choose the board and terminal layout.", Shortcut: "g", Keywords: []string{"view", "split", "terminal"}},
		{ID: "repo-prev", Title: "Previous repo", Section: "View", Detail: "Switch to the previous repo filter.", Shortcut: ",", Keywords: []string{"repo", "left"}, Disabled: len(m.repos) == 0, DisabledReason: "Add a repo before switching repo scope."},
		{ID: "repo-next", Title: "Next repo", Section: "View", Detail: "Switch to the next repo filter.", Shortcut: ".", Keywords: []string{"repo", "right"}, Disabled: len(m.repos) == 0, DisabledReason: "Add a repo before switching repo scope."},
		{ID: "sync", Title: "Sync now", Section: "System", Detail: "Refresh PR, CI, and review state from GitHub.", Shortcut: "s", Keywords: []string{"refresh", "github"}},
		{ID: "ai-chat", Title: "AI chat", Section: "System", Detail: "Open the local Ollama tool-calling chat modal.", Shortcut: "a/A", Keywords: []string{"assistant", "ollama", "chat", "ai"}},
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

func createTaskParams(title, kind, repoID, pillarID, agentCLI, location string) map[string]interface{} {
	params := map[string]interface{}{
		"title":    title,
		"kind":     kind,
		"agentCli": agentCLI,
		"location": location,
	}
	// A general task carries no repo, so sending an empty repoId would only give
	// the daemon something to reject.
	if repoID != "" {
		params["repoId"] = repoID
	}
	if pillarID != "" {
		params["pillarId"] = pillarID
	}
	return params
}

func (m *Model) createTaskCmd(title, kind, repoID, pillarID, agentCLI, location string) tea.Cmd {
	status := "Created task."
	if kind == TaskKindGeneral {
		status = "Created general task."
	}
	return m.boardActionCmd("createTask", createTaskParams(title, kind, repoID, pillarID, agentCLI, location), status)
}

func (m *Model) handleSetBranchModalKey(key tea.KeyMsg) tea.Cmd {
	state := m.setBranchModal
	if state == nil {
		m.closeModal()
		return nil
	}
	switch key.Type {
	case tea.KeyEsc:
		m.closeModal()
		return nil
	case tea.KeyEnter:
		branch := strings.TrimSpace(state.Value)
		if branch == "" {
			return nil
		}
		taskID := state.TaskID
		m.closeModal()
		return m.setTaskBranchCmd(taskID, branch)
	case tea.KeyBackspace, tea.KeyDelete:
		state.Value = trimLastRune(state.Value)
		return nil
	}
	if next, changed := appendPrintableInput(state.Value, key); changed {
		state.Value = next
	}
	return nil
}

func (m *Model) setTaskBranchCmd(taskID, branch string) tea.Cmd {
	return m.boardActionCmd("setTaskBranch", map[string]string{"id": taskID, "branchName": branch}, "Branch updated. Syncing...")
}

func (m *Model) renameTaskCmd(taskID, title string) tea.Cmd {
	return m.boardActionCmd("renameTask", map[string]string{"id": taskID, "title": title}, "Renamed task.")
}

func (m *Model) updateTaskDescriptionCmd(taskID, description string) tea.Cmd {
	return m.boardActionCmd("updateTaskDescription", map[string]string{"id": taskID, "description": description}, "Saved task description.")
}

func (m *Model) deleteTaskCmd(taskID string) tea.Cmd {
	if taskID == m.activeTaskID {
		m.clearActiveTerminalState()
	}
	return tea.Batch(
		m.syncSessionUpdateWatchCmd(),
		m.boardActionCmd("deleteTask", map[string]string{"id": taskID}, "Deleted task."),
	)
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

// prActionDisabledReason explains why a card-level PR command is greyed out. A
// multi-PR card is not missing a PR — it has too many for one command to guess
// between — so it gets sent to the picker instead of a misleading "no PR".
func prActionDisabledReason(task *TaskRecord, fallback string) string {
	if task == nil {
		return fallback
	}
	if reason := multiBranchChoiceReason(*task); reason != "" {
		return reason
	}
	return fallback
}

// hasOpenPR answers for the card as a whole, which only means something while
// the card has one branch. With several, the rolled-up state names no PR anyone
// can open, so the card-level actions must stand down and let the picker choose.
func hasOpenPR(task TaskRecord) bool {
	if hasMultipleBranches(task) {
		return false
	}
	return taskPRStatus(task).isOpen()
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
	if key.Alt {
		return current, false
	}
	if key.Type == tea.KeySpace {
		return current + " ", true
	}
	if key.Type != tea.KeyRunes {
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
