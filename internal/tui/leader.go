package tui

import (
	"fmt"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Vim-style leader chords.
//
// The board's single-key bindings ran out of letters long ago: every action
// competed for the same 52 keys, which is how navigation lost `j` to "comment on
// PR". A leader opens a second namespace that does not compete with the first,
// so hjkl can mean only movement and every action can keep a name that says what
// it does.
//
// A chord is `,` followed by a short mnemonic, grouped by first letter — `,g`
// artifacts/GA, `,p` pull requests, `,t` tasks, `,v` view, `,r` repos, `,s` sync,
// `,m` missions. Nothing here removes an existing single-key binding except the
// two the user's layout requires: `,` itself, which was previous-repo, and `j`,
// which was comment-on-PR.

const (
	leaderKey = ","
	// Long enough to type a two-key mnemonic without hurrying, short enough that
	// an abandoned leader does not swallow the next real keystroke. Vim's own
	// timeoutlen is 1s; this is more forgiving because the prefix is shown.
	leaderTimeout = 2 * time.Second
)

// leaderChord is one entry in the table below.
type leaderChord struct {
	// Seq is the mnemonic typed after the leader, e.g. "ga".
	Seq string
	// Group labels the chord in help, e.g. "Artifacts".
	Group string
	Desc  string
	// Run performs the action. Returning nil is fine for chords that only open a
	// modal or mutate local state.
	Run func(m *Model) tea.Cmd
}

// withTask runs an action against the selected card, saying so when there is
// none rather than silently doing nothing.
func withTask(run func(m *Model, task *TaskRecord) tea.Cmd) func(m *Model) tea.Cmd {
	return func(m *Model) tea.Cmd {
		task := m.selectedTask()
		if task == nil {
			m.statusMessage = "Select a task first."
			return nil
		}
		return run(m, task)
	}
}

// leaderChords is the whole vim command surface, in one place so a rebinding is
// a one-line edit rather than a hunt through the key switch.
var leaderChords = []leaderChord{
	// ---- Artifacts / releases -------------------------------------
	{Seq: "ga", Group: "Artifacts", Desc: "GA it now — opens the dev portal", Run: func(m *Model) tea.Cmd {
		return m.openArtifactDevPortalCmd()
	}},
	{Seq: "gd", Group: "Artifacts", Desc: "start the gradual API rollout instead", Run: func(m *Model) tea.Cmd {
		m.openArtifactRolloutModal()
		return nil
	}},
	{Seq: "gr", Group: "Artifacts", Desc: "refresh the artifacts rail now", Run: func(m *Model) tea.Cmd {
		return m.refreshArtifactsCmd()
	}},
	{Seq: "gt", Group: "Artifacts", Desc: "edit which artifacts are tracked", Run: func(m *Model) tea.Cmd {
		return m.openArtifactListModal()
	}},
	{Seq: "gn", Group: "Artifacts", Desc: "select the next artifact in the rail", Run: func(m *Model) tea.Cmd {
		m.moveArtifactSelection(1)
		return nil
	}},
	{Seq: "gp", Group: "Artifacts", Desc: "select the previous artifact in the rail", Run: func(m *Model) tea.Cmd {
		m.moveArtifactSelection(-1)
		return nil
	}},

	// ---- Pull requests --------------------------------------------
	{Seq: "pn", Group: "Pull requests", Desc: "create a PR for this card", Run: withTask(func(m *Model, task *TaskRecord) tea.Cmd {
		return m.createTaskPRCmd(task)
	})},
	{Seq: "pc", Group: "Pull requests", Desc: "comment on the PR", Run: func(m *Model) tea.Cmd {
		m.openPRCommentModal(m.selectedTask())
		return nil
	}},
	{Seq: "pm", Group: "Pull requests", Desc: "merge the PR", Run: withTask(func(m *Model, task *TaskRecord) tea.Cmd {
		return m.mergeTaskPRCmd(task)
	})},
	{Seq: "po", Group: "Pull requests", Desc: "open the PR in a browser", Run: withTask(func(m *Model, task *TaskRecord) tea.Cmd {
		return m.openPRCmd(task, false)
	})},
	{Seq: "pv", Group: "Pull requests", Desc: "open the PR checks", Run: withTask(func(m *Model, task *TaskRecord) tea.Cmd {
		return m.openPRCmd(task, true)
	})},
	{Seq: "pl", Group: "Pull requests", Desc: "pick among this card's PRs", Run: func(m *Model) tea.Cmd {
		m.openBranchPRListModal(m.selectedTask())
		return nil
	}},
	{Seq: "pr", Group: "Pull requests", Desc: "retry PR creation for a pushed branch", Run: withTask(func(m *Model, task *TaskRecord) tea.Cmd {
		return m.retryPushedBranchPRCreationCmd(task)
	})},

	// ---- Tasks -----------------------------------------------------
	{Seq: "tn", Group: "Task", Desc: "new task", Run: func(m *Model) tea.Cmd {
		m.openCreateTaskModal()
		return nil
	}},
	{Seq: "tr", Group: "Task", Desc: "rename the task", Run: func(m *Model) tea.Cmd {
		m.openRenameTaskModal(m.selectedTask())
		return nil
	}},
	{Seq: "td", Group: "Task", Desc: "delete the task", Run: func(m *Model) tea.Cmd {
		m.openDeleteConfirmModal(m.selectedTask())
		return nil
	}},
	{Seq: "te", Group: "Task", Desc: "edit the description", Run: func(m *Model) tea.Cmd {
		m.openTaskDescriptionModal(m.selectedTask())
		return nil
	}},
	{Seq: "tb", Group: "Task", Desc: "set the tracked branch", Run: func(m *Model) tea.Cmd {
		m.openSetBranchModal(m.selectedTask())
		return nil
	}},
	{Seq: "tp", Group: "Task", Desc: "assign a pillar", Run: func(m *Model) tea.Cmd {
		m.openPillarPickerModal(m.selectedTask())
		return nil
	}},
	{Seq: "ti", Group: "Task", Desc: "open the workspace in the IDE", Run: withTask(func(m *Model, task *TaskRecord) tea.Cmd {
		return m.openTaskInIDECmd(task)
	})},
	{Seq: "tx", Group: "Task", Desc: "reveal the workspace", Run: withTask(func(m *Model, task *TaskRecord) tea.Cmd {
		return m.revealTaskWorkspaceCmd(task)
	})},
	{Seq: "tf", Group: "Task", Desc: "recreate the session from scratch", Run: withTask(func(m *Model, task *TaskRecord) tea.Cmd {
		return m.openSessionCmd(task.ID, true, SessionSlotPrimary)
	})},

	// ---- View ------------------------------------------------------
	{Seq: "vf", Group: "View", Desc: "filters", Run: func(m *Model) tea.Cmd {
		m.openFilterModal()
		return nil
	}},
	{Seq: "vl", Group: "View", Desc: "board / terminal layout", Run: func(m *Model) tea.Cmd {
		m.openViewModal()
		return nil
	}},
	{Seq: "vd", Group: "View", Desc: "toggle the PR detail pane", Run: func(m *Model) tea.Cmd {
		m.toggleDetailPane()
		return nil
	}},
	{Seq: "vh", Group: "View", Desc: "help", Run: func(m *Model) tea.Cmd {
		m.openHelpModal()
		return nil
	}},

	// ---- Repos, sync, missions -------------------------------------
	{Seq: "rn", Group: "Repos", Desc: "next repo", Run: func(m *Model) tea.Cmd {
		m.switchRepo(1)
		return m.persistActiveRepoCmd()
	}},
	{Seq: "rp", Group: "Repos", Desc: "previous repo", Run: func(m *Model) tea.Cmd {
		m.switchRepo(-1)
		return m.persistActiveRepoCmd()
	}},
	{Seq: "ss", Group: "Sync", Desc: "sync PR, CI and review state", Run: func(m *Model) tea.Cmd {
		return m.syncCmd()
	}},
	{Seq: "mm", Group: "Missions", Desc: "toggle the mission rail", Run: func(m *Model) tea.Cmd {
		return m.toggleMissionsPaneCmd(true)
	}},
}

// leaderChordFor returns the chord a sequence names exactly, and whether any
// chord merely starts with it — the two questions a pending prefix asks.
func leaderChordFor(seq string) (chord *leaderChord, isPrefix bool) {
	for index := range leaderChords {
		switch {
		case leaderChords[index].Seq == seq:
			chord = &leaderChords[index]
		case strings.HasPrefix(leaderChords[index].Seq, seq):
			isPrefix = true
		}
	}
	return chord, isPrefix
}

// leaderChordsByGroup lists the table for help, grouped and stably ordered.
func leaderChordsByGroup() []string {
	byGroup := map[string][]string{}
	order := []string{}
	for _, chord := range leaderChords {
		if _, seen := byGroup[chord.Group]; !seen {
			order = append(order, chord.Group)
		}
		byGroup[chord.Group] = append(byGroup[chord.Group],
			fmt.Sprintf("%s%s %s", leaderKey, chord.Seq, chord.Desc))
	}

	lines := []string{}
	for _, group := range order {
		entries := byGroup[group]
		sort.Strings(entries)
		lines = append(lines, group+": "+strings.Join(entries, "   "))
	}
	return lines
}

// armLeader starts or extends a chord and schedules its expiry.
//
// Each keystroke re-arms with a fresh window and a bumped version, so the timer
// the previous keystroke started expires against a stale version and is ignored
// rather than cancelling a chord the user is still typing.
func (m *Model) armLeader(buffer string) tea.Cmd {
	m.leaderPending = true
	m.leaderBuffer = buffer
	m.leaderVersion++
	version := m.leaderVersion
	return tea.Tick(leaderTimeout, func(_ time.Time) tea.Msg {
		return leaderTimeoutMsg{Version: version}
	})
}

func (m *Model) clearLeader() {
	m.leaderPending = false
	m.leaderBuffer = ""
}

// handleLeaderKey consumes one key of a pending chord.
//
// Every branch ends the chord except a genuine prefix, so the leader can never
// latch on and eat subsequent input.
func (m *Model) handleLeaderKey(key tea.KeyMsg) tea.Cmd {
	switch key.Type {
	case tea.KeyEsc:
		m.clearLeader()
		m.statusMessage = ""
		return nil
	case tea.KeyRunes:
	default:
		// Anything that is not a plain rune cannot be part of a mnemonic.
		m.clearLeader()
		return nil
	}

	seq := m.leaderBuffer + string(key.Runes)
	chord, isPrefix := leaderChordFor(seq)

	if chord != nil {
		m.clearLeader()
		m.statusMessage = ""
		return chord.Run(m)
	}

	if isPrefix {
		return m.armLeader(seq)
	}

	m.clearLeader()
	m.statusMessage = fmt.Sprintf("No such chord: %s%s", leaderKey, seq)
	return nil
}

// leaderIndicator is what the status bar shows while a chord is pending.
func (m *Model) leaderIndicator() string {
	if !m.leaderPending {
		return ""
	}
	return leaderKey + m.leaderBuffer + "…"
}
