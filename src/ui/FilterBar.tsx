// ============================================================
// AgentBoard — FilterBar component
// ============================================================

import React from 'react';
import { Box, Text } from 'ink';
import { useAppState } from '../store/index.js';
import type { AppState } from '../types/index.js';

export function hasActiveFilters(filters: AppState['filters']): boolean {
  return (
    (filters.repoIds != null && filters.repoIds.length > 0) ||
    (filters.pillarIds != null && filters.pillarIds.length > 0) ||
    (filters.labelIds != null && filters.labelIds.length > 0) ||
    (filters.trackIds != null && filters.trackIds.length > 0) ||
    (filters.prState != null && filters.prState.length > 0) ||
    (filters.ciState != null && filters.ciState.length > 0) ||
    (filters.sessionState != null && filters.sessionState.length > 0) ||
    (filters.searchText != null && filters.searchText.length > 0) ||
    filters.includeArchived === true
  );
}

export function shouldShowFilterBar(state: Pick<AppState, 'filters' | 'focus'>): boolean {
  return state.focus === 'filterbar' || state.focus === 'search' || hasActiveFilters(state.filters);
}

export const FilterBar = React.memo(function FilterBar(): JSX.Element {
  const state = useAppState();

  if (!shouldShowFilterBar(state)) {
    return <></>;
  }

  const chips: JSX.Element[] = [];

  if (state.filters.repoIds && state.filters.repoIds.length > 0) {
    for (const id of state.filters.repoIds) {
      const repo = state.repos.find((r) => r.id === id);
      const label = repo ? repo.label : id;
      chips.push(
        <Text key={`repo:${id}`} backgroundColor="blue" color="white">
          {` repo:${label} `}
        </Text>,
      );
    }
  }

  if (state.filters.pillarIds && state.filters.pillarIds.length > 0) {
    for (const id of state.filters.pillarIds) {
      const pillar = state.pillars.find((p) => p.id === id);
      const label = pillar ? pillar.label : id;
      chips.push(
        <Text key={`pillar:${id}`} backgroundColor="magenta" color="white">
          {` pillar:${label} `}
        </Text>,
      );
    }
  }

  if (state.filters.searchText && state.filters.searchText.length > 0) {
    chips.push(
      <Text key="search" backgroundColor="green" color="white">
        {` search:${state.filters.searchText} `}
      </Text>,
    );
  }

  const isFocused = state.focus === 'filterbar' || state.focus === 'search';

  return (
    <Box flexDirection="row" gap={1} height={1} overflow="hidden">
      {chips.length > 0 && chips}
      {isFocused && (
        <Text dimColor>
          {'[f] filter  [/] search  [ESC] clear'}
        </Text>
      )}
    </Box>
  );
});
