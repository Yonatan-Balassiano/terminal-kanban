export const BOARD_WIDTH = 98;
export const MIN_TERMINAL_PANE_WIDTH = 40;
export const TERMINAL_DIVIDER_WIDTH = 1;
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

export function canShowTerminalPane(
  columns: number | undefined = process.stdout.columns ?? 80,
): boolean {
  return getTerminalPaneWidth(columns) >= MIN_TERMINAL_PANE_WIDTH;
}
