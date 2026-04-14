import type { CIState, PRState, ReviewState } from '../types/index.js';

export const TASK_CARD_ORANGE = '#ff9f1c';
export const TASK_CARD_PURPLE = '#a855f7';
export const TASK_CARD_SELECTED = 'cyan';

export interface TaskCardStatusLike {
  prNumber?: number;
  prState: PRState;
  prDraft?: boolean;
  ciState: CIState;
  reviewState?: ReviewState;
}

export function getTaskCardBorderColor(
  task: TaskCardStatusLike,
  isSelected: boolean,
): string {
  if (isSelected) {
    return TASK_CARD_SELECTED;
  }

  if (task.prState === 'merged') {
    return TASK_CARD_PURPLE;
  }

  if (task.ciState === 'failed') {
    return 'red';
  }

  if (task.ciState === 'passed') {
    return 'green';
  }

  if (
    task.prState === 'open' ||
    task.prState === 'draft' ||
    task.ciState === 'pending'
  ) {
    return TASK_CARD_ORANGE;
  }

  return 'gray';
}

export function getReviewBadge(reviewState: ReviewState): string | null {
  if (reviewState === 'approved') {
    return 'V approved';
  }

  if (reviewState === 'changes_requested') {
    return '! changes';
  }

  return null;
}

export function getBuildBadge(ciState: CIState): string | null {
  switch (ciState) {
    case 'pending':
      return 'build pending';
    case 'passed':
      return 'build pass';
    case 'failed':
      return 'build fail';
    default:
      return null;
  }
}

export function canMergeTask(task: TaskCardStatusLike): boolean {
  return (
    task.prState === 'open' &&
    task.prDraft !== true &&
    task.ciState === 'passed' &&
    task.reviewState === 'approved'
  );
}

export function getMergeBlockerReason(task: TaskCardStatusLike): string | null {
  const prRef = task.prNumber != null ? `PR #${task.prNumber}` : 'The PR';

  if (task.prState === 'none' || task.prNumber == null) {
    return 'Selected task has no pull request.';
  }

  if (task.prDraft || task.prState === 'draft') {
    return `${prRef} is still draft.`;
  }

  if (task.prState === 'merged') {
    return `${prRef} is already merged.`;
  }

  if (task.prState === 'closed') {
    return `${prRef} is closed.`;
  }

  if (task.prState !== 'open') {
    return `${prRef} is not open.`;
  }

  if (task.reviewState === 'changes_requested') {
    return `${prRef} still has requested changes.`;
  }

  if (task.reviewState !== 'approved') {
    return `${prRef} is not approved yet.`;
  }

  if (task.ciState === 'failed') {
    return `${prRef} has failing checks.`;
  }

  if (task.ciState === 'pending') {
    return `${prRef} checks are still pending.`;
  }

  if (task.ciState !== 'passed') {
    return `${prRef} does not have a passing build yet.`;
  }

  return null;
}
