import { Box, Text } from 'ink';
import { useAppState } from '../store/index.js';
import { useTerminalBuffer } from '../store/terminal-buffer.js';
import { truncateAnsi, truncatePlain } from './ansi-truncate.js';
import { Badge, SessionActivityBadge, UI_CHROME } from './chrome.js';
import {
  getTerminalContentWidth,
  getTerminalPaneWidth,
  getTerminalViewportHeight,
  shouldShowTerminalFooter,
} from './terminal-layout.js';

function injectCursor(line: string, col: number): string {
  if (col < 0) return line;
  if (col >= line.length) {
    return line + ' '.repeat(col - line.length) + '█';
  }
  return line.slice(0, col) + '█' + line.slice(col + 1);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export interface TerminalPaneProps {
  fullWidth?: boolean;
  height: number;
  columns: number;
}

export function TerminalPane({
  fullWidth = false,
  height,
  columns,
}: TerminalPaneProps): JSX.Element {
  const state = useAppState();
  const {
    lines: bufferLines,
    ansiLines: bufferAnsiLines,
    cursorX: bufferCursorX,
    cursorY: bufferCursorY,
  } = useTerminalBuffer();

  const termWidth = fullWidth ? columns : getTerminalPaneWidth(columns);
  const contentWidth = getTerminalContentWidth(columns, fullWidth);
  const viewportHeight = getTerminalViewportHeight(height);
  const footerVisible = shouldShowTerminalFooter(height);

  const activeTask =
    state.activeTaskId != null
      ? state.tasks.find((task) => task.id === state.activeTaskId)
      : undefined;
  const activeRepo =
    activeTask != null ? state.repos.find((repo) => repo.id === activeTask.repoId) : undefined;
  const activity =
    activeTask != null ? state.sessionActivityByTaskId[activeTask.id] : undefined;

  if (activeTask == null) {
    const emptyLines = Array.from({ length: viewportHeight }, (_, index) => (
      <Text key={`empty:${index}`} color={UI_CHROME.muted}>
        {index === 0 ? 'No session open. Press Enter on a task to start one.' : ' '}
      </Text>
    ));

    return (
      <Box flexDirection="column" width={termWidth} height={height} overflow="hidden">
        <Box
          flexDirection="row"
          justifyContent="space-between"
          height={1}
          overflow="hidden"
        >
          <Badge label="TERMINAL" tone="accent" />
          <Badge label="NO SESSION" tone="muted" />
        </Box>
        <Box flexDirection="column" height={viewportHeight} overflow="hidden">
          {emptyLines}
        </Box>
        {footerVisible && (
          <Box justifyContent="space-between" height={1} overflow="hidden">
            <Text color={UI_CHROME.muted}>Open a task shell to attach the live pane.</Text>
            <Text color={UI_CHROME.muted}>Enter shell</Text>
          </Box>
        )}
      </Box>
    );
  }

  const maxScrollOffset = Math.max(0, bufferLines.length - viewportHeight);
  const scrollOffset = Math.min(state.terminalScrollOffset, maxScrollOffset);
  const viewportStart = Math.max(0, bufferLines.length - viewportHeight - scrollOffset);
  const viewportEnd = viewportStart + viewportHeight;
  const hasStyledLines = bufferAnsiLines.length === bufferLines.length;
  const rawPlainViewportLines = bufferLines.slice(viewportStart, viewportEnd).map((line, idx) => {
    if (hasStyledLines) {
      return line;
    }

    const absoluteIndex = viewportStart + idx;
    if (absoluteIndex === bufferCursorY) {
      return injectCursor(line, bufferCursorX);
    }
    return line;
  });
  const rawStyledViewportLines = hasStyledLines
    ? bufferAnsiLines.slice(viewportStart, viewportEnd)
    : rawPlainViewportLines;
  const viewportLines = rawStyledViewportLines.map((line, idx) => {
    const plainLine = truncatePlain(rawPlainViewportLines[idx] ?? '', contentWidth);
    const paddedSuffix = ' '.repeat(Math.max(0, contentWidth - Array.from(plainLine).length));

    if (hasStyledLines) {
      return truncateAnsi(line, contentWidth) + paddedSuffix;
    }

    return plainLine + paddedSuffix;
  });
  const paddedViewportLines = [
    ...viewportLines,
    ...Array.from(
      { length: Math.max(0, viewportHeight - viewportLines.length) },
      () => ' '.repeat(contentWidth),
    ),
  ];
  const branchLabel = state.activeSessionBranch ?? activeTask.branchName ?? 'branch pending';
  const historyLabel =
    scrollOffset > 0 ? `history -${scrollOffset}` : `live tail ${Math.max(0, bufferLines.length)}`;

  return (
    <Box flexDirection="column" width={termWidth} height={height} overflow="hidden">
      <Box
        flexDirection="row"
        justifyContent="space-between"
        height={1}
        overflow="hidden"
      >
        <Box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} overflow="hidden">
          <Badge label="TERMINAL" tone="accent" />
          <Box flexShrink={1} overflow="hidden">
            <Text bold color={UI_CHROME.text} wrap="truncate">
              {truncate(activeTask.title, 32)}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0} overflow="hidden">
          <Badge label={`REPO ${truncate(activeRepo?.label ?? activeTask.repoId, 12)}`} tone="info" />
          {state.activeSessionBackendType && (
            <Badge label={state.activeSessionBackendType.toUpperCase()} tone="muted" />
          )}
          <SessionActivityBadge
            activity={activity}
            hasSession={Boolean(activeTask.sessionId)}
            isActiveSession
          />
        </Box>
      </Box>

      <Box flexDirection="column" height={viewportHeight} overflow="hidden">
        {paddedViewportLines.map((line, idx) => (
          <Text key={idx} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>

      {footerVisible && (
        <Box justifyContent="space-between" height={1} overflow="hidden">
          <Text color={UI_CHROME.muted}>{historyLabel}</Text>
          <Text color={UI_CHROME.muted} wrap="truncate">
            {`branch ${truncate(branchLabel, 28)}  Esc board`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
