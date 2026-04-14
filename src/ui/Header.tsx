import React from 'react';
import { Box, Text } from 'ink';
import { useAppState } from '../store/index.js';
import { Badge, SessionActivityBadge, UI_CHROME, countActiveFilters } from './chrome.js';
import { getHeaderContextTask } from './header-context.js';

export const HEADER_HEIGHT = 2;

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function HeaderText({
  icon,
  value,
  valueColor = UI_CHROME.text,
}: {
  icon: string;
  value: string;
  valueColor?: string;
}): JSX.Element {
  return (
    <Box marginRight={1} flexDirection="row" flexShrink={1} overflow="hidden">
      <Text color={UI_CHROME.muted}>{`${icon} `}</Text>
      <Text color={valueColor} wrap="truncate">
        {value}
      </Text>
    </Box>
  );
}

export const Header = React.memo(function Header(): JSX.Element {
  const state = useAppState();
  const {
    repos,
    tasks,
    pillars,
    tracks,
    savedViews,
    activeRepoId,
    activeViewId,
    activeTaskId,
    activeSessionBranch,
    sessionActivityByTaskId,
    syncInProgress,
    daemonConnected,
    filters,
  } = state;

  const activeRepo =
    activeRepoId != null ? repos.find((repo) => repo.id === activeRepoId) : undefined;
  const activeView = savedViews.find((view) => view.id === activeViewId);
  const contextTask = getHeaderContextTask(state);
  const contextTrack =
    contextTask != null ? tracks.find((track) => track.id === contextTask.trackId) : undefined;
  const contextPillar =
    contextTask?.pillarId != null
      ? pillars.find((pillar) => pillar.id === contextTask.pillarId)
      : undefined;
  const contextRepo =
    contextTask != null ? repos.find((repo) => repo.id === contextTask.repoId) : undefined;
  const contextActivity =
    contextTask != null ? sessionActivityByTaskId[contextTask.id] : undefined;
  const busySessions = tasks.filter(
    (task) => task.sessionId != null && sessionActivityByTaskId[task.id]?.isBusy,
  );
  const activeFilters = countActiveFilters(filters);
  const branchLabel =
    activeTaskId === contextTask?.id
      ? activeSessionBranch ?? contextTask?.branchName
      : contextTask?.branchName;

  return (
    <Box flexDirection="column" height={HEADER_HEIGHT} overflow="hidden">
      <Box
        flexDirection="row"
        justifyContent="space-between"
        height={1}
        overflow="hidden"
      >
        <Box flexDirection="row" gap={1} overflow="hidden">
          <Badge label="agentboard" tone="accent" />
          <Badge
            icon="◈"
            label={activeRepo ? truncate(activeRepo.label, 18) : 'all repos'}
            tone="muted"
          />
          {activeView && (
            <Badge icon="⌘" label={truncate(activeView.label, 16)} tone="purple" />
          )}
          {activeFilters > 0 && (
            <Badge icon="⚲" label={String(activeFilters)} tone="muted" />
          )}
        </Box>

        <Box flexDirection="row" gap={1} flexShrink={0} overflow="hidden">
          {busySessions.length > 0 && (
            <Badge
              icon="◌"
              label={busySessions.length === 1 ? '1 running' : `${busySessions.length} running`}
              tone="warning"
            />
          )}
          {syncInProgress && <Badge icon="↻" label="syncing" tone="warning" />}
          <Badge
            icon={daemonConnected ? '●' : '○'}
            label={daemonConnected ? 'daemon' : 'offline'}
            tone={daemonConnected ? 'success' : 'danger'}
          />
        </Box>
      </Box>

      <Box
        flexDirection="row"
        justifyContent="space-between"
        height={1}
        overflow="hidden"
      >
        <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
          {contextTask ? (
            <>
              <Box marginRight={1} flexShrink={1} overflow="hidden">
                <Text color={UI_CHROME.text} wrap="truncate">
                  {truncate(contextTask.title, 48)}
                </Text>
              </Box>
              <HeaderText
                icon="≡"
                value={contextTrack?.label ?? contextTask.trackId}
                valueColor={UI_CHROME.accent}
              />
              <HeaderText
                icon="◈"
                value={contextRepo?.label ?? contextTask.repoId}
                valueColor={UI_CHROME.blue}
              />
              {contextPillar && (
                <HeaderText
                  icon={contextPillar.icon ?? '⬢'}
                  value={contextPillar.label}
                  valueColor={contextPillar.color ?? UI_CHROME.purple}
                />
              )}
              <HeaderText
                icon="⌂"
                value={contextTask.worktreePath ? 'worktree' : 'repo'}
                valueColor={contextTask.worktreePath ? UI_CHROME.success : UI_CHROME.muted}
              />
            </>
          ) : (
            <Text color={UI_CHROME.muted}>No task selected</Text>
          )}
        </Box>

        <Box flexDirection="row" gap={1} flexShrink={0} overflow="hidden">
          {branchLabel && (
            <Badge icon="⎇" label={truncate(branchLabel, 20)} tone="muted" />
          )}
          {contextTask && (
            <SessionActivityBadge
              activity={contextActivity}
              hasSession={Boolean(contextTask.sessionId)}
              isActiveSession={activeTaskId === contextTask.id}
            />
          )}
        </Box>
      </Box>
    </Box>
  );
});
