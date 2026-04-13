// ============================================================
// AgentBoard — TerminalPane component
// ============================================================

import { Box, Text } from 'ink';
import { useAppState } from '../store/index.js';
import { useTerminalBuffer } from '../store/terminal-buffer.js';
import { truncateAnsi, truncatePlain } from './ansi-truncate.js';
import {
  getTerminalContentWidth,
  getTerminalPaneWidth,
} from './terminal-layout.js';

function injectCursor(line: string, col: number): string {
  if (col < 0) return line;
  if (col >= line.length) {
    // Pad and append cursor block
    return line + ' '.repeat(col - line.length) + '█';
  }
  return line.slice(0, col) + '█' + line.slice(col + 1);
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
  } =
    useTerminalBuffer();

  const termWidth = fullWidth
    ? columns
    : getTerminalPaneWidth(columns);
  const contentWidth = getTerminalContentWidth(columns, fullWidth);

  const activeTask =
    state.activeTaskId != null
      ? state.tasks.find((t) => t.id === state.activeTaskId)
      : undefined;

  if (activeTask == null) {
    return (
      <Box flexDirection="column" width={termWidth} height={height} overflow="hidden">
        <Text dimColor>
          {'No session open. Press Enter on a task to start one.'}
        </Text>
      </Box>
    );
  }

  const viewportHeight = Math.max(1, height);
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

  return (
    <Box flexDirection="column" width={termWidth} height={height} overflow="hidden">
      {paddedViewportLines.map((line, idx) => (
        <Text key={idx} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}
