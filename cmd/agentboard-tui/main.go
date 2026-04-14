package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/wix-private/agentboard-go/internal/tui"
)

func main() {
	socketPath := tui.DefaultSocketPath()
	if value := os.Getenv("AGENTBOARD_SOCKET_PATH"); value != "" {
		socketPath = value
	}

	model, err := tui.NewModel(socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		_ = model.Close()
	}()

	program := tea.NewProgram(model, tea.WithAltScreen())
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
