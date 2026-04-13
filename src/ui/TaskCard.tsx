// ============================================================
// AgentBoard — TaskCard component
// ============================================================

import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import type {
  TaskRecord,
  PillarRecord,
  PRState,
  SessionActivitySnapshot,
} from '../types/index.js';
import {
  canMergeTask,
  getBuildBadge,
  getReviewBadge,
  getTaskCardBorderColor,
  TASK_CARD_ORANGE,
  TASK_CARD_PURPLE,
} from './task-card-status.js';

export interface TaskCardProps {
  task: TaskRecord;
  isSelected: boolean;
  isActiveSession: boolean;
  sessionActivity?: SessionActivitySnapshot;
  pillars: PillarRecord[];
  repoLabel: string;
}

const CARD_WIDTH = 30;
const CARD_CONTENT_WIDTH = CARD_WIDTH - 4;
const SHELL_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---- helpers ------------------------------------------------

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function ShellStatus({
  hasSession,
  isActiveSession,
  isBusySession,
  shortId,
}: {
  hasSession: boolean;
  isActiveSession: boolean;
  isBusySession: boolean;
  shortId: string;
}): JSX.Element {
  const [spinnerIndex, setSpinnerIndex] = React.useState(0);

  React.useEffect(() => {
    if (!isBusySession) {
      setSpinnerIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setSpinnerIndex((index) => (index + 1) % SHELL_SPINNER_FRAMES.length);
    }, 80);
    timer.unref?.();

    return () => {
      clearInterval(timer);
    };
  }, [isBusySession]);

  const sessionIcon = isBusySession
    ? SHELL_SPINNER_FRAMES[spinnerIndex] ?? SHELL_SPINNER_FRAMES[0]
    : isActiveSession
      ? '●'
      : hasSession
        ? '●'
        : '○';
  const sessionIconColor = isBusySession
    ? 'yellow'
    : isActiveSession
      ? 'cyan'
      : hasSession
        ? 'green'
        : 'gray';
  const sessionLabel = isActiveSession ? 'open shell' : 'shell';
  const sessionLabelColor = isActiveSession ? 'cyan' : 'gray';

  return (
    <Box>
      <Text>{'  '}</Text>
      <Text color={sessionIconColor}>{sessionIcon}</Text>
      <Text color={sessionLabelColor}>{` ${sessionLabel}`}</Text>
      <Text dimColor>{`  ${shortId}`}</Text>
    </Box>
  );
}

function prBadge(prState: PRState, prDraft: boolean, prNumber?: number): string | null {
  const prSuffix = prNumber !== undefined ? ` #${prNumber}` : '';
  if (prDraft) return chalk.hex(TASK_CARD_ORANGE)(`~${prSuffix} draft`);
  switch (prState) {
    case 'open':
      return chalk.hex(TASK_CARD_ORANGE)(`↑${prSuffix} open`);
    case 'merged':
      return chalk.hex(TASK_CARD_PURPLE)(`⇑${prSuffix} merged`);
    case 'closed':
      return chalk.red(`✗${prSuffix} closed`);
    default:
      return null;
  }
}

export function getTaskCardHeight(task: TaskRecord, hasPillar: boolean): number {
  const hasDescription = Boolean(task.description);
  const hasRow2 = hasPillar || prBadge(task.prState, task.prDraft, task.prNumber) !== null;
  const hasRow3 =
    getBuildBadge(task.ciState) !== null ||
    getReviewBadge(task.reviewState) !== null ||
    canMergeTask(task);

  return 2 + 1 + (hasDescription ? 1 : 0) + (hasRow2 ? 1 : 0) + (hasRow3 ? 1 : 0) + 1 + 1 + 1;
}

// ---- component ----------------------------------------------

