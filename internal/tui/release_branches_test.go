package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func openBranch(id string, prNumber int) TaskBranchRecord {
	return TaskBranchRecord{
		ID:         id,
		RepoID:     "repo-" + id,
		BranchName: "feat/" + id,
		PRNumber:   intPtr(prNumber),
		PRState:    "open",
		CIState:    "passed",
	}
}

func branchTask(branches ...TaskBranchRecord) TaskRecord {
	return TaskRecord{
		ID:        "task-1",
		Title:     "Cross-repo feature",
		RepoID:    "repo-1",
		TrackID:   "in-progress",
		SortKey:   1,
		UpdatedAt: 1,
		Branches:  branches,
	}
}

func keyPress(value string) tea.KeyMsg {
	if value == "esc" {
		return tea.KeyMsg{Type: tea.KeyEsc}
	}
	if value == "up" {
		return tea.KeyMsg{Type: tea.KeyUp}
	}
	if value == "down" {
		return tea.KeyMsg{Type: tea.KeyDown}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(value)}
}

func branchBoardModel(task TaskRecord) *Model {
	return &Model{
		width:              200,
		height:             40,
		focus:              FocusBoard,
		tracks:             []TrackRecord{{ID: "in-progress", SortOrder: 1}},
		tasks:              []TaskRecord{task},
		selectedTrackIndex: 0,
		selectedTaskIndex:  0,
	}
}

// A branch merged on a card whose release the daemon never resolved must not be
// drawn as shipped or as building. "✓" is the whole truth there.
func TestMergedBranchWithoutReleaseInfoClaimsNothingAboutProduction(t *testing.T) {
	branch := TaskBranchRecord{PRState: "merged", PRNumber: intPtr(1)}

	if got := taskBranchGlyph(branch, nil); got != branchGlyphMerged {
		t.Fatalf("glyph = %q, want %q", got, branchGlyphMerged)
	}
}

func TestTaskBranchGlyphNamesWhatTheBranchNeeds(t *testing.T) {
	cases := []struct {
		name    string
		branch  TaskBranchRecord
		release *TaskReleaseSummary
		want    string
	}{
		{
			name:    "shipped",
			branch:  TaskBranchRecord{PRState: "merged"},
			release: &TaskReleaseSummary{Stage: "ga"},
			want:    branchGlyphShipped,
		},
		{
			name:    "built but not shipped",
			branch:  TaskBranchRecord{PRState: "merged"},
			release: &TaskReleaseSummary{Stage: "rc-built"},
			want:    branchGlyphBuilt,
		},
		{
			name:    "merged and waiting on a build",
			branch:  TaskBranchRecord{PRState: "merged"},
			release: &TaskReleaseSummary{Stage: "awaiting-build"},
			want:    branchGlyphBuilding,
		},
		{
			name:   "failing checks outrank an open PR",
			branch: TaskBranchRecord{PRState: "open", CIState: "failed"},
			want:   branchGlyphCIFailed,
		},
		{
			name:   "requested changes outrank an open PR",
			branch: TaskBranchRecord{PRState: "open", ReviewState: "changes_requested"},
			want:   branchGlyphChanges,
		},
		{
			name:   "draft",
			branch: TaskBranchRecord{PRState: "open", PRDraft: true},
			want:   branchGlyphDraft,
		},
		{
			name:   "open",
			branch: TaskBranchRecord{PRState: "open"},
			want:   branchGlyphOpen,
		},
		{
			name:   "branch without a PR",
			branch: TaskBranchRecord{BranchName: "feat/x"},
			want:   branchGlyphNoPR,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := taskBranchGlyph(tc.branch, tc.release); got != tc.want {
				t.Fatalf("glyph = %q, want %q", got, tc.want)
			}
		})
	}
}

// A card is 28 columns wide. Beyond five branches the strip counts the rest —
// silently dropping them would hide PRs nobody then chases.
func TestBranchGlyphStripCapsAtFiveAndCountsTheRest(t *testing.T) {
	branches := []TaskBranchRecord{}
	for index := 0; index < 8; index++ {
		branches = append(branches, openBranch(string(rune('a'+index)), index+1))
	}

	strip := taskBranchGlyphStrip(branchTask(branches...))

	if got := strings.Count(strip, branchGlyphOpen); got != taskBranchStripLimit {
		t.Fatalf("strip = %q, want %d glyphs", strip, taskBranchStripLimit)
	}
	if !strings.HasSuffix(strip, "+3") {
		t.Fatalf("strip = %q, want a +3 overflow marker", strip)
	}
}

