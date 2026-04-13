// ============================================================
// AgentBoard — Header component (top bar)
// ============================================================

import React from 'react';
import { Box, Text } from 'ink';
import { useAppState } from '../store/index.js';
import { getHeaderContextTask } from './header-context.js';

function InfoBadge({
  label,
  value,
  labelColor,
  valueColor = 'white',
  flexGrow = 0,
  flexShrink = 0,
}: {
  label: string;
  value: string;
  labelColor: string;
  valueColor?: string;
  flexGrow?: number;
  flexShrink?: number;
}): JSX.Element {
  return (
    <Box marginRight={1} flexGrow={flexGrow} flexShrink={flexShrink} overflow="hidden">
      <Text color="gray">{'['}</Text>
      <Text color={labelColor}>{label}</Text>
      <Text color="gray">{':'}</Text>
      <Text color={valueColor} wrap="truncate">
        {value}
      </Text>
      <Text color="gray">{']'}</Text>
    </Box>
  );
}

export const Header = React.memo(function Header(): JSX.Element {
  const state = useAppState();
  const {
    repos,
    tasks,
    pillars,
    savedViews,
    activeRepoId,
    activeViewId,
    activeTaskId,
    activeSessionBranch,
    activeSessionBackendType,
    focus,
    daemonConnected,
  } = state;

  const activeTask =
    activeTaskId != null ? tasks.find((task) => task.id === activeTaskId) : undefined;
  const contextTask = getHeaderContextTask(state);
  const contextPillar =
    contextTask?.pillarId != null
      ? pillars.find((pillar) => pillar.id === contextTask.pillarId)
      : undefined;
  const activeTaskRepo =
    contextTask != null
      ? repos.find((repo) => repo.id === contextTask.repoId)
      : undefined;
  const activeView = savedViews.find((v) => v.id === activeViewId);
  const terminalMode = focus === 'terminal' && activeTask != null;

  const daemonBadge = daemonConnected ? (
    <Text backgroundColor="green" color="black" bold>
      {' DAEMON '}
    </Text>
  ) : (
    <Text backgroundColor="yellow" color="black" bold>
      {' DISCONNECTED '}
    </Text>
  );

  return (
    <Box flexDirection="row" flexWrap="nowrap" height={1} overflow="hidden">
      <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box marginRight={1}>
          <Text backgroundColor="cyan" color="black" bold>
            {' AGENTBOARD '}
          </Text>
        </Box>

        {repos.length === 0 ? (
          <Box marginRight={1}>
            <Text dimColor>{'No repos registered'}</Text>
          </Box>
        ) : (
          <>
            {repos.map((repo) => {
              const isActive = repo.id === activeRepoId;
              return (
                <Box key={repo.id} marginRight={1}>
                  <Text
                    color={isActive ? 'cyan' : 'white'}
                    bold={isActive}
                  >
                    [{repo.label}
                    {isActive ? '*' : ''}]
                  </Text>
                </Box>
              );
            })}
            <Box marginRight={1}>
              <Text
                color={activeRepoId === undefined ? 'cyan' : 'white'}
                bold={activeRepoId === undefined}
              >
                [{activeRepoId === undefined ? 'All*' : 'All'}]
              </Text>
            </Box>
          </>
        )}

        {!terminalMode && activeView && (
          <Box marginRight={1}>
            <Text color="magenta">{`View: @${activeView.label}`}</Text>
          </Box>
        )}
      </Box>

      <Box flexDirection="row" flexShrink={0} overflow="hidden">
        {contextTask && (
          <>
            <InfoBadge
              label="repo"
              value={activeTaskRepo?.label ?? contextTask.repoId}
              labelColor="cyan"
            />
            <InfoBadge
              label="pillar"
              value={contextPillar?.label ?? 'none'}
              labelColor="magenta"
            />
            <InfoBadge
              label="ws"
              value={contextTask.worktreePath ? 'worktree' : 'regular'}
              labelColor="green"
            />
            <InfoBadge
              label="task"
              value={contextTask.title}
              labelColor="yellow"
              flexShrink={1}
            />
          </>
        )}

        {terminalMode && (
          <>
            <Box marginRight={1}>
              <Text backgroundColor="blue" color="white" bold>
                {' TERMINAL '}
              </Text>
            </Box>
            <Box marginRight={1}>
              <Text color="cyan">
                {activeSessionBranch ?? activeTask.branchName ?? 'branch pending'}
              </Text>
            </Box>
            {activeSessionBackendType && (
              <Box marginRight={1}>
                <Text dimColor>{`[${activeSessionBackendType}]`}</Text>
              </Box>
            )}
            <Box marginRight={1}>
              <Text dimColor>{'Esc:board'}</Text>
            </Box>
          </>
        )}

        {daemonBadge}
      </Box>
    </Box>
  );
});
