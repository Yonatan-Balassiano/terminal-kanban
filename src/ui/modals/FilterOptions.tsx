import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAppState } from '../../store/index.js';
import type { FilterModel } from '../../types/index.js';

type ActiveColumn = 'repo' | 'pillar';

interface Option {
  id: string;
  label: string;
}

const COLUMN_WIDTH = 28;
const VISIBLE_ROWS = 8;

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(length - 1, index));
}

function toggleId(ids: string[], id: string): string[] {
  if (ids.includes(id)) {
    return ids.filter((value) => value !== id);
  }

  return [...ids, id];
}

function getInitialIndex(options: Option[], selectedIds?: string[]): number {
  if (!selectedIds || selectedIds.length === 0) {
    return 0;
  }

  const firstSelectedId = selectedIds[0];
  const index = options.findIndex((option) => option.id === firstSelectedId);
  return index >= 0 ? index : 0;
}

function buildFilters(
  base: FilterModel,
  repoIds: string[],
  pillarIds: string[],
): FilterModel {
  const next: FilterModel = { ...base };

  if (repoIds.length > 0) {
    next.repoIds = repoIds;
  } else {
    delete next.repoIds;
  }

  if (pillarIds.length > 0) {
    next.pillarIds = pillarIds;
  } else {
    delete next.pillarIds;
  }

  return next;
}

function getWindowStart(index: number, length: number): number {
  if (length <= VISIBLE_ROWS) {
    return 0;
  }

  const centered = index - Math.floor(VISIBLE_ROWS / 2);
  return Math.max(0, Math.min(length - VISIBLE_ROWS, centered));
}

function padLabel(label: string, width: number): string {
  const chars = Array.from(label);
  if (chars.length >= width) {
    return `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
  }

  return label + ' '.repeat(width - chars.length);
}

function RenderColumn({
  title,
  active,
  options,
  selectedIds,
  selectedIndex,
}: {
  title: string;
  active: boolean;
  options: Option[];
  selectedIds: string[];
  selectedIndex: number;
}): JSX.Element {
  const windowStart = getWindowStart(selectedIndex, options.length);
  const visibleOptions = options.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box
      borderStyle="round"
      borderColor={active ? 'cyan' : 'gray'}
      width={COLUMN_WIDTH}
      flexDirection="column"
      paddingX={1}
      paddingY={0}
    >
      <Text color={active ? 'cyan' : undefined} bold>
        {title}
      </Text>
      <Text dimColor>{selectedIds.length === 0 ? 'all selected' : `${selectedIds.length} checked`}</Text>
      {visibleOptions.map((option, idx) => {
        const actualIndex = windowStart + idx;
        const rowActive = active && actualIndex === selectedIndex;
        const checked = selectedIds.includes(option.id);
        return (
          <Text key={option.id} color={rowActive ? 'cyan' : undefined} bold={rowActive} wrap="truncate">
            {`${rowActive ? '▸' : ' '} [${checked ? 'x' : ' '}] ${padLabel(option.label, COLUMN_WIDTH - 9)}`}
          </Text>
        );
      })}
      {Array.from({ length: Math.max(0, VISIBLE_ROWS - visibleOptions.length) }, (_, idx) => (
        <Text key={`empty:${idx}`}>{' '}</Text>
      ))}
    </Box>
  );
}

export interface FilterOptionsModalProps {
  onSubmit: (filters: FilterModel) => void;
  onCancel: () => void;
}

export function FilterOptionsModal({
  onSubmit,
  onCancel,
}: FilterOptionsModalProps): JSX.Element {
  const state = useAppState();
  const repoOptions: Option[] = state.repos.map((repo) => ({
    id: repo.id,
    label: repo.label,
  }));
  const pillarOptions: Option[] = state.pillars.map((pillar) => ({
    id: pillar.id,
    label: pillar.icon ? `${pillar.icon} ${pillar.label}` : pillar.label,
  }));

  const [activeColumn, setActiveColumn] = useState<ActiveColumn>('repo');
  const [repoIndex, setRepoIndex] = useState(() =>
    clampIndex(getInitialIndex(repoOptions, state.filters.repoIds), repoOptions.length),
  );
  const [pillarIndex, setPillarIndex] = useState(() =>
    clampIndex(getInitialIndex(pillarOptions, state.filters.pillarIds), pillarOptions.length),
  );
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>(
    state.filters.repoIds ? [...state.filters.repoIds] : [],
  );
  const [selectedPillarIds, setSelectedPillarIds] = useState<string[]>(
    state.filters.pillarIds ? [...state.filters.pillarIds] : [],
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (input === 'c' || input === 'C') {
      setSelectedRepoIds([]);
      setSelectedPillarIds([]);
      return;
    }

    if (input === ' ') {
      if (activeColumn === 'repo') {
        const option = repoOptions[repoIndex];
        if (option) {
          setSelectedRepoIds((current) => toggleId(current, option.id));
        }
      } else {
        const option = pillarOptions[pillarIndex];
        if (option) {
          setSelectedPillarIds((current) => toggleId(current, option.id));
        }
      }
      return;
    }

    if (key.return) {
      onSubmit(buildFilters(state.filters, selectedRepoIds, selectedPillarIds));
      return;
    }

    if (key.leftArrow) {
      setActiveColumn('repo');
      return;
    }

    if (key.rightArrow) {
      setActiveColumn('pillar');
      return;
    }

    if (key.upArrow) {
      if (activeColumn === 'repo') {
        setRepoIndex((current) => clampIndex(current - 1, repoOptions.length));
      } else {
        setPillarIndex((current) => clampIndex(current - 1, pillarOptions.length));
      }
      return;
    }

    if (key.downArrow) {
      if (activeColumn === 'repo') {
        setRepoIndex((current) => clampIndex(current + 1, repoOptions.length));
      } else {
        setPillarIndex((current) => clampIndex(current + 1, pillarOptions.length));
      }
    }
  });

  return (
    <Box borderStyle="round" padding={1} flexDirection="column" gap={1}>
      <Text bold>{'Filters'}</Text>

      <Box flexDirection="row" gap={2}>
        <RenderColumn
          title="Repos"
          active={activeColumn === 'repo'}
          options={repoOptions}
          selectedIds={selectedRepoIds}
          selectedIndex={repoIndex}
        />
        <RenderColumn
          title="Pillars"
          active={activeColumn === 'pillar'}
          options={pillarOptions}
          selectedIds={selectedPillarIds}
          selectedIndex={pillarIndex}
        />
      </Box>

      <Text dimColor>{'No checks means all. [←/→] switch list  [↑/↓] move  [space] toggle'}</Text>
      <Text dimColor>{'[Enter] apply  [c] clear all  [Esc] cancel'}</Text>
    </Box>
  );
}