func TestBranchGlyphStripShowsEveryBranchUnderTheCap(t *testing.T) {
	strip := taskBranchGlyphStrip(branchTask(openBranch("a", 1), openBranch("b", 2), openBranch("c", 3)))

	if strings.Contains(strip, "+") {
		t.Fatalf("strip = %q, want no overflow marker", strip)
	}
	if got := strings.Count(strip, branchGlyphOpen); got != 3 {
		t.Fatalf("strip = %q, want 3 glyphs", strip)
	}
}

func TestRollupLineCountsLandedWorkAndBreakage(t *testing.T) {
	failing := openBranch("c", 3)
	failing.CIState = "failed"
	task := branchTask(
		TaskBranchRecord{ID: "a", PRState: "merged", PRNumber: intPtr(1)},
		TaskBranchRecord{ID: "b", PRState: "merged", PRNumber: intPtr(2)},
		failing,
		openBranch("d", 4),
	)
	task.Release = &TaskReleaseSummary{Stage: "rolling-out", GaCount: 1}

	line := taskBranchRollupLine(task)

	if !strings.HasPrefix(line, "2/4 merged") {
		t.Fatalf("rollup = %q, want it to lead with 2/4 merged", line)
	}
	if !strings.Contains(line, "1 GA") {
		t.Fatalf("rollup = %q, want the GA count from the release summary", line)
	}
	if !strings.Contains(line, "1 ✗") {
		t.Fatalf("rollup = %q, want the failing branch counted", line)
	}
}

// GA is only ever known from the card's release summary. With no summary the
// rollup must stay silent rather than reporting zero shipped.
func TestRollupLineOmitsGACountWhenTheReleaseIsUnknown(t *testing.T) {
	line := taskBranchRollupLine(branchTask(openBranch("a", 1), openBranch("b", 2)))

	if strings.Contains(line, "GA") {
		t.Fatalf("rollup = %q, want no GA claim without a release summary", line)
	}
}

// tasks.PRNumber is nil on a multi-branch card by design, so merging "the card's
// PR" would act on whichever branch the rollup happened to name.
func TestCanMergeRefusesAMultiBranchCard(t *testing.T) {
	ready := openBranch("a", 1)
	ready.ReviewState = "approved"
	task := branchTask(ready, openBranch("b", 2))
	task.PRState = "open"
	task.CIState = "passed"
	task.ReviewState = "approved"

	if canMergeTask(task) {
		t.Fatal("canMergeTask() = true on a card with two PRs; it must refuse")
	}
	reason := getMergeBlockerReason(task)
	if !strings.Contains(reason, "choose a PR") {
		t.Fatalf("blocker = %q, want it to tell the user to choose a PR", reason)
	}
	if !strings.Contains(reason, "2 PRs") {
		t.Fatalf("blocker = %q, want the PR count named", reason)
	}
}

func TestCommentBlockerSendsAMultiBranchCardToThePicker(t *testing.T) {
	task := branchTask(openBranch("a", 1), openBranch("b", 2))
	task.PRState = "open"

	if reason := getPRCommentBlockerReason(task); !strings.Contains(reason, "choose a PR") {
		t.Fatalf("blocker = %q, want it to tell the user to choose a PR", reason)
	}
	if hasOpenPR(task) {
		t.Fatal("hasOpenPR() = true on a multi-PR card; the card has no single PR to open")
	}
}

// The single-PR path is the common one and must be untouched by the multi-PR work.
func TestSingleBranchCardKeepsTheOriginalMergeRules(t *testing.T) {
	ready := openBranch("a", 7)
	ready.ReviewState = "approved"
	task := branchTask(ready)
	task.PRNumber = intPtr(7)
	task.PRState = "open"
	task.CIState = "passed"
	task.ReviewState = "approved"

	if !canMergeTask(task) {
		t.Fatal("canMergeTask() = false on a ready single-PR card")
	}
	if reason := getMergeBlockerReason(task); reason != "" {
		t.Fatalf("blocker = %q, want none", reason)
	}
}

func TestBranchMergeBlockerReadsTheBranchNotTheCard(t *testing.T) {
	branch := openBranch("a", 12)
	branch.ReviewState = "changes_requested"

	if canMergeBranchPR(branch) {
		t.Fatal("canMergeBranchPR() = true with requested changes")
	}
	if reason := getBranchMergeBlockerReason(branch); reason != "PR #12 still has requested changes." {
		t.Fatalf("blocker = %q, want it to name PR #12", reason)
	}
}

