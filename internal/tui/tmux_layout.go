package tui

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// errTmuxTaskPaneNotFound says the backend session this attach was pointed at no
// longer has a pane. The caller can recover by opening the session again rather
// than leaving the card with no shell it can reach.
var errTmuxTaskPaneNotFound = errors.New("tmux task pane not found")

const (
	tmuxBoardPaneOption            = "@agentboard_board_pane"
	tmuxSessionPaneOption          = "@agentboard_session_pane"
	tmuxSessionBackendIDOption     = "@agentboard_session_backend_id"
	tmuxBackendSessionIDPaneOption = "@agentboard_backend_session_id"
	tmuxHoldingSessionName         = "agentboard-task-panes"
	tmuxLayoutLockName             = "agentboard_attach_layout"
)

type tmuxRunner interface {
	Run(args ...string) (string, error)
}

type execTmuxRunner struct{}

type tmuxPaneRecord struct {
	ID               string
	BackendSessionID string
}

func (execTmuxRunner) Run(args ...string) (string, error) {
	output, err := exec.Command("tmux", args...).CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(output))
		if text != "" {
			return text, fmt.Errorf("%w: %s", err, text)
		}
		return "", err
	}
	return string(output), nil
}

func attachTaskSessionInTmux(backendSessionID string) error {
	return attachTaskSessionInTmuxWithEnvironment(
		os.Getenv("TMUX"),
		os.Getenv("TMUX_PANE"),
		execTmuxRunner{},
		backendSessionID,
	)
}

func attachTaskSessionInTmuxWithRunner(tmuxEnv string, runner tmuxRunner, backendSessionID string) error {
	return attachTaskSessionInTmuxWithEnvironment(tmuxEnv, "", runner, backendSessionID)
}

func attachTaskSessionInTmuxWithEnvironment(tmuxEnv string, tmuxPane string, runner tmuxRunner, backendSessionID string) error {
	if strings.TrimSpace(tmuxEnv) == "" {
		return fmt.Errorf("not inside tmux; run agentboard from its managed tmux layout")
	}
	backendSessionID = strings.TrimSpace(backendSessionID)
	if backendSessionID == "" {
		return fmt.Errorf("tmux session has no backend session id")
	}

	if _, err := runner.Run("wait-for", "-L", tmuxLayoutLockName); err != nil {
		return err
	}
	defer func() {
		_, _ = runner.Run("wait-for", "-U", tmuxLayoutLockName)
	}()

	boardPane, err := tmuxResolveBoardPane(runner, tmuxPane)
	if err != nil {
		return err
	}

	if err := tmuxSetWindowOption(runner, boardPane, tmuxBoardPaneOption, boardPane); err != nil {
		return err
	}

	paneID := tmuxWindowOption(runner, boardPane, tmuxSessionPaneOption)
	visibleBackendSessionID := tmuxWindowOption(runner, boardPane, tmuxSessionBackendIDOption)

	visiblePanes, err := tmuxPanesInWindow(runner, boardPane)
	if err != nil {
		return err
	}
	visibleTaskPanes := tmuxTaskPanes(visiblePanes, boardPane)

	if visibleBackendSessionID == backendSessionID && len(visibleTaskPanes) > 0 {
		if err := tmuxTagPaneGroup(runner, visibleTaskPanes, backendSessionID); err != nil {
			return err
		}
		selectedPane := tmuxPreferredPane(paneID, visibleTaskPanes)
		if err := tmuxSetWindowOption(runner, boardPane, tmuxSessionPaneOption, selectedPane); err != nil {
			return err
		}
		if err := tmuxSetWindowOption(runner, boardPane, tmuxSessionBackendIDOption, backendSessionID); err != nil {
			return err
		}
		_, err = runner.Run("select-pane", "-t", selectedPane)
		return err
	}

	if len(visibleTaskPanes) > 0 {
		if err := tmuxDetachVisibleSessionPanes(runner, visibleTaskPanes, visibleBackendSessionID); err != nil {
			return err
		}
	}

	sourcePanes, err := tmuxFindBackendPanes(runner, backendSessionID)
	if err != nil {
		return err
	}
	if len(sourcePanes) == 0 {
		return fmt.Errorf("%w: %s", errTmuxTaskPaneNotFound, backendSessionID)
	}

	joinedPanes := []string{}
	clearedBoardPaneTag := false
	for _, sourcePane := range sourcePanes {
		if strings.TrimSpace(sourcePane) == "" {
			continue
		}
		// The board's own pane is never a task pane, so a tag on it is stale
		// bookkeeping — and leaving it there wedges the card for good: this
		// attach finds nothing to join, while the daemon keeps reporting the
		// session alive because *some* pane still carries the tag, so it hands
		// back the dead record instead of rebuilding. Strip the tag to break
		// that loop.
		if sourcePane == boardPane {
			if err := tmuxUntagPane(runner, sourcePane); err != nil {
				return err
			}
			clearedBoardPaneTag = true
			continue
		}
		if err := tmuxSetPaneOption(runner, sourcePane, tmuxBackendSessionIDPaneOption, backendSessionID); err != nil {
			return err
		}
		joinDirection := "-h"
		joinTarget := boardPane
		if len(joinedPanes) > 0 {
			joinDirection = "-v"
			joinTarget = joinedPanes[len(joinedPanes)-1]
		}
		if _, err := runner.Run("join-pane", joinDirection, "-s", sourcePane, "-t", joinTarget); err != nil {
			return err
		}
		joinedPanes = append(joinedPanes, sourcePane)
	}
	if len(joinedPanes) == 0 {
		if clearedBoardPaneTag {
			return fmt.Errorf("tmux task pane for %s was lost; open the task again to start a fresh session", backendSessionID)
		}
		return fmt.Errorf("tmux task pane not found: %s", backendSessionID)
	}

	if err := tmuxSetWindowOption(runner, boardPane, tmuxSessionPaneOption, joinedPanes[0]); err != nil {
		return err
	}
	if err := tmuxSetWindowOption(runner, boardPane, tmuxSessionBackendIDOption, backendSessionID); err != nil {
		return err
	}
	_, err = runner.Run("select-pane", "-t", joinedPanes[0])
	return err
}

