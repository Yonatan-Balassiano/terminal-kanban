package tui

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"
)

const (
	headerHeight    = 2
	statusBarHeight = 1
	// Leads the card header so it survives truncation on narrow cards.
	remoteTaskMarker = "☁ "

	// How far a merged card's change has got towards production. Purple and the
	// tick are reserved for work that is actually live: before this, a change
	// nobody had shipped looked identical to one running in production.
	releaseShippedGlyph = "✓"
	releaseRollingGlyph = "↻"
	releasePendingGlyph = "▲"
	releaseMergedGlyph  = "◇"

	artifactDriftMarker   = "▲"
	artifactInSyncMarker  = "✓"
	artifactOwnedMarker   = "●"
	artifactNoGALabel     = "no GA"
	artifactUnknownLabel  = "?"
	artifactFooterLabel   = "ARTIFACTS"
	artifactStaleNote     = "stale · S refresh"
	artifactSelectedMark  = "▸"
	artifactChipSeparator = "  │  "
	// Two strips pinned above the status bar: a full catalog does not fit on one
	// line at any realistic width, and a hidden artifact is one nobody rolls out.
	artifactFooterHeight = 2
)

var (
	spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	ansiPattern   = regexp.MustCompile(`\x1b\[[0-9;]*m`)
)

var uiChrome = struct {
	Accent      string
	AccentMuted string
	Blue        string
	Danger      string
	Line        string
	Muted       string
	Panel       string
	PanelAlt    string
	Purple      string
	Success     string
	Text        string
	Warning     string
}{
	Accent:      "#7dd3fc",
	AccentMuted: "#164e63",
	Blue:        "#93c5fd",
	Danger:      "#f87171",
	Line:        "#31384a",
	Muted:       "#94a3b8",
	Panel:       "#151827",
	PanelAlt:    "#202637",
	Purple:      "#d8b4fe",
	Success:     "#86efac",
	Text:        "#d7dde8",
	Warning:     "#fbbf24",
}

func renderView(m *Model) string {
	if m.modal != ModalNone {
		return lipgloss.Place(
			m.width,
			m.height,
			lipgloss.Center,
			lipgloss.Center,
			renderModal(m),
			lipgloss.WithWhitespaceBackground(lipgloss.Color("#111827")),
		)
	}

	parts := []string{
		fitHeight(renderHeader(m), headerHeight),
	}

	if shouldShowFilterBar(m.filters, m.focus) {
		parts = append(parts, fitHeight(renderFilterBar(m), 1))
	}

	parts = append(parts, fitHeight(renderContent(m), m.contentHeight()))
	parts = append(parts, fitHeight(renderArtifactFooter(m), artifactFooterHeight))
	parts = append(parts, fitHeight(renderStatusBar(m), statusBarHeight))

	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

func renderContent(m *Model) string {
	contentHeight := m.contentHeight()

	if m.terminalTakesOver() {
		return renderTerminalPane(m, contentHeight, true)
	}

	showSplitTerminal := m.sidePaneShouldRender()
	stacked := showSplitTerminal && m.terminalLayoutMode == TerminalLayoutMode("top-bottom")

	if !showSplitTerminal {
		if m.boardOverviewMode {
			return renderOverviewBoard(m, contentHeight, m.width)
		}
		return renderBoard(m, contentHeight, m.width)
	}

	if stacked {
		dividerHeight := 0
		if contentHeight >= 3 {
			dividerHeight = 1
		}
		boardHeight := max(1, (contentHeight-dividerHeight+1)/2)
		terminalHeight := max(1, contentHeight-boardHeight-dividerHeight)
		boardFn := renderBoard
		if m.boardOverviewMode {
			boardFn = renderOverviewBoard
		}
		chunks := []string{
			fitHeight(boardFn(m, boardHeight, m.width), boardHeight),
		}
		if dividerHeight > 0 {
			chunks = append(chunks, fitHeight(lipgloss.NewStyle().Foreground(lipgloss.Color("cyan")).Render(strings.Repeat("─", max(1, m.width))), 1))
		}
		chunks = append(chunks, fitHeight(renderSidePane(m, terminalHeight, true), terminalHeight))
		return lipgloss.JoinVertical(lipgloss.Left, chunks...)
	}

	boardWidth := m.sideBySideBoardWidth()
	boardRenderFn := renderBoard
	if m.boardOverviewMode {
		boardRenderFn = renderOverviewBoard
	}
	boardView := fitSize(boardRenderFn(m, contentHeight, boardWidth), boardWidth, contentHeight)
	terminalView := fitHeight(renderSidePane(m, contentHeight, false), contentHeight)
	divider := renderVerticalDivider(contentHeight)
	return lipgloss.JoinHorizontal(lipgloss.Top, boardView, divider, terminalView)
}

func renderHeader(m *Model) string {
	activeRepo := m.repoByID(m.activeRepoID)
	var activeView *SavedViewRecord
	for _, view := range m.savedViews {
		if view.ID == m.activeViewID {
			activeView = &view
			break
		}
	}

	contextTask := m.contextTask()
	var contextTrack *TrackRecord
	if contextTask != nil {
		for _, track := range m.tracks {
			if track.ID == contextTask.TrackID {
				contextTrack = &track
				break
			}
		}
	}

	var contextPillar *PillarRecord
	if contextTask != nil && contextTask.PillarID != "" {
		for _, pillar := range m.pillars {
			if pillar.ID == contextTask.PillarID {
				contextPillar = &pillar
				break
			}
		}
	}

	contextRepo := (*RepoRecord)(nil)
	if contextTask != nil {
		contextRepo = m.repoByID(contextTask.RepoID)
	}

	busySessions := 0
	attentionTasks := 0
	for _, task := range m.tasks {
		if task.SessionAttentionNeeded {
			attentionTasks++
		}
		if task.SessionID != "" || task.SecondarySessionID != "" {
			if activity := m.sessionActivityByTaskID[task.ID]; activity != nil && activity.IsBusy {
				busySessions++
			}
		}
	}

	row1Left := []string{
		badge("agentboard", "accent", "", false),
		badge(repoPositionLabel(m, activeRepo), "muted", "◈", false),
	}
	if activeView != nil {
		row1Left = append(row1Left, badge(truncateText(activeView.Label, 16), "purple", "⌘", false))
	}

	activeFilters := countActiveFilters(m.filters)
	if activeFilters > 0 {
		row1Left = append(row1Left, badge(fmt.Sprintf("%d", activeFilters), "muted", "⚲", false))
	}

	row1Right := []string{}
	if attentionTasks > 0 {
		label := "1 attention"
		if attentionTasks != 1 {
			label = fmt.Sprintf("%d attention", attentionTasks)
		}
		row1Right = append(row1Right, badge(label, "info", "!", false))
	}
	if busySessions > 0 {
		label := "1 running"
		if busySessions != 1 {
			label = fmt.Sprintf("%d running", busySessions)
		}
		row1Right = append(row1Right, badge(label, "warning", "◌", false))
	}
	if m.syncInProgress {
		row1Right = append(row1Right, badge("syncing", "warning", "↻", false))
	}
	if m.daemonConnected {
		row1Right = append(row1Right, badge("daemon", "success", "●", false))
	} else {
		row1Right = append(row1Right, badge("offline", "danger", "○", false))
	}

	row1 := joinSpaceBetween(strings.Join(row1Left, " "), strings.Join(row1Right, " "), m.width)

	row2Left := ""
	if contextTask != nil {
		parts := []string{
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render(truncateText(contextTask.Title, 48)),
			headerText("≡", valueOrTrack(contextTrack, contextTask.TrackID), uiChrome.Accent),
			headerText("◈", taskRepoLabel(*contextTask, contextRepo), uiChrome.Blue),
			headerText("⌂", workspaceKind(contextTask), workspaceColor(contextTask)),
		}
		if contextPillar != nil {
			color := contextPillar.Color
			if color == "" {
				color = uiChrome.Purple
			}
			icon := contextPillar.Icon
			if icon == "" {
				icon = "⬢"
			}
			parts = append(parts, headerText(icon, contextPillar.Label, color))
		}
		row2Left = strings.Join(parts, " ")
	} else {
		row2Left = lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("No task selected")
	}

	row2Right := []string{}
	if contextTask != nil {
		branchLabel := contextTask.BranchName
		if m.activeTaskID == contextTask.ID && m.terminalBranchForSlot(m.focusedTerminalSlot) != "" {
			branchLabel = m.terminalBranchForSlot(m.focusedTerminalSlot)
		}
		if branchLabel != "" {
			row2Right = append(row2Right, badge(truncateText(branchLabel, 20), "muted", "⎇", false))
		}
		if contextTask.SecondarySessionID != "" {
			row2Right = append(row2Right, badge("dual", "info", "⇵", false))
		}
		row2Right = append(row2Right, renderSessionActivityBadge(m, contextTask, true))
	}

	row2 := joinSpaceBetween(row2Left, strings.Join(row2Right, " "), m.width)
	return fitHeight(row1+"\n"+row2, headerHeight)
}

func renderFilterBar(m *Model) string {
	chips := []string{
		badge(fmt.Sprintf("%d", countActiveFilters(m.filters)), "muted", "⚲", false),
	}
	for _, id := range m.filters.RepoIDs {
		label := id
		if repo := m.repoByID(id); repo != nil {
			label = repo.Label
		}
		chips = append(chips, badge(label, "accent", "◈", false))
	}
	for _, id := range m.filters.PillarIDs {
		label := id
		icon := "⬢"
		for _, pillar := range m.pillars {
			if pillar.ID == id {
				label = pillar.Label
				if pillar.Icon != "" {
					icon = pillar.Icon
				}
				break
			}
		}
		chips = append(chips, badge(label, "purple", icon, false))
	}
	if m.filters.SearchText != "" {
		chips = append(chips, badge(m.filters.SearchText, "success", "/", false))
	}

	right := "Filtered board"
	if m.focus == FocusFilterBar || m.focus == FocusSearch {
		right = "[f] edit  [/] search  [:] commands  [Esc] clear"
	}

	return joinSpaceBetween(
		strings.Join(chips, " "),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(right),
		m.width,
	)
}

func renderBoard(m *Model, height int, width int) string {
	tracks := m.sortedTracks()
	plan := planBoardRender(m, width, tracks)
	parts := []string{}

	if len(m.repos) == 0 {
		board := fitHeight(
			lipgloss.NewStyle().
				Padding(1, 2).
				Foreground(lipgloss.Color(uiChrome.Muted)).
				Render("No repos registered. Run: agentboard repos add <path>"),
			height,
		)
		parts = append(parts, board)
		return fitSize(lipgloss.JoinHorizontal(lipgloss.Top, parts...), width, height)
	}

	repoLabels := map[string]string{}
	for _, repo := range m.repos {
		repoLabels[repo.ID] = repo.Label
	}

	columns := []string{}
	tasksByTrack := m.tasksByTrack()
	for trackIndex := plan.trackStart; trackIndex < plan.trackEnd; trackIndex++ {
		track := tracks[trackIndex]
		tasks := tasksByTrack[track.ID]
		isSelected := trackIndex == m.selectedTrackIndex
		if plan.collapsedTrackIDs[track.ID] {
			columns = append(columns, renderCollapsedTrack(m, track, tasks, isSelected, height))
			continue
		}
		if plan.compactTracks {
			columns = append(columns, renderTrackWithWidth(m, track, tasks, isSelected, height, repoLabels, plan.trackRenderWidth, true))
			continue
		}
		columns = append(columns, renderTrack(m, track, tasks, isSelected, height, repoLabels))
	}

	board := fitHeight(lipgloss.JoinHorizontal(lipgloss.Top, columns...), height)
	parts = append(parts, board)
	return fitSize(lipgloss.JoinHorizontal(lipgloss.Top, parts...), width, height)
}

type boardRenderPlan struct {
	compactTracks     bool
	trackStart        int
	trackEnd          int
	trackRenderWidth  int
	collapsedTrackIDs map[string]bool
}

func planBoardRender(m *Model, width int, tracks []TrackRecord) boardRenderPlan {
	trackCount := len(tracks)
	if trackCount == 0 {
		return boardRenderPlan{
			trackRenderWidth:  trackColumnRenderWidth,
			collapsedTrackIDs: map[string]bool{},
		}
	}

	selectedTrackIndex := clamp(m.selectedTrackIndex, 0, trackCount-1)
	collapsedTrackIDs := collapsedTrackIDsForBoardWidth(m, width)
	delete(collapsedTrackIDs, tracks[selectedTrackIndex].ID)
	if width >= boardRenderWidthWithCollapsed(m, collapsedTrackIDs) {
		return boardRenderPlan{
			trackStart:        0,
			trackEnd:          trackCount,
			trackRenderWidth:  trackColumnRenderWidth,
			collapsedTrackIDs: collapsedTrackIDs,
		}
	}

	trackBudget := width
	compactTracks := trackBudget < trackColumnRenderWidth
	trackRenderWidth := trackColumnRenderWidth
	visibleTrackCount := 1
	if compactTracks {
		trackRenderWidth = max(1, trackBudget)
	} else {
		visibleTrackCount = clamp(trackBudget/trackColumnRenderWidth, 1, trackCount)
	}

	trackStart := selectedTrackIndex - visibleTrackCount/2
	trackStart = clamp(trackStart, 0, max(0, trackCount-visibleTrackCount))
	return boardRenderPlan{
		compactTracks:     compactTracks,
		trackStart:        trackStart,
		trackEnd:          min(trackCount, trackStart+visibleTrackCount),
		trackRenderWidth:  trackRenderWidth,
		collapsedTrackIDs: map[string]bool{},
	}
}

// The footer is the only always-visible surface for artifact state, so it spans
// two rows rather than hiding artifacts behind an overflow marker. Degraded
// modes carry no versions worth wrapping and stay on the head row.
func renderArtifactFooter(m *Model) string {
	width := max(1, m.width)
	head := renderArtifactFooterHead(m.artifacts)
	budget := width - plainWidth(head) - 1

	if note, color := artifactFooterNote(m.artifacts); note != "" {
		body := lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Render(truncateText(note, max(1, budget)))
		return fitWidth(head+" "+body, width)
	}

	first, second := renderArtifactChipRows(m.artifacts, m.selectedArtifactIndex, budget, width)
	strip := fitWidth(head+" "+first, width)
	if second == "" {
		return strip
	}
	return strip + "\n" + fitWidth(second, width)
}

func renderArtifactFooterHead(snapshot ArtifactsSnapshot) string {
	driftCount := countArtifactDrift(snapshot.Artifacts)
	countColor := ternaryString(driftCount > 0, uiChrome.Warning, uiChrome.Muted)
	head := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Accent)).Render(artifactFooterLabel) +
		" " + lipgloss.NewStyle().Foreground(lipgloss.Color(countColor)).Render(fmt.Sprintf("%s%d", artifactDriftMarker, driftCount))
	if owned := countArtifactOwnedPending(snapshot.Artifacts); owned > 0 {
		head += " " + artifactOwnedStyle(snapshot.Stale).Render(fmt.Sprintf("%s%d", artifactOwnedMarker, owned))
	}
	if !snapshot.Stale {
		return head
	}
	return head + " " + lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Warning)).Render(artifactStaleNote)
}

