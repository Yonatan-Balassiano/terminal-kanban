package tui

import (
	"sort"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// orchestratorColour is one orchestrator's identity on the board: Solid fills
// the orchestrator's own card, Border — a bright shade of the same hue — draws
// its outline, and Tint — a dimmer shade — sits behind the title of every card
// below it, so a family reads as one.
type orchestratorColour struct {
	Solid  string
	Border string
	Tint   string
}

// orchestratorPalette is handed out in orchestrator creation order. The
// colours are deliberately saturated mid-tones: a dark card background next
// to a dark board all but vanishes, and a terminal limited to 256 colours
// rounds a near-black shade to black. TestOrchestratorPaletteIsVisible pins
// the contrast each one needs, both against the board and under uiChrome.Text.
var orchestratorPalette = []orchestratorColour{
	{Solid: "#5b3fc4", Border: "#a78bfa", Tint: "#4a35a0"}, // indigo
	{Solid: "#0f7a6e", Border: "#2dd4bf", Tint: "#0b5049"}, // teal
	{Solid: "#a15c07", Border: "#fbbf24", Tint: "#6b3d05"}, // amber
	{Solid: "#b0245f", Border: "#f472b6", Tint: "#8a1d4b"}, // rose
	{Solid: "#1d5fd1", Border: "#60a5fa", Tint: "#143f8a"}, // blue
	{Solid: "#3d7a1a", Border: "#a3e635", Tint: "#285012"}, // green
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

// taskCardFrame draws the border around a card's rendered lines. An
// orchestrator's card is filled with its own Solid colour and outlined in its
// Border colour, which takes precedence over the state colour the border
// would otherwise carry — that state still shows in the card's header and
// badges, and selection still shows as the double border.
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
	style = style.BorderForeground(lipgloss.Color(colour.Border))
	// Background only, never BorderBackground: a border glyph is drawn in the
	// middle of its cell, so filling that cell puts colour outside the outline.
	return style.
		Background(lipgloss.Color(colour.Solid)).
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
