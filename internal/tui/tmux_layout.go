package tui

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const tmuxSessionPaneOption = "@agentboard_session_pane"

type tmuxRunner interface {
	Run(args ...string) (string, error)
}

type execTmuxRunner struct{}

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

func attachTaskSessionInTmux(attachCommand string) error {
	return attachTaskSessionInTmuxWithRunner(os.Getenv("TMUX"), execTmuxRunner{}, attachCommand)
}

func attachTaskSessionInTmuxWithRunner(tmuxEnv string, runner tmuxRunner, attachCommand string) error {
	if strings.TrimSpace(tmuxEnv) == "" {
		return fmt.Errorf("not inside tmux; run agentboard from its managed tmux layout")
	}
	if strings.TrimSpace(attachCommand) == "" {
		return fmt.Errorf("tmux session has no attach command")
	}

	currentPane, err := tmuxCurrentPane(runner)
	if err != nil {
		return err
	}

	paneID := ""
	if storedPane, err := runner.Run("show-window-options", "-qv", tmuxSessionPaneOption); err == nil {
		storedPane = strings.TrimSpace(storedPane)
		if storedPane != "" && storedPane != currentPane && tmuxPaneExistsInCurrentWindow(runner, storedPane) {
			paneID = storedPane
		}
	}

	if paneID == "" {
		paneID, err = tmuxSplitRightPane(runner)
		if err != nil {
			return err
		}
		if _, err := runner.Run("set-window-option", "-q", tmuxSessionPaneOption, paneID); err != nil {
			return err
		}
	}

	if _, err := runner.Run("respawn-pane", "-k", "-t", paneID, attachCommand); err != nil {
		return err
	}
	_, err = runner.Run("select-pane", "-t", paneID)
	return err
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

func tmuxSplitRightPane(runner tmuxRunner) (string, error) {
	output, err := runner.Run("split-window", "-h", "-P", "-F", "#{pane_id}")
	if err != nil {
		return "", err
	}
	paneID := strings.TrimSpace(output)
	if paneID == "" {
		return "", fmt.Errorf("tmux did not report the new pane")
	}
	return paneID, nil
}

func tmuxPaneExistsInCurrentWindow(runner tmuxRunner, paneID string) bool {
	output, err := runner.Run("list-panes", "-F", "#{pane_id}")
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