// A note replaces the chips entirely: with no confirmed catalog there are no
// versions worth showing next to it.
func artifactFooterNote(snapshot ArtifactsSnapshot) (string, string) {
	switch {
	case snapshot.NeedsAuth:
		return "sign in required · run: agentboard mcp login", uiChrome.Warning
	case snapshot.RefreshedAt == 0:
		return "loading…", uiChrome.Muted
	case len(snapshot.Artifacts) == 0:
		return "no artifacts", uiChrome.Muted
	default:
		return "", ""
	}
}

// renderArtifactChipRows lays the chips out over the two footer rows. The first
// row is narrower because it shares its line with the head.
func renderArtifactChipRows(snapshot ArtifactsSnapshot, selectedIndex, firstWidth, secondWidth int) (string, string) {
	chips := make([]string, len(snapshot.Artifacts))
	chipWidths := make([]int, len(snapshot.Artifacts))
	for index, artifact := range snapshot.Artifacts {
		chips[index] = renderArtifactChip(artifact, index == selectedIndex, snapshot.Stale)
		chipWidths[index] = plainWidth(chips[index])
	}

	start, split, end := artifactChipRows(chipWidths, selectedIndex, [2]int{firstWidth, secondWidth})
	first := slices.Clone(chips[start:split])
	second := slices.Clone(chips[split:end])
	hidden := len(chips) - (end - start)
	if len(second) > 0 {
		second = withOverflowMarker(second, hidden, secondWidth)
	} else {
		first = withOverflowMarker(first, hidden, firstWidth)
	}
	return joinArtifactChips(first), joinArtifactChips(second)
}

// The marker is dropped rather than truncated when it genuinely cannot fit: a
// clipped "+" reads as noise, while a visible chip still carries information.
func withOverflowMarker(row []string, hidden, width int) []string {
	if hidden <= 0 {
		return row
	}
	marked := append(slices.Clone(row), lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(artifactOverflowLabel(hidden)))
	if plainWidth(joinArtifactChips(marked)) > width {
		return row
	}
	return marked
}

func joinArtifactChips(chips []string) string {
	separator := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Line)).Render(artifactChipSeparator)
	return strings.Join(chips, separator)
}

// artifactChipRows returns the half-open bounds of the two rows: chips[start:split]
// and chips[split:end]. The window slides rather than always starting at zero so
// the selected chip cannot be pushed off the strip by the artifacts in front of it.
func artifactChipRows(chipWidths []int, selectedIndex int, rowWidths [2]int) (int, int, int) {
	if len(chipWidths) == 0 {
		return 0, 0, 0
	}
	selectedIndex = clamp(selectedIndex, 0, len(chipWidths)-1)

	for start := 0; start <= selectedIndex; start++ {
		split := artifactChipFit(chipWidths, start, rowWidths[0])
		end := artifactChipFit(chipWidths, split, rowWidths[1])
		split, end = artifactReserveOverflow(chipWidths, start, split, end, rowWidths)
		if end > selectedIndex {
			return start, artifactBalancedSplit(chipWidths, start, split, end, rowWidths), end
		}
	}
	return selectedIndex, selectedIndex, selectedIndex + 1
}

// artifactChipFit reports the exclusive end index of the chips that fit on one
// row starting at start.
func artifactChipFit(chipWidths []int, start, width int) int {
	used, end := 0, start
	for index := start; index < len(chipWidths); index++ {
		next := used + chipWidths[index]
		if index > start {
			next += plainWidth(artifactChipSeparator)
		}
		if next > width {
			break
		}
		used, end = next, index+1
	}
	return end
}

// Dropping chips is a last resort, but once it happens the count must not itself
// be pushed off the edge, so the trailing row gives way until the marker fits.
func artifactReserveOverflow(chipWidths []int, start, split, end int, rowWidths [2]int) (int, int) {
	for end-start < len(chipWidths) {
		hidden := len(chipWidths) - (end - start)
		if end > split {
			if end <= split+1 || artifactRowFitsOverflow(chipWidths, split, end, hidden, rowWidths[1]) {
				return split, end
			}
			end--
			continue
		}
		if split <= start+1 || artifactRowFitsOverflow(chipWidths, start, split, hidden, rowWidths[0]) {
			return split, end
		}
		split, end = split-1, split-1
	}
	return split, end
}

func artifactRowFitsOverflow(chipWidths []int, start, end, hidden, width int) bool {
	used := artifactRowWidth(chipWidths, start, end)
	if end > start {
		used += plainWidth(artifactChipSeparator)
	}
	return used+plainWidth(artifactOverflowLabel(hidden)) <= width
}

// Greedy packing crams the first row full and leaves a stub below it. Walking the
// split back evens the two rows out; the loop stops as soon as the second row
// stops fitting, since every earlier split only makes it longer.
func artifactBalancedSplit(chipWidths []int, start, split, end int, rowWidths [2]int) int {
	hidden := len(chipWidths) - (end - start)
	best, bestGap := split, artifactRowGap(chipWidths, start, split, end)
	for candidate := split - 1; candidate > start; candidate-- {
		if hidden > 0 && !artifactRowFitsOverflow(chipWidths, candidate, end, hidden, rowWidths[1]) {
			break
		}
		if artifactRowWidth(chipWidths, candidate, end) > rowWidths[1] {
			break
		}
		if gap := artifactRowGap(chipWidths, start, candidate, end); gap < bestGap {
			best, bestGap = candidate, gap
		}
	}
	return best
}

func artifactRowGap(chipWidths []int, start, split, end int) int {
	gap := artifactRowWidth(chipWidths, start, split) - artifactRowWidth(chipWidths, split, end)
	if gap < 0 {
		return -gap
	}
	return gap
}

func artifactRowWidth(chipWidths []int, start, end int) int {
	total := 0
	for index := start; index < end; index++ {
		total += chipWidths[index]
		if index > start {
			total += plainWidth(artifactChipSeparator)
		}
	}
	return total
}

func artifactOverflowLabel(hidden int) string {
	return fmt.Sprintf("+%d", hidden)
}

func renderArtifactChip(artifact ArtifactRecord, selected bool, dim bool) string {
	label := artifactDisplayName(artifact) + " " + artifactChipState(artifact)
	if selected {
		label = artifactSelectedMark + label
	}

	style := lipgloss.NewStyle().Foreground(lipgloss.Color(artifactChipColor(artifact, selected, dim)))
	if selected {
		style = style.Bold(true).Background(lipgloss.Color(uiChrome.AccentMuted))
	}

	chip := style.Render(label)
	if owned := artifactOwnedLabel(artifact); owned != "" {
		chip += " " + artifactOwnedStyle(dim).Render(owned)
	}
	if tag := artifactModeTag(artifact); tag != "" {
		chip += " " + lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(tag)
	}
	return chip
}

// "Which of these am I holding up?" is the question the footer exists to answer,
// so the ownership marker outranks the drift marker visually. An unresolved
// ownership count renders nothing at all: a 0 would read as a confident "none of
// this is yours", which is a different and possibly wrong claim.
func artifactOwnedLabel(artifact ArtifactRecord) string {
	if artifact.MyPendingCount == nil || *artifact.MyPendingCount <= 0 {
		return ""
	}
	return fmt.Sprintf("%s%d", artifactOwnedMarker, *artifact.MyPendingCount)
}

func artifactOwnedStyle(dim bool) lipgloss.Style {
	color := ternaryString(dim, uiChrome.Muted, uiChrome.Purple)
	return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(color))
}

// The version slot never renders blank: a package that never goes GA says so
// rather than looking like a failed read.
func artifactChipState(artifact ArtifactRecord) string {
	switch artifact.Status {
	case ArtifactStatusDrift:
		return artifact.GAVersion + artifactDriftLabel(artifact)
	case ArtifactStatusInSync:
		return artifact.GAVersion + artifactInSyncMarker
	case ArtifactStatusNoGA:
		return artifactNoGALabel
	default:
		return artifactUnknownLabel
	}
}

