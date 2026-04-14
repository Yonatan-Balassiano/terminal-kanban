import { describe, expect, it } from 'vitest';
import {
  canMergeTask,
  getBuildBadge,
  getMergeBlockerReason,
  getReviewBadge,
  getTaskCardBorderColor,
  TASK_CARD_ORANGE,
  TASK_CARD_PURPLE,
  TASK_CARD_SELECTED,
} from '../src/ui/task-card-status.js';

describe('task card status styling', () => {
  it('uses purple for merged PRs', () => {
    expect(
      getTaskCardBorderColor(
        { prState: 'merged', ciState: 'passed' },
        false,
      ),
    ).toBe(TASK_CARD_PURPLE);
  });

  it('uses red when CI fails', () => {
    expect(
      getTaskCardBorderColor(
        { prState: 'open', ciState: 'failed' },
        false,
      ),
    ).toBe('red');
  });

  it('uses green when CI passes on an open PR', () => {
    expect(
      getTaskCardBorderColor(
        { prState: 'open', ciState: 'passed' },
        false,
      ),
    ).toBe('green');
  });

  it('uses orange while PR work is still open', () => {
    expect(
      getTaskCardBorderColor(
        { prState: 'open', ciState: 'pending' },
        false,
      ),
    ).toBe(TASK_CARD_ORANGE);
  });

  it('falls back to selection color when no PR or CI status exists', () => {
    expect(
      getTaskCardBorderColor(
        { prState: 'none', ciState: 'none' },
        true,
      ),
    ).toBe(TASK_CARD_SELECTED);
  });

  it('uses the selection color even when the task status border would otherwise be green', () => {
    expect(
      getTaskCardBorderColor(
        { prState: 'open', ciState: 'passed', reviewState: 'approved' },
        true,
      ),
    ).toBe(TASK_CARD_SELECTED);
  });

  it('adds a V approved label when the PR is approved', () => {
    expect(getReviewBadge('approved')).toBe('V approved');
    expect(getReviewBadge('commented')).toBeNull();
  });

  it('renders explicit build labels', () => {
    expect(getBuildBadge('pending')).toBe('build pending');
    expect(getBuildBadge('passed')).toBe('build pass');
    expect(getBuildBadge('failed')).toBe('build fail');
  });

  it('marks a task mergeable only when open, approved, and passing', () => {
    expect(
      canMergeTask({
        prState: 'open',
        ciState: 'passed',
        reviewState: 'approved',
      }),
    ).toBe(true);

    expect(
      canMergeTask({
        prState: 'open',
        ciState: 'pending',
        reviewState: 'approved',
      }),
    ).toBe(false);

    expect(
      canMergeTask({
        prNumber: 39,
        prState: 'open',
        prDraft: true,
        ciState: 'passed',
        reviewState: 'approved',
      }),
    ).toBe(false);
  });

  it('explains why a PR cannot be merged', () => {
    expect(
      getMergeBlockerReason({
        prNumber: 39,
        prState: 'merged',
        ciState: 'passed',
        reviewState: 'approved',
      }),
    ).toBe('PR #39 is already merged.');

    expect(
      getMergeBlockerReason({
        prNumber: 39,
        prState: 'open',
        ciState: 'pending',
        reviewState: 'approved',
      }),
    ).toBe('PR #39 checks are still pending.');
  });
});