// A cross-repo card must never build a PR link from the card's repo: that opens
// the wrong project.
func TestBranchPRURLIsBuiltFromTheBranchRepo(t *testing.T) {
	branch := openBranch("a", 42)
	repo := &RepoRecord{ID: "repo-a", GitHubOwner: "wix-private", GitHubRepo: "other-service"}

	if got := getBranchPRURL(branch, repo); got != "https://github.com/wix-private/other-service/pull/42" {
		t.Fatalf("url = %q, want the branch repo's PR link", got)
	}
	if got := getBranchPRURL(TaskBranchRecord{}, repo); got != "" {
		t.Fatalf("url = %q, want empty for a branch with no PR", got)
	}
}

func TestPressingEOpensAndClosesTheDetailPane(t *testing.T) {
	model := branchBoardModel(branchTask(openBranch("a", 1), openBranch("b", 2)))

	model.handleKey(keyPress("e"))

	if !model.detailPaneVisible {
		t.Fatal("detailPaneVisible = false after pressing e")
	}
	if model.focus != FocusDetail {
		t.Fatalf("focus = %q, want %q", model.focus, FocusDetail)
	}

	model.handleKey(keyPress("e"))

	if model.detailPaneVisible {
		t.Fatal("detailPaneVisible = true after pressing e twice")
	}
	if model.focus != FocusBoard {
		t.Fatalf("focus = %q, want the board back", model.focus)
	}
}

func TestEscapeClosesTheDetailPane(t *testing.T) {
	model := branchBoardModel(branchTask(openBranch("a", 1)))
	model.handleKey(keyPress("e"))

	model.handleKey(keyPress("esc"))

	if model.detailPaneVisible {
		t.Fatal("detailPaneVisible = true after Esc")
	}
}

func TestDetailPaneArrowsWalkBranchesAndClampAtTheEnds(t *testing.T) {
	model := branchBoardModel(branchTask(openBranch("a", 1), openBranch("b", 2), openBranch("c", 3)))
	model.handleKey(keyPress("e"))

	model.handleKey(keyPress("down"))
	if model.detailBranchIndex != 1 {
		t.Fatalf("detailBranchIndex = %d, want 1", model.detailBranchIndex)
	}

	model.handleKey(keyPress("down"))
	model.handleKey(keyPress("down"))
	if model.detailBranchIndex != 2 {
		t.Fatalf("detailBranchIndex = %d, want it clamped to the last branch", model.detailBranchIndex)
	}

	model.handleKey(keyPress("up"))
	model.handleKey(keyPress("up"))
	model.handleKey(keyPress("up"))
	if model.detailBranchIndex != 0 {
		t.Fatalf("detailBranchIndex = %d, want it clamped to the first branch", model.detailBranchIndex)
	}
}

// The pane is a pane and not a modal precisely so the board stays usable; a key
// it does not claim must still reach the board.
func TestDetailPaneLeavesBoardKeysAlone(t *testing.T) {
	model := branchBoardModel(branchTask(openBranch("a", 1)))
	model.tasks = append(model.tasks, TaskRecord{ID: "task-2", TrackID: "in-progress", SortKey: 2, Title: "Second"})
	model.handleKey(keyPress("e"))

	model.handleKey(keyPress("k"))

	if !model.detailPaneVisible {
		t.Fatal("detailPaneVisible = false; a board key must not close the pane")
	}
	if model.focus != FocusDetail {
		t.Fatalf("focus = %q, want the pane to keep focus", model.focus)
	}
}

func TestDetailPaneShowsEveryBranchAndTheCardRelease(t *testing.T) {
	task := branchTask(openBranch("a", 11), openBranch("b", 22))
	task.Release = &TaskReleaseSummary{Stage: "rolling-out", BlockingRcVersion: "1.292.0"}
	model := branchBoardModel(task)
	model.repos = []RepoRecord{{ID: "repo-a", Label: "web5-poc"}, {ID: "repo-b", Label: "assistant"}}
	model.handleKey(keyPress("e"))

	plain := ansiPattern.ReplaceAllString(renderDetailPane(model, 24, false), "")

	for _, want := range []string{"web5-poc", "assistant", "#11 open", "#22 open", "rollout 1.292.0"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("detail pane = %q, want it to contain %q", plain, want)
		}
	}
}

// The detail pane takes the terminal's slot. If it did not report that the split
// is in use, the board would render full width underneath it.
func TestDetailPaneClaimsTheSidePaneSlotWithoutASession(t *testing.T) {
	model := branchBoardModel(branchTask(openBranch("a", 1)))

	if model.sidePaneShouldRender() {
		t.Fatal("sidePaneShouldRender() = true with nothing open")
	}

	model.handleKey(keyPress("e"))

	if !model.sidePaneShouldRender() {
		t.Fatal("sidePaneShouldRender() = false with the detail pane open")
	}
}