func artifactDriftLabel(artifact ArtifactRecord) string {
	if artifact.Drift == nil {
		return artifactDriftMarker
	}
	return fmt.Sprintf("%s%d", artifactDriftMarker, *artifact.Drift)
}

func artifactChipColor(artifact ArtifactRecord, selected bool, dim bool) string {
	switch {
	case selected:
		return uiChrome.Accent
	case dim:
		return uiChrome.Muted
	case artifact.Status == ArtifactStatusDrift:
		return uiChrome.Warning
	case artifact.Status == ArtifactStatusInSync:
		return uiChrome.Success
	default:
		return uiChrome.Muted
	}
}

func countArtifactDrift(artifacts []ArtifactRecord) int {
	count := 0
	for _, artifact := range artifacts {
		if artifact.Status == ArtifactStatusDrift {
			count++
		}
	}
	return count
}

// Counts artifacts, not commits: the head answers "how many of these are on me?".
func countArtifactOwnedPending(artifacts []ArtifactRecord) int {
	count := 0
	for _, artifact := range artifacts {
		if artifactOwnedLabel(artifact) != "" {
			count++
		}
	}
	return count
}

func artifactModeTag(artifact ArtifactRecord) string {
	if artifact.Mode == "" || artifact.Mode == ArtifactModeLive {
		return ""
	}
	return string(artifact.Mode)
}

func artifactDisplayName(artifact ArtifactRecord) string {
	if artifact.ShortName != "" {
		return artifact.ShortName
	}
	return artifact.Name
}

func collapsedTrackIDsForBoardWidth(m *Model, width int) map[string]bool {
	collapsed := map[string]bool{}
	if width <= 0 || width >= m.boardRenderWidth() {
		return collapsed
	}

	tracks := m.sortedTracks()
	for index := len(tracks) - 1; index >= 0; index-- {
		track := tracks[index]
		if !isCollapsibleTrack(track) {
			continue
		}
		collapsed[track.ID] = true
		if boardRenderWidthWithCollapsed(m, collapsed) <= width {
			return collapsed
		}
	}

	return collapsed
}

func boardRenderWidthWithCollapsed(m *Model, collapsed map[string]bool) int {
	width := 0
	for _, track := range m.sortedTracks() {
		if collapsed[track.ID] {
			width += collapsedTrackRenderWidth
			continue
		}
		width += trackColumnRenderWidth
	}
	return width
}

func isCollapsibleTrack(track TrackRecord) bool {
	value := strings.ToLower(track.ID + " " + track.Label)
	return strings.Contains(value, "merged") || strings.Contains(value, "merge") || strings.Contains(value, "done")
}

func renderTrack(m *Model, track TrackRecord, tasks []TaskRecord, isSelected bool, height int, repoLabels map[string]string) string {
	return renderTrackWithWidth(m, track, tasks, isSelected, height, repoLabels, trackColumnRenderWidth, false)
}

func renderTrackWithWidth(m *Model, track TrackRecord, tasks []TaskRecord, isSelected bool, height int, repoLabels map[string]string, renderWidth int, compact bool) string {
	isBoardSelection := isSelected && (m.focus == FocusBoard || m.terminalBoardNavPending)
	trackStyleWidth := max(1, renderWidth-2)
	headerWidth := max(1, trackStyleWidth-2)
	taskCardStyleWidth := max(1, trackStyleWidth-2)
	taskCardContentWidth := max(1, taskCardStyleWidth-2)
	listDensity := m.boardDensityMode == "list"
	taskHeights := make([]int, 0, len(tasks))
	for _, task := range tasks {
		if listDensity {
			taskHeights = append(taskHeights, 1)
		} else {
			taskHeights = append(taskHeights, taskCardHeightForWidth(m, task, taskCardContentWidth, compact))
		}
	}
	listHeight := max(1, height-3)
	windowStart, windowEnd := visibleWindow(taskHeights, ternaryInt(isSelected, m.selectedTaskIndex, 0), listHeight)
	visibleTasks := tasks[windowStart:windowEnd]

	header := joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(isBoardSelection, uiChrome.Accent, uiChrome.Text))).Render(strings.ToUpper(track.Label)),
		lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(isBoardSelection, uiChrome.Accent, uiChrome.Muted))).Render(fmt.Sprintf("%d", len(tasks))),
		headerWidth,
	)

	bodyLines := []string{}
	if len(tasks) == 0 {
		bodyLines = append(bodyLines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText("No tasks", headerWidth)))
	} else {
		for offset, task := range visibleTasks {
			actualIndex := windowStart + offset
			if listDensity {
				bodyLines = append(bodyLines, renderTaskRow(
					m,
					task,
					isBoardSelection && actualIndex == m.selectedTaskIndex,
					m.activeTaskID == task.ID,
					m.sessionActivityByTaskID[task.ID],
					repoLabels[task.RepoID],
					taskCardContentWidth,
				))
			} else {
				bodyLines = append(bodyLines, renderTaskCardWithWidth(
					m,
					task,
					isBoardSelection && actualIndex == m.selectedTaskIndex,
					m.activeTaskID == task.ID,
					m.sessionActivityByTaskID[task.ID],
					repoLabels[task.RepoID],
					taskCardStyleWidth,
					taskCardContentWidth,
					compact,
				))
			}
		}
	}

	border := lipgloss.NormalBorder()
	if isBoardSelection {
		border = lipgloss.RoundedBorder()
	}

	return fitHeight(
		lipgloss.NewStyle().
			Width(trackStyleWidth).
			Height(height).
			Border(border).
			BorderForeground(lipgloss.Color(ternaryString(isBoardSelection, uiChrome.Accent, uiChrome.Line))).
			Render(header+"\n"+strings.Join(bodyLines, "\n")),
		height,
	)
}

func renderCollapsedTrack(m *Model, track TrackRecord, tasks []TaskRecord, isSelected bool, height int) string {
	isBoardSelection := isSelected && (m.focus == FocusBoard || m.terminalBoardNavPending)
	contentWidth := collapsedTrackHeaderWidth
	label := truncateText(strings.ToUpper(track.Label), contentWidth)
	lines := []string{
		lipgloss.NewStyle().
			Foreground(lipgloss.Color(ternaryString(isBoardSelection, uiChrome.Accent, uiChrome.Text))).
			Render(label),
		lipgloss.NewStyle().
			Foreground(lipgloss.Color(ternaryString(isBoardSelection, uiChrome.Accent, uiChrome.Muted))).
			Render(fmt.Sprintf("%d", len(tasks))),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("hidden"),
	}

	border := lipgloss.NormalBorder()
	if isBoardSelection {
		border = lipgloss.RoundedBorder()
	}

	return fitHeight(
		lipgloss.NewStyle().
			Width(collapsedTrackStyleWidth).
			Height(height).
			Border(border).
			BorderForeground(lipgloss.Color(ternaryString(isBoardSelection, uiChrome.Accent, uiChrome.Line))).
			Render(strings.Join(lines, "\n")),
		height,
	)
}

func renderTaskCard(m *Model, task TaskRecord, isSelected, isActiveSession bool, activity *SessionActivitySnapshot, repoLabel string) string {
	return renderTaskCardWithWidth(m, task, isSelected, isActiveSession, activity, repoLabel, taskCardStyleWidth, taskCardContentWidth, false)
}

func renderTaskCardWithWidth(m *Model, task TaskRecord, isSelected, isActiveSession bool, activity *SessionActivitySnapshot, repoLabel string, cardStyleWidth int, contentWidth int, compact bool) string {
	borderColor := taskCardBorderColor(task, isSelected)
	if task.SessionAttentionNeeded {
		if m.spinnerIndex%2 == 0 {
			borderColor = uiChrome.Warning
		} else {
			borderColor = uiChrome.Danger
		}
	}
	headerStatus := headerStatusModel(m, task, activity, isActiveSession)
	activeSessionIcon := headerStatus.Icon
	descriptionLines := descriptionLinesForWidth(task.Description, contentWidth)
	titleText := task.Title
	if task.SessionAttentionNeeded {
		titleText = "⚠ " + titleText
	}
	titleLines := taskTitleLinesForWidth(titleText, contentWidth)
	branchLabel := ""
	if !task.IsGeneral() {
		branchLabel = truncateText(compactBranchLabel(task.BranchName), min(16, max(1, contentWidth/2)))
	}
	headerLabel := truncateText(taskCardHeaderLabel(task, repoLabel), contentWidth)

	lines := []string{
		lipgloss.NewStyle().Foreground(lipgloss.Color(headerStatus.Color)).Render(activeSessionIcon) + " " +
			lipgloss.NewStyle().Foreground(lipgloss.Color(ternaryString(isSelected, uiChrome.Accent, uiChrome.Blue))).Render(headerLabel),
	}
	if compact {
		for index, line := range titleLines {
			style := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text))
			if isActiveSession && index == 0 {
				style = style.Bold(true)
			}
			lines = append(lines, style.Render(line))
		}
		lines = append(lines, joinSpaceBetween(
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("#"+truncateText(task.ID, min(8, contentWidth))),
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(branchLabel),
			contentWidth,
		))

		border := lipgloss.RoundedBorder()
		if isSelected || isActiveSession {
			border = lipgloss.DoubleBorder()
		}

		return lipgloss.NewStyle().
			Width(cardStyleWidth).
			Border(border).
			BorderForeground(lipgloss.Color(borderColor)).
			Padding(0, 1).
			Render(strings.Join(lines, "\n"))
	}

	lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Line)).Render(strings.Repeat("─", contentWidth)))
	for index, line := range titleLines {
		style := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text))
		if isActiveSession && index == 0 {
			style = style.Bold(true)
		}
		lines = append(lines, style.Render(line))
	}
	githubStatus := githubStatusBadgeModel(task)
	if githubStatus != nil {
		lines = append(lines, badge(
			truncateText(githubStatus.Label, contentWidth-2),
			githubStatus.Tone,
			"",
			true,
		))
	}
	// A card with one branch is the old card and must stay byte-identical, so
	// the rollup only appears once there is genuinely more than one PR to sum up.
	if hasMultipleBranches(task) {
		lines = append(lines,
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Accent)).Render(truncateText(taskBranchRollupLine(task), contentWidth)),
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(taskBranchGlyphStrip(task), contentWidth)),
		)
	}
	for _, dl := range descriptionLines {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(dl))
	}
	lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Line)).Render(strings.Repeat("─", contentWidth)))

	metaParts := []string{}
	if pillar := pillarLabel(m.pillars, task.PillarID); pillar != "" {
		metaParts = append(metaParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(pillar))
	}
	if task.SecondarySessionID != "" {
		metaParts = append(metaParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Warning)).Render("⇵ dual"))
	}
	// A general task owns no branch, so the ⎇ chip would be a lie.
	if !task.IsGeneral() {
		metaParts = append(metaParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("⎇ "+branchLabel))
	}
	lines = append(lines, strings.Join(metaParts, " "))

	gitStatus := gitStatus(task)
	rightMeta := formatRelativeAge(task.UpdatedAt)
	if gitStatus != "" {
		rightMeta = gitStatus + " " + rightMeta
	}
	lines = append(lines, joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("#"+truncateText(task.ID, 8)),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(rightMeta),
		contentWidth,
	))

	border := lipgloss.RoundedBorder()
	if isSelected || isActiveSession {
		border = lipgloss.DoubleBorder()
	}

	return lipgloss.NewStyle().
		Width(cardStyleWidth).
		Border(border).
		BorderForeground(lipgloss.Color(borderColor)).
		Padding(0, 1).
		Render(strings.Join(lines, "\n"))
}

