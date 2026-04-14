import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type {
  PillarRecord,
  SessionActivitySnapshot,
  TaskRecord,
} from '../types/index.js';
import { truncatePlain } from './ansi-truncate.js';
import { Badge, type BadgeTone, UI_CHROME, getSessionBadgeModel } from './chrome.js';
import { canMergeTask, getTaskCardBorderColor } from './task-card-status.js';

export interface TaskCardProps {
  task: TaskRecord;
  isSelected: boolean;
  isActiveSession: boolean;
  sessionActivity?: SessionActivitySnapshot;
  pillars: PillarRecord[];
  repoLabel: string;
}

const CARD_WIDTH = 32;
const CARD_CONTENT_WIDTH = CARD_WIDTH - 4;

type InlineStatus = {
  color: string;
  icon: string;
  label: string;
};

function truncate(str: string, max: number): string {
  if (max <= 0) {
    return '';
  }

  if (stringWidth(str) <= max) {
    return str;
  }

  if (max === 1) {
    return '…';
  }

  return `${truncatePlain(str, max - 1)}…`;
}

function normalizeSingleLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!normalized) {
    return undefined;
  }

  return normalized.replace(/\s+/g, ' ');
}

function getDescriptionPreview(description: string | undefined): string | undefined {
  return normalizeSingleLine(description);
}

export function getTaskCardTitleLines(title: string): string[] {
  const normalized = normalizeSingleLine(title) ?? 'Untitled task';
  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (stringWidth(candidate) <= CARD_CONTENT_WIDTH) {
      current = candidate;
      continue;
    }

    if (lines.length === 1) {
      const remainder = words.slice(index).join(' ');
      const tail = current.length > 0 ? `${current} ${remainder}` : remainder;
      lines.push(truncate(tail, CARD_CONTENT_WIDTH));
      return lines;
    }

    if (current.length === 0) {
      lines.push(truncate(word, CARD_CONTENT_WIDTH));
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current.length > 0) {
    lines.push(truncate(current, CARD_CONTENT_WIDTH));
  }

  return lines.slice(0, 2);
}

