// ============================================================
// AgentBoard — FilterBar component
// ============================================================

import React from 'react';
import { Box, Text } from 'ink';
import { useAppState } from '../store/index.js';
import type { AppState } from '../types/index.js';
import { Badge, countActiveFilters, UI_CHROME } from './chrome.js';

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

  const chips: JSX.Element[] = [
    <Badge
      key="summary"
      icon="⚲"
      label={String(countActiveFilters(state.filters))}
      tone="muted"
    />,
  ];

  if (state.filters.repoIds && state.filters.repoIds.length > 0) {
    for (const id of state.filters.repoIds) {
      const repo = state.repos.find((r) => r.id === id);
      const label = repo ? repo.label : id;
      chips.push(
        <Badge key={`repo:${id}`} icon="◈" label={label} tone="accent" />,
      );
    }
  }

  if (state.filters.pillarIds && state.filters.pillarIds.length > 0) {
    for (const id of state.filters.pillarIds) {
      const pillar = state.pillars.find((p) => p.id === id);
      const label = pillar ? pillar.label : id;
      chips.push(
        <Badge key={`pillar:${id}`} icon={pillar?.icon ?? '⬢'} label={label} tone="purple" />,
      );
    }
  }

  if (state.filters.searchText && state.filters.searchText.length > 0) {
    chips.push(
      <Badge key="search" icon="/" label={state.filters.searchText} tone="success" />,
    );
  }

  const isFocused = state.focus === 'filterbar' || state.focus === 'search';

  return (
    <Box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
      <Box flexDirection="row" gap={1} overflow="hidden">
        {chips}
      </Box>
      <Box flexShrink={0} overflow="hidden">
        <Text color={UI_CHROME.muted}>
          {isFocused ? '[f] edit  [/] search  [:] commands  [Esc] clear' : 'Filtered board'}
        </Text>
      </Box>
    </Box>
  );
});