func tmuxResolveBoardPane(runner tmuxRunner, tmuxPane string) (string, error) {
	tmuxPane = strings.TrimSpace(tmuxPane)
	if tmuxPane != "" && tmuxPaneExists(runner, tmuxPane) {
		return tmuxPane, nil
	}

	currentPane, err := tmuxCurrentPane(runner)
	if err != nil {
		return "", err
	}

	boardPane := tmuxWindowOption(runner, currentPane, tmuxBoardPaneOption)
	if boardPane == currentPane {
		return currentPane, nil
	}
	if boardPane != "" && tmuxPaneExists(runner, boardPane) {
		return boardPane, nil
	}

	return tmuxBoardPaneByTag(runner, currentPane), nil
}

// Pick the board pane in a window that has not recorded one yet — a freshly
// built layout, or one rebuilt after a relaunch.
//
// The active pane is the only other hint available, and it is the wrong answer
// whenever a task pane holds focus. Task panes always carry a backend-session
// tag and the board pane never does, so an untagged pane beats a tagged active
// one. Guessing wrong is expensive: the layout engine then treats the board's
// own pane as a task pane, tags it and breaks it out into the holding session,
// and every later attach dies on a task pane that is really the board.
func tmuxBoardPaneByTag(runner tmuxRunner, currentPane string) string {
	panes, err := tmuxPanesInWindow(runner, currentPane)
	if err != nil {
		return currentPane
	}

	untagged := []string{}
	for _, pane := range panes {
		if pane.BackendSessionID == "" {
			untagged = append(untagged, pane.ID)
		}
	}

	for _, paneID := range untagged {
		if paneID == currentPane {
			return currentPane
		}
	}
	if len(untagged) == 1 {
		return untagged[0]
	}
	return currentPane
}