export function compactTaskBranchLabel(branchName: string | undefined): string {
  if (!branchName) {
    return 'branch';
  }

  const [prefix, rawSlug] = branchName.includes('/')
    ? branchName.split('/', 2)
    : [undefined, branchName];
  const slug = rawSlug ?? branchName;
  const parts = slug.split('-').filter((part) => part.length > 0);
  if (parts.length === 0) {
    return branchName;
  }

  const maybeSuffix = parts[parts.length - 1];
  const suffix = maybeSuffix && /^\d+$/.test(maybeSuffix) ? parts.pop() : undefined;
  const headParts = parts.slice(0, 3);
  const hasMoreWords = parts.length > headParts.length;
  let compactSlug = headParts.join('-');
  if (hasMoreWords) {
    compactSlug = compactSlug.length > 0 ? `${compactSlug}…` : '…';
  }
  if (suffix) {
    compactSlug = compactSlug.length > 0 ? `${compactSlug}-${suffix}` : suffix;
  }

  return prefix ? `${prefix}/${compactSlug}` : compactSlug;
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

function getPRBadgeModel(task: TaskRecord): { label: string; tone: BadgeTone } | null {
  if (task.prNumber == null || task.prState === 'none') {
    return null;
  }

  if (task.prState === 'merged') {
    return { label: `#${task.prNumber}`, tone: 'purple' };
  }

  if (task.prState === 'closed') {
    return { label: `#${task.prNumber}`, tone: 'danger' };
  }

  if (task.prDraft || task.prState === 'draft') {
    return { label: `#${task.prNumber}`, tone: 'warning' };
  }

  if (canMergeTask(task)) {
    return { label: `#${task.prNumber}`, tone: 'success' };
  }

  return { label: `#${task.prNumber}`, tone: 'info' };
}

function getGitStatus(task: TaskRecord): InlineStatus | null {
  if (task.gitState === 'conflicted') {
    return { icon: '!', label: 'conflict', color: UI_CHROME.danger };
  }
  if (task.gitState === 'dirty') {
    return { icon: '~', label: 'dirty', color: UI_CHROME.warning };
  }
  if (task.gitState === 'untracked') {
    return { icon: '?', label: 'untracked', color: UI_CHROME.warning };
  }
  if (task.gitState === 'detached') {
    return { icon: '×', label: 'detached', color: UI_CHROME.danger };
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
  return (
    8 +
    getTaskCardTitleLines(_task.title).length +
    (getDescriptionPreview(_task.description) ? 1 : 0)
  );
}

export function TaskCard({
  task,
  isSelected,
  isActiveSession,
  sessionActivity,
  pillars,
  repoLabel,
}: TaskCardProps): JSX.Element {
  const pillar = pillars.find((candidate) => candidate.id === task.pillarId);
  const isBusySession = sessionActivity?.isBusy === true;
  const borderColor = getTaskCardBorderColor(task, isSelected);
  const sessionStatus = getHeaderStatus(
    sessionActivity,
    Boolean(task.sessionId),
    isActiveSession,
  );
  const activeSessionIcon = isBusySession ? '◌' : sessionStatus.icon;
  const descriptionPreview = getDescriptionPreview(task.description);
  const titleLines = getTaskCardTitleLines(task.title);
  const branchLabel = truncate(compactTaskBranchLabel(task.branchName), 16);
  const workspaceLabel = task.worktreePath ? 'worktree' : 'root';
  const headerLabel = truncate(`${repoLabel} > ${workspaceLabel}`, CARD_CONTENT_WIDTH - 2);
  const prBadge = getPRBadgeModel(task);
  const checksStatus = getChecksStatus(task);
  const reviewStatus = getReviewStatus(task);
  const gitStatus = getGitStatus(task);

  return (
    <Box
      flexDirection="column"
      width={CARD_WIDTH}
      borderStyle={isSelected || isActiveSession ? 'double' : 'round'}
      borderColor={borderColor}
    >
      <Box flexDirection="column" paddingX={1} overflow="hidden">
        <Box flexDirection="row" gap={1} overflow="hidden">
          <Text color={sessionStatus.color}>{activeSessionIcon}</Text>
          <Text color={isSelected ? UI_CHROME.accent : UI_CHROME.blue} wrap="truncate">
            {headerLabel}
          </Text>
        </Box>

        <Text color={UI_CHROME.line}>{'─'.repeat(CARD_CONTENT_WIDTH)}</Text>

        {titleLines.map((line, index) => (
          <Text
            key={`title:${index}`}
            color={UI_CHROME.text}
            bold={isActiveSession && index === 0}
            wrap="truncate"
          >
            {line}
          </Text>
        ))}

        {descriptionPreview && (
          <Text color={UI_CHROME.muted} wrap="truncate">
            {truncate(descriptionPreview, CARD_CONTENT_WIDTH)}
          </Text>
        )}

        <Text color={UI_CHROME.line}>{'─'.repeat(CARD_CONTENT_WIDTH)}</Text>

        <Box flexDirection="row" gap={1} overflow="hidden">
          {pillar && (
            <Text color={UI_CHROME.muted} wrap="truncate">
              {`${pillar.icon ?? '⬢'} ${truncate(pillar.label, 9)}`}
            </Text>
          )}
          <Text color={UI_CHROME.muted} wrap="truncate">
            {`⎇ ${branchLabel}`}
          </Text>
        </Box>

        <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
          <Text color={UI_CHROME.muted}>{`#${task.id.slice(0, 8)}`}</Text>
          <Box flexDirection="row" gap={1} overflow="hidden">
            {gitStatus && (
              <Text color={gitStatus.color} wrap="truncate">
                {`${gitStatus.icon} ${gitStatus.label}`}
              </Text>
            )}
            <Text color={UI_CHROME.muted}>{formatRelativeAge(task.updatedAt)}</Text>
          </Box>
        </Box>

        <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
          <Box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} overflow="hidden">
            <Box flexShrink={1} overflow="hidden" width={10}>
              <StatusText status={checksStatus} />
            </Box>
            <Box flexShrink={1} overflow="hidden" width={10}>
              <StatusText status={reviewStatus} />
            </Box>
          </Box>
          {prBadge && (
            <Box flexShrink={0} marginLeft={1}>
              <Badge label={prBadge.label} tone={prBadge.tone} emphasis="strong" />
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