// overviewScope is one selectable row on the overview screen: every repo, plus
// the repo-less "General" scope so general cards are reachable from somewhere
// other than the all-repos view.
type overviewScope struct {
	ID    string
	Label string
}

func (m *Model) overviewScopes() []overviewScope {
	scopes := make([]overviewScope, 0, len(m.repos)+1)
	for _, repo := range m.repos {
		label := repo.Label
		if label == "" {
			label = repo.ID
		}
		scopes = append(scopes, overviewScope{ID: repo.ID, Label: label})
	}

	// With neither repos nor general cards there is nothing to scope to, and the
	// "register a repo" hint is more useful than a lone empty row.
	if len(scopes) == 0 && !m.hasGeneralTasks() {
		return nil
	}
	return append(scopes, overviewScope{ID: GeneralScopeID, Label: "General"})
}

func (m *Model) hasGeneralTasks() bool {
	for _, task := range m.tasks {
		if task.IsGeneral() {
			return true
		}
	}
	return false
}

// taskScopeID is the overview row a task counts toward.
func taskScopeID(task TaskRecord) string {
	if task.IsGeneral() {
		return GeneralScopeID
	}
	return task.RepoID
}

func renderOverviewBoard(m *Model, height int, width int) string {
	scopes := m.overviewScopes()
	if len(scopes) == 0 {
		return fitHeight(
			lipgloss.NewStyle().Padding(1, 2).Foreground(lipgloss.Color(uiChrome.Muted)).
				Render("No repos registered. Run: agentboard repos add <path>"),
			height,
		)
	}

	// Keyed by scope, not repo ID, so general tasks land in their own row
	// instead of an empty-string bucket nothing renders.
	tasksByScope := map[string][]TaskRecord{}
	for _, task := range m.visibleTasks() {
		tasksByScope[taskScopeID(task)] = append(tasksByScope[taskScopeID(task)], task)
	}

	contentWidth := max(1, width-2)
	rows := []string{}
	for i, repo := range scopes {
		tasks := tasksByScope[repo.ID]

		var activeSessions, prCount, doneCount int
		var attentionTitle string
		var activeTitle string
		for _, t := range tasks {
			if t.SessionAttentionNeeded && attentionTitle == "" {
				attentionTitle = t.Title
			}
			if t.SessionID != "" && activeTitle == "" {
				activeTitle = t.Title
			}
			if t.SessionID != "" {
				activeSessions++
			}
			if t.PRState == "open" || t.PRState == "draft" {
				prCount++
			}
			if t.TrackID == "done" {
				doneCount++
			}
		}

		// Status column: attention > active > idle
		statusText := ""
		statusColor := uiChrome.Muted
		if attentionTitle != "" {
			statusText = "⚠ " + truncatePlain(attentionTitle, 22) + " needs input"
			statusColor = uiChrome.Warning
		} else if activeTitle != "" {
			statusText = "▶ " + truncatePlain(activeTitle, 24)
			statusColor = uiChrome.Accent
		} else {
			statusText = "idle"
		}

		// Count chips
		activeStr := "──"
		if activeSessions > 0 {
			activeStr = fmt.Sprintf("▶%d", activeSessions)
		}
		// General tasks can never have a PR, so the column stays blank for them
		// rather than reporting a zero that reads like "none yet".
		prStr := "──"
		if repo.ID != GeneralScopeID {
			prStr = fmt.Sprintf("PR %d", prCount)
		}
		doneStr := fmt.Sprintf("✓%d", doneCount)

		repoLabel := repo.Label

		left := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Text)).Render(truncatePlain(repoLabel, 10)) +
			"  " +
			lipgloss.NewStyle().Foreground(lipgloss.Color(statusColor)).Render(truncatePlain(statusText, 36))
		right := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(activeStr) +
			"  " +
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Blue)).Render(prStr) +
			"  " +
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Success)).Render(doneStr)

		isSelected := i == m.overviewSelectedIndex
		isActive := m.activeRepoID == repo.ID
		rowStyle := lipgloss.NewStyle().Width(contentWidth)
		if isSelected {
			rowStyle = rowStyle.Background(lipgloss.Color(uiChrome.PanelAlt))
		}
		if isActive && !isSelected {
			rowStyle = rowStyle.Foreground(lipgloss.Color(uiChrome.AccentMuted))
		}
		_ = isActive
		rows = append(rows, rowStyle.Render(joinSpaceBetween(left, right, contentWidth)))
	}

	body := strings.Join(rows, "\n")
	hint := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("↑/↓ move  Enter → filter to scope  0 all repos  O/Esc exit")

	return fitHeight(
		lipgloss.NewStyle().
			Width(contentWidth).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(uiChrome.Line)).
			Render(body+"\n\n"+hint),
		height,
	)
}

func renderTaskRow(m *Model, task TaskRecord, isSelected, isActiveSession bool, activity *SessionActivitySnapshot, repoLabel string, contentWidth int) string {
	headerStatus := headerStatusModel(m, task, activity, isActiveSession)

	githubStatus := githubStatusBadgeModel(task)
	rightParts := []string{}
	if task.IsGeneral() {
		rightParts = append(rightParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("gen"))
	} else if repoLabel != "" {
		rightParts = append(rightParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncatePlain(repoLabel, 5)))
	}
	if githubStatus != nil {
		rightParts = append(rightParts, lipgloss.NewStyle().Foreground(lipgloss.Color(toneColor(githubStatus.Tone))).Render(truncatePlain(githubStatus.Label, 14)))
	}
	right := strings.Join(rightParts, " ")
	rightW := plainWidth(right)

	leftBudget := max(1, contentWidth-rightW-1)
	iconStr := lipgloss.NewStyle().Foreground(lipgloss.Color(headerStatus.Color)).Render(headerStatus.Icon)
	titleColor := uiChrome.Text
	if isActiveSession {
		titleColor = uiChrome.Accent
	}
	titleStr := lipgloss.NewStyle().
		Foreground(lipgloss.Color(titleColor)).
		Bold(isActiveSession).
		Render(truncatePlain(task.Title, max(1, leftBudget-2)))
	left := iconStr + " " + titleStr

	line := joinSpaceBetween(left, right, contentWidth)

	if isSelected {
		return lipgloss.NewStyle().
			Width(contentWidth).
			Background(lipgloss.Color(uiChrome.PanelAlt)).
			Render(line)
	}
	return lipgloss.NewStyle().Width(contentWidth).Render(line)
}

// renderSidePane fills the one slot the board shares with something else. The
// detail pane wins while it is open — it was opened deliberately, and the
// terminal is still running underneath it, one key away.
func renderSidePane(m *Model, height int, fullWidth bool) string {
	// Focusing the terminal is an explicit request for it, so it takes the slot
	// back for as long as it holds focus; the detail pane returns on Esc.
	if m.focus == FocusTerminal && m.terminalPaneShouldRender() {
		return renderTerminalPane(m, height, fullWidth)
	}
	if m.detailPaneShouldRender() {
		return renderDetailPane(m, height, fullWidth)
	}
	return renderTerminalPane(m, height, fullWidth)
}

// renderDetailPane lists every branch of the selected card so a multi-repo
// feature can be watched without leaving the board. It follows the board
// selection rather than pinning a card, which is the whole reason it is a pane
// and not a modal.
func renderDetailPane(m *Model, height int, fullWidth bool) string {
	width := m.width
	if !fullWidth {
		width = m.sideBySideTerminalOuterWidth()
	}
	contentWidth := max(1, width-terminalPaneFrameWidth)
	contentHeight := terminalPaneContentHeight(height)

	task := m.selectedTask()
	body := ""
	if task == nil {
		body = lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).
			Render(truncateText("Select a card to inspect its PRs.", contentWidth))
	} else {
		body = strings.Join(detailPaneLines(m, *task, contentHeight, contentWidth), "\n")
	}

	border := lipgloss.NormalBorder()
	borderColor := uiChrome.Line
	if m.focus == FocusDetail {
		border = lipgloss.RoundedBorder()
		borderColor = uiChrome.Accent
	}

	return fitSize(
		lipgloss.NewStyle().
			Width(contentWidth).
			Height(contentHeight).
			Border(border).
			BorderForeground(lipgloss.Color(borderColor)).
			Render(fitHeight(body, contentHeight)),
		width,
		height,
	)
}

func detailPaneLines(m *Model, task TaskRecord, contentHeight, contentWidth int) []string {
	branches := task.Branches
	lines := []string{
		joinSpaceBetween(
			strings.Join([]string{
				badge("PRS", "accent", "", false),
				lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Text)).Render(truncateText(task.Title, max(1, contentWidth/2))),
			}, " "),
			badge(fmt.Sprintf("%d BRANCH", len(branches)), "muted", "", false),
			contentWidth,
		),
	}

	// The release line describes the card, never a single branch, so it is
	// stated once and labelled as the card's.
	releaseNote := "release " + releaseStageLabel(task.Release)
	if task.Release != nil && task.Release.Reason != "" {
		releaseNote += " · " + task.Release.Reason
	}
	lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(toneColor(releaseStageTone(task.Release)))).
		Render(truncateText(releaseNote, contentWidth)))

	if len(branches) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).
			Render(truncateText("This card has no tracked branch yet.", contentWidth)))
		return lines
	}

	// Two header lines, a footer hint, and two rows per branch.
	visibleRows := max(1, (contentHeight-3)/2)
	selected := clamp(m.detailBranchIndex, 0, len(branches)-1)
	windowStart := commandWindowStart(selected, len(branches), visibleRows)
	for offset := windowStart; offset < min(len(branches), windowStart+visibleRows); offset++ {
		lines = append(lines, detailBranchRowLines(m, task, branches[offset], offset == selected, contentWidth)...)
	}

	lines = append(lines, joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(fmt.Sprintf("%d/%d", selected+1, len(branches))),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("↑↓ branch  E actions  Esc close"),
		contentWidth,
	))
	return lines
}

func detailBranchRowLines(m *Model, task TaskRecord, branch TaskBranchRecord, selected bool, contentWidth int) []string {
	marker := " "
	titleColor := uiChrome.Text
	if selected {
		marker = "▸"
		titleColor = uiChrome.Accent
	}

	head := joinSpaceBetween(
		lipgloss.NewStyle().Foreground(lipgloss.Color(titleColor)).Render(
			truncateText(marker+" "+m.taskBranchRepoLabel(branch)+" ⎇ "+compactBranchLabel(branch.BranchName), max(1, contentWidth-16)),
		),
		lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(taskBranchGlyph(branch, task.Release)),
		contentWidth,
	)
	detail := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(
		truncateText("   "+taskBranchPRLabel(branch)+"  "+taskBranchChecksLabel(branch), contentWidth),
	)
	return []string{head, detail}
}

