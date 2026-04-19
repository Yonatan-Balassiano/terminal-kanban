package tui

import (
	"regexp"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

var gitPushPattern = regexp.MustCompile(`\bgit\s+push\b`)

const postPushSyncDelay = 250 * time.Millisecond

type flushTerminalInputMsg struct {
	Version int
}

type postPushSyncMsg struct {
	Version int
	TaskID  string
}

func appendTerminalCommand(current string, key tea.KeyMsg) string {
	switch key.Type {
	case tea.KeyEnter, tea.KeyEsc, tea.KeyCtrlC:
		return ""
	case tea.KeyBackspace, tea.KeyDelete:
		return trimLastRune(current)
	case tea.KeyUp, tea.KeyDown, tea.KeyLeft, tea.KeyRight, tea.KeyTab:
		return current
	}

	if key.Type != tea.KeyRunes || key.Alt {
		return current
	}

	return current + string(key.Runes)
}

func shouldTriggerTerminalPushSync(command string, key tea.KeyMsg) bool {
	return key.Type == tea.KeyEnter && gitPushPattern.MatchString(command)
}

func shouldFlushTerminalInputImmediately(key tea.KeyMsg) bool {
	switch key.Type {
	case tea.KeyEnter, tea.KeyTab, tea.KeyEsc, tea.KeyUp, tea.KeyDown, tea.KeyLeft, tea.KeyRight, tea.KeyCtrlC:
		return true
	}
	return false
}

func (m *Model) queueTerminalInputCmd(taskID string, slot SessionSlot, data string, key tea.KeyMsg, shouldTriggerPushSync bool) tea.Cmd {
	if data == "" {
		return nil
	}

	commands := []tea.Cmd{}
	normalizedSlot := normalizeSessionSlot(slot)
	if m.pendingTerminalInputTaskID != "" && (m.pendingTerminalInputTaskID != taskID || m.pendingTerminalInputSlot != normalizedSlot) {
		if flushCmd := m.flushPendingTerminalInputCmd(); flushCmd != nil {
			commands = append(commands, flushCmd)
		}
	}

	m.pendingTerminalInputTaskID = taskID
	m.pendingTerminalInputSlot = normalizedSlot
	m.pendingTerminalInput += data
	m.pendingTerminalPushSync = m.pendingTerminalPushSync || shouldTriggerPushSync

	if shouldFlushTerminalInputImmediately(key) {
		if flushCmd := m.flushPendingTerminalInputCmd(); flushCmd != nil {
			commands = append(commands, flushCmd)
		}
		return tea.Batch(commands...)
	}

	m.terminalInputFlushVersion++
	version := m.terminalInputFlushVersion
	commands = append(commands, tea.Tick(terminalInputFlushMillis*time.Millisecond, func(_ time.Time) tea.Msg {
		return flushTerminalInputMsg{Version: version}
	}))

	return tea.Batch(commands...)
}

func (m *Model) flushPendingTerminalInputCmd() tea.Cmd {
	taskID := m.pendingTerminalInputTaskID
	slot := m.pendingTerminalInputSlot
	data := m.pendingTerminalInput
	shouldTriggerPushSync := m.pendingTerminalPushSync

	m.pendingTerminalInputTaskID = ""
	m.pendingTerminalInputSlot = SessionSlotPrimary
	m.pendingTerminalInput = ""
	m.pendingTerminalPushSync = false

	if taskID == "" || data == "" {
		return nil
	}

	commands := []tea.Cmd{m.sendInputCmd(taskID, slot, data)}
	if shouldTriggerPushSync {
		m.postPushSyncVersion++
		version := m.postPushSyncVersion
		commands = append(commands, tea.Tick(postPushSyncDelay, func(_ time.Time) tea.Msg {
			return postPushSyncMsg{Version: version, TaskID: taskID}
		}))
	}

	return tea.Batch(commands...)
}
