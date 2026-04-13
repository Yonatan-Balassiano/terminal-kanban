import { Box, Text } from 'ink';
import type {
  PillarRecord,
  SessionActivitySnapshot,
  TaskRecord,
} from '../types/index.js';
import { UI_CHROME, getSessionBadgeModel, useSpinnerFrame } from './chrome.js';
import { canMergeTask, getTaskCardBorderColor } from './task-card-status.js';

export interface TaskCardProps {
  task: TaskRecord;
  isSelected: boolean;
  isActiveSession: boolean;
  sessionActivity?: SessionActivitySnapshot;
  pillars: PillarRecord[];
  repoLabel: string;
  showRepoLabel: boolean;
}

const CARD_WIDTH = 32;
const CARD_CONTENT_WIDTH = CARD_WIDTH - 4;

type InlineStatus = {
  color: string;
  icon: string;
  label: string;
};

function truncate(str: string, max: number): string {
  if (str.length <= max) {
    return str;
  }

  return `${str.slice(0, Math.max(0, max - 1))}…`;
}

function formatRelativeAge(timestamp: number): string {
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (elapsedMs < minute) {
    return 'just now';
  }
  if (elapsedMs < hour) {
    return `${Math.floor(elapsedMs / minute)}m ago`;
  }
  if (elapsedMs < day) {
    return `${Math.floor(elapsedMs / hour)}h ago`;
  }

  return `${Math.floor(elapsedMs / day)}d ago`;
}

function statusToneColor(tone: 'accent' | 'danger' | 'info' | 'muted' | 'neutral' | 'purple' | 'success' | 'warning'): string {
  switch (tone) {
    case 'accent':
      return UI_CHROME.accent;
    case 'danger':
      return UI_CHROME.danger;
    case 'info':
      return UI_CHROME.blue;
    case 'purple':
      return UI_CHROME.purple;
    case 'success':
      return UI_CHROME.success;
    case 'warning':
      return UI_CHROME.warning;
    case 'muted':
    case 'neutral':
    default:
      return UI_CHROME.muted;
  }
}

function getHeaderStatus(
  sessionActivity: SessionActivitySnapshot | undefined,
  hasSession: boolean,
  isActiveSession: boolean,
): InlineStatus {
  const model = getSessionBadgeModel(sessionActivity, { hasSession, isActiveSession });
  const color = statusToneColor(model.tone);
  const label = model.label;

  return {
    color,
    icon:
      model.label === 'live'
        ? '●'
        : model.label === 'idle'
          ? '◦'
          : model.label === 'orphaned'
            ? '!'
            : model.label === 'ended'
              ? '×'
              : '○',
    label,
  };
}

function getChecksStatus(task: TaskRecord): InlineStatus | null {
  if (task.ciState === 'pending') {
    return { icon: '◌', label: 'Checks', color: UI_CHROME.warning };
  }
  if (task.ciState === 'passed') {
    return {
      icon: '✓',
      label: task.ciSummary ? `Checks ${truncate(task.ciSummary, 8)}` : 'Checks',
      color: UI_CHROME.success,
    };
  }
  if (task.ciState === 'failed') {
    return {
      icon: '!',
      label: task.failingCheckName
        ? truncate(task.failingCheckName, 12)
        : 'Checks',
      color: UI_CHROME.danger,
    };
  }

  return null;
}

function getReviewStatus(task: TaskRecord): InlineStatus | null {
  if (task.reviewState === 'approved') {
    return {
      icon: '👍',
      label: task.reviewSummary ? truncate(task.reviewSummary, 10) : 'Approved',
      color: UI_CHROME.success,
    };
  }
  if (task.reviewState === 'changes_requested') {
    return {
      icon: '!',
      label: task.reviewSummary ? truncate(task.reviewSummary, 10) : 'Changes',
      color: UI_CHROME.danger,
    };
  }

  return null;
}

function getPRStatus(task: TaskRecord): InlineStatus | null {
  if (task.prDraft) {
    return { icon: '~', label: `PR #${task.prNumber ?? '?'}`, color: UI_CHROME.warning };
  }
  if (task.prState === 'open') {
    return { icon: '↗', label: `PR #${task.prNumber ?? '?'}`, color: UI_CHROME.warning };
  }
  if (task.prState === 'merged') {
    return { icon: '⇡', label: `PR #${task.prNumber ?? '?'}`, color: UI_CHROME.purple };
  }
  if (task.prState === 'closed') {
    return { icon: '×', label: `PR #${task.prNumber ?? '?'}`, color: UI_CHROME.danger };
  }
  if (canMergeTask(task)) {
    return { icon: '⇢', label: 'Merge ready', color: UI_CHROME.success };
  }

  return null;
}

