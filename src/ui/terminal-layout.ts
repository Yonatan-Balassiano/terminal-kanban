export const BOARD_WIDTH = 98;
export const MIN_TERMINAL_PANE_WIDTH = 40;
export const TERMINAL_DIVIDER_WIDTH = 1;
export const TERMINAL_HEADER_HEIGHT = 1;
export const TERMINAL_FOOTER_HEIGHT = 1;
export const MIN_TOTAL_TERMINAL_WIDTH =
  BOARD_WIDTH + TERMINAL_DIVIDER_WIDTH + MIN_TERMINAL_PANE_WIDTH;

export function getTerminalPaneWidth(
  columns: number | undefined = process.stdout.columns ?? 80,
): number {
  return columns - BOARD_WIDTH - TERMINAL_DIVIDER_WIDTH;
}

export function getTerminalContentWidth(
  columns: number | undefined = process.stdout.columns ?? 80,
  fullWidth = false,
): number {
  const paneWidth = fullWidth ? columns : getTerminalPaneWidth(columns);
  return Math.max(1, paneWidth ?? 0);
}

export function getTerminalViewportHeight(height: number): number {
  if (height <= 2) {
    return Math.max(1, height - TERMINAL_HEADER_HEIGHT);
  }

  return Math.max(1, height - TERMINAL_HEADER_HEIGHT - TERMINAL_FOOTER_HEIGHT);
}

export function shouldShowTerminalFooter(height: number): boolean {
  return height > 2;
}

export function canShowTerminalPane(
  columns: number | undefined = process.stdout.columns ?? 80,
): boolean {
  return getTerminalPaneWidth(columns) >= MIN_TERMINAL_PANE_WIDTH;
}