func tmuxWindowOption(runner tmuxRunner, targetPane string, option string) string {
	args := []string{"show-options", "-w", "-q", "-v"}
	if strings.TrimSpace(targetPane) != "" {
		args = append(args, "-t", targetPane)
	}
	args = append(args, option)
	output, err := runner.Run(args...)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func tmuxSetWindowOption(runner tmuxRunner, targetPane string, option string, value string) error {
	args := []string{"set-window-option", "-q"}
	if strings.TrimSpace(targetPane) != "" {
		args = append(args, "-t", targetPane)
	}
	args = append(args, option, value)
	_, err := runner.Run(args...)
	return err
}

func tmuxSetPaneOption(runner tmuxRunner, targetPane string, option string, value string) error {
	args := []string{"set-option", "-p", "-q"}
	if strings.TrimSpace(targetPane) != "" {
		args = append(args, "-t", targetPane)
	}
	args = append(args, option, value)
	_, err := runner.Run(args...)
	return err
}

func tmuxUntagPane(runner tmuxRunner, targetPane string) error {
	targetPane = strings.TrimSpace(targetPane)
	if targetPane == "" {
		// Without a target tmux unsets the option on the current pane, which is
		// the one pane this must never touch.
		return nil
	}
	_, err := runner.Run("set-option", "-p", "-q", "-u", "-t", targetPane, tmuxBackendSessionIDPaneOption)
	return err
}

func tmuxPaneOption(runner tmuxRunner, targetPane string, option string) string {
	args := []string{"show-options", "-p", "-q", "-v"}
	if strings.TrimSpace(targetPane) != "" {
		args = append(args, "-t", targetPane)
	}
	args = append(args, option)
	output, err := runner.Run(args...)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func tmuxCurrentPane(runner tmuxRunner) (string, error) {
	output, err := runner.Run("display-message", "-p", "#{pane_id}")
	if err != nil {
		return "", err
	}
	paneID := strings.TrimSpace(output)
	if paneID == "" {
		return "", fmt.Errorf("tmux did not report the current pane")
	}
	return paneID, nil
}

func tmuxSplitRightPane(runner tmuxRunner, targetPane string) (string, error) {
	args := []string{"split-window", "-h"}
	if strings.TrimSpace(targetPane) != "" {
		args = append(args, "-t", targetPane)
	}
	args = append(args, "-P", "-F", "#{pane_id}")
	output, err := runner.Run(args...)
	if err != nil {
		return "", err
	}
	paneID := strings.TrimSpace(output)
	if paneID == "" {
		return "", fmt.Errorf("tmux did not report the new pane")
	}
	return paneID, nil
}

func tmuxPanesInWindow(runner tmuxRunner, targetPane string) ([]tmuxPaneRecord, error) {
	output, err := runner.Run("list-panes", "-t", targetPane, "-F", "#{pane_id}\t#{@agentboard_backend_session_id}")
	if err != nil {
		return nil, err
	}
	return tmuxParsePaneRecords(output), nil
}

func tmuxParsePaneRecords(output string) []tmuxPaneRecord {
	panes := []tmuxPaneRecord{}
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		paneID := strings.TrimSpace(parts[0])
		if paneID == "" {
			continue
		}
		record := tmuxPaneRecord{ID: paneID}
		if len(parts) == 2 {
			record.BackendSessionID = strings.TrimSpace(parts[1])
		}
		panes = append(panes, record)
	}
	return panes
}

func tmuxTaskPanes(panes []tmuxPaneRecord, boardPane string) []tmuxPaneRecord {
	taskPanes := []tmuxPaneRecord{}
	for _, pane := range panes {
		if strings.TrimSpace(pane.ID) == "" || pane.ID == boardPane {
			continue
		}
		taskPanes = append(taskPanes, pane)
	}
	return taskPanes
}

func tmuxPreferredPane(preferredPane string, panes []tmuxPaneRecord) string {
	preferredPane = strings.TrimSpace(preferredPane)
	for _, pane := range panes {
		if pane.ID == preferredPane {
			return preferredPane
		}
	}
	if len(panes) == 0 {
		return ""
	}
	return panes[0].ID
}

func tmuxTagPaneGroup(runner tmuxRunner, panes []tmuxPaneRecord, backendSessionID string) error {
	for _, pane := range panes {
		if err := tmuxSetPaneOption(runner, pane.ID, tmuxBackendSessionIDPaneOption, backendSessionID); err != nil {
			return err
		}
	}
	return nil
}

func tmuxFindBackendPanes(runner tmuxRunner, backendSessionID string) ([]string, error) {
	output, err := runner.Run("list-panes", "-a", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}")
	if err == nil {
		panes := []string{}
		for _, line := range strings.Split(output, "\n") {
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) == 2 && strings.TrimSpace(parts[1]) == backendSessionID {
				paneID := strings.TrimSpace(parts[0])
				if paneID != "" {
					panes = append(panes, paneID)
				}
			}
		}
		if len(panes) > 0 {
			return panes, nil
		}
	}

	output, err = runner.Run("display-message", "-p", "-t", backendSessionID, "#{pane_id}")
	if err != nil {
		return nil, nil
	}
	paneID := strings.TrimSpace(output)
	if paneID == "" {
		return nil, nil
	}
	return []string{paneID}, nil
}

