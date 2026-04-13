// ============================================================
// AgentBoard — CreateTaskModal
// ============================================================

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAppState } from '../../store/index.js';
import {
  getInitialCreateTaskOptionIndex,
  getInitialCreateTaskRepoIndex,
  getNextCreateTaskOptionIndex,
  getNextCreateTaskRepoIndex,
} from '../create-task-repo.js';

export interface CreateTaskProps {
  onSubmit: (title: string, repoId: string, pillarId?: string) => void;
  onCancel: () => void;
}

type ActiveLine = 'title' | 'repo' | 'pillar';

interface PillarOption {
  id: string | null;
  label: string;
}

export function CreateTaskModal(props: CreateTaskProps): JSX.Element {
  const { onSubmit, onCancel } = props;
  const state = useAppState();

  const [value, setValue] = useState('');
  const repos = state.repos;
  const initialRepoIndex = getInitialCreateTaskRepoIndex(repos, state.activeRepoId);
  const [repoIndex, setRepoIndex] = useState(() => initialRepoIndex);
  const pillarOptions: PillarOption[] = [
    { id: null, label: 'None' },
    ...state.pillars.map((pillar) => ({
      id: pillar.id,
      label: pillar.icon ? `${pillar.icon} ${pillar.label}` : pillar.label,
    })),
  ];
  const initialPillarIndex = getInitialCreateTaskOptionIndex(
    pillarOptions,
    repos[initialRepoIndex]?.defaultPillarId ?? null,
  );
  const [pillarIndex, setPillarIndex] = useState(() => initialPillarIndex);
  const [activeLine, setActiveLine] = useState<ActiveLine>('title');
  const singleRepo = repos.length <= 1;
  const selectedRepo = repos[singleRepo ? 0 : repoIndex];
  const singlePillarOption = pillarOptions.length <= 1;
  const selectedPillar = pillarOptions[singlePillarOption ? 0 : pillarIndex];

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const title = value.trim();
      if (title.length === 0) return;
      const repoId =
        repos.length === 0
          ? (state.activeRepoId ?? '')
          : repos[singleRepo ? 0 : repoIndex]?.id ?? '';
      onSubmit(title, repoId, selectedPillar?.id ?? undefined);
      return;
    }

    if (key.upArrow) {
      setActiveLine((current) => {
        if (current === 'pillar') return 'repo';
        if (current === 'repo') return 'title';
        return 'title';
      });
      return;
    }

    if (key.downArrow) {
      setActiveLine((current) => {
        if (current === 'title') return 'repo';
        if (current === 'repo') return 'pillar';
        return 'pillar';
      });
      return;
    }

    if ((key.leftArrow || input === ',' || input === '<') && activeLine === 'repo' && !singleRepo) {
      setRepoIndex((i) => getNextCreateTaskRepoIndex(i, repos.length, -1));
      return;
    }

    if ((key.rightArrow || input === '.' || input === '>') && activeLine === 'repo' && !singleRepo) {
      setRepoIndex((i) => getNextCreateTaskRepoIndex(i, repos.length, 1));
      return;
    }

    if ((key.leftArrow || input === '[') && activeLine === 'pillar' && !singlePillarOption) {
      setPillarIndex((i) => getNextCreateTaskOptionIndex(i, pillarOptions.length, -1));
      return;
    }

    if ((key.rightArrow || input === ']') && activeLine === 'pillar' && !singlePillarOption) {
      setPillarIndex((i) => getNextCreateTaskOptionIndex(i, pillarOptions.length, 1));
      return;
    }

    if (activeLine === 'title' && (key.backspace || key.delete) && value.length > 0) {
      setValue((v) => v.slice(0, -1));
      return;
    }

    // Printable characters
    if (activeLine === 'title' && input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  const linePrefix = (line: ActiveLine): string => (activeLine === line ? '▸' : ' ');
  const lineColor = (line: ActiveLine): string | undefined =>
    activeLine === line ? 'cyan' : undefined;

  return (
    <Box
      borderStyle="round"
      padding={1}
      flexDirection="column"
      gap={1}
    >
      <Text bold>{'Create Task'}</Text>

      <Box flexDirection="row">
        <Text color={lineColor('title')}>{`${linePrefix('title')} Title: `}</Text>
        <Text color={lineColor('title')}>{`${value}${activeLine === 'title' ? '|' : ''}`}</Text>
      </Box>

      <Box flexDirection="row">
        <Text color={lineColor('repo')}>{`${linePrefix('repo')} Repo: `}</Text>
        <Text color={activeLine === 'repo' ? 'cyan' : 'green'} bold>{selectedRepo?.label ?? 'None'}</Text>
        {repos.length > 1 && (
          <Text dimColor>{` (${repoIndex + 1}/${repos.length})`}</Text>
        )}
      </Box>

      <Box flexDirection="row">
        <Text color={lineColor('pillar')}>{`${linePrefix('pillar')} Pillar: `}</Text>
        <Text color={activeLine === 'pillar' ? 'cyan' : 'green'} bold>{selectedPillar?.label ?? 'None'}</Text>
        {pillarOptions.length > 1 && (
          <Text dimColor>{` (${pillarIndex + 1}/${pillarOptions.length})`}</Text>
        )}
      </Box>

      <Text dimColor>{'[↑/↓ lines]  [←/→ change current field]'}</Text>
      <Text dimColor>{'[Enter] create  [Esc] cancel'}</Text>
    </Box>
  );
}
