package tui

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

type fakeTmuxRunner struct {
	calls [][]string
	fn    func(args []string) (string, error)
}

func (r *fakeTmuxRunner) Run(args ...string) (string, error) {
	copied := append([]string(nil), args...)
	r.calls = append(r.calls, copied)
	if r.fn == nil {
		return "", nil
	}
	return r.fn(copied)
}

func TestAttachTaskSessionInTmuxCreatesRightPaneAndFocusesIt(t *testing.T) {
	runner := &fakeTmuxRunner{
		fn: func(args []string) (string, error) {
			switch strings.Join(args, " ") {
			case "display-message -p #{pane_id}":
				return "%1\n", nil
			case "show-window-options -qv @agentboard_session_pane":
				return "", errors.New("missing option")
			case "split-window -h -P -F #{pane_id}":
				return "%2\n", nil
			default:
				return "", nil
			}
		},
	}

	err := attachTaskSessionInTmuxWithRunner("tmux-env", runner, "env -u TMUX tmux attach-session -t ab_task_1234_p")
	if err != nil {
		t.Fatalf("attachTaskSessionInTmuxWithRunner() error = %v", err)
	}

	want := [][]string{
		{"display-message", "-p", "#{pane_id}"},
		{"show-window-options", "-qv", "@agentboard_session_pane"},
		{"split-window", "-h", "-P", "-F", "#{pane_id}"},
		{"set-window-option", "-q", "@agentboard_session_pane", "%2"},
		{"respawn-pane", "-k", "-t", "%2", "env -u TMUX tmux attach-session -t ab_task_1234_p"},
		{"select-pane", "-t", "%2"},
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("tmux calls = %#v, want %#v", runner.calls, want)
	}
}

func TestAttachTaskSessionInTmuxReusesStoredPane(t *testing.T) {
	runner := &fakeTmuxRunner{
		fn: func(args []string) (string, error) {
			switch strings.Join(args, " ") {
			case "display-message -p #{pane_id}":
				return "%1\n", nil
			case "show-window-options -qv @agentboard_session_pane":
				return "%2\n", nil
			case "list-panes -F #{pane_id}":
				return "%1\n%2\n", nil
			default:
				return "", nil
			}
		},
	}

	err := attachTaskSessionInTmuxWithRunner("tmux-env", runner, "env -u TMUX tmux attach-session -t ab_other_1234_p")
	if err != nil {
		t.Fatalf("attachTaskSessionInTmuxWithRunner() error = %v", err)
	}

	want := [][]string{
		{"display-message", "-p", "#{pane_id}"},
		{"show-window-options", "-qv", "@agentboard_session_pane"},
		{"list-panes", "-F", "#{pane_id}"},
		{"respawn-pane", "-k", "-t", "%2", "env -u TMUX tmux attach-session -t ab_other_1234_p"},
		{"select-pane", "-t", "%2"},
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("tmux calls = %#v, want %#v", runner.calls, want)
	}
}

func TestAttachTaskSessionInTmuxRequiresTmux(t *testing.T) {
	runner := &fakeTmuxRunner{}

	err := attachTaskSessionInTmuxWithRunner("", runner, "env -u TMUX tmux attach-session -t ab_task_1234_p")
	if err == nil {
		t.Fatal("attachTaskSessionInTmuxWithRunner() error = nil, want an error")
	}
	if len(runner.calls) != 0 {
		t.Fatalf("tmux calls = %#v, want none", runner.calls)
	}
}
