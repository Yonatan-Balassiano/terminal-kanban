package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// Card search is a jump, not a filter: "/" opens a prompt in the status bar,
// Enter moves the selection to the first card whose title contains the query,
// and N / P step through the rest of the matches. Every card stays on the
// board — narrowing it is what the filter modal's search text is for.
//
// Matches are recomputed on every step rather than cached, so a card that
// moves column or appears from a sync between presses is found where it is now.

// cardSearchPosition is a card's place on the board in reading order: column by
// column, top to bottom — the order "first" and "next" mean to someone looking
// at it.
type cardSearchPosition struct {
	trackIndex int
	taskIndex  int
	taskID     string
}

func (m *Model) openCardSearch() {
	m.searchInputActive = true
	m.searchInput = ""
	m.statusMessage = ""
}

// handleCardSearchInputKey owns every key while the prompt is open, so typing
// "n" into a query never creates a task.
func (m *Model) handleCardSearchInputKey(key tea.KeyMsg) tea.Cmd {
	switch key.Type {
	case tea.KeyEsc:
		m.searchInputActive = false
		m.searchInput = ""
	case tea.KeyEnter:
		m.searchInputActive = false
		query := strings.TrimSpace(m.searchInput)
		m.searchInput = ""
		if query == "" {
			m.clearCardSearch()
			return nil
		}
		m.searchQuery = query
		m.jumpToCardMatch(0)
	case tea.KeyBackspace:
		if runes := []rune(m.searchInput); len(runes) > 0 {
			m.searchInput = string(runes[:len(runes)-1])
		}
	case tea.KeyCtrlU:
		m.searchInput = ""
	case tea.KeySpace:
		m.searchInput += " "
	case tea.KeyRunes:
		m.searchInput += string(key.Runes)
	}
	return nil
}

func (m *Model) clearCardSearch() {
	m.searchQuery = ""
	m.statusMessage = ""
}

func (m *Model) cardSearchMatches() []cardSearchPosition {
	if m.searchQuery == "" {
		return nil
	}
	needle := strings.ToLower(m.searchQuery)
	tasksByTrack := m.tasksByTrack()
	matches := []cardSearchPosition{}
	for trackIndex, track := range m.sortedTracks() {
		for taskIndex, task := range tasksByTrack[track.ID] {
			if strings.Contains(strings.ToLower(task.Title), needle) {
				matches = append(matches, cardSearchPosition{trackIndex: trackIndex, taskIndex: taskIndex, taskID: task.ID})
			}
		}
	}
	return matches
}

// jumpToCardMatch selects a match relative to the current selection: 0 takes
// the first match on the board, 1 the next one after the selected card, -1 the
// one before it. Both directions wrap.
func (m *Model) jumpToCardMatch(direction int) {
	matches := m.cardSearchMatches()
	if len(matches) == 0 {
		m.statusMessage = fmt.Sprintf("No card matches %q", m.searchQuery)
		return
	}

	target := 0
	switch {
	case direction > 0:
		for i, match := range matches {
			if m.cardSearchPositionAfterSelection(match) {
				target = i
				break
			}
		}
	case direction < 0:
		target = len(matches) - 1
		for i := len(matches) - 1; i >= 0; i-- {
			if m.cardSearchPositionBeforeSelection(matches[i]) {
				target = i
				break
			}
		}
	}

	match := matches[target]
	m.selectedTrackIndex = match.trackIndex
	m.selectedTaskIndex = match.taskIndex
	m.statusMessage = fmt.Sprintf("/%s  %d/%d  N next  P prev  Esc clear", m.searchQuery, target+1, len(matches))
}

func (m *Model) cardSearchPositionAfterSelection(position cardSearchPosition) bool {
	if position.trackIndex != m.selectedTrackIndex {
		return position.trackIndex > m.selectedTrackIndex
	}
	return position.taskIndex > m.selectedTaskIndex
}

func (m *Model) cardSearchPositionBeforeSelection(position cardSearchPosition) bool {
	if position.trackIndex != m.selectedTrackIndex {
		return position.trackIndex < m.selectedTrackIndex
	}
	return position.taskIndex < m.selectedTaskIndex
}
