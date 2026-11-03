package tui

import (
	"fmt"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// The PR pane shows a card's whole family: its own branches, every PR its
// subtasks opened (at any depth), and the claude.ai Artifacts all of their
// sessions published. "Claude artifact" throughout, never bare "artifact":
// in this TUI that word already means a deploy artifact (the rollout rail).

// claudeArtifactsRefreshInterval bounds how stale the pane's list may get.
// Artifacts change only when an agent publishes one, and the daemon answers
// from a per-transcript cache, so this is a cheap call.
const claudeArtifactsRefreshInterval = 30 * time.Second

// ClaudeArtifact mirrors TaskArtifact in src/types/index.ts.
type ClaudeArtifact struct {
	URL              string `json:"url"`
	Title            string `json:"title"`
	Icon             string `json:"icon"`
	Description      string `json:"description"`
	Versions         int    `json:"versions"`
	FirstPublishedAt int64  `json:"firstPublishedAt"`
	LastPublishedAt  int64  `json:"lastPublishedAt"`
	// The card whose session published it: the pane's card or one of its subtasks.
	TaskID string `json:"taskId"`
}

type getTaskArtifactsResult struct {
	Artifacts     []ClaudeArtifact `json:"artifacts"`
	RemoteTaskIDs []string         `json:"remoteTaskIds"`
}

type claudeArtifactsLoadedMsg struct {
	taskID string
	result getTaskArtifactsResult
	err    error
}

// claudeArtifactsState is the pane's list for one card. Kept per card id so
// a reply that lands after the selection moved on is recognisably stale.
type claudeArtifactsState struct {
	TaskID   string
	Result   getTaskArtifactsResult
	Err      error
	LoadedAt time.Time
	Loading  bool
}

// descendantTaskIDs is every card below taskID at any depth, parents before
// their subtasks. The seen set makes a parent cycle terminate.
func (m *Model) descendantTaskIDs(taskID string) []string {
	out := []string{}
	seen := map[string]bool{taskID: true}
	for index := -1; index < len(out); index++ {
		parentID := taskID
		if index >= 0 {
			parentID = out[index]
		}
		for _, task := range m.tasks {
			if task.ParentTaskID == parentID && !seen[task.ID] {
				seen[task.ID] = true
				out = append(out, task.ID)
			}
		}
	}
	return out
}

// subtaskPRBranches is every PR its subtasks opened, at any depth — the
// branches a parent card's own row cannot otherwise show.
func (m *Model) subtaskPRBranches(task TaskRecord) []TaskBranchRecord {
	branches := []TaskBranchRecord{}
	for _, id := range m.descendantTaskIDs(task.ID) {
		if child := m.taskByID(id); child != nil {
			for _, branch := range child.Branches {
				if branch.PRNumber != nil && branch.PRState != "" && branch.PRState != "none" {
					branches = append(branches, branch)
				}
			}
		}
	}
	return branches
}

type detailRowKind int

const (
	detailRowBranch detailRowKind = iota
	detailRowClaudeArtifact
)

// detailRow is one selectable line pair in the PR pane: a branch (the card's
// own or a subtask's) or a Claude artifact.
type detailRow struct {
	Kind     detailRowKind
	Branch   TaskBranchRecord
	Artifact ClaudeArtifact
}

// detailRows is what the PR pane lists for task, in order. The branches are
// exactly the E picker's, so the pane's selection carries over into it.
func (m *Model) detailRows(task TaskRecord) []detailRow {
	rows := []detailRow{}
	for _, branch := range m.branchPRListBranchesFor(&task) {
		rows = append(rows, detailRow{Kind: detailRowBranch, Branch: branch})
	}
	for _, artifact := range m.claudeArtifactsFor(task.ID).Result.Artifacts {
		rows = append(rows, detailRow{Kind: detailRowClaudeArtifact, Artifact: artifact})
	}
	return rows
}

func (m *Model) claudeArtifactsFor(taskID string) claudeArtifactsState {
	if m.claudeArtifacts != nil && m.claudeArtifacts.TaskID == taskID {
		return *m.claudeArtifacts
	}
	return claudeArtifactsState{TaskID: taskID}
}

func (m *Model) selectedDetailRow() (detailRow, bool) {
	task := m.selectedTask()
	if task == nil {
		return detailRow{}, false
	}
	rows := m.detailRows(*task)
	if len(rows) == 0 {
		return detailRow{}, false
	}
	return rows[clamp(m.detailBranchIndex, 0, len(rows)-1)], true
}

// maybeFetchClaudeArtifactsCmd loads the pane's list when the pane is open on
// a card whose list is missing or older than the refresh interval. Called
// after every message, so opening the pane or moving to another card fetches
// at once, and the session poll keeps an open pane fresh.
func (m *Model) maybeFetchClaudeArtifactsCmd() tea.Cmd {
	if !m.detailPaneVisible || m.client == nil {
		return nil
	}
	task := m.selectedTask()
	if task == nil {
		return nil
	}
	current := m.claudeArtifacts
	if current != nil && current.TaskID == task.ID &&
		(current.Loading || time.Since(current.LoadedAt) < claudeArtifactsRefreshInterval) {
		return nil
	}
	if current == nil || current.TaskID != task.ID {
		m.claudeArtifacts = &claudeArtifactsState{TaskID: task.ID}
	}
	m.claudeArtifacts.Loading = true
	taskID := task.ID
	client := m.client
	return func() tea.Msg {
		var result getTaskArtifactsResult
		err := client.Call("getTaskArtifacts", map[string]interface{}{"taskId": taskID, "includeSubtasks": true}, &result)
		return claudeArtifactsLoadedMsg{taskID: taskID, result: result, err: err}
	}
}

func (m *Model) applyClaudeArtifacts(msg claudeArtifactsLoadedMsg) {
	if m.claudeArtifacts == nil || m.claudeArtifacts.TaskID != msg.taskID {
		return // The pane moved to another card while this was in flight.
	}
	m.claudeArtifacts.Loading = false
	m.claudeArtifacts.LoadedAt = time.Now()
	m.claudeArtifacts.Err = msg.err
	if msg.err == nil {
		m.claudeArtifacts.Result = msg.result
	}
}

func (m *Model) openClaudeArtifactCmd(artifact ClaudeArtifact) tea.Cmd {
	url := artifact.URL
	return func() tea.Msg {
		if err := openExternal(url); err != nil {
			return asyncErrorMsg{err: err}
		}
		return boardActionMsg{status: "Opened browser."}
	}
}

// openSelectedDetailRowCmd opens whatever the pane has selected: the PR of a
// branch row, or the page of a Claude artifact row.
func (m *Model) openSelectedDetailRowCmd(checks bool) tea.Cmd {
	row, ok := m.selectedDetailRow()
	if !ok {
		return nil
	}
	if row.Kind == detailRowClaudeArtifact {
		if checks {
			m.statusMessage = "A Claude artifact has no checks; Enter opens it."
			return nil
		}
		return m.openClaudeArtifactCmd(row.Artifact)
	}
	return m.openBranchPRCmd(row.Branch, checks)
}

// isOwnBranchRow is true for a branch of the selected card itself, as opposed
// to a subtask's PR or a Claude artifact.
func (m *Model) isOwnBranchRow(row detailRow) bool {
	task := m.selectedTask()
	return row.Kind == detailRowBranch && task != nil && (row.Branch.TaskID == "" || row.Branch.TaskID == task.ID)
}

// subtaskPRRollupLine is the parent card's one-line summary of its subtasks'
// PRs, or "" when they have none.
func (m *Model) subtaskPRRollupLine(task TaskRecord) string {
	branches := m.subtaskPRBranches(task)
	if len(branches) == 0 {
		return ""
	}
	merged, failing := 0, 0
	for _, branch := range branches {
		switch {
		case branch.PRState == "merged":
			merged++
		case branch.CIState == "failed":
			failing++
		}
	}
	noun := "PRs"
	if len(branches) == 1 {
		noun = "PR"
	}
	line := fmt.Sprintf("↳ %d subtask %s · %d/%d merged", len(branches), noun, merged, len(branches))
	if failing > 0 {
		line += fmt.Sprintf(" · %d ✗", failing)
	}
	return line
}
