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

func TestAttachTaskSessionInTmuxJoinsTaskPaneIntoBoardWindow(t *testing.T) {
	runner := &fakeTmuxRunner{
		fn: func(args []string) (string, error) {
			switch strings.Join(args, " ") {
			case "display-message -p #{pane_id}":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_board_pane":
				return "", errors.New("missing option")
			case "show-options -w -q -v -t %1 @agentboard_session_pane":
				return "", errors.New("missing option")
			case "list-panes -t %1 -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "", nil
			case "list-panes -a -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "", nil
			case "display-message -p -t ab_task_1234_p #{pane_id}":
				return "%2\n", nil
			default:
				return "", nil
			}
		},
	}

	err := attachTaskSessionInTmuxWithRunner("tmux-env", runner, "ab_task_1234_p")
	if err != nil {
		t.Fatalf("attachTaskSessionInTmuxWithRunner() error = %v", err)
	}

	want := [][]string{
		{"wait-for", "-L", "agentboard_attach_layout"},
		{"display-message", "-p", "#{pane_id}"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_board_pane"},
		{"list-panes", "-t", "%1", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_board_pane", "%1"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_pane"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_backend_id"},
		{"list-panes", "-t", "%1", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"list-panes", "-a", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"display-message", "-p", "-t", "ab_task_1234_p", "#{pane_id}"},
		{"set-option", "-p", "-q", "-t", "%2", "@agentboard_backend_session_id", "ab_task_1234_p"},
		{"join-pane", "-h", "-s", "%2", "-t", "%1"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_pane", "%2"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_backend_id", "ab_task_1234_p"},
		{"select-pane", "-t", "%2"},
		{"wait-for", "-U", "agentboard_attach_layout"},
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("tmux calls = %#v, want %#v", runner.calls, want)
	}
}

func TestAttachTaskSessionInTmuxSelectsAlreadyVisiblePane(t *testing.T) {
	runner := &fakeTmuxRunner{
		fn: func(args []string) (string, error) {
			switch strings.Join(args, " ") {
			case "display-message -p #{pane_id}":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_board_pane":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_session_pane":
				return "%2\n", nil
			case "show-options -w -q -v -t %1 @agentboard_session_backend_id":
				return "ab_task_1234_p\n", nil
			case "list-panes -t %1 -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%1\t\n%2\tab_task_1234_p\n", nil
			default:
				return "", nil
			}
		},
	}

	err := attachTaskSessionInTmuxWithRunner("tmux-env", runner, "ab_task_1234_p")
	if err != nil {
		t.Fatalf("attachTaskSessionInTmuxWithRunner() error = %v", err)
	}

	want := [][]string{
		{"wait-for", "-L", "agentboard_attach_layout"},
		{"display-message", "-p", "#{pane_id}"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_board_pane"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_board_pane", "%1"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_pane"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_backend_id"},
		{"list-panes", "-t", "%1", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"set-option", "-p", "-q", "-t", "%2", "@agentboard_backend_session_id", "ab_task_1234_p"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_pane", "%2"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_backend_id", "ab_task_1234_p"},
		{"select-pane", "-t", "%2"},
		{"wait-for", "-U", "agentboard_attach_layout"},
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("tmux calls = %#v, want %#v", runner.calls, want)
	}
}

func TestAttachTaskSessionInTmuxMovesVisiblePaneGroupToHoldingSessionBeforeJoiningNext(t *testing.T) {
	runner := &fakeTmuxRunner{
		fn: func(args []string) (string, error) {
			switch strings.Join(args, " ") {
			case "display-message -p #{pane_id}":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_board_pane":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_session_pane":
				return "%2\n", nil
			case "show-options -w -q -v -t %1 @agentboard_session_backend_id":
				return "ab_old_1234_p\n", nil
			case "list-panes -t %1 -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%1\t\n%2\tab_old_1234_p\n%4\t\n", nil
			case "has-session -t agentboard-task-panes":
				return "", errors.New("missing session")
			case "list-panes -a -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%3\tab_next_1234_p\n%5\tab_next_1234_p\n", nil
			default:
				return "", nil
			}
		},
	}

	err := attachTaskSessionInTmuxWithRunner("tmux-env", runner, "ab_next_1234_p")
	if err != nil {
		t.Fatalf("attachTaskSessionInTmuxWithRunner() error = %v", err)
	}

	want := [][]string{
		{"wait-for", "-L", "agentboard_attach_layout"},
		{"display-message", "-p", "#{pane_id}"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_board_pane"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_board_pane", "%1"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_pane"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_backend_id"},
		{"list-panes", "-t", "%1", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"set-option", "-p", "-q", "-t", "%2", "@agentboard_backend_session_id", "ab_old_1234_p"},
		{"set-option", "-p", "-q", "-t", "%4", "@agentboard_backend_session_id", "ab_old_1234_p"},
		{"has-session", "-t", "agentboard-task-panes"},
		{"new-session", "-d", "-s", "agentboard-task-panes", "sh -lc 'while :; do sleep 3600; done'"},
		{"set-option", "-q", "-t", "agentboard-task-panes", "destroy-unattached", "off"},
		{"break-pane", "-d", "-s", "%2", "-t", "agentboard-task-panes:"},
		{"break-pane", "-d", "-s", "%4", "-t", "agentboard-task-panes:"},
		{"list-panes", "-a", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"set-option", "-p", "-q", "-t", "%3", "@agentboard_backend_session_id", "ab_next_1234_p"},
		{"join-pane", "-h", "-s", "%3", "-t", "%1"},
		{"set-option", "-p", "-q", "-t", "%5", "@agentboard_backend_session_id", "ab_next_1234_p"},
		{"join-pane", "-v", "-s", "%5", "-t", "%3"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_pane", "%3"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_backend_id", "ab_next_1234_p"},
		{"select-pane", "-t", "%3"},
		{"wait-for", "-U", "agentboard_attach_layout"},
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("tmux calls = %#v, want %#v", runner.calls, want)
	}
}

func TestAttachTaskSessionInTmuxKillsLegacyNestedAttachPaneBeforeJoiningNext(t *testing.T) {
	runner := &fakeTmuxRunner{
		fn: func(args []string) (string, error) {
			switch strings.Join(args, " ") {
			case "display-message -p #{pane_id}":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_board_pane":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_session_pane":
				return "%9\n", nil
			case "show-options -w -q -v -t %1 @agentboard_session_backend_id":
				return "", errors.New("legacy pane")
			case "list-panes -t %1 -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%1\t\n%9\t\n", nil
			case "show-options -p -q -v -t %9 @agentboard_backend_session_id":
				return "", errors.New("not a moved task pane")
			case "list-panes -a -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%2\tab_next_1234_p\n", nil
			default:
				return "", nil
			}
		},
	}

	err := attachTaskSessionInTmuxWithRunner("tmux-env", runner, "ab_next_1234_p")
	if err != nil {
		t.Fatalf("attachTaskSessionInTmuxWithRunner() error = %v", err)
	}

	want := [][]string{
		{"wait-for", "-L", "agentboard_attach_layout"},
		{"display-message", "-p", "#{pane_id}"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_board_pane"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_board_pane", "%1"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_pane"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_backend_id"},
		{"list-panes", "-t", "%1", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"show-options", "-p", "-q", "-v", "-t", "%9", "@agentboard_backend_session_id"},
		{"kill-pane", "-t", "%9"},
		{"list-panes", "-a", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"set-option", "-p", "-q", "-t", "%2", "@agentboard_backend_session_id", "ab_next_1234_p"},
		{"join-pane", "-h", "-s", "%2", "-t", "%1"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_pane", "%2"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_backend_id", "ab_next_1234_p"},
		{"select-pane", "-t", "%2"},
		{"wait-for", "-U", "agentboard_attach_layout"},
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("tmux calls = %#v, want %#v", runner.calls, want)
	}
}

func TestAttachTaskSessionInTmuxUsesProcessPaneInsteadOfActivePane(t *testing.T) {
	runner := &fakeTmuxRunner{
		fn: func(args []string) (string, error) {
			switch strings.Join(args, " ") {
			case "display-message -p -t %1 #{pane_id}":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_session_pane":
				return "", errors.New("missing option")
			case "list-panes -t %1 -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "", nil
			case "list-panes -a -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%2\tab_task_1234_p\n", nil
			default:
				return "", nil
			}
		},
	}

	err := attachTaskSessionInTmuxWithEnvironment("tmux-env", "%1", runner, "ab_task_1234_p")
	if err != nil {
		t.Fatalf("attachTaskSessionInTmuxWithEnvironment() error = %v", err)
	}

	want := [][]string{
		{"wait-for", "-L", "agentboard_attach_layout"},
		{"display-message", "-p", "-t", "%1", "#{pane_id}"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_board_pane", "%1"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_pane"},
		{"show-options", "-w", "-q", "-v", "-t", "%1", "@agentboard_session_backend_id"},
		{"list-panes", "-t", "%1", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"list-panes", "-a", "-F", "#{pane_id}\t#{@agentboard_backend_session_id}"},
		{"set-option", "-p", "-q", "-t", "%2", "@agentboard_backend_session_id", "ab_task_1234_p"},
		{"join-pane", "-h", "-s", "%2", "-t", "%1"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_pane", "%2"},
		{"set-window-option", "-q", "-t", "%1", "@agentboard_session_backend_id", "ab_task_1234_p"},
		{"select-pane", "-t", "%2"},
		{"wait-for", "-U", "agentboard_attach_layout"},
	}
	if !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("tmux calls = %#v, want %#v", runner.calls, want)
	}
}

func TestAttachTaskSessionInTmuxClearsBoardPaneTag(t *testing.T) {
	runner := &fakeTmuxRunner{
		fn: func(args []string) (string, error) {
			switch strings.Join(args, " ") {
			case "display-message -p #{pane_id}":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_board_pane":
				return "%1\n", nil
			case "show-options -w -q -v -t %1 @agentboard_session_backend_id":
				return "ab_task_1234_p\n", nil
			case "list-panes -t %1 -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%1\tab_task_1234_p\n", nil
			// The board pane is the only pane still carrying the tag: the task
			// pane it belonged to is gone.
			case "list-panes -a -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%1\tab_task_1234_p\n", nil
			default:
				return "", nil
			}
		},
	}

	err := attachTaskSessionInTmuxWithRunner("tmux-env", runner, "ab_task_1234_p")
	if err == nil {
		t.Fatal("attachTaskSessionInTmuxWithRunner() error = nil, want an error")
	}

	untag := []string{"set-option", "-p", "-q", "-u", "-t", "%1", "@agentboard_backend_session_id"}
	found := false
	for _, call := range runner.calls {
		if reflect.DeepEqual(call, untag) {
			found = true
		}
		if call[0] == "join-pane" || call[0] == "break-pane" || call[0] == "kill-pane" {
			t.Fatalf("board pane was moved or killed: %#v", call)
		}
	}
	if !found {
		t.Fatalf("stale board pane tag was not cleared; calls = %#v", runner.calls)
	}
}

func TestAttachTaskSessionInTmuxPrefersUntaggedPaneAsBoard(t *testing.T) {
	runner := &fakeTmuxRunner{
		fn: func(args []string) (string, error) {
			switch strings.Join(args, " ") {
			// A task pane holds focus and the window has not recorded a board
			// pane yet, so the active pane is the wrong answer.
			case "display-message -p #{pane_id}":
				return "%2\n", nil
			case "show-options -w -q -v -t %2 @agentboard_board_pane":
				return "", errors.New("missing option")
			case "list-panes -t %2 -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%1\t\n%2\tab_other_9999_p\n", nil
			case "list-panes -t %1 -F #{pane_id}\t#{@agentboard_backend_session_id}":
				return "%1\t\n%2\tab_other_9999_p\n", nil
			case "display-message -p -t ab_task_1234_p #{pane_id}":
				return "%3\n", nil
			default:
				return "", nil
			}
		},
	}

	if err := attachTaskSessionInTmuxWithRunner("tmux-env", runner, "ab_task_1234_p"); err != nil {
		t.Fatalf("attachTaskSessionInTmuxWithRunner() error = %v", err)
	}

	for _, call := range runner.calls {
		if call[0] == "set-window-option" && len(call) == 6 && call[4] == "@agentboard_board_pane" {
			if call[5] != "%1" {
				t.Fatalf("board pane = %s, want %%1", call[5])
			}
		}
		if call[0] == "join-pane" && call[len(call)-1] != "%1" {
			t.Fatalf("joined into %s, want the board pane %%1", call[len(call)-1])
		}
		if call[0] == "break-pane" && call[3] == "%1" {
			t.Fatal("board pane was broken out into the holding session")
		}
	}
}

func TestAttachTaskSessionInTmuxRequiresTmux(t *testing.T) {
	runner := &fakeTmuxRunner{}

	err := attachTaskSessionInTmuxWithRunner("", runner, "ab_task_1234_p")
	if err == nil {
		t.Fatal("attachTaskSessionInTmuxWithRunner() error = nil, want an error")
	}
	if len(runner.calls) != 0 {
		t.Fatalf("tmux calls = %#v, want none", runner.calls)
	}
}