function getGitStatus(task: TaskRecord): InlineStatus | null {
  if (task.gitState === 'conflicted') {
    return { icon: '!', label: 'Conflict', color: UI_CHROME.danger };
  }
  if (task.gitState === 'dirty') {
    return { icon: '~', label: 'Dirty', color: UI_CHROME.warning };
  }
  if (task.gitState === 'untracked') {
    return { icon: '?', label: 'Untracked', color: UI_CHROME.warning };
  }
  if (task.gitState === 'detached') {
    return { icon: '×', label: 'Detached', color: UI_CHROME.danger };
  }
  if (task.gitState === 'clean') {
    return { icon: '✓', label: 'Clean', color: UI_CHROME.muted };
  }

  return null;
}

function StatusText({ status }: { status: InlineStatus | null }): JSX.Element {
  if (status == null) {
    return <Text color={UI_CHROME.muted}>{' '}</Text>;
  }

  return (
    <Text color={status.color} wrap="truncate">
      {`${status.icon} ${status.label}`}
    </Text>
  );
}

export function getTaskCardHeight(_task: TaskRecord, _hasPillar: boolean): number {
  return 7;
}

export function TaskCard({
  task,
  isSelected,
  isActiveSession,
  sessionActivity,
  pillars,
  repoLabel,
  showRepoLabel,
}: TaskCardProps): JSX.Element {
  const pillar = pillars.find((candidate) => candidate.id === task.pillarId);
  const isBusySession = sessionActivity?.isBusy === true;
  const spinnerFrame = useSpinnerFrame(isBusySession);
  const borderColor = getTaskCardBorderColor(task, isSelected);
  const headerStatus = getHeaderStatus(
    sessionActivity,
    Boolean(task.sessionId),
    isActiveSession,
  );
  const activeHeaderIcon = isBusySession ? spinnerFrame : headerStatus.icon;
  const branchLabel = task.branchName ? truncate(task.branchName, 14) : 'branch';
  const workspaceLabel = task.worktreePath ? 'worktree' : 'root';
  const contextParts = [
    pillar ? `${pillar.icon ?? '⬢'} ${truncate(pillar.label, showRepoLabel ? 10 : 18)}` : null,
    showRepoLabel ? `◈ ${truncate(repoLabel, 10)}` : null,
    `⎇ ${truncate(`${branchLabel}/${workspaceLabel}`, 18)}`,
  ].filter((part): part is string => part != null);
  const checksStatus = getChecksStatus(task) ?? getPRStatus(task);
  const reviewStatus = getReviewStatus(task) ?? getGitStatus(task);

  return (
    <Box
      flexDirection="column"
      width={CARD_WIDTH}
      borderStyle={isActiveSession ? 'double' : 'round'}
      borderColor={borderColor}
    >
      <Box flexDirection="column" paddingX={1} overflow="hidden">
        <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
          <Box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} overflow="hidden">
            <Text color={isSelected ? UI_CHROME.accent : UI_CHROME.muted}>
              {isSelected ? '▸' : ' '}
            </Text>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text
                color={UI_CHROME.text}
                bold={isActiveSession}
                wrap="truncate"
              >
                {task.title}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0} marginLeft={1} overflow="hidden">
            <Text color={headerStatus.color}>{activeHeaderIcon}</Text>
            <Text color={UI_CHROME.text} bold={isActiveSession} wrap="truncate">
              {headerStatus.label}
            </Text>
          </Box>
        </Box>

        <Text color={UI_CHROME.line}>{'─'.repeat(CARD_CONTENT_WIDTH)}</Text>

        <Text color={UI_CHROME.muted} wrap="truncate">
          {truncate(contextParts.join('  '), CARD_CONTENT_WIDTH)}
        </Text>

        <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
          <Text color={UI_CHROME.muted}>{`#${task.id.slice(0, 8)}`}</Text>
          <Text color={UI_CHROME.muted}>{formatRelativeAge(task.updatedAt)}</Text>
        </Box>

        <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
          <Box flexShrink={1} overflow="hidden" width={13}>
            <StatusText status={checksStatus} />
          </Box>
          <Box flexShrink={1} overflow="hidden" width={13}>
            <StatusText status={reviewStatus} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