func tmuxMovePaneToHoldingSession(runner tmuxRunner, paneID string) error {
	return tmuxMovePanesToHoldingSession(runner, []string{paneID})
}

func tmuxMovePanesToHoldingSession(runner tmuxRunner, paneIDs []string) error {
	if len(paneIDs) == 0 {
		return nil
	}
	if err := tmuxEnsureHoldingSession(runner); err != nil {
		return err
	}
	for _, paneID := range paneIDs {
		if _, err := runner.Run("break-pane", "-d", "-s", paneID, "-t", tmuxHoldingSessionName+":"); err != nil {
			return err
		}
	}
	return nil
}

func tmuxDetachVisibleSessionPanes(runner tmuxRunner, panes []tmuxPaneRecord, backendSessionID string) error {
	backendSessionID = strings.TrimSpace(backendSessionID)
	panesToMove := []string{}
	for _, pane := range panes {
		if backendSessionID != "" {
			if err := tmuxSetPaneOption(runner, pane.ID, tmuxBackendSessionIDPaneOption, backendSessionID); err != nil {
				return err
			}
			panesToMove = append(panesToMove, pane.ID)
			continue
		}

		if pane.BackendSessionID != "" || tmuxPaneOption(runner, pane.ID, tmuxBackendSessionIDPaneOption) != "" {
			panesToMove = append(panesToMove, pane.ID)
			continue
		}

		if _, err := runner.Run("kill-pane", "-t", pane.ID); err != nil {
			return err
		}
	}
	return tmuxMovePanesToHoldingSession(runner, panesToMove)
}

func tmuxEnsureHoldingSession(runner tmuxRunner) error {
	if _, err := runner.Run("has-session", "-t", tmuxHoldingSessionName); err == nil {
		return nil
	}
	if _, err := runner.Run("new-session", "-d", "-s", tmuxHoldingSessionName, "sh -lc 'while :; do sleep 3600; done'"); err != nil {
		return err
	}
	_, err := runner.Run("set-option", "-q", "-t", tmuxHoldingSessionName, "destroy-unattached", "off")
	return err
}

func tmuxPaneExists(runner tmuxRunner, paneID string) bool {
	paneID = strings.TrimSpace(paneID)
	if paneID == "" {
		return false
	}
	output, err := runner.Run("display-message", "-p", "-t", paneID, "#{pane_id}")
	if err != nil {
		return false
	}
	return strings.TrimSpace(output) == paneID
}

func tmuxPaneExistsInWindow(runner tmuxRunner, targetPane string, paneID string) bool {
	paneID = strings.TrimSpace(paneID)
	targetPane = strings.TrimSpace(targetPane)
	if paneID == "" || targetPane == "" {
		return false
	}
	output, err := runner.Run("list-panes", "-t", targetPane, "-F", "#{pane_id}")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) == paneID {
			return true
		}
	}
	return false
}