func renderTerminalPane(m *Model, height int, fullWidth bool) string {
	width := m.width
	if !fullWidth {
		width = m.sideBySideTerminalOuterWidth()
	}

	contentWidth := max(1, width-terminalPaneFrameWidth)
	contentHeight := terminalPaneContentHeight(height)
	body := ""

	if m.activeTaskID == "" {
		viewportHeight := terminalSlotViewportHeight(contentHeight)
		footerVisible := contentHeight > 2
		lines := []string{
			joinSpaceBetween(badge("TERMINAL", "accent", "", false), badge("NO SESSION", "muted", "", false), contentWidth),
		}
		for index := 0; index < viewportHeight; index++ {
			value := " "
			if index == 0 {
				value = "No session open. Press Enter on a task to start one."
			}
			lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(truncateText(value, contentWidth)))
		}
		if footerVisible {
			lines = append(lines, joinSpaceBetween(
				lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Open a task shell to attach the live pane."),
				lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Enter shell"),
				contentWidth,
			))
		}
		body = strings.Join(lines, "\n")
	} else {
		activeTask := (*TaskRecord)(nil)
		for _, task := range m.tasks {
			if task.ID == m.activeTaskID {
				activeTask = &task
				break
			}
		}
		if activeTask == nil {
			body = ""
		} else if !m.activeTaskUsesDualTerminal() {
			body = fitHeight(renderTerminalSlotPane(m, *activeTask, SessionSlotPrimary, contentHeight, contentWidth), contentHeight)
		} else {
			primaryHeight, secondaryHeight := splitTerminalSlotHeights(true, contentHeight)
			parts := []string{
				fitHeight(renderTerminalSlotPane(m, *activeTask, SessionSlotPrimary, primaryHeight, contentWidth), primaryHeight),
			}
			if secondaryHeight > 0 {
				if dividerHeight := dualTerminalDividerHeight(contentHeight); dividerHeight > 0 {
					parts = append(parts, fitHeight(renderHorizontalDivider(contentWidth), dividerHeight))
				}
				parts = append(parts, fitHeight(renderTerminalSlotPane(m, *activeTask, SessionSlotSecondary, secondaryHeight, contentWidth), secondaryHeight))
			}
			body = fitHeight(lipgloss.JoinVertical(lipgloss.Left, parts...), contentHeight)
		}
	}

	border := lipgloss.NormalBorder()
	borderColor := uiChrome.Line
	if m.focus == FocusTerminal {
		border = lipgloss.RoundedBorder()
		borderColor = uiChrome.Accent
	}

	return fitSize(
		lipgloss.NewStyle().
			Width(contentWidth).
			Height(contentHeight).
			Border(border).
			BorderForeground(lipgloss.Color(borderColor)).
			Render(fitHeight(body, contentHeight)),
		width,
		height,
	)
}

func renderTerminalSlotPane(m *Model, activeTask TaskRecord, slot SessionSlot, height, contentWidth int) string {
	activeRepo := m.repoByID(activeTask.RepoID)
	viewportHeight := terminalSlotViewportHeight(height)
	footerVisible := height > 2
	normalizedSlot := normalizeSessionSlot(slot)
	slotLabel := "MAIN"
	slotTone := "muted"
	if normalizedSlot == SessionSlotSecondary {
		slotLabel = "DEV"
		slotTone = "warning"
	}
	if m.focus == FocusTerminal && normalizedSlot == normalizeSessionSlot(m.focusedTerminalSlot) {
		slotTone = "accent"
	}

	activity := m.sessionActivity(activeTask.ID, normalizedSlot)
	label, tone, spinning, icon := sessionBadgeModel(activeTask, activity, m.focus == FocusTerminal && normalizedSlot == normalizeSessionSlot(m.focusedTerminalSlot))
	if spinning {
		icon = spinnerFrames[m.spinnerIndex]
	}

	headerBadges := []string{
		badge("TERMINAL", "accent", "", false),
		badge(slotLabel, slotTone, "", false),
	}
	if activeTask.SecondarySessionID != "" {
		headerBadges = append(headerBadges, badge("DUAL", "info", "", false))
	}
	if backend := m.terminalBackendTypeForSlot(normalizedSlot); backend != "" {
		headerBadges = append(headerBadges, badge(strings.ToUpper(string(backend)), "muted", "", false))
	}

	rightBadges := []string{
		badge("REPO "+truncateText(taskRepoLabel(activeTask, activeRepo), 12), "info", "", false),
		badge(label, tone, icon, false),
	}
	if activeTask.SessionAttentionNeeded {
		rightBadges = append([]string{badge("⚠ NEEDS INPUT", "warning", "", true)}, rightBadges...)
	}

	lines := []string{
		joinSpaceBetween(
			strings.Join(append(headerBadges,
				lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Text)).Render(truncateText(activeTask.Title, 26)),
			), " "),
			strings.Join(rightBadges, " "),
			contentWidth,
		),
	}

	rawPlainViewportLines, rawStyledViewportLines := terminalViewport(m, normalizedSlot, viewportHeight, contentWidth)
	for index := range rawStyledViewportLines {
		line := rawStyledViewportLines[index]
		plain := rawPlainViewportLines[index]
		rendered := truncateANSI(line, contentWidth)
		padding := strings.Repeat(" ", max(0, contentWidth-plainWidth(truncatePlain(plain, contentWidth))))
		lines = append(lines, rendered+padding)
	}

	branchLabel := m.terminalBranchForSlot(normalizedSlot)
	if branchLabel == "" {
		branchLabel = activeTask.BranchName
	}
	if branchLabel == "" {
		branchLabel = "branch pending"
	}

	if footerVisible {
		buffer := m.terminalBufferForSlot(normalizedSlot)
		historyLabel := fmt.Sprintf("live tail %d", max(0, len(buffer.Lines)))
		if scrollOffset := m.terminalScrollOffsetForSlot(normalizedSlot); scrollOffset > 0 {
			historyLabel = fmt.Sprintf("history -%d", scrollOffset)
		}
		footerHint := "branch " + truncateText(branchLabel, 14) + "  Shift+←/→ resize  Esc board"
		if activeTask.SecondarySessionID != "" {
			footerHint = "branch " + truncateText(branchLabel, 12) + "  Shift+Tab pane  Shift+←/→ resize"
		}
		lines = append(lines, joinSpaceBetween(
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(historyLabel),
			lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(footerHint),
			contentWidth,
		))
	}

	return fitHeight(strings.Join(lines, "\n"), height)
}

func renderVerticalDivider(height int) string {
	dividerStyle := lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Accent))
	lines := make([]string, max(1, height))
	for index := range lines {
		lines[index] = dividerStyle.Render("│")
	}
	return strings.Join(lines, "\n")
}

func renderHorizontalDivider(width int) string {
	return lipgloss.NewStyle().
		Foreground(lipgloss.Color(uiChrome.Accent)).
		Render(strings.Repeat("─", max(1, width)))
}

func renderStatusBar(m *Model) string {
	contextTask := m.contextTask()
	contextActivity := (*SessionActivitySnapshot)(nil)
	if contextTask != nil {
		contextActivity = m.sessionActivityByTaskID[contextTask.ID]
	}

	activityLabel := ""
	if contextActivity != nil && contextActivity.IsBusy {
		label := contextActivity.Label
		if label == "" {
			label = contextActivity.Command
		}
		if label == "" {
			label = "Working"
		}
		activityLabel = spinnerFrames[m.spinnerIndex] + " " + label
	}

	leftParts := []string{badge(strings.ToUpper(string(m.focus)), ternaryString(m.focus == FocusTerminal, "accent", "neutral"), "", false)}
	if activityLabel != "" {
		leftParts = append(leftParts, badge(activityLabel, "warning", "", false))
	} else if contextTask != nil && contextTask.SessionAttentionNeeded {
		leftParts = append(leftParts, badge("attention", "info", "!", false))
	}
	if m.statusMessage != "" {
		leftParts = append(leftParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render(truncateText(m.statusMessage, max(1, m.width/2))))
	} else if contextTask != nil {
		leftParts = append(leftParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Selected: "+contextTask.Title))
	} else {
		leftParts = append(leftParts, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Ready"))
	}

	// The hint line is longer than any terminal, so it yields first: losing the
	// tail of a reminder costs less than losing the status message or the
	// attention badge, which are the parts that are actually news.
	left := strings.Join(leftParts, " ")
	hints := truncateText(kbdHints(m.focus), max(1, m.width-plainWidth(left)-1))
	return joinSpaceBetween(left, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(hints), m.width)
}

func renderHelpModal() string {
	sections := [][]string{
		{"Navigation", "Arrow keys move between columns and tasks, h/k/l mirror left/up/right", ": or Ctrl+P opens the command palette", "a or A opens the local AI chat modal", "Enter opens the selected task shell", "t focuses the terminal pane", "z expands the terminal workspace"},
		{"Task", "n new task, r rename, Ctrl+D edit description, d delete", "p assign pillar, P create pillar, D delete pillar and its tasks", "B toggles the dual shell layout for the selected task", "[ and ] move the selected task between tracks", "i opens IDE, x reveals workspace, R recreates the task shell"},
		{"Remote", "Remote tasks run their agent in tmux on another machine", "Ctrl+R reconnects the selected remote card to that machine", "It keeps the running agent when the remote session survived, and starts the host first when it is switched off", "R recreates instead: it always throws the running agent away"},
		{"GitHub", "c create PR now, C retry pushed-branch PR creation", "j comment on the selected open or draft PR", "o open PR, v open checks, m merge approved passing PR", "s runs a sync for PR, CI, and review status"},
		{"Multi-PR cards", "A card can span several repos and PRs; its badge sums them up", "e opens the PR pane beside the board and stays open while you move", "E opens the PR picker: o open, v checks, j comment, m merge that PR", "c/j/m on the card itself stand down once there are several PRs"},
		{"Artifacts", "The footer strip tracks GA versus latest RC for every artifact", "S refreshes it now, ▲N marks how far the latest RC is ahead of GA", "; moves the footer selection, G rolls the selected drifting artifact out to production", "Chips dim when the data is stale; run agentboard mcp login if it asks for auth"},
		{"Views", "f opens filters, g changes board / terminal layout", "Shift+Left/Right resizes the side-by-side terminal split", ", and . switch active repo, ? toggles this help"},
		{"Terminal", "Shift+Tab switches focus between the main and dev panes", "Tab then hjkl or arrows switches to the neighboring task shell", "Ctrl+C interrupts the running command inside the focused terminal", "PgUp/PgDn or Shift+Up/Down scroll terminal history", "Shift+Left/Right resizes the split, Esc returns focus to the board", "Ctrl+H also returns focus to the board, without clearing input or exiting fullscreen"},
		{"Setup", "If worktree setup fails because the repo uses master, run:", "agentboard repos set-default-base-branch <repo-id> master"},
	}

	lines := []string{
		joinSpaceBetween(badge("KEYBOARD", "accent", "", false), lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render("Esc close"), 68),
		"",
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(uiChrome.Text)).Render("AgentBoard shortcuts and setup"),
		"",
	}
	for _, section := range sections {
		lines = append(lines, badge(strings.ToUpper(section[0]), "muted", "", false))
		for _, item := range section[1:] {
			lines = append(lines, lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Text)).Render("- "+item))
		}
		lines = append(lines, "")
	}

	return lipgloss.NewStyle().
		Width(72).
		Border(lipgloss.DoubleBorder()).
		BorderForeground(lipgloss.Color(uiChrome.Accent)).
		Padding(1).
		Render(strings.TrimRight(strings.Join(lines, "\n"), "\n"))
}

func renderSessionActivityBadge(m *Model, task *TaskRecord, isActiveSession bool) string {
	label, tone, spinning, icon := sessionBadgeModel(*task, m.sessionActivityByTaskID[task.ID], isActiveSession)
	if spinning {
		icon = spinnerFrames[m.spinnerIndex]
	}
	return badge(label, tone, icon, false)
}

