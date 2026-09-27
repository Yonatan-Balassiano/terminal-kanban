package tui

import (
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// orchestratorColour is one orchestrator's identity on the board: Solid fills
// the orchestrator's own card, and Tint — a dimmer shade of the same hue —
// sits behind the title of every card below it, so a family reads as one.
type orchestratorColour struct {
	Solid string
	Tint  string
}

// orchestratorPalette is handed out in orchestrator creation order. Every
// Solid is dark enough to keep uiChrome.Text readable on top of it.
var orchestratorPalette = []orchestratorColour{
	{Solid: "#3b2a66", Tint: "#271d42"}, // indigo
	{Solid: "#0f4a42", Tint: "#0c302c"}, // teal
	{Solid: "#5a3d0a", Tint: "#3a2808"}, // amber
	{Solid: "#5c2140", Tint: "#3b162a"}, // rose
	{Solid: "#16406e", Tint: "#102a47"}, // blue
	{Solid: "#2b4f1c", Tint: "#1c3313"}, // green
}

// maxParentDepth bounds the walk up a card's parents, so a corrupt parent
// cycle cannot hang the render loop.
const maxParentDepth = 32

// orchestratorColourFor is the colour of `task`'s family: its own if it is an
// orchestrator, otherwise that of the nearest orchestrator above it. False
// when no orchestrator is found.
func (m *Model) orchestratorColourFor(task TaskRecord) (orchestratorColour, bool) {
	byID := make(map[string]TaskRecord, len(m.tasks))
	for _, other := range m.tasks {
		byID[other.ID] = other
	}

	current := task
	for depth := 0; depth < maxParentDepth; depth++ {
		if current.IsOrchestrator {
			return orchestratorPalette[m.orchestratorIndex(current.ID)%len(orchestratorPalette)], true
		}
		parent, ok := byID[current.ParentTaskID]
		if current.ParentTaskID == "" || !ok {
			return orchestratorColour{}, false
		}
		current = parent
	}
	return orchestratorColour{}, false
}

// orchestratorIndex is `taskID`'s position among the board's orchestrators by
// creation time — stable across redraws, unlike column or snapshot order. An
// orchestrator missing from the snapshot counts as the first.
func (m *Model) orchestratorIndex(taskID string) int {
	orchestrators := []TaskRecord{}
	for _, task := range m.tasks {
		if task.IsOrchestrator {
			orchestrators = append(orchestrators, task)
		}
	}
	sort.Slice(orchestrators, func(i, j int) bool {
		if orchestrators[i].CreatedAt != orchestrators[j].CreatedAt {
			return orchestrators[i].CreatedAt < orchestrators[j].CreatedAt
		}
		return orchestrators[i].ID < orchestrators[j].ID
	})
	for index, task := range orchestrators {
		if task.ID == taskID {
			return index
		}
	}
	return 0
}

// renderTaskTitleLines renders a card's title. A card under an orchestrator
// gets that orchestrator's Tint behind its title, across the card's width.
func renderTaskTitleLines(m *Model, task TaskRecord, titleLines []string, isActiveSession bool, width int) []string {
	style := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text))
	if colour, ok := m.orchestratorColourFor(task); ok && !task.IsOrchestrator {
		style = style.Background(lipgloss.Color(colour.Tint)).Width(width)
	}

	rendered := make([]string, 0, len(titleLines))
	for index, line := range titleLines {
		lineStyle := style
		if isActiveSession && index == 0 {
			lineStyle = lineStyle.Bold(true)
		}
		rendered = append(rendered, lineStyle.Render(line))
	}
	return rendered
}

// taskCardFrame draws the border around a card's rendered lines, filling an
// orchestrator's card with its own Solid colour.
func taskCardFrame(m *Model, task TaskRecord, border lipgloss.Border, borderColor string, width int, lines []string) string {
	style := lipgloss.NewStyle().
		Width(width).
		Border(border).
		BorderForeground(lipgloss.Color(borderColor)).
		Padding(0, 1)
	if !task.IsOrchestrator {
		return style.Render(strings.Join(lines, "\n"))
	}
	colour, _ := m.orchestratorColourFor(task)
	background := lipgloss.Color(colour.Solid)
	return style.
		Background(background).
		BorderBackground(background).
		Render(reapplyBackgroundAfterResets(strings.Join(lines, "\n"), colour.Solid))
}

// reapplyBackgroundAfterResets keeps a background under already-styled text.
// Each styled segment ends in a full SGR reset, which would drop the outer
// style's background for the rest of the line — so re-emit it after each one.
func reapplyBackgroundAfterResets(content string, color string) string {
	profileColor := lipgloss.ColorProfile().Color(color)
	if profileColor == nil {
		return content
	}
	sequence := profileColor.Sequence(true)
	if sequence == "" {
		return content
	}
	const reset = "\x1b[0m"
	return strings.ReplaceAll(content, reset, reset+"\x1b["+sequence+"m")
}