export function TaskCard({
  task,
  isSelected,
  isActiveSession,
  sessionActivity,
  pillars,
  repoLabel,
}: TaskCardProps): JSX.Element {
  const pillar = pillars.find((p) => p.id === task.pillarId);

  // Row 1: selection indicator + title
  const selectionIndicator = isSelected ? '▸' : ' ';
  const titleMaxLen = CARD_CONTENT_WIDTH - 2;
  const title = truncate(task.title, titleMaxLen);
  const description = task.description
    ? truncate(task.description, CARD_CONTENT_WIDTH)
    : null;

  // Row 2: pillar chip + PR badge
  const pillarChip = pillar
      ? (() => {
        const icon = pillar.icon ?? '⬢';
        const label = truncate(pillar.label, 12);
        const text = `${icon} ${label}`;
        return pillar.color ? chalk.hex(pillar.color)(text) : text;
      })()
    : null;
  const pr = prBadge(task.prState, task.prDraft, task.prNumber);
  const build = getBuildBadge(task.ciState);
  const review = getReviewBadge(task.reviewState);

  const row2Parts = [
    pillarChip,
    pr,
  ].filter(Boolean);
  const row2 = row2Parts.length > 0 ? row2Parts.join('  ') : null;

  const row3Parts = [
    build ? (task.ciState === 'passed'
      ? chalk.green(task.ciSummary ? `${build} ${task.ciSummary}` : build)
      : task.ciState === 'failed'
        ? chalk.red(task.failingCheckName ? `${build} ${truncate(task.failingCheckName, 10)}` : (task.ciSummary ? `${build} ${task.ciSummary}` : build))
        : chalk.hex(TASK_CARD_ORANGE)(task.ciSummary ? `${build} ${task.ciSummary}` : build)) : null,
    review ? (task.reviewState === 'changes_requested'
      ? chalk.red(task.reviewSummary ? `${review} ${task.reviewSummary}` : review)
      : chalk.green(task.reviewSummary ? `${review} ${task.reviewSummary}` : review)) : null,
    canMergeTask(task) ? chalk.green('merge ready') : null,
  ].filter(Boolean);
  const row3 = row3Parts.length > 0 ? row3Parts.join('  ') : null;

  // Row 4: repo label
  const row4 = chalk.gray(`repo ${truncate(repoLabel, CARD_CONTENT_WIDTH - 5)}`);

  // Row 5: git/worktree summary
  const workspaceKind = task.worktreePath
    ? chalk.cyan('worktree')
    : chalk.gray('regular');
  const gitStatusBase =
    task.gitState === 'conflicted'
      ? chalk.red('conflicted')
      : task.gitState === 'dirty'
        ? chalk.yellow('dirty')
        : task.gitState === 'untracked'
          ? chalk.yellow('untracked')
          : task.gitState === 'detached'
            ? chalk.red('detached')
            : task.gitState === 'clean'
              ? chalk.green('clean')
              : chalk.gray('unknown');
  const gitDivergence = [
    task.gitAheadCount > 0 ? `+${task.gitAheadCount}` : null,
    task.gitBehindCount > 0 ? `-${task.gitBehindCount}` : null,
  ].filter(Boolean).join('/');
  const gitFlags = [
    task.hasUntracked ? '?' : null,
    task.hasConflicts ? '!' : null,
  ].filter(Boolean).join('');
  const row5 = [
    workspaceKind,
    gitStatusBase,
    gitDivergence.length > 0 ? chalk.gray(gitDivergence) : null,
    gitFlags.length > 0 ? chalk.yellow(gitFlags) : null,
  ].filter(Boolean).join(' ');

  // Row 6: session indicator + short task id
  const hasSession = Boolean(task.sessionId);
  const isBusySession = sessionActivity?.isBusy === true;
  const shortId = chalk.dim(`#${task.id.slice(0, 8)}`);

  const bodyBackgroundColor: string | undefined = undefined;
  const titleBackgroundColor: string | undefined = isActiveSession ? 'cyan' : undefined;
  const titleColor: string | undefined =
    isActiveSession ? 'black' : isSelected ? 'cyan' : undefined;
  const borderColor = getTaskCardBorderColor(task, isSelected);

  return (
    <Box
      flexDirection="column"
      width={CARD_WIDTH}
      borderStyle={isActiveSession ? 'double' : 'single'}
      borderColor={borderColor}
    >
      <Box flexDirection="column" paddingX={1}>
        <Text
          backgroundColor={titleBackgroundColor}
          color={titleColor}
          bold={isSelected || isActiveSession}
          wrap="truncate"
        >
          {selectionIndicator} {title}
        </Text>

        {description !== null && (
          <Text backgroundColor={bodyBackgroundColor} wrap="truncate" dimColor>
            {'  '}
            {description}
          </Text>
        )}

        {row2 !== null && (
          <Text backgroundColor={bodyBackgroundColor} wrap="truncate">
            {'  '}
            {row2}
          </Text>
        )}

        {row3 !== null && (
          <Text backgroundColor={bodyBackgroundColor} wrap="truncate">
            {'  '}
            {row3}
          </Text>
        )}

        <Text backgroundColor={bodyBackgroundColor} wrap="truncate">
          {'  '}
          {row4}
        </Text>

        <Text backgroundColor={bodyBackgroundColor} wrap="truncate">
          {'  '}
          {row5}
        </Text>

        <ShellStatus
          hasSession={hasSession}
          isActiveSession={isActiveSession}
          isBusySession={isBusySession}
          shortId={shortId}
        />
      </Box>
    </Box>
  );
}