func sessionBadgeModel(task TaskRecord, activity *SessionActivitySnapshot, isActiveSession bool) (string, string, bool, string) {
	if activity != nil && activity.SessionStatus == "orphaned" {
		return "orphaned", "danger", false, "!"
	}
	if activity != nil && activity.SessionStatus == "terminated" {
		return "ended", "muted", false, "×"
	}
	if task.SessionAttentionNeeded {
		return "attention", "info", false, "!"
	}
	if activity != nil && activity.IsBusy {
		label := strings.TrimSpace(strings.TrimSpace(activity.Label + " " + activity.Command))
		if activity.Label != "" {
			label = activity.Label
		} else if activity.Command != "" {
			label = activity.Command
		} else {
			label = "work"
		}
		return label, "warning", true, ""
	}
	if isActiveSession {
		return "live", "accent", false, "●"
	}
	if task.SessionID != "" || task.SecondarySessionID != "" || (activity != nil && activity.SessionStatus == "idle") {
		return "idle", "success", false, "◦"
	}
	return "shell", "muted", false, "○"
}

func headerStatusModel(m *Model, task TaskRecord, activity *SessionActivitySnapshot, isActiveSession bool) struct {
	Color string
	Icon  string
	Label string
} {
	label, tone, spinning, icon := sessionBadgeModel(task, activity, isActiveSession)
	if spinning {
		icon = spinnerFrames[m.spinnerIndex]
	}
	return struct {
		Color string
		Icon  string
		Label string
	}{
		Color: toneColor(tone),
		Icon:  icon,
		Label: label,
	}
}

func badge(label, tone, icon string, strong bool) string {
	background, foreground := tonePalette(tone)
	text := label
	if icon != "" {
		text = icon + " " + label
	}
	style := lipgloss.NewStyle().
		Background(lipgloss.Color(background)).
		Foreground(lipgloss.Color(foreground)).
		Padding(0, 1)
	if strong {
		style = style.Bold(true)
	}
	return style.Render(text)
}

func tonePalette(tone string) (string, string) {
	switch tone {
	case "accent":
		return "#182536", uiChrome.Accent
	case "danger":
		return "#2b1d26", uiChrome.Danger
	case "info":
		return "#1e2636", uiChrome.Blue
	case "muted":
		return uiChrome.PanelAlt, uiChrome.Muted
	case "purple":
		return "#261f36", uiChrome.Purple
	case "success":
		return "#18261c", uiChrome.Success
	case "warning":
		return "#2a2416", uiChrome.Warning
	default:
		return "#252b3a", uiChrome.Text
	}
}

func toneColor(tone string) string {
	switch tone {
	case "accent":
		return uiChrome.Accent
	case "danger":
		return uiChrome.Danger
	case "info":
		return uiChrome.Blue
	case "purple":
		return uiChrome.Purple
	case "success":
		return uiChrome.Success
	case "warning":
		return uiChrome.Warning
	default:
		return uiChrome.Muted
	}
}

func taskCardBorderColor(task TaskRecord, isSelected bool) string {
	if task.SessionAttentionNeeded {
		if isSelected {
			return uiChrome.Blue
		}
		return "#3b82f6"
	}
	if task.PRState == "merged" {
		if isSelected {
			return uiChrome.Purple
		}
		return "#a855f7"
	}
	if task.CIState == "failed" || task.ReviewState == "changes_requested" || task.PRState == "closed" {
		if isSelected {
			return uiChrome.Danger
		}
		return "#ef4444"
	}
	if canMergeTask(task) || task.CIState == "passed" || task.ReviewState == "approved" {
		if isSelected {
			return uiChrome.Success
		}
		return "#22c55e"
	}
	if task.PRState == "open" || task.PRState == "draft" || task.CIState == "pending" {
		if isSelected {
			return uiChrome.Warning
		}
		return "#f59e0b"
	}
	if isSelected {
		return uiChrome.Accent
	}
	return "#475569"
}

func taskCardHeight(m *Model, task TaskRecord) int {
	return taskCardHeightForWidth(m, task, taskCardContentWidth, false)
}

func taskCardHeightForWidth(m *Model, task TaskRecord, contentWidth int, compact bool) int {
	titleText := task.Title
	if task.SessionAttentionNeeded {
		titleText = "⚠ " + titleText
	}
	titleLines := taskTitleLinesForWidth(titleText, contentWidth)
	if compact {
		return 4 + len(titleLines)
	}
	// fixed lines: header + sep + sep + pillar/branch + id/age = 5
	// + 2 borders from lipgloss = 7 base
	height := 7 + len(titleLines)
	if githubStatusBadgeModel(task) != nil {
		height++
	}
	// Mirrors the rollup badge line and the per-branch glyph strip in
	// renderTaskCardWithWidth. Disagreeing with the renderer here desynchronises
	// visibleWindow's scrolling silently, so the two must change together.
	if hasMultipleBranches(task) {
		height += 2
	}
	// Counted, not tested for emptiness: a description wraps to two lines at this
	// width, and assuming one silently desynchronised the scroll window.
	height += len(descriptionLinesForWidth(task.Description, contentWidth))
	return height
}

func taskTitleLines(title string) []string {
	return taskTitleLinesForWidth(title, taskCardContentWidth)
}

func taskTitleLinesForWidth(title string, width int) []string {
	normalized := normalizeSingleLine(title)
	if normalized == "" {
		normalized = "Untitled task"
	}
	width = max(1, width)
	words := strings.Fields(normalized)
	lines := []string{}
	current := ""
	for index, word := range words {
		candidate := strings.TrimSpace(current + " " + word)
		if plainWidth(candidate) <= width {
			current = candidate
			continue
		}
		if len(lines) == 1 {
			remainder := strings.Join(words[index:], " ")
			tail := strings.TrimSpace(current + " " + remainder)
			lines = append(lines, truncateText(tail, width))
			return lines
		}
		if current == "" {
			lines = append(lines, truncateText(word, width))
			continue
		}
		lines = append(lines, current)
		current = word
	}
	if current != "" {
		lines = append(lines, truncateText(current, width))
	}
	if len(lines) > 2 {
		return lines[:2]
	}
	return lines
}

func normalizeSingleLine(value string) string {
	if value == "" {
		return ""
	}
	for _, line := range strings.Split(value, "\n") {
		line = strings.Join(strings.Fields(strings.TrimSpace(line)), " ")
		if line != "" {
			return line
		}
	}
	return ""
}

func descriptionLinesForWidth(description string, width int) []string {
	normalized := normalizeSingleLine(description)
	if normalized == "" {
		return nil
	}
	width = max(1, width)
	words := strings.Fields(normalized)
	lines := []string{}
	current := ""
	for index, word := range words {
		candidate := strings.TrimSpace(current + " " + word)
		if plainWidth(candidate) <= width {
			current = candidate
			continue
		}
		if len(lines) == 1 {
			remainder := strings.Join(words[index:], " ")
			tail := strings.TrimSpace(current + " " + remainder)
			lines = append(lines, truncateText(tail, width))
			return lines
		}
		if current == "" {
			lines = append(lines, truncateText(word, width))
			continue
		}
		lines = append(lines, current)
		current = word
	}
	if current != "" {
		lines = append(lines, truncateText(current, width))
	}
	if len(lines) > 2 {
		return lines[:2]
	}
	return lines
}

func compactBranchLabel(branchName string) string {
	if branchName == "" {
		return "branch"
	}
	prefix := ""
	slug := branchName
	if strings.Contains(branchName, "/") {
		parts := strings.SplitN(branchName, "/", 2)
		prefix = parts[0]
		slug = parts[1]
	}
	parts := []string{}
	for _, part := range strings.Split(slug, "-") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return branchName
	}
	suffix := ""
	last := parts[len(parts)-1]
	if numericString(last) {
		suffix = last
		parts = parts[:len(parts)-1]
	}
	head := parts
	if len(head) > 3 {
		head = head[:3]
	}
	compact := strings.Join(head, "-")
	if len(parts) > len(head) {
		compact += "…"
	}
	if suffix != "" {
		if compact != "" {
			compact += "-"
		}
		compact += suffix
	}
	if prefix != "" {
		return prefix + "/" + compact
	}
	return compact
}

func numericString(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return value != ""
}

func formatRelativeAge(timestamp int64) string {
	elapsed := time.Since(time.UnixMilli(timestamp))
	if elapsed < time.Minute {
		return "just now"
	}
	if elapsed < time.Hour {
		return fmt.Sprintf("%dm ago", int(elapsed/time.Minute))
	}
	if elapsed < 24*time.Hour {
		return fmt.Sprintf("%dh ago", int(elapsed/time.Hour))
	}
	return fmt.Sprintf("%dd ago", int(elapsed/(24*time.Hour)))
}

func pillarLabel(pillars []PillarRecord, pillarID string) string {
	if pillarID == "" {
		return ""
	}
	for _, pillar := range pillars {
		if pillar.ID == pillarID {
			icon := pillar.Icon
			if icon == "" {
				icon = "⬢"
			}
			return icon + " " + truncateText(pillar.Label, 9)
		}
	}
	return ""
}

func gitStatus(task TaskRecord) string {
	switch task.GitState {
	case "conflicted":
		return "! conflict"
	case "dirty":
		return "~ dirty"
	case "untracked":
		return "? untracked"
	case "detached":
		return "× detached"
	default:
		return ""
	}
}

type githubStatusBadge struct {
	Label string
	Tone  string
}

const (
	// A card is 28 columns wide, so the strip names the first few branches and
	// counts the rest rather than wrapping the card out of shape.
	taskBranchStripLimit = 5

	branchGlyphShipped  = "✓ga"
	branchGlyphBuilt    = "↻rc"
	branchGlyphBuilding = "⏳"
	branchGlyphMerged   = "✓"
	branchGlyphOpen     = "●open"
	branchGlyphDraft    = "◐"
	branchGlyphCIFailed = "✗ci"
	branchGlyphChanges  = "✎"
	branchGlyphNoPR     = "○"
)

// hasMultipleBranches is the switch for every multi-PR affordance. A card with
// one branch must keep rendering and behaving exactly as it did before cards
// could span repos.
func hasMultipleBranches(task TaskRecord) bool {
	return len(task.Branches) > 1
}

// taskBranchGlyph condenses one branch to the smallest mark that still says what
// the user has to do about it.
//
// Release stage is only ever resolved for the card as a whole, so a merged
// branch borrows the card's stage; with no release summary it stays a bare ✓ —
// merged, where it got to unknown — rather than claiming a build or a ship that
// nobody checked.
func taskBranchGlyph(branch TaskBranchRecord, release *TaskReleaseSummary) string {
	switch {
	case branch.PRState == "merged":
		return mergedBranchGlyph(release)
	case branch.CIState == "failed":
		return branchGlyphCIFailed
	case branch.ReviewState == "changes_requested":
		return branchGlyphChanges
	case branch.PRDraft || branch.PRState == "draft":
		return branchGlyphDraft
	case branch.PRState == "open":
		return branchGlyphOpen
	default:
		return branchGlyphNoPR
	}
}

func mergedBranchGlyph(release *TaskReleaseSummary) string {
	if release == nil {
		return branchGlyphMerged
	}
	switch release.Stage {
	case "ga":
		return branchGlyphShipped
	case "rolling-out", "rc-built":
		return branchGlyphBuilt
	case "awaiting-build":
		return branchGlyphBuilding
	default:
		return branchGlyphMerged
	}
}

// taskBranchGlyphStrip is one glyph per branch, capped so the line still fits a
// card. The overflow count is shown rather than dropped: a hidden PR is a PR
// nobody chases.
func taskBranchGlyphStrip(task TaskRecord) string {
	shown := min(len(task.Branches), taskBranchStripLimit)
	glyphs := make([]string, 0, shown+1)
	for _, branch := range task.Branches[:shown] {
		glyphs = append(glyphs, taskBranchGlyph(branch, task.Release))
	}
	if hidden := len(task.Branches) - shown; hidden > 0 {
		glyphs = append(glyphs, fmt.Sprintf("+%d", hidden))
	}
	return strings.Join(glyphs, " ")
}

