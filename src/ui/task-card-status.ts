import type { CIState, PRState, ReviewState } from '../types/index.js';

export const TASK_CARD_ORANGE = '#ff9f1c';
export const TASK_CARD_PURPLE = '#a855f7';

export interface TaskCardStatusLike {
  prState: PRState;
  ciState: CIState;
  reviewState?: ReviewState;
}

export function getTaskCardBorderColor(
  task: TaskCardStatusLike,
  isSelected: boolean,
): string {
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

  return isSelected ? 'cyan' : 'gray';
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
    task.ciState === 'passed' &&
    task.reviewState === 'approved'
  );
}
