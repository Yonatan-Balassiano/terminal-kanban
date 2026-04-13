// ============================================================
// AgentBoard — StatusBar component
// ============================================================

import React from 'react';
import { Box, Text } from 'ink';
import { useAppState } from '../store/index.js';
import type { AppFocus } from '../types/index.js';

function focusLabel(focus: AppFocus): string {
  switch (focus) {
    case 'board':
      return 'BOARD';
    case 'terminal':
      return 'TERMINAL';
    case 'filterbar':
      return 'FILTER';
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
      return 'n new  f filters  g layout  ,/. repo  i IDE  x workspace  c create-pr  o PR  v checks  m merge  R native-term  P new-pillar  D del-pillar  p assign  Ctrl+D desc  d del  z full-term  [ ]move  Enter shell  s sync  ? help  q quit';
    case 'terminal':
      return 'Ctrl+C interrupt  PgUp/PgDn scroll  Esc board';
    case 'modal':
      return 'Esc cancel';
    case 'filterbar':
    case 'search':
      return '[f] filter  [/] search  [ESC] clear';
    default:
      return '';
  }
}

export const StatusBar = React.memo(function StatusBar(): JSX.Element {
  const state = useAppState();

  const label = focusLabel(state.focus);
  const hints = kbdHints(state.focus);

  return (
    <Box justifyContent="space-between" height={1} overflow="hidden">
      {/* Left section: mode + status message */}
      <Box flexDirection="row" gap={1}>
        <Text backgroundColor="cyan" color="black">
          {` ${label} `}
        </Text>
        {state.statusMessage != null && state.statusMessage.length > 0 && (
          <Text>{state.statusMessage}</Text>
        )}
        {state.syncInProgress && (
          <Text color="yellow">{'⟳ syncing…'}</Text>
        )}
      </Box>

      {/* Right section: keyboard hints */}
      <Box>
        <Text dimColor wrap="truncate">{hints}</Text>
      </Box>
    </Box>
  );
});