// taskBranchRollupLine sums the card's branches the way the user reads them: how
// much has landed, how much of that has shipped, and what is broken.
//
// The landed and broken counts come from the same branches the glyph strip
// draws, so the two lines can never contradict each other. GA comes from the
// card's release summary because a branch on its own cannot know it, and is
// omitted entirely when the daemon has not resolved a release.
func taskBranchRollupLine(task TaskRecord) string {
	merged, failing, changesRequested := 0, 0, 0
	for _, branch := range task.Branches {
		switch {
		case branch.PRState == "merged":
			merged++
		case branch.CIState == "failed":
			failing++
		case branch.ReviewState == "changes_requested":
			changesRequested++
		}
	}

	parts := []string{fmt.Sprintf("%d/%d merged", merged, len(task.Branches))}
	if task.Release != nil && task.Release.GaCount > 0 {
		parts = append(parts, fmt.Sprintf("%d GA", task.Release.GaCount))
	}
	if failing > 0 {
		parts = append(parts, fmt.Sprintf("%d ✗", failing))
	}
	if changesRequested > 0 {
		parts = append(parts, fmt.Sprintf("%d ✎", changesRequested))
	}
	return strings.Join(parts, " · ")
}

// taskBranchPRLabel is the branch's pull request in one phrase, or why there is
// nothing to point at.
func taskBranchPRLabel(branch TaskBranchRecord) string {
	if branch.PRNumber == nil {
		return "no PR"
	}
	state := string(branch.PRState)
	if branch.PRDraft {
		state = "draft"
	}
	if state == "" || state == "none" {
		state = "unknown"
	}
	return fmt.Sprintf("#%d %s", *branch.PRNumber, state)
}

// taskBranchChecksLabel reports CI and review side by side, and says "?" where
// the daemon has no answer rather than letting a blank read as a pass.
func taskBranchChecksLabel(branch TaskBranchRecord) string {
	ci := string(branch.CIState)
	if ci == "" || ci == "none" {
		ci = "?"
	}
	if branch.CIRequiredTotal > 0 {
		ci = fmt.Sprintf("%s %d/%d", ci, branch.CIRequiredPassed, branch.CIRequiredTotal)
	}
	review := string(branch.ReviewState)
	if review == "" || review == "none" {
		review = "?"
	}
	return "ci " + ci + "  review " + review
}

func githubStatusBadgeModel(task TaskRecord) *githubStatusBadge {
	segments := []string{}
	syncStatus := githubSyncStatusLabel(task)

	switch {
	case task.PRState == "merged":
		// Merging is no longer the end of the story, so a merged card reports
		// how far its change has actually got instead of just "merged".
		segments = append(segments, releaseStageLabel(task.Release))
	case task.PRState == "closed":
		segments = append(segments, "closed")
	default:
		if build := githubBuildStatusLabel(task); build != "" {
			segments = append(segments, build)
		}
		if review := githubReviewStatusLabel(task); review != "" {
			segments = append(segments, review)
		}
		if prState := githubPRStateLabel(task); prState != "" {
			segments = append(segments, prState)
		}
	}
	if len(segments) == 0 && syncStatus != "" {
		segments = append(segments, syncStatus)
	}

	if task.PRNumber != nil && task.PRState != "none" {
		segments = append(segments, fmt.Sprintf("#%d", *task.PRNumber))
	}

	if len(segments) == 0 {
		return nil
	}

	return &githubStatusBadge{
		Label: strings.Join(segments, "·"),
		Tone:  githubStatusTone(task),
	}
}

// releaseStageLabel describes a merged card's progress towards production.
//
// Falls back to "merged" whenever the stage is unknown or absent: the card must
// never imply a change has shipped, nor that it has stalled, on the strength of
// an answer the daemon could not get.
func releaseStageLabel(release *TaskReleaseSummary) string {
	if release == nil {
		// Not resolved yet. "merged" is what the card always said, and claiming
		// anything more would be inventing a verdict nobody reached.
		return releaseMergedGlyph + " merged"
	}

	switch release.Stage {
	case "ga":
		if release.BlockingGaVersion != "" {
			return releaseShippedGlyph + " GA " + release.BlockingGaVersion
		}
		return releaseShippedGlyph + " GA"
	case "rolling-out":
		if release.BlockingRcVersion != "" {
			return releaseRollingGlyph + " rollout " + release.BlockingRcVersion
		}
		return releaseRollingGlyph + " rolling out"
	case "rc-built":
		if release.BlockingRcVersion != "" {
			return releasePendingGlyph + " rc " + release.BlockingRcVersion
		}
		return releasePendingGlyph + " rc built"
	case "awaiting-build":
		return releasePendingGlyph + " building"
	case "no-artifact":
		// Landed, but nothing tracked ships it. Deliberately not the shipped
		// styling: the two are different facts, and a card that merely touched
		// no tracked artifact must never read as "live in production".
		return releaseMergedGlyph + " merged"
	default:
		// Could not tell. The question mark is the whole point — silence here
		// would read as a confident verdict.
		return releaseMergedGlyph + " merged ?"
	}
}

// releaseStageTone colours the badge by how far from production the work is.
//
// Purple is reserved for work that is actually live. It used to mean "merged",
// which made a change nobody had shipped look identical to one running in
// production.
func releaseStageTone(release *TaskReleaseSummary) string {
	if release == nil {
		return "muted"
	}

	switch release.Stage {
	case "ga":
		return "purple"
	case "rolling-out":
		return "accent"
	case "rc-built", "awaiting-build":
		return "warning"
	default:
		// no-artifact and unknown: landed, with nothing to wait for or nothing
		// knowable. Neither is production.
		return "muted"
	}
}

func githubBuildStatusLabel(task TaskRecord) string {
	if task.CIRequiredTotal > 0 {
		switch task.CIState {
		case "failed":
			return fmt.Sprintf("build %d/%d fail", task.CIRequiredPassed, task.CIRequiredTotal)
		case "pending", "passed":
			return fmt.Sprintf("build %d/%d", task.CIRequiredPassed, task.CIRequiredTotal)
		}
	}

	switch task.CIState {
	case "pending":
		return "build pending"
	case "passed":
		return "build pass"
	case "failed":
		return "build fail"
	default:
		return ""
	}
}

func githubSyncStatusLabel(task TaskRecord) string {
	switch task.GitHubSyncStatus {
	case "syncing":
		return "syncing"
	case "error":
		return "sync error"
	default:
		return ""
	}
}

func githubReviewStatusLabel(task TaskRecord) string {
	switch task.ReviewState {
	case "approved":
		return "approved"
	case "changes_requested":
		return "changes req"
	default:
		return ""
	}
}

func githubPRStateLabel(task TaskRecord) string {
	switch {
	case task.PRDraft || task.PRState == "draft":
		return "draft"
	case task.PRState == "open" && task.CIState == "none" && task.ReviewState != "approved" && task.ReviewState != "changes_requested":
		return "pr open"
	default:
		return ""
	}
}

func githubStatusTone(task TaskRecord) string {
	switch {
	case task.GitHubSyncStatus == "error" && (task.PRState == "" || task.PRState == "none"):
		return "danger"
	case task.PRState == "merged":
		return releaseStageTone(task.Release)
	case task.CIState == "failed" || task.ReviewState == "changes_requested" || task.PRState == "closed":
		return "danger"
	case task.GitHubSyncStatus == "syncing":
		return "info"
	case task.PRDraft || task.PRState == "draft" || task.CIState == "pending":
		return "warning"
	case canMergeTask(task) || task.CIState == "passed" || task.ReviewState == "approved":
		return "success"
	case task.PRState == "open":
		return "info"
	default:
		return "muted"
	}
}

func renderTaskViewport(line string, width int) string {
	return padWidth(truncateText(line, width), width)
}

func terminalViewport(m *Model, slot SessionSlot, viewportHeight, contentWidth int) ([]string, []string) {
	buffer := m.terminalBufferForSlot(slot)
	bufferLines := buffer.Lines
	bufferANSILines := buffer.ANSILines
	maxScrollOffset := max(0, len(bufferLines)-viewportHeight)
	scrollOffset := min(m.terminalScrollOffsetForSlot(slot), maxScrollOffset)
	viewportStart := max(0, len(bufferLines)-viewportHeight-scrollOffset)
	viewportEnd := min(len(bufferLines), viewportStart+viewportHeight)
	hasStyledLines := len(bufferANSILines) == len(bufferLines)

	rawPlain := []string{}
	rawStyled := []string{}

	for index := viewportStart; index < viewportEnd; index++ {
		plainLine := bufferLines[index]
		if !hasStyledLines && index == buffer.CursorY {
			plainLine = injectCursor(plainLine, buffer.CursorX)
		}
		rawPlain = append(rawPlain, plainLine)
		if hasStyledLines {
			rawStyled = append(rawStyled, bufferANSILines[index])
		} else {
			rawStyled = append(rawStyled, plainLine)
		}
	}

	for len(rawPlain) < viewportHeight {
		rawPlain = append(rawPlain, strings.Repeat(" ", contentWidth))
		rawStyled = append(rawStyled, strings.Repeat(" ", contentWidth))
	}
	return rawPlain, rawStyled
}

func injectCursor(line string, col int) string {
	if col < 0 {
		return line
	}
	if plainWidth(line) <= col {
		return line + strings.Repeat(" ", col-plainWidth(line)) + "█"
	}
	runes := []rune(line)
	if col >= len(runes) {
		return line + "█"
	}
	runes[col] = '█'
	return string(runes)
}

func terminalViewportHeight(height int) int {
	if height <= 2 {
		return max(1, height-terminalHeaderHeight)
	}
	return max(1, height-terminalHeaderHeight-terminalFooterHeight)
}

func shouldShowFilterBar(filters FilterModel, focus AppFocus) bool {
	return focus == FocusFilterBar || focus == FocusSearch || countActiveFilters(filters) > 0
}

func countActiveFilters(filters FilterModel) int {
	count := 0
	count += len(filters.RepoIDs)
	count += len(filters.PillarIDs)
	count += len(filters.LabelIDs)
	count += len(filters.TrackIDs)
	count += len(filters.PRState)
	count += len(filters.CIState)
	count += len(filters.SessionState)
	if filters.SearchText != "" {
		count++
	}
	if filters.IncludeArchived {
		count++
	}
	return count
}

func visibleWindow(itemHeights []int, selectedIndex, availableHeight int) (int, int) {
	if len(itemHeights) == 0 {
		return 0, 0
	}
	maxHeight := max(1, availableHeight)
	selectedIndex = clamp(selectedIndex, 0, len(itemHeights)-1)
	start, end, used := 0, 0, 0

	for end < len(itemHeights) {
		nextHeight := itemHeights[end]
		if end > start && used+nextHeight > maxHeight {
			break
		}
		used += nextHeight
		end++
	}

	for selectedIndex >= end && end < len(itemHeights) {
		used += itemHeights[end]
		end++
		for start < end-1 && used > maxHeight {
			used -= itemHeights[start]
			start++
		}
	}
	return start, end
}

func getTaskPRURL(task *TaskRecord, repo *RepoRecord) string {
	if task.PRURL != "" {
		return task.PRURL
	}
	if task.PRNumber == nil || repo == nil {
		return ""
	}
	repoURL := repo.GitHubURL
	if repoURL == "" && repo.GitHubOwner != "" && repo.GitHubRepo != "" {
		repoURL = "https://github.com/" + repo.GitHubOwner + "/" + repo.GitHubRepo
	}
	if repoURL == "" {
		return ""
	}
	return fmt.Sprintf("%s/pull/%d", repoURL, *task.PRNumber)
}

