package tui

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

func (m *Model) revealTaskWorkspaceCmd(task *TaskRecord) tea.Cmd {
	if task == nil {
		return nil
	}
	return func() tea.Msg {
		var workspace TaskWorkspaceResult
		if err := m.client.Call("prepareTaskWorkspace", map[string]string{"taskId": task.ID}, &workspace); err != nil {
			return asyncErrorMsg{err: err}
		}
		if err := revealPath(workspace.Path); err != nil {
			return asyncErrorMsg{err: err}
		}
		return boardActionMsg{status: "Opening workspace for " + task.Title}
	}
}

func (m *Model) openTaskInIDECmd(task *TaskRecord) tea.Cmd {
	if task == nil {
		return nil
	}
	repo := m.repoByID(task.RepoID)
	return func() tea.Msg {
		var workspace TaskWorkspaceResult
		if err := m.client.Call("prepareTaskWorkspace", map[string]string{"taskId": task.ID}, &workspace); err != nil {
			return asyncErrorMsg{err: err}
		}
		if err := openPathInIDE(workspace.Path, repo); err != nil {
			return asyncErrorMsg{err: err}
		}
		return boardActionMsg{status: "Opening IDE for " + task.Title}
	}
}

func revealPath(targetPath string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", targetPath).Start()
	case "linux":
		return exec.Command("xdg-open", targetPath).Start()
	case "windows":
		return exec.Command("cmd", "/c", "start", "", targetPath).Start()
	default:
		return fmt.Errorf("unsupported platform for file manager open: %s", runtime.GOOS)
	}
}

func openPathInIDE(targetPath string, repo *RepoRecord) error {
	if repo != nil && repo.IDECommand != "" {
		return exec.Command("sh", "-lc", repo.IDECommand+" "+shellQuote(targetPath)).Start()
	}

	order := []PreferredIDE{"webstorm", "idea", "cursor", "vscode", "system"}
	if repo != nil && repo.PreferredIDE != "" {
		order = []PreferredIDE{repo.PreferredIDE}
	}

	for _, ide := range order {
		if ide == "system" {
			return revealPath(targetPath)
		}

		if runtime.GOOS == "darwin" {
			switch ide {
			case "webstorm":
				if tryLaunch("webstorm", targetPath) || tryLaunch("open", "-na", "WebStorm.app", "--args", targetPath) {
					return nil
				}
			case "idea":
				if tryLaunch("idea", targetPath) || tryLaunch("open", "-na", "IntelliJ IDEA.app", "--args", targetPath) {
					return nil
				}
			case "cursor":
				if tryLaunch("cursor", targetPath) || tryLaunch("open", "-na", "Cursor.app", "--args", targetPath) {
					return nil
				}
			case "vscode":
				if tryLaunch("code", targetPath) || tryLaunch("open", "-na", "Visual Studio Code.app", "--args", targetPath) {
					return nil
				}
			}
			continue
		}

		switch ide {
		case "webstorm":
			if tryLaunch("webstorm", targetPath) {
				return nil
			}
		case "idea":
			if tryLaunch("idea", targetPath) {
				return nil
			}
		case "cursor":
			if tryLaunch("cursor", targetPath) {
				return nil
			}
		case "vscode":
			if tryLaunch("code", targetPath) {
				return nil
			}
		}
	}

	return fmt.Errorf("no supported IDE launcher was available")
}

func tryLaunch(command string, args ...string) bool {
	return exec.Command(command, args...).Start() == nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
