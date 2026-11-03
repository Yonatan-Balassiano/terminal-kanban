package tui

import (
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// familyModel is a parent card with a subtask and a grandchild, each with one
// open PR, plus a subtask branch that has no PR yet.
func familyModel() *Model {
	model := branchPRModelWithSubtask(oneOpenBranch("branch-a", "repo-a", 11), oneOpenBranch("branch-c", "repo-a", 33))
	model.tasks[1].Branches = append(model.tasks[1].Branches, TaskBranchRecord{
		ID: "branch-bare", TaskID: "task-2", RepoID: "repo-a", BranchName: "feat/bare", PRState: "none",
	})
	grandchild := oneOpenBranch("branch-g", "repo-b", 44)
	stampBranchTaskID(grandchild, "task-3")
	model.tasks = append(model.tasks, TaskRecord{
		ID: "task-3", Title: "Nested follow-up", TrackID: "in-progress", SortKey: 3, RepoID: "repo-b",
		ParentTaskID: "task-2", Branches: grandchild,
	})
	return model
}

func detailRowIDs(rows []detailRow) []string {
	ids := []string{}
	for _, row := range rows {
		if row.Kind == detailRowClaudeArtifact {
			ids = append(ids, "artifact:"+row.Artifact.URL)
		} else {
			ids = append(ids, row.Branch.ID)
		}
	}
	return ids
}

func TestDetailRowsListOwnBranchesThenEverySubtaskPRThenClaudeArtifacts(t *testing.T) {
	model := familyModel()
	model.claudeArtifacts = &claudeArtifactsState{TaskID: "task-1", Result: getTaskArtifactsResult{
		Artifacts: []ClaudeArtifact{{URL: "https://claude.ai/artifact/A", Title: "Plan", TaskID: "task-3"}},
	}}

	got := strings.Join(detailRowIDs(model.detailRows(model.tasks[0])), ",")

	// Grandchild included; the subtask's PR-less branch is not.
	if want := "branch-a,branch-c,branch-g,artifact:https://claude.ai/artifact/A"; got != want {
		t.Fatalf("detailRows = %s, want %s", got, want)
	}
}

// Another card's list must never show under this one, however late it arrives.
func TestClaudeArtifactsReplyForAnotherCardIsDropped(t *testing.T) {
	model := familyModel()
	model.claudeArtifacts = &claudeArtifactsState{TaskID: "task-2", Loading: true}

	model.applyClaudeArtifacts(claudeArtifactsLoadedMsg{taskID: "task-1", result: getTaskArtifactsResult{
		Artifacts: []ClaudeArtifact{{URL: "https://claude.ai/artifact/A"}},
	}})

	if len(model.claudeArtifactsFor("task-1").Result.Artifacts) != 0 || !model.claudeArtifacts.Loading {
		t.Fatalf("claudeArtifacts = %+v, want the stale reply ignored", model.claudeArtifacts)
	}
}

func TestFailedRefreshKeepsTheLastListAndSaysWhy(t *testing.T) {
	model := familyModel()
	model.claudeArtifacts = &claudeArtifactsState{TaskID: "task-1", Result: getTaskArtifactsResult{
		Artifacts: []ClaudeArtifact{{URL: "https://claude.ai/artifact/A"}},
	}}

	model.applyClaudeArtifacts(claudeArtifactsLoadedMsg{taskID: "task-1", err: errors.New("daemon gone")})

	if len(model.claudeArtifacts.Result.Artifacts) != 1 {
		t.Fatalf("claudeArtifacts = %+v, want the previous list kept", model.claudeArtifacts)
	}
	if note := claudeArtifactsNote(model, model.tasks[0]); !strings.Contains(note, "daemon gone") {
		t.Fatalf("note = %q, want the error", note)
	}
}

func TestDetailPaneNamesTheSubtaskAndListsClaudeArtifacts(t *testing.T) {
	model := familyModel()
	model.claudeArtifacts = &claudeArtifactsState{TaskID: "task-1", Result: getTaskArtifactsResult{
		Artifacts: []ClaudeArtifact{{URL: "https://claude.ai/artifact/A", Title: "Theme plan", Versions: 2, TaskID: "task-3"}},
	}}

	plain := ansiPattern.ReplaceAllString(strings.Join(detailPaneLines(model, model.tasks[0], 30, 90), "\n"), "")

	for _, want := range []string{"#33", "↳ Extracted helper", "#44", "↳ Nested follow-up", "CLAUDE ARTIFACTS 1", "Theme plan", "v2"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("detail pane = %q, want it to contain %q", plain, want)
		}
	}
}

// E from the pane acts on the PR the pane has selected, even a subtask's.
func TestPRActionsFromThePaneStartOnTheSelectedRow(t *testing.T) {
	model := familyModel()
	model.toggleDetailPane()
	model.moveDetailBranchSelection(2) // branch-g, the grandchild's PR

	model.handleDetailPaneKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("E")})

	if model.branchPRListModal == nil {
		t.Fatalf("PR picker did not open")
	}
	if got := model.branchPRListBranches()[model.branchPRListModal.Index].ID; got != "branch-g" {
		t.Fatalf("picker selected %s, want branch-g", got)
	}
}

// On the card's own branch, o keeps its board meaning (dev portal first).
func TestOpenOnTheCardsOwnBranchFallsThroughToTheBoard(t *testing.T) {
	model := familyModel()
	model.toggleDetailPane()

	if _, handled := model.handleDetailPaneKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("o")}); handled {
		t.Fatalf("o on the card's own branch was claimed by the pane")
	}
	model.moveDetailBranchSelection(1)
	if _, handled := model.handleDetailPaneKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("o")}); !handled {
		t.Fatalf("o on a subtask's PR was not handled by the pane")
	}
}

func TestParentCardSummarisesItsSubtasksPRs(t *testing.T) {
	model := familyModel()
	model.tasks[2].Branches[0].PRState = "merged"

	if got, want := model.subtaskPRRollupLine(model.tasks[0]), "↳ 2 subtask PRs · 1/2 merged"; got != want {
		t.Fatalf("rollup = %q, want %q", got, want)
	}
	if got := model.subtaskPRRollupLine(model.tasks[2]); got != "" {
		t.Fatalf("rollup for a card with no subtasks = %q, want none", got)
	}
}

// The height mirror must count the rollup line, or column scrolling drifts.
func TestCardHeightCountsTheSubtaskPRRollup(t *testing.T) {
	model := familyModel()
	for _, task := range model.tasks {
		want := lipgloss.Height(renderTaskCard(model, task, false, false, nil, "web5-poc"))
		if got := taskCardHeightForWidth(model, task, taskCardContentWidth, false); got != want {
			t.Fatalf("%s: taskCardHeightForWidth() = %d, rendered card is %d lines", task.ID, got, want)
		}
	}
}