// getBranchPRURL resolves one branch's PR link. A branch names its own repo, so
// the link never has to be guessed from the card's repo — which on a cross-repo
// card would open the wrong project.
func getBranchPRURL(branch TaskBranchRecord, repo *RepoRecord) string {
	if branch.PRURL != "" {
		return branch.PRURL
	}
	if branch.PRNumber == nil || repo == nil {
		return ""
	}
	repoURL := repo.GitHubURL
	if repoURL == "" && repo.GitHubOwner != "" && repo.GitHubRepo != "" {
		repoURL = "https://github.com/" + repo.GitHubOwner + "/" + repo.GitHubRepo
	}
	if repoURL == "" {
		return ""
	}
	return fmt.Sprintf("%s/pull/%d", repoURL, *branch.PRNumber)
}

// prStatus is the slice of pull-request state the merge and comment guards read.
// A card and a single branch both reduce to it, so the rules are written once
// and cannot drift apart between the card-level keys and the per-PR modal.
type prStatus struct {
	Number *int
	State  PRState
	Draft  bool
	CI     CIState
	Review ReviewState
}

func taskPRStatus(task TaskRecord) prStatus {
	return prStatus{
		Number: task.PRNumber,
		State:  task.PRState,
		Draft:  task.PRDraft,
		CI:     task.CIState,
		Review: task.ReviewState,
	}
}

func branchPRStatus(branch TaskBranchRecord) prStatus {
	return prStatus{
		Number: branch.PRNumber,
		State:  branch.PRState,
		Draft:  branch.PRDraft,
		CI:     branch.CIState,
		Review: branch.ReviewState,
	}
}

func (s prStatus) isOpen() bool {
	return s.State == "open" || s.State == "draft"
}

func (s prStatus) canMerge() bool {
	return s.State == "open" && !s.Draft && s.CI == "passed" && s.Review == "approved"
}

func (s prStatus) ref() string {
	if s.Number == nil {
		return "The PR"
	}
	return fmt.Sprintf("PR #%d", *s.Number)
}

func (s prStatus) commentBlockerReason() string {
	prRef := s.ref()
	if s.Number == nil || s.State == "none" {
		return "Selected task has no pull request."
	}
	if s.State == "merged" {
		return prRef + " is already merged."
	}
	if s.State == "closed" {
		return prRef + " is closed."
	}
	if !s.isOpen() {
		return prRef + " is not open."
	}
	return ""
}

func (s prStatus) mergeBlockerReason() string {
	prRef := s.ref()
	if s.Number == nil || s.State == "none" {
		return "Selected task has no pull request."
	}
	if s.Draft || s.State == "draft" {
		return prRef + " is still draft."
	}
	if s.State == "merged" {
		return prRef + " is already merged."
	}
	if s.State == "closed" {
		return prRef + " is closed."
	}
	if s.State != "open" {
		return prRef + " is not open."
	}
	if s.Review == "changes_requested" {
		return prRef + " still has requested changes."
	}
	if s.Review != "approved" {
		return prRef + " is not approved yet."
	}
	if s.CI == "failed" {
		return prRef + " has failing checks."
	}
	if s.CI == "pending" {
		return prRef + " checks are still pending."
	}
	if s.CI != "passed" {
		return prRef + " does not have a passing build yet."
	}
	return ""
}

// multiBranchChoiceReason is why a card-level PR action must refuse. Once a card
// carries several PRs the daemon leaves tasks.PRNumber nil on purpose, so acting
// "on the card's PR" would mean merging or commenting on an arbitrary one.
func multiBranchChoiceReason(task TaskRecord) string {
	if !hasMultipleBranches(task) {
		return ""
	}
	return fmt.Sprintf("This card has %d PRs — press E to choose a PR.", len(task.Branches))
}

func canMergeTask(task TaskRecord) bool {
	if hasMultipleBranches(task) {
		return false
	}
	return taskPRStatus(task).canMerge()
}

func canMergeBranchPR(branch TaskBranchRecord) bool {
	return branchPRStatus(branch).canMerge()
}

func getPRCommentBlockerReason(task TaskRecord) string {
	if reason := multiBranchChoiceReason(task); reason != "" {
		return reason
	}
	return taskPRStatus(task).commentBlockerReason()
}

func getBranchPRCommentBlockerReason(branch TaskBranchRecord) string {
	return branchPRStatus(branch).commentBlockerReason()
}

func getMergeBlockerReason(task TaskRecord) string {
	if reason := multiBranchChoiceReason(task); reason != "" {
		return reason
	}
	return taskPRStatus(task).mergeBlockerReason()
}

func getBranchMergeBlockerReason(branch TaskBranchRecord) string {
	return branchPRStatus(branch).mergeBlockerReason()
}

func taskLocationMarker(task TaskRecord) string {
	if task.Location == TaskLocationRemote {
		return remoteTaskMarker
	}
	return ""
}

func workspaceKind(task *TaskRecord) string {
	if task != nil && task.IsGeneral() {
		return "no repo"
	}
	if task != nil && task.WorktreePath != "" {
		return "worktree"
	}
	return "repo"
}

func workspaceColor(task *TaskRecord) string {
	if task != nil && task.WorktreePath != "" {
		return uiChrome.Success
	}
	return uiChrome.Muted
}

func repoPositionLabel(m *Model, activeRepo *RepoRecord) string {
	if activeRepo == nil && m.isGeneralScope() {
		return "general"
	}
	if activeRepo == nil {
		return fmt.Sprintf("all repos [%d]", len(m.repos))
	}
	label := activeRepo.Label
	if label == "" {
		label = activeRepo.ID
	}
	for i, repo := range m.repos {
		if repo.ID == activeRepo.ID {
			return fmt.Sprintf("%s [%d/%d]", truncateText(label, 12), i+1, len(m.repos))
		}
	}
	return truncateText(label, 18)
}

func valueOrAllRepos(repo *RepoRecord) string {
	if repo == nil {
		return "all repos"
	}
	return repo.Label
}

func valueOrTrack(track *TrackRecord, fallback string) string {
	if track == nil {
		return fallback
	}
	return track.Label
}

func valueOrRepo(repo *RepoRecord, fallback string) string {
	if repo == nil {
		return fallback
	}
	return repo.Label
}

// taskCardHeaderLabel is the top line of a card: where the task's work lives.
// A general task has no repo and no worktree, so it says so outright rather
// than rendering an empty "> root" path.
func taskCardHeaderLabel(task TaskRecord, repoLabel string) string {
	if task.IsGeneral() {
		return "general · no repo"
	}
	workspaceLabel := "root"
	if task.WorktreePath != "" {
		workspaceLabel = "worktree"
	}
	return fmt.Sprintf("%s%s > %s", taskLocationMarker(task), repoLabel, workspaceLabel)
}

// taskRepoLabel names the repo chip for a task, standing in for the repo a
// general task does not have.
func taskRepoLabel(task TaskRecord, repo *RepoRecord) string {
	if task.IsGeneral() {
		return "general"
	}
	return valueOrRepo(repo, task.RepoID)
}

func headerText(icon, value, color string) string {
	return lipgloss.NewStyle().Foreground(lipgloss.Color(uiChrome.Muted)).Render(icon+" ") +
		lipgloss.NewStyle().Foreground(lipgloss.Color(color)).Render(value)
}

func kbdHints(focus AppFocus) string {
	switch focus {
	case FocusBoard:
		// e/E lead: this string already overflows a narrow terminal, and the PR
		// pane and picker are the only way to act on a card with several PRs.
		return "e PRs pane  E PR actions  ↑↓←→ move  Enter shell  n new  m merge  c PR  C retry PR  j comment  a/A ai chat  B dual shell  f filter  O overview  ; artifact  G roll out  T track  1-9 repo  ? help"
	case FocusDetail:
		return "↑↓ branch  ←→ card  E PR actions  e/Esc close"
	case FocusTerminal:
		return "Shift+Tab pane  Shift+←/→ resize  Tab+h/j/k/l switch shell  PgUp/PgDn scroll  Ctrl+H board  Esc board"
	case FocusModal:
		return "Enter confirm  Esc cancel"
	case FocusFilterBar, FocusSearch:
		return "f edit  / search  Esc clear"
	default:
		return ""
	}
}

func joinSpaceBetween(left, right string, width int) string {
	leftWidth := lipgloss.Width(left)
	rightWidth := lipgloss.Width(right)
	if leftWidth+rightWidth >= width {
		return truncateText(left, max(1, width-rightWidth-1)) + " " + right
	}
	return left + strings.Repeat(" ", width-leftWidth-rightWidth) + right
}

func fitHeight(value string, height int) string {
	lines := strings.Split(value, "\n")
	switch {
	case len(lines) == height:
		return value
	case len(lines) > height:
		return strings.Join(lines[:height], "\n")
	default:
		padding := make([]string, height-len(lines))
		for index := range padding {
			padding[index] = ""
		}
		return strings.Join(append(lines, padding...), "\n")
	}
}

func fitSize(value string, width int, height int) string {
	return fitWidth(fitHeight(value, height), width)
}

func fitWidth(value string, width int) string {
	if width <= 0 {
		return ""
	}
	lines := strings.Split(value, "\n")
	for index, line := range lines {
		line = truncateANSI(line, width)
		lines[index] = line + strings.Repeat(" ", max(0, width-plainWidth(line)))
	}
	return strings.Join(lines, "\n")
}

func truncateText(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if plainWidth(value) <= width {
		return value
	}
	if width == 1 {
		return "…"
	}

	result := ""
	used := 0
	for _, r := range value {
		charWidth := runewidth.RuneWidth(r)
		if used+charWidth > width-1 {
			break
		}
		result += string(r)
		used += charWidth
	}
	return result + "…"
}

func padWidth(value string, width int) string {
	padding := max(0, width-plainWidth(value))
	return value + strings.Repeat(" ", padding)
}

func truncatePlain(line string, maxWidth int) string {
	if maxWidth <= 0 || plainWidth(line) <= maxWidth {
		return line
	}
	return truncateText(line, maxWidth)
}

func truncateANSI(line string, maxWidth int) string {
	if maxWidth <= 0 || plainWidth(stripANSI(line)) <= maxWidth {
		return line
	}

	builder := strings.Builder{}
	width := 0
	sawANSI := false

	for len(line) > 0 && width < maxWidth {
		if strings.HasPrefix(line, "\x1b[") {
			end := strings.IndexByte(line, 'm')
			if end < 0 {
				break
			}
			builder.WriteString(line[:end+1])
			line = line[end+1:]
			sawANSI = true
			continue
		}

		r, size := utf8.DecodeRuneInString(line)
		if r == utf8.RuneError && size == 1 {
			break
		}
		runeWidth := runewidth.RuneWidth(r)
		if width+runeWidth > maxWidth {
			break
		}
		builder.WriteRune(r)
		width += runeWidth
		line = line[size:]
	}

	result := builder.String()
	if sawANSI && !strings.HasSuffix(result, "\x1b[0m") {
		result += "\x1b[0m"
	}
	return result
}

func stripANSI(value string) string {
	return ansiPattern.ReplaceAllString(value, "")
}

func plainWidth(value string) int {
	return runewidth.StringWidth(stripANSI(value))
}

func ternaryString(condition bool, left, right string) string {
	if condition {
		return left
	}
	return right
}

func ternaryInt(condition bool, left, right int) int {
	if condition {
		return left
	}
	return right
}
