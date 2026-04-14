import React from 'react';
import { Box, Text } from 'ink';
import { useAppState } from '../store/index.js';
import type { AppFocus } from '../types/index.js';
import { Badge, UI_CHROME } from './chrome.js';
import { getHeaderContextTask } from './header-context.js';

export const STATUS_BAR_HEIGHT = 1;

function focusLabel(focus: AppFocus): string {
  switch (focus) {
    case 'board':
      return 'BOARD';
    case 'terminal':
      return 'TERMINAL';
    case 'filterbar':
      return 'FILTERS';
    case 'modal':
      return 'MODAL';
    case 'search':
      return 'SEARCH';
    default:
      return String(focus).toUpperCase();
  }
}

function kbdHints(focus: AppFocus): string {
  switch (focus) {
    case 'board':
      return 'move  : commands  Enter shell  n new  f filters  s sync  ? help';
    case 'terminal':
      return 'Ctrl+C interrupt  PgUp/PgDn scroll  Esc board';
    case 'modal':
      return 'Enter confirm  Esc cancel';
    case 'filterbar':
    case 'search':
      return 'f edit  / search  Esc clear';
    default:
      return '';
  }
}

export const StatusBar = React.memo(function StatusBar(): JSX.Element {
  const state = useAppState();
  const contextTask = getHeaderContextTask(state);
  const contextActivity =
    contextTask != null ? state.sessionActivityByTaskId[contextTask.id] : undefined;
  const focus = focusLabel(state.focus);
  const hints = kbdHints(state.focus);
  const activityLabel =
    contextActivity?.isBusy === true
      ? `◌ ${contextActivity.label ?? contextActivity.command ?? 'Working'}`
      : undefined;

  return (
    <Box justifyContent="space-between" height={STATUS_BAR_HEIGHT} overflow="hidden">
      <Box flexDirection="row" gap={1} overflow="hidden">
        <Badge label={focus} tone={state.focus === 'terminal' ? 'accent' : 'neutral'} />
        {activityLabel && <Badge label={activityLabel} tone="warning" />}
        {state.statusMessage != null && state.statusMessage.length > 0 ? (
          <Box flexShrink={1} overflow="hidden">
            <Text color={UI_CHROME.text} wrap="truncate">
              {state.statusMessage}
            </Text>
          </Box>
        ) : (
          <Text color={UI_CHROME.muted}>
            {contextTask ? `Selected: ${contextTask.title}` : 'Ready'}
          </Text>
        )}
      </Box>

      <Box flexShrink={0} overflow="hidden">
        <Text color={UI_CHROME.muted} wrap="truncate">
          {hints}
        </Text>
      </Box>
    </Box>
  );
});
